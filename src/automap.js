// Ported from: descent-master/MAIN/AUTOMAP.C
// Automap wireframe display with edge deduplication and defining-edge detection

import * as THREE from 'three';

import {
	Vertices, Segments, Num_segments, Num_vertices,
	Side_to_verts, Walls, Automap_visited, Objects
} from './mglobal.js';
import { find_connect_side } from './gameseg.js';
import {
	WALL_DOOR, WALL_CLOSED, WALL_BLASTABLE,
	WallAnims, WCF_HIDDEN,
	KEY_BLUE, KEY_RED, KEY_GOLD
} from './wall.js';
import {
	SEGMENT_IS_FUELCEN, SEGMENT_IS_CONTROLCEN, SEGMENT_IS_ROBOTMAKER
} from './fuelcen.js';
import {
	OBJ_HOSTAGE, OBJ_POWERUP, OBJ_NONE, OBJ_PLAYER,
	get_Highest_object_index
} from './object.js';
import { POW_KEY_BLUE, POW_KEY_RED, POW_KEY_GOLD } from './collide.js';

// --- Edge flags (from AUTOMAP.C lines 219-225) ---
const EF_USED = 1;
const EF_DEFINING = 2;
const EF_FRONTIER = 4;
const EF_SECRET = 8;
const EF_GRATE = 16;
const EF_NO_FADE = 32;

// --- Color constants (from AUTOMAP.C lines 248-252) ---
// Original uses BM_XRGB palette indices; we store RGB floats directly.
// Colors scaled from 0-63 VGA range to 0-1 float range.
const WALL_NORMAL_COLOR = 0;		// gray (29/63, 29/63, 29/63)
const WALL_DOOR_COLOR = 1;			// green (21/63, 31/63, 11/63)
const WALL_DOOR_BLUE = 2;			// blue (0, 0, 31/63)
const WALL_DOOR_GOLD = 3;			// gold (31/63, 31/63, 0)
const WALL_DOOR_RED = 4;			// red (31/63, 0, 0)
const COLOR_FUELCEN = 5;			// brown (29/63, 27/63, 13/63)
const COLOR_CONTROLCEN = 6;		// red (29/63, 0, 0)
const COLOR_ROBOTMAKER = 7;		// magenta (29/63, 0, 31/63)
const COLOR_HOSTAGE = 8;			// green (0, 31/63, 0)
const COLOR_NONE = 255;			// don't draw

const ColorTable = [];
ColorTable[ WALL_NORMAL_COLOR ] = [ 29 / 63, 29 / 63, 29 / 63 ];
ColorTable[ WALL_DOOR_COLOR ] = [ 21 / 63, 31 / 63, 11 / 63 ];
ColorTable[ WALL_DOOR_BLUE ] = [ 0, 0, 31 / 63 ];
ColorTable[ WALL_DOOR_GOLD ] = [ 31 / 63, 31 / 63, 0 ];
ColorTable[ WALL_DOOR_RED ] = [ 31 / 63, 0, 0 ];
ColorTable[ COLOR_FUELCEN ] = [ 29 / 63, 27 / 63, 13 / 63 ];
ColorTable[ COLOR_CONTROLCEN ] = [ 29 / 63, 0, 0 ];
ColorTable[ COLOR_ROBOTMAKER ] = [ 29 / 63, 0, 31 / 63 ];
ColorTable[ COLOR_HOSTAGE ] = [ 0, 31 / 63, 0 ];

// --- Edge data structure (from AUTOMAP.C lines 227-237) ---
const MAX_EDGES = 6000;

// Flat arrays for edge data (avoid per-edge object allocation)
const edge_v0 = new Int16Array( MAX_EDGES );
const edge_v1 = new Int16Array( MAX_EDGES );
const edge_sides = new Uint8Array( MAX_EDGES * 4 );
const edge_segnum = new Int16Array( MAX_EDGES * 4 );
const edge_flags = new Uint8Array( MAX_EDGES );
const edge_color = new Uint8Array( MAX_EDGES );
const edge_num_faces = new Uint8Array( MAX_EDGES );

let Num_edges = 0;
let Max_edges = MAX_EDGES;
let Highest_edge_index = - 1;

// --- Map movement defines (from AUTOMAP.C lines 268-275) ---
const PITCH_DEFAULT = 9000 / 65536.0;	// fixed-point to float
const ZOOM_DEFAULT = 20 * 10;			// i2f(20*10) -> 200 units
const ZOOM_MIN_VALUE = 20 * 5;			// i2f(20*5) -> 100 units
const ZOOM_MAX_VALUE = 20 * 100;		// i2f(20*100) -> 2000 units
const SLIDE_SPEED = 350;
const ROT_SPEED_DIVISOR = 115000;

// --- Automap state ---
let _scene = null;
let _camera = null;
let _mineGroup = null;

let _isAutomap = false;
let _automapGroup = null;		// THREE.Group holding line geometry + objects
let _edgeLines = null;			// THREE.LineSegments for edges
let _playerArrow = null;		// THREE.LineSegments for player arrow
let _objectSprites = [];		// sprites for keys/hostages
let _playerArrowSize = 5.0;

// Saved camera state
const _savedCameraPos = new THREE.Vector3();
const _savedCameraQuat = new THREE.Quaternion();

// Camera orbit state (ported from AUTOMAP.C lines 286-290)
const _viewTarget = new THREE.Vector3();
let _viewDist = 0;
let _tangles_p = 0;		// pitch angle
let _tangles_h = 0;		// heading angle
let _tangles_b = 0;		// bank angle

// Pre-allocated vectors for camera computation (Golden Rule #5)
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _euler = new THREE.Euler();

// Pre-allocated vectors for normal computation
const _nv0 = { x: 0, y: 0, z: 0 };
const _nv1 = { x: 0, y: 0, z: 0 };
const _nv2 = { x: 0, y: 0, z: 0 };

// --- Public API ---

export function automap_set_externals( ext ) {

	if ( ext.scene !== undefined ) _scene = ext.scene;
	if ( ext.camera !== undefined ) _camera = ext.camera;
	if ( ext.mineGroup !== undefined ) _mineGroup = ext.mineGroup;

}

export function getIsAutomap() {

	return _isAutomap;

}

// Enter automap mode
// Ported from: AUTOMAP.C do_automap() lines 494-586
export function automap_enter() {

	if ( _scene === null || _camera === null ) return;

	_isAutomap = true;

	// Save camera state
	_savedCameraPos.copy( _camera.position );
	_savedCameraQuat.copy( _camera.quaternion );

	// Initialize view (ported from AUTOMAP.C lines 569-579)
	if ( _viewDist === 0 ) {

		_viewDist = ZOOM_DEFAULT;

	}

	_tangles_p = PITCH_DEFAULT;
	_tangles_h = 0;
	_tangles_b = 0;

	// View target = player position (in Three.js coords)
	_viewTarget.copy( _savedCameraPos );

	// Build edge list and geometry
	automap_build_edge_list();
	buildEdgeGeometry();
	buildPlayerArrow();
	buildObjectSprites();

	// Show automap, hide mine
	if ( _mineGroup !== null ) _mineGroup.visible = false;

	// Add distance-based edge fading for depth perception
	// Ported from: AUTOMAP.C lines 855-866 (distance fade with gr_fade_table)
	_scene.fog = new THREE.Fog( 0x000000, 10, _viewDist * 2.5 );

	// Position camera for initial view
	updateAutomapCamera( 0 );

}

// Exit automap mode
export function automap_exit() {

	_isAutomap = false;

	// Restore camera
	_camera.position.copy( _savedCameraPos );
	_camera.quaternion.copy( _savedCameraQuat );

	// Clean up automap geometry
	disposeAutomapGeometry();

	// Remove automap fog
	_scene.fog = null;

	// Show mine
	if ( _mineGroup !== null ) _mineGroup.visible = true;

}

// Reset automap on level change
export function automap_reset() {

	_isAutomap = false;
	_viewDist = 0;
	disposeAutomapGeometry();

}

// Update automap camera each frame (called from game.js)
// Returns { forward, up } in Descent coordinates for audio listener
// Ported from: AUTOMAP.C do_automap() main loop lines 590-714
export function automap_frame( dt, mouse, wheel, keys, isPointerLocked, fireDown ) {

	if ( _isAutomap !== true ) return;

	// Fire button resets view (ported from AUTOMAP.C lines 668-675)
	if ( fireDown === true ) {

		_viewDist = ZOOM_DEFAULT;
		_tangles_p = PITCH_DEFAULT;
		_tangles_h = 0;
		_tangles_b = 0;
		_viewTarget.copy( _savedCameraPos );

	}

	// Zoom with scroll wheel / forward thrust
	// Ported from: AUTOMAP.C line 677 — ViewDist -= forward_thrust * ZOOM_SPEED_FACTOR
	if ( wheel !== 0 ) {

		_viewDist += wheel * 0.5;

	}

	// Mouse rotation (ported from AUTOMAP.C lines 679-681)
	if ( isPointerLocked === true ) {

		_tangles_h += mouse.x * 0.00003;
		_tangles_p += mouse.y * 0.00003;

	}

	// Keyboard zoom (W/S = forward/backward zoom)
	if ( keys[ 'KeyW' ] || keys[ 'ArrowUp' ] ) {

		_viewDist -= 200 * dt;

	}

	if ( keys[ 'KeyS' ] || keys[ 'ArrowDown' ] ) {

		_viewDist += 200 * dt;

	}

	// WASD pan (slide view target) — ported from AUTOMAP.C lines 683-695
	if ( keys[ 'KeyA' ] || keys[ 'ArrowLeft' ] || keys[ 'KeyD' ] || keys[ 'ArrowRight' ] ||
		keys[ 'Space' ] || keys[ 'ShiftLeft' ] || keys[ 'ShiftRight' ] ) {

		// Get camera right and up vectors for panning
		_tmpVec.set( 1, 0, 0 ).applyQuaternion( _camera.quaternion );
		_tmpVec2.set( 0, 1, 0 ).applyQuaternion( _camera.quaternion );

		const slideSpeed = SLIDE_SPEED * dt;

		if ( keys[ 'KeyA' ] || keys[ 'ArrowLeft' ] ) _viewTarget.addScaledVector( _tmpVec, - slideSpeed );
		if ( keys[ 'KeyD' ] || keys[ 'ArrowRight' ] ) _viewTarget.addScaledVector( _tmpVec, slideSpeed );
		if ( keys[ 'Space' ] ) _viewTarget.addScaledVector( _tmpVec2, slideSpeed );
		if ( keys[ 'ShiftLeft' ] || keys[ 'ShiftRight' ] ) _viewTarget.addScaledVector( _tmpVec2, - slideSpeed );

		// Clamp distance from player (ported from AUTOMAP.C line 692)
		const dist = _viewTarget.distanceTo( _savedCameraPos );
		if ( dist > 1000 ) {

			_viewTarget.copy( _savedCameraPos );

		}

	}

	// Clamp zoom
	if ( _viewDist < ZOOM_MIN_VALUE ) _viewDist = ZOOM_MIN_VALUE;
	if ( _viewDist > ZOOM_MAX_VALUE ) _viewDist = ZOOM_MAX_VALUE;

	// Update fog distance to match zoom level
	if ( _scene.fog !== null ) _scene.fog.far = _viewDist * 2.5;

	updateAutomapCamera( dt );

	// Update player arrow position/orientation
	updatePlayerArrow();

}

// --- Internal: Camera computation ---
// Ported from: AUTOMAP.C lines 697-698 + draw_automap lines 350-352
// ViewMatrix = PlayerOrient * AnglesMatrix
// ViewerPos = ViewTarget - ViewMatrix.fvec * ViewDist

function updateAutomapCamera( dt ) {

	if ( _camera === null ) return;

	// Build view matrix from player orientation + tangles
	// Ported from: vm_angles_2_matrix(&tempm, &tangles)
	//              vm_matrix_x_matrix(&ViewMatrix, &PlayerOrient, &tempm)
	// The player orientation is stored in _savedCameraQuat.
	// tangles add rotation on top of the player's orientation.

	// Create rotation from tangles (pitch, heading, bank)
	_euler.set( - _tangles_p * Math.PI * 2, - _tangles_h * Math.PI * 2, _tangles_b * Math.PI * 2, 'YXZ' );
	_tmpQuat.setFromEuler( _euler );

	// Combine: player orient * tangles
	_camera.quaternion.copy( _savedCameraQuat ).multiply( _tmpQuat );

	// Camera position = viewTarget - forward * ViewDist
	_tmpVec.set( 0, 0, 1 ).applyQuaternion( _camera.quaternion );
	_camera.position.copy( _viewTarget ).addScaledVector( _tmpVec, _viewDist );

}

// --- Internal: Geometry building ---

function disposeAutomapGeometry() {

	if ( _automapGroup !== null && _scene !== null ) {

		_scene.remove( _automapGroup );

	}

	if ( _edgeLines !== null ) {

		_edgeLines.geometry.dispose();
		_edgeLines.material.dispose();
		_edgeLines = null;

	}

	if ( _playerArrow !== null ) {

		_playerArrow.geometry.dispose();
		_playerArrow.material.dispose();
		_playerArrow = null;

	}

	for ( let i = 0; i < _objectSprites.length; i ++ ) {

		const sprite = _objectSprites[ i ];
		sprite.material.dispose();

	}

	_objectSprites.length = 0;
	_automapGroup = null;

}

// Build THREE.LineSegments from the edge list
function buildEdgeGeometry() {

	// Dispose old geometry
	if ( _edgeLines !== null ) {

		if ( _automapGroup !== null ) _automapGroup.remove( _edgeLines );
		_edgeLines.geometry.dispose();
		_edgeLines.material.dispose();
		_edgeLines = null;

	}

	if ( _automapGroup === null ) {

		_automapGroup = new THREE.Group();
		_scene.add( _automapGroup );

	}

	const positions = [];
	const colors = [];

	for ( let i = 0; i <= Highest_edge_index; i ++ ) {

		if ( ( edge_flags[ i ] & EF_USED ) === 0 ) continue;

		// Frontier edges: skip normal-colored non-secret ones (ported from AUTOMAP.C line 770-771)
		if ( ( edge_flags[ i ] & EF_FRONTIER ) !== 0 ) {

			if ( ( edge_flags[ i ] & EF_SECRET ) === 0 && edge_color[ i ] === WALL_NORMAL_COLOR ) {

				continue;

			}

		}

		// Only draw defining edges and grate edges (ported from AUTOMAP.C line 801)
		if ( ( edge_flags[ i ] & ( EF_DEFINING | EF_GRATE ) ) === 0 ) continue;

		const v0 = edge_v0[ i ];
		const v1 = edge_v1[ i ];

		const rgb = ColorTable[ edge_color[ i ] ];
		if ( rgb === undefined ) continue;

		positions.push(
			Vertices[ v0 * 3 ], Vertices[ v0 * 3 + 1 ], - Vertices[ v0 * 3 + 2 ],
			Vertices[ v1 * 3 ], Vertices[ v1 * 3 + 1 ], - Vertices[ v1 * 3 + 2 ]
		);

		colors.push( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ], rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );

	const material = new THREE.LineBasicMaterial( {
		vertexColors: true,
		transparent: true,
		opacity: 0.9,
		depthTest: true
	} );

	_edgeLines = new THREE.LineSegments( geometry, material );
	_automapGroup.add( _edgeLines );

}

// Build player arrow (ported from AUTOMAP.C draw_player lines 301-331)
function buildPlayerArrow() {

	if ( _playerArrow !== null ) {

		if ( _automapGroup !== null ) _automapGroup.remove( _playerArrow );
		_playerArrow.geometry.dispose();
		_playerArrow.material.dispose();
		_playerArrow = null;

	}

	// Arrow geometry: 5 line segments (shaft, 2 heads, up vector)
	// Will be updated each frame in updatePlayerArrow()
	const positions = new Float32Array( 5 * 2 * 3 );	// 5 lines, 2 verts each, 3 components
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );

	const material = new THREE.LineBasicMaterial( {
		color: 0x00ff00,
		depthTest: false,
		transparent: true,
		opacity: 1.0
	} );

	_playerArrow = new THREE.LineSegments( geometry, material );
	_playerArrow.renderOrder = 999;

	if ( _automapGroup !== null ) _automapGroup.add( _playerArrow );
	_playerArrowSize = getPlayerObjectSize();
	updatePlayerArrow();

}

function getPlayerObjectSize() {

	if ( Objects[ 0 ] !== undefined && Objects[ 0 ].type === OBJ_PLAYER && Objects[ 0 ].size > 0 ) {

		return Objects[ 0 ].size;

	}

	const highestObj = get_Highest_object_index();

	for ( let i = 0; i <= highestObj; i ++ ) {

		const obj = Objects[ i ];

		if ( obj !== undefined && obj.type === OBJ_PLAYER && obj.size > 0 ) {

			return obj.size;

		}

	}

	return 5.0;

}

// Update player arrow position from saved camera state
// Ported from: AUTOMAP.C draw_player() lines 301-331
function updatePlayerArrow() {

	if ( _playerArrow === null ) return;

	const pos = _savedCameraPos;
	const size = _playerArrowSize;

	// Extract forward, right, up from saved quaternion (Descent coords → Three.js)
	_tmpVec.set( 0, 0, - 1 ).applyQuaternion( _savedCameraQuat );
	const fx = _tmpVec.x, fy = _tmpVec.y, fz = _tmpVec.z;

	_tmpVec.set( 1, 0, 0 ).applyQuaternion( _savedCameraQuat );
	const rx = _tmpVec.x, ry = _tmpVec.y, rz = _tmpVec.z;

	_tmpVec.set( 0, 1, 0 ).applyQuaternion( _savedCameraQuat );
	const ux = _tmpVec.x, uy = _tmpVec.y, uz = _tmpVec.z;

	const px = pos.x, py = pos.y, pz = pos.z;

	// Arrow tip = pos + fvec * size * 3
	const tipX = px + fx * size * 3;
	const tipY = py + fy * size * 3;
	const tipZ = pz + fz * size * 3;

	// Arrow head right = pos + fvec * size * 2 + rvec * size
	const hrX = px + fx * size * 2 + rx * size;
	const hrY = py + fy * size * 2 + ry * size;
	const hrZ = pz + fz * size * 2 + rz * size;

	// Arrow head left = pos + fvec * size * 2 - rvec * size
	const hlX = px + fx * size * 2 - rx * size;
	const hlY = py + fy * size * 2 - ry * size;
	const hlZ = pz + fz * size * 2 - rz * size;

	// Up vector tip = pos + uvec * size * 2
	const upX = px + ux * size * 2;
	const upY = py + uy * size * 2;
	const upZ = pz + uz * size * 2;

	const attr = _playerArrow.geometry.getAttribute( 'position' );
	const a = attr.array;

	// Line 0: center to tip (shaft)
	a[ 0 ] = px; a[ 1 ] = py; a[ 2 ] = pz;
	a[ 3 ] = tipX; a[ 4 ] = tipY; a[ 5 ] = tipZ;

	// Line 1: tip to head right
	a[ 6 ] = tipX; a[ 7 ] = tipY; a[ 8 ] = tipZ;
	a[ 9 ] = hrX; a[ 10 ] = hrY; a[ 11 ] = hrZ;

	// Line 2: tip to head left
	a[ 12 ] = tipX; a[ 13 ] = tipY; a[ 14 ] = tipZ;
	a[ 15 ] = hlX; a[ 16 ] = hlY; a[ 17 ] = hlZ;

	// Line 3: center to up
	a[ 18 ] = px; a[ 19 ] = py; a[ 20 ] = pz;
	a[ 21 ] = upX; a[ 22 ] = upY; a[ 23 ] = upZ;

	// Line 4: head right to head left (connecting arrowheads)
	a[ 24 ] = hrX; a[ 25 ] = hrY; a[ 26 ] = hrZ;
	a[ 27 ] = hlX; a[ 28 ] = hlY; a[ 29 ] = hlZ;

	attr.needsUpdate = true;

}

// Build sprites for objects visible on automap (keys, hostages)
// Ported from: AUTOMAP.C draw_automap() lines 384-406
function buildObjectSprites() {

	// Clean up old sprites
	for ( let i = 0; i < _objectSprites.length; i ++ ) {

		if ( _automapGroup !== null ) _automapGroup.remove( _objectSprites[ i ] );
		_objectSprites[ i ].material.dispose();

	}

	_objectSprites.length = 0;

	if ( _automapGroup === null ) return;

	const highestObj = get_Highest_object_index();

	for ( let i = 0; i <= highestObj; i ++ ) {

		const obj = Objects[ i ];
		if ( obj.type === OBJ_NONE ) continue;

		if ( obj.type === OBJ_HOSTAGE ) {

			// Hostages always show (ported from AUTOMAP.C line 388)
			const sprite = new THREE.Sprite( new THREE.SpriteMaterial( {
				color: 0x007f00,
				depthTest: false
			} ) );
			sprite.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
			sprite.scale.set( obj.size * 2, obj.size * 2, 1 );
			sprite.renderOrder = 998;
			_automapGroup.add( sprite );
			_objectSprites.push( sprite );

		} else if ( obj.type === OBJ_POWERUP ) {

			// Keys only in visited segments (ported from AUTOMAP.C lines 393-404)
			if ( Automap_visited[ obj.segnum ] === 1 ) {

				let color = null;

				if ( obj.id === POW_KEY_RED ) color = 0xff1414;
				else if ( obj.id === POW_KEY_BLUE ) color = 0x1414ff;
				else if ( obj.id === POW_KEY_GOLD ) color = 0xffff2a;

				if ( color !== null ) {

					const sprite = new THREE.Sprite( new THREE.SpriteMaterial( {
						color: color,
						depthTest: false
					} ) );
					sprite.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
					sprite.scale.set( obj.size * 4, obj.size * 4, 1 );
					sprite.renderOrder = 998;
					_automapGroup.add( sprite );
					_objectSprites.push( sprite );

				}

			}

		}

	}

}

// ==================================================================
//
// Edge list building (ported from AUTOMAP.C lines 877-1194)
//
// ==================================================================

// Find edge in hash table (ported from AUTOMAP.C automap_find_edge lines 881-908)
// Returns index if found, -1 if empty slot found. Sets edge_ptr_index to the slot.
let _foundIndex = 0;

function automap_find_edge( v0, v1 ) {

	let hash = ( ( v0 * 5 + v1 ) % Max_edges );
	if ( hash < 0 ) hash += Max_edges;
	const oldhash = hash;

	while ( true ) {

		if ( edge_num_faces[ hash ] === 0 ) {

			// Empty slot
			_foundIndex = hash;
			return - 1;

		}

		if ( edge_v0[ hash ] === v0 && edge_v1[ hash ] === v1 ) {

			// Found existing edge
			_foundIndex = hash;
			return hash;

		}

		hash ++;
		if ( hash === Max_edges ) hash = 0;
		if ( hash === oldhash ) {

			// Table full — shouldn't happen with MAX_EDGES=6000
			console.warn( 'Automap edge hash table full!' );
			_foundIndex = hash;
			return - 1;

		}

	}

}

// Add one edge (ported from AUTOMAP.C add_one_edge lines 912-967)
function add_one_edge( va, vb, color, side, segnum, hidden, grate, no_fade ) {

	if ( Num_edges >= Max_edges ) return;

	// Normalize vertex order (smaller index first)
	if ( va > vb ) {

		const tmp = va;
		va = vb;
		vb = tmp;

	}

	const found = automap_find_edge( va, vb );
	const idx = _foundIndex;

	if ( found === - 1 ) {

		// New edge
		edge_v0[ idx ] = va;
		edge_v1[ idx ] = vb;
		edge_color[ idx ] = color;
		edge_num_faces[ idx ] = 1;
		edge_flags[ idx ] = EF_USED | EF_DEFINING;
		edge_sides[ idx * 4 ] = side;
		edge_segnum[ idx * 4 ] = segnum;

		if ( idx > Highest_edge_index ) {

			Highest_edge_index = idx;

		}

		Num_edges ++;

	} else {

		// Existing edge — merge color and add face info
		if ( color !== WALL_NORMAL_COLOR ) {

			edge_color[ idx ] = color;

		}

		const nf = edge_num_faces[ idx ];
		if ( nf < 4 ) {

			edge_sides[ idx * 4 + nf ] = side;
			edge_segnum[ idx * 4 + nf ] = segnum;
			edge_num_faces[ idx ] = nf + 1;

		}

	}

	if ( grate !== 0 ) edge_flags[ idx ] |= EF_GRATE;
	if ( hidden !== 0 ) edge_flags[ idx ] |= EF_SECRET;
	if ( no_fade !== 0 ) edge_flags[ idx ] |= EF_NO_FADE;

}

// Add unknown edge (frontier) (ported from AUTOMAP.C add_one_unknown_edge lines 969-983)
function add_one_unknown_edge( va, vb ) {

	if ( va > vb ) {

		const tmp = va;
		va = vb;
		vb = tmp;

	}

	const found = automap_find_edge( va, vb );
	if ( found !== - 1 ) {

		edge_flags[ _foundIndex ] |= EF_FRONTIER;

	}

}

// Get side vertex indices (like get_side_verts in the original)
function get_side_verts( segnum, sn ) {

	const seg = Segments[ segnum ];
	const sv = Side_to_verts[ sn ];
	return [
		seg.verts[ sv[ 0 ] ],
		seg.verts[ sv[ 1 ] ],
		seg.verts[ sv[ 2 ] ],
		seg.verts[ sv[ 3 ] ]
	];

}

// Add edges for one segment (ported from AUTOMAP.C add_segment_edges lines 987-1092)
function add_segment_edges( segnum ) {

	const seg = Segments[ segnum ];

	for ( let sn = 0; sn < 6; sn ++ ) {

		let hidden_flag = 0;
		let is_grate = 0;
		let no_fade = 0;
		let color = COLOR_NONE;

		// Dead-end walls get normal color
		if ( seg.children[ sn ] === - 1 ) {

			color = WALL_NORMAL_COLOR;

		}

		// Special segment colors
		switch ( seg.special ) {

			case SEGMENT_IS_FUELCEN:
				color = COLOR_FUELCEN;
				break;
			case SEGMENT_IS_CONTROLCEN:
				color = COLOR_CONTROLCEN;
				break;
			case SEGMENT_IS_ROBOTMAKER:
				color = COLOR_ROBOTMAKER;
				break;

		}

		// Wall/door color logic (ported from AUTOMAP.C lines 1020-1068)
		const wallNum = seg.sides[ sn ].wall_num;

		if ( wallNum > - 1 ) {

			const wall = Walls[ wallNum ];

			switch ( wall.type ) {

				case WALL_DOOR:
					if ( wall.keys === KEY_BLUE ) {

						no_fade = 1;
						color = WALL_DOOR_BLUE;

					} else if ( wall.keys === KEY_GOLD ) {

						no_fade = 1;
						color = WALL_DOOR_GOLD;

					} else if ( wall.keys === KEY_RED ) {

						no_fade = 1;
						color = WALL_DOOR_RED;

					} else if ( wall.clip_num >= 0 && wall.clip_num < WallAnims.length &&
						WallAnims[ wall.clip_num ] !== undefined &&
						( WallAnims[ wall.clip_num ].flags & WCF_HIDDEN ) === 0 ) {

						// Non-hidden door: check other side for key color
						const connected_seg = seg.children[ sn ];

						if ( connected_seg !== - 1 ) {

							const connected_side = find_connect_side( segnum, connected_seg );

							if ( connected_side !== - 1 ) {

								const cWallNum = Segments[ connected_seg ].sides[ connected_side ].wall_num;

								if ( cWallNum > - 1 ) {

									const cKeys = Walls[ cWallNum ].keys;

									if ( cKeys === KEY_BLUE ) {

										color = WALL_DOOR_BLUE;
										no_fade = 1;

									} else if ( cKeys === KEY_GOLD ) {

										color = WALL_DOOR_GOLD;
										no_fade = 1;

									} else if ( cKeys === KEY_RED ) {

										color = WALL_DOOR_RED;
										no_fade = 1;

									} else {

										color = WALL_DOOR_COLOR;

									}

								} else {

									color = WALL_DOOR_COLOR;

								}

							} else {

								color = WALL_DOOR_COLOR;

							}

						} else {

							color = WALL_DOOR_COLOR;

						}

					} else {

						// Hidden door: show as normal wall
						color = WALL_NORMAL_COLOR;
						hidden_flag = 1;

					}

					break;

				case WALL_CLOSED:
					// Grate — draw with diagonals
					color = WALL_NORMAL_COLOR;
					is_grate = 1;
					break;

				case WALL_BLASTABLE:
					// Hostage doors / blastable walls
					color = WALL_DOOR_COLOR;
					break;

			}

		}

		if ( color !== COLOR_NONE ) {

			const verts = get_side_verts( segnum, sn );

			add_one_edge( verts[ 0 ], verts[ 1 ], color, sn, segnum, hidden_flag, 0, no_fade );
			add_one_edge( verts[ 1 ], verts[ 2 ], color, sn, segnum, hidden_flag, 0, no_fade );
			add_one_edge( verts[ 2 ], verts[ 3 ], color, sn, segnum, hidden_flag, 0, no_fade );
			add_one_edge( verts[ 3 ], verts[ 0 ], color, sn, segnum, hidden_flag, 0, no_fade );

			// Grate diagonals (ported from AUTOMAP.C lines 1085-1088)
			if ( is_grate !== 0 ) {

				add_one_edge( verts[ 0 ], verts[ 2 ], color, sn, segnum, hidden_flag, 1, no_fade );
				add_one_edge( verts[ 1 ], verts[ 3 ], color, sn, segnum, hidden_flag, 1, no_fade );

			}

		}

	}

}

// Add frontier edges from unvisited segment (ported from AUTOMAP.C add_unknown_segment_edges lines 1097-1118)
function add_unknown_segment_edges( segnum ) {

	const seg = Segments[ segnum ];

	for ( let sn = 0; sn < 6; sn ++ ) {

		// Only add edges that have no children (dead-ends)
		if ( seg.children[ sn ] === - 1 ) {

			const verts = get_side_verts( segnum, sn );

			add_one_unknown_edge( verts[ 0 ], verts[ 1 ] );
			add_one_unknown_edge( verts[ 1 ], verts[ 2 ] );
			add_one_unknown_edge( verts[ 2 ], verts[ 3 ] );
			add_one_unknown_edge( verts[ 3 ], verts[ 0 ] );

		}

	}

}

// Compute side normal from vertex positions
// Ported from: uses cross product of two edges of the side quad
function compute_side_normal( segnum, sidenum, result ) {

	const seg = Segments[ segnum ];
	const sv = Side_to_verts[ sidenum ];
	const vi0 = seg.verts[ sv[ 0 ] ];
	const vi1 = seg.verts[ sv[ 1 ] ];
	const vi2 = seg.verts[ sv[ 2 ] ];

	_nv0.x = Vertices[ vi0 * 3 ];
	_nv0.y = Vertices[ vi0 * 3 + 1 ];
	_nv0.z = Vertices[ vi0 * 3 + 2 ];

	_nv1.x = Vertices[ vi1 * 3 ];
	_nv1.y = Vertices[ vi1 * 3 + 1 ];
	_nv1.z = Vertices[ vi1 * 3 + 2 ];

	_nv2.x = Vertices[ vi2 * 3 ];
	_nv2.y = Vertices[ vi2 * 3 + 1 ];
	_nv2.z = Vertices[ vi2 * 3 + 2 ];

	// edge0 = v1 - v0
	const e0x = _nv1.x - _nv0.x;
	const e0y = _nv1.y - _nv0.y;
	const e0z = _nv1.z - _nv0.z;

	// edge1 = v2 - v1
	const e1x = _nv2.x - _nv1.x;
	const e1y = _nv2.y - _nv1.y;
	const e1z = _nv2.z - _nv1.z;

	// cross product
	result.x = e0y * e1z - e0z * e1y;
	result.y = e0z * e1x - e0x * e1z;
	result.z = e0x * e1y - e0y * e1x;

	// normalize
	const mag = Math.sqrt( result.x * result.x + result.y * result.y + result.z * result.z );
	if ( mag > 0.000001 ) {

		result.x /= mag;
		result.y /= mag;
		result.z /= mag;

	}

}

// Pre-allocated normals for defining edge check
const _normal1 = { x: 0, y: 0, z: 0 };
const _normal2 = { x: 0, y: 0, z: 0 };

// Build the complete edge list (ported from AUTOMAP.C automap_build_edge_list lines 1120-1194)
function automap_build_edge_list() {

	// Size the hash table
	Max_edges = Math.min( Num_vertices * 4, MAX_EDGES );
	if ( Max_edges < 100 ) Max_edges = MAX_EDGES;

	// Clear edge arrays
	edge_num_faces.fill( 0 );
	edge_flags.fill( 0 );
	Num_edges = 0;
	Highest_edge_index = - 1;

	// Add visited segments (ported from AUTOMAP.C lines 1149-1155)
	for ( let s = 0; s < Num_segments; s ++ ) {

		if ( Automap_visited[ s ] === 1 ) {

			add_segment_edges( s );

		}

	}

	// Add frontier edges from unvisited segments (ported from AUTOMAP.C lines 1157-1163)
	for ( let s = 0; s < Num_segments; s ++ ) {

		if ( Automap_visited[ s ] !== 1 ) {

			add_unknown_segment_edges( s );

		}

	}

	// Remove non-defining edges (ported from AUTOMAP.C lines 1167-1190)
	// If all adjacent face normals have dot product > 0.9, clear EF_DEFINING
	for ( let i = 0; i <= Highest_edge_index; i ++ ) {

		if ( ( edge_flags[ i ] & EF_USED ) === 0 ) continue;

		const nf = edge_num_faces[ i ];
		let still_defining = true;

		for ( let e1 = 0; e1 < nf && still_defining === true; e1 ++ ) {

			for ( let e2 = e1 + 1; e2 < nf; e2 ++ ) {

				const seg1 = edge_segnum[ i * 4 + e1 ];
				const seg2 = edge_segnum[ i * 4 + e2 ];

				if ( seg1 !== seg2 ) {

					compute_side_normal( seg1, edge_sides[ i * 4 + e1 ], _normal1 );
					compute_side_normal( seg2, edge_sides[ i * 4 + e2 ], _normal2 );

					const dot = _normal1.x * _normal2.x + _normal1.y * _normal2.y + _normal1.z * _normal2.z;

					// If dot > 0.9 (F1_0 - F1_0/10), faces are nearly coplanar — not a defining edge
					if ( dot > 0.9 ) {

						edge_flags[ i ] &= ~EF_DEFINING;
						still_defining = false;
						break;

					}

				}

			}

		}

	}

}

