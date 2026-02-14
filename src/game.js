// Ported from: descent-master/MAIN/GAME.C
// Core game loop, camera setup, frame timing

import * as THREE from 'three';

import {
	Vertices, Segments, Num_segments,
	set_FrameTime, set_GameTime, set_FrameCount,
	FrameTime, GameTime, FrameCount,
	Automap_visited
} from './mglobal.js';
import { find_point_seg } from './gameseg.js';
import { wall_frame_process } from './wall.js';
import { do_special_effects } from './effects.js';
import { triggers_frame_process } from './switch.js';
import { Laser_player_fire, Laser_player_fire_secondary, Laser_create_new, PARENT_PLAYER, FLARE_ID, Flare_create, laser_do_weapon_sequence, set_primary_weapon, set_secondary_weapon, Primary_weapon, Secondary_weapon, WEAPON_SELECT_CHANGED, WEAPON_SELECT_ALREADY, WEAPON_SELECT_UNAVAILABLE, get_player_laser_weapon_info_index } from './laser.js';
import { Weapon_info, Primary_weapon_to_weapon_info, Secondary_weapon_to_weapon_info } from './bm.js';
import { fireball_process } from './fireball.js';
import { ai_do_frame } from './ai.js';
import { digi_play_sample, digi_update_listener, SOUND_LASER_FIRED, SOUND_FUSION_WARMUP, SOUND_WEAPON_HIT_BLASTABLE,
	SOUND_GOOD_SELECTION_PRIMARY, SOUND_GOOD_SELECTION_SECONDARY, SOUND_ALREADY_SELECTED, SOUND_BAD_SELECTION } from './digi.js';
import { Polygon_models, polyobj_calc_gun_points } from './polyobj.js';
import { buildAutomapGeometry } from './automap.js';
import { updateMineVisibility } from './render.js';
import { controls_init, controls_set_resize_refs, controls_set_key_action_callback,
	controls_get_keys, controls_consume_mouse, controls_consume_wheel, controls_is_pointer_locked,
	controls_is_fire_down, controls_is_secondary_fire_down, controls_set_secondary_fire_down } from './controls.js';
import { PLAYER_MASS, PLAYER_DRAG, PLAYER_MAX_THRUST, PLAYER_MAX_ROTTHRUST, PLAYER_WIGGLE, PLAYER_RADIUS,
	do_physics_sim_rot, do_physics_sim, do_physics_move, physics_reset,
	set_object_turnroll, getTurnroll, phys_apply_force_to_player, phys_apply_rot,
	do_physics_align_object } from './physics.js';
import { gauges_get_canvas_ctx, gauges_mark_dirty, gauges_needs_upload } from './gauges.js';

let renderer = null;
let scene = null;
let camera = null;
let mineGroup = null;

let lastTime = 0;

// Pause state
let isPaused = false;
let pauseOverlay = null;
let _onQuitToMenu = null;	// callback for quit to main menu
let _onCockpitModeChanged = null;	// callback when cockpit mode changes (F3/H)
let _onSaveGame = null;		// callback for save game
let _onLoadGame = null;		// callback for load game

// Frame callback (set by main.js for powerup collection, reactor, etc.)
let _frameCallback = null;

export function game_set_frame_callback( cb ) {

	_frameCallback = cb;

}

// Fusion cannon externals (energy access, damage flash, HUD update)
let _getPlayerEnergy = null;
let _setPlayerEnergy = null;
let _flashDamage = null;
let _updateHUD = null;
let _applyPlayerDamage = null;
let _getPlayerQuadLasers = null;

export function game_set_fusion_externals( ext ) {

	if ( ext.getPlayerEnergy !== undefined ) _getPlayerEnergy = ext.getPlayerEnergy;
	if ( ext.setPlayerEnergy !== undefined ) _setPlayerEnergy = ext.setPlayerEnergy;
	if ( ext.flashDamage !== undefined ) _flashDamage = ext.flashDamage;
	if ( ext.updateHUD !== undefined ) _updateHUD = ext.updateHUD;
	if ( ext.applyPlayerDamage !== undefined ) _applyPlayerDamage = ext.applyPlayerDamage;
	if ( ext.getPlayerQuadLasers !== undefined ) _getPlayerQuadLasers = ext.getPlayerQuadLasers;

}

// Free-fly camera state
const mouseSpeed = 0.02;

// Player segment tracking for collision
let playerSegnum = 0;

// Fusion cannon charge state
// Ported from: GAME.C lines 492-494
const FUSION_INDEX = 4;		// Primary_weapon value for fusion
let Fusion_charge = 0;			// Current charge level (seconds)
let Fusion_next_sound_time = 0;	// Timer for sound playback
let Auto_fire_fusion_cannon_time = 0;	// When to auto-fire
export { Fusion_charge };


// Cruise control (ported from KCONFIG.C lines 2064-2080)
// Maintains a set forward speed when player releases W/S keys
let Cruise_speed = 0;	// 0-100 percentage
export function game_get_cruise_speed() { return Cruise_speed; }

// Draw cruise speed on HUD canvas
// Ported from: GAME.C lines 1530-1546 — gr_printf "CRUISE %d%%"
let _prevCruiseDrawn = false;

function drawCruiseSpeed() {

	const ctx = gauges_get_canvas_ctx();
	if ( ctx === null ) return;

	if ( Cruise_speed > 0 ) {

		// Draw cruise speed text on the gauges canvas
		// This runs AFTER gauges_draw() in the frame callback, so the canvas is already clean
		ctx.save();
		ctx.font = '7px monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.fillStyle = '#00cc00';
		ctx.fillText( 'CRUISE ' + Math.floor( Cruise_speed ) + '%', 160, 14 );
		ctx.restore();
		gauges_mark_dirty();		// ensure gauges redraws next frame (clears our text area)
		gauges_needs_upload();		// ensure texture upload includes our text
		_prevCruiseDrawn = true;

	} else if ( _prevCruiseDrawn === true ) {

		// Force redraw to clear the cruise text
		gauges_mark_dirty();
		_prevCruiseDrawn = false;

	}

}

// Missile gun alternation (ported from LASER.C)
let Missile_gun = 0;

// Player ship gun points — loaded from pship1.pof (model 25) with submodel offsets accumulated
// Ported from: BMREAD.C lines 1485-1498 (Player_ship->gun_points setup)
// Guns 0,1 = left/right laser pair; 2,3 = quad; 4,5 = missile alternating; 6 = center; 7 = rear
const PLAYER_SHIP_MODEL_NUM = 25;
let Player_gun_points = null;	// populated in game_init() from Polygon_models

// Player's forward fire direction in Descent coordinates (updated each frame in updateCamera)
// Ported from original Descent which fires parallel bolts along the player's forward vector.
const _fireDir = { x: 0, y: 0, z: 1 };

// Player dead flag — blocks movement and weapon input
let playerDead = false;

export function game_set_player_dead( dead ) {

	playerDead = dead;

}

// Reset player physics state (velocity + rotational velocity)
// Called on respawn, restart, and level transitions
export function game_reset_physics() {

	physics_reset();
	Missile_gun = 0;
	Cruise_speed = 0;

}

// Cockpit mode state
// Ported from: GAME.H CM_* constants and GAME.C toggle_cockpit()
const CM_FULL_COCKPIT = 0;
const CM_REAR_VIEW = 1;
const CM_STATUS_BAR = 2;
const CM_FULL_SCREEN = 3;

let Cockpit_mode = CM_FULL_COCKPIT;
let Rear_view = false;
let old_cockpit_mode = CM_FULL_COCKPIT;

export function getCockpitMode() { return Cockpit_mode; }
export function isRearView() { return Rear_view; }

// Automap state
let automapGroup = null;
let isAutomap = false;
const _savedCameraPos = new THREE.Vector3();
const _savedCameraQuat = new THREE.Quaternion();
let automapZoom = 1.0;		// zoom multiplier for automap camera distance
let playerMarker = null;	// sprite showing player position on automap

// First-person weapon model
let gunGroup = null;
let muzzleFlashLeft = null;
let muzzleFlashRight = null;
let muzzleFlashTimer = 0;

// Initialize the Three.js renderer and scene
export function game_init() {

	// Renderer
	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setClearColor( 0x000000 );
	document.body.appendChild( renderer.domElement );

	// Scene
	scene = new THREE.Scene();

	// Camera
	camera = new THREE.PerspectiveCamera(
		90,
		window.innerWidth / window.innerHeight,
		0.1,
		10000
	);

	// Load player ship gun points from POF model (ported from BMREAD.C)
	const playerModel = Polygon_models[ PLAYER_SHIP_MODEL_NUM ];
	if ( playerModel !== undefined && playerModel.n_guns > 0 ) {

		Player_gun_points = polyobj_calc_gun_points( playerModel );

	} else {

		console.warn( 'Player ship model not loaded, using fallback gun points' );
		Player_gun_points = [
			{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 },
			{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 },
			{ x: 0, y: 0, z: - 1 }, { x: 0, y: 0, z: - 1 },
			{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: - 1 }
		];

	}

	// Position camera at the center of the first segment
	positionCameraAtSegment( 0 );

	// Add camera to scene so camera children (gun model) render
	scene.add( camera );

	// Create first-person weapon model
	createGunModel();

	// Input handling (ported from CONTROLS.C)
	controls_init( renderer.domElement );
	controls_set_resize_refs( camera, renderer );
	controls_set_key_action_callback( handleKeyAction );

	// Expose for debugging
	window.__renderer = renderer;
	window.__scene = scene;
	window.__camera = camera;

	return { renderer, scene, camera };

}

function positionCameraAtSegment( segnum ) {

	if ( segnum < 0 || segnum >= Num_segments ) return;

	const seg = Segments[ segnum ];

	// Compute center of segment by averaging its 8 vertices
	let cx = 0, cy = 0, cz = 0;
	for ( let i = 0; i < 8; i ++ ) {

		const vi = seg.verts[ i ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	cx /= 8;
	cy /= 8;
	cz /= 8;

	// Convert to Three.js coords (negate Z)
	camera.position.set( cx, cy, - cz );
	camera.rotation.order = 'YXZ';

}

// Set player start position and orientation from level data
// playerObj is a GameObject with pos_x/y/z and orient_rvec/uvec/fvec
export function game_set_player_start( playerObj ) {

	if ( camera === null ) return;

	// Convert Descent coordinates to Three.js (negate Z)
	camera.position.set(
		playerObj.pos_x,
		playerObj.pos_y,
		- playerObj.pos_z
	);

	// Build a rotation matrix from the player object's orientation
	// Descent orient: rvec (right), uvec (up), fvec (forward)
	// Three.js: X=right, Y=up, Z=-forward (negate Z)
	const m = new THREE.Matrix4();
	m.set(
		playerObj.orient_rvec_x, playerObj.orient_uvec_x, - playerObj.orient_fvec_x, 0,
		playerObj.orient_rvec_y, playerObj.orient_uvec_y, - playerObj.orient_fvec_y, 0,
		- playerObj.orient_rvec_z, - playerObj.orient_uvec_z, playerObj.orient_fvec_z, 0,
		0, 0, 0, 1
	);

	camera.quaternion.setFromRotationMatrix( m );

	// Track player segment for collision
	playerSegnum = playerObj.segnum;

	console.log( 'Player start: pos=(' +
		playerObj.pos_x.toFixed( 1 ) + ', ' +
		playerObj.pos_y.toFixed( 1 ) + ', ' +
		playerObj.pos_z.toFixed( 1 ) + ') seg=' + playerObj.segnum );

}

// Set the mine geometry group in the scene
export function game_set_mine( group ) {

	if ( mineGroup !== null ) {

		scene.remove( mineGroup );

	}

	mineGroup = group;
	scene.add( mineGroup );

}

// Main render loop
export function game_loop( time ) {

	requestAnimationFrame( game_loop );

	// Frame timing
	if ( lastTime === 0 ) lastTime = time;
	// Ported from: GAME.C calc_frame_time() — clamp to [1/150, 1/5] seconds
	const dt = Math.max( 1 / 150, Math.min( ( time - lastTime ) / 1000, 0.2 ) );
	lastTime = time;

	set_FrameTime( dt );
	set_GameTime( GameTime + dt );
	set_FrameCount( FrameCount + 1 );

	// When paused, only render (no physics/AI/weapons)
	if ( isPaused === true ) {

		updateMineVisibility( playerSegnum, camera );
		renderer.render( scene, camera );
		return;

	}

	// Update free-fly camera
	updateCamera( dt );

	// Update muzzle flash sprite timer (short flash)
	if ( muzzleFlashTimer > 0 ) {

		muzzleFlashTimer -= dt;

		if ( muzzleFlashTimer <= 0 ) {

			if ( muzzleFlashLeft !== null ) {

				muzzleFlashLeft.material.opacity = 0;
				muzzleFlashRight.material.opacity = 0;

			}

		}

	}

	// Update audio listener position/orientation (Descent coordinates)
	// _forward and _up were computed in updateCamera()
	if ( camera !== null ) {

		digi_update_listener(
			camera.position.x, camera.position.y, - camera.position.z,
			_forward.x, _forward.y, - _forward.z,
			_up.x, _up.y, - _up.z
		);

	}

	// Process door/wall animations
	wall_frame_process();

	// Process trigger timers
	triggers_frame_process();

	// Process animated textures (eclips)
	do_special_effects();

	// Process robot AI
	ai_do_frame( dt );

	// Process weapon firing and movement
	processWeapons();
	processSecondaryWeapons();
	laser_do_weapon_sequence( dt );

	// Process explosion effects
	fireball_process( dt );

	// Frame callback (powerup collection, reactor check, etc.)
	if ( _frameCallback !== null ) {

		_frameCallback( dt );

	}

	// Draw cruise speed on HUD when active
	// Ported from: GAME.C lines 1530-1546 — show "CRUISE XX%" when speed > 0
	drawCruiseSpeed();

	// Update portal visibility before rendering
	updateMineVisibility( playerSegnum, camera );

	// Render — apply rear view rotation if active
	// Ported from: RENDER.C lines 1728-1734 — rotate view 180° around heading axis
	if ( Rear_view === true && camera !== null ) {

		_savedRenderQuat.copy( camera.quaternion );
		camera.quaternion.multiply( _rearViewQuat );
		// Hide gun model during rear view
		if ( gunGroup !== null ) gunGroup.visible = false;
		renderer.render( scene, camera );
		camera.quaternion.copy( _savedRenderQuat );
		if ( gunGroup !== null ) gunGroup.visible = true;

	} else {

		renderer.render( scene, camera );

	}

}

// Pre-allocated vectors for camera update (Golden Rule #5: no allocations in render loop)
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

// Pre-allocated quaternion for rear view 180° Y rotation (Golden Rule #5)
const _rearViewQuat = new THREE.Quaternion();
_rearViewQuat.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), Math.PI );
const _savedRenderQuat = new THREE.Quaternion();

// --- Ported from: CONTROLS.C read_flying_controls() + PHYSICS.C do_physics_sim() ---

function updateCamera( dt ) {

	if ( camera === null ) return;

	// --- Automap camera: free orbit with mouse drag + scroll zoom ---
	if ( isAutomap === true ) {

		const mouse = controls_consume_mouse();
		const wheel = controls_consume_wheel();

		// Mouse drag rotates the view (orbit around current position)
		if ( controls_is_pointer_locked() ) {

			camera.rotateY( - mouse.x * 0.003 );
			camera.rotateX( - mouse.y * 0.003 );

		}

		// Scroll wheel zooms (move forward/backward along view direction)
		if ( wheel !== 0 ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( camera.quaternion );
			camera.position.addScaledVector( _forward, wheel * 0.15 );

		}

		// WASD pans the automap camera (reuse pre-allocated vectors — Golden Rule #5)
		const keys = controls_get_keys();
		const panSpeed = 80.0 * dt;

		_forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		_right.set( 1, 0, 0 ).applyQuaternion( camera.quaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( camera.quaternion );

		if ( keys[ 'KeyW' ] || keys[ 'ArrowUp' ] ) camera.position.addScaledVector( _forward, panSpeed );
		if ( keys[ 'KeyS' ] || keys[ 'ArrowDown' ] ) camera.position.addScaledVector( _forward, - panSpeed );
		if ( keys[ 'KeyA' ] || keys[ 'ArrowLeft' ] ) camera.position.addScaledVector( _right, - panSpeed );
		if ( keys[ 'KeyD' ] || keys[ 'ArrowRight' ] ) camera.position.addScaledVector( _right, panSpeed );
		if ( keys[ 'Space' ] ) camera.position.addScaledVector( _up, panSpeed );
		if ( keys[ 'ShiftLeft' ] || keys[ 'ShiftRight' ] ) camera.position.addScaledVector( _up, - panSpeed );

		// Extract forward/up for audio listener (keep audio positioned at player)
		_forward.set( 0, 0, - 1 ).applyQuaternion( _savedCameraQuat );
		_up.set( 0, 1, 0 ).applyQuaternion( _savedCameraQuat );
		return;

	}

	if ( playerDead === true ) {

		// Still extract forward/up vectors for audio listener, but skip movement
		camera.getWorldDirection( _forward );
		_up.set( 0, 1, 0 ).applyQuaternion( camera.quaternion );
		return;

	}

	// Consume wheel delta to prevent it building up during gameplay
	controls_consume_wheel();

	// --- Rotational physics (ported from do_physics_sim_rot) ---

	// Compute rotational thrust from input
	let rotThrust_x = 0, rotThrust_y = 0, rotThrust_z = 0;

	// Mouse look → rotational thrust (when pointer locked)
	const mouse = controls_consume_mouse();

	if ( controls_is_pointer_locked() ) {

		// Mouse movement maps to rotational thrust (pitch + yaw)
		// Scale: mouseSpeed converts pixels to a normalized input, then scale by max_rotthrust
		rotThrust_y = - mouse.x * mouseSpeed * PLAYER_MAX_ROTTHRUST * 8.0;
		rotThrust_x = - mouse.y * mouseSpeed * PLAYER_MAX_ROTTHRUST * 8.0;

	}

	const keys = controls_get_keys();

	// Keyboard roll (Q/E)
	if ( keys[ 'KeyQ' ] ) rotThrust_z += PLAYER_MAX_ROTTHRUST;
	if ( keys[ 'KeyE' ] ) rotThrust_z -= PLAYER_MAX_ROTTHRUST;

	// Apply rotational drag + thrust (ported from do_physics_sim_rot in PHYSICS.C)
	const playerRotVel = do_physics_sim_rot( rotThrust_x, rotThrust_y, rotThrust_z, dt );

	// Turn banking: un-apply old bank, apply rotation, re-apply new bank
	// Ported from: PHYSICS.C lines 516-546 — unrotate for bank, rotate, re-apply bank
	const oldTurnroll = getTurnroll();
	camera.rotateZ( - oldTurnroll );

	// Apply actual rotation from player input
	camera.rotateY( playerRotVel.y * dt );
	camera.rotateX( playerRotVel.x * dt );
	camera.rotateZ( playerRotVel.z * dt );

	// Compute new turn banking angle and re-apply
	set_object_turnroll( dt );
	camera.rotateZ( getTurnroll() );

	// Auto-level the ship toward world-up (ported from PHYSICS.C line 1049)
	// PF_LEVELLING gradually rotates the ship back to upright when not actively rolling
	do_physics_align_object( camera, dt );

	// --- Linear physics (ported from do_physics_sim + read_flying_controls) ---

	// Get camera local axes (Three.js space)
	_forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
	_right.set( 1, 0, 0 ).applyQuaternion( camera.quaternion );
	_up.set( 0, 1, 0 ).applyQuaternion( camera.quaternion );

	// Compute thrust in Descent coordinates (negate Z from Three.js)
	// Ported from read_flying_controls: thrust = fvec*forward + rvec*side + uvec*vert
	// When key is fully held, thrust magnitude = max_thrust along that axis
	let thrust_x = 0, thrust_y = 0, thrust_z = 0;

	// Forward vector in Descent coords
	const fwd_dx = _forward.x, fwd_dy = _forward.y, fwd_dz = - _forward.z;
	const rgt_dx = _right.x, rgt_dy = _right.y, rgt_dz = - _right.z;
	const up_dx = _up.x, up_dy = _up.y, up_dz = - _up.z;

	// Store fire direction for weapon firing (parallel to forward vector)
	_fireDir.x = fwd_dx;
	_fireDir.y = fwd_dy;
	_fireDir.z = fwd_dz;

	// Cruise control: R to increase, T to decrease cruise speed
	// Ported from: KCONFIG.C lines 2064-2080 — "stupid-cruise-control-type of throttle"
	if ( keys[ 'KeyR' ] ) {

		Cruise_speed += 200 * dt;	// ramp up at ~200%/sec
		if ( Cruise_speed > 100 ) Cruise_speed = 100;

	}

	if ( keys[ 'KeyT' ] ) {

		Cruise_speed -= 200 * dt;	// ramp down at ~200%/sec
		if ( Cruise_speed < 0 ) Cruise_speed = 0;

	}

	// WASD = thrust along ship axes
	const forwardPressed = ( keys[ 'KeyW' ] || keys[ 'ArrowUp' ] );
	const backwardPressed = ( keys[ 'KeyS' ] || keys[ 'ArrowDown' ] );

	if ( forwardPressed ) {

		thrust_x += fwd_dx * PLAYER_MAX_THRUST;
		thrust_y += fwd_dy * PLAYER_MAX_THRUST;
		thrust_z += fwd_dz * PLAYER_MAX_THRUST;

	}

	if ( backwardPressed ) {

		thrust_x -= fwd_dx * PLAYER_MAX_THRUST;
		thrust_y -= fwd_dy * PLAYER_MAX_THRUST;
		thrust_z -= fwd_dz * PLAYER_MAX_THRUST;

	}

	// Apply cruise control forward thrust when W/S not pressed
	// Ported from: KCONFIG.C line 2079 — if (Controls.forward_thrust_time==0) apply cruise
	if ( forwardPressed !== true && backwardPressed !== true && Cruise_speed > 0 ) {

		const cruiseFrac = Cruise_speed / 100.0;
		thrust_x += fwd_dx * PLAYER_MAX_THRUST * cruiseFrac;
		thrust_y += fwd_dy * PLAYER_MAX_THRUST * cruiseFrac;
		thrust_z += fwd_dz * PLAYER_MAX_THRUST * cruiseFrac;

	}

	if ( keys[ 'KeyA' ] || keys[ 'ArrowLeft' ] ) {

		thrust_x -= rgt_dx * PLAYER_MAX_THRUST;
		thrust_y -= rgt_dy * PLAYER_MAX_THRUST;
		thrust_z -= rgt_dz * PLAYER_MAX_THRUST;

	}

	if ( keys[ 'KeyD' ] || keys[ 'ArrowRight' ] ) {

		thrust_x += rgt_dx * PLAYER_MAX_THRUST;
		thrust_y += rgt_dy * PLAYER_MAX_THRUST;
		thrust_z += rgt_dz * PLAYER_MAX_THRUST;

	}

	if ( keys[ 'Space' ] ) {

		thrust_x += up_dx * PLAYER_MAX_THRUST;
		thrust_y += up_dy * PLAYER_MAX_THRUST;
		thrust_z += up_dz * PLAYER_MAX_THRUST;

	}

	if ( keys[ 'ShiftLeft' ] || keys[ 'ShiftRight' ] ) {

		thrust_x -= up_dx * PLAYER_MAX_THRUST;
		thrust_y -= up_dy * PLAYER_MAX_THRUST;
		thrust_z -= up_dz * PLAYER_MAX_THRUST;

	}

	// Linear physics simulation (ported from do_physics_sim in PHYSICS.C)
	const frame = do_physics_sim( thrust_x, thrust_y, thrust_z, up_dx, up_dy, up_dz, dt );

	// Apply movement with FVI-based collision detection
	const p0_x = camera.position.x;
	const p0_y = camera.position.y;
	const p0_z = - camera.position.z;

	const moveResult = do_physics_move( p0_x, p0_y, p0_z, frame.x, frame.y, frame.z, playerSegnum, dt );

	// Apply result: convert back to Three.js coordinates
	camera.position.x = moveResult.x;
	camera.position.y = moveResult.y;
	camera.position.z = - moveResult.z;
	playerSegnum = moveResult.segnum;

	// Mark current segment as visited for automap
	// Ported from: RENDER.C line 981 — Automap_visited[segnum] = 1
	if ( playerSegnum >= 0 ) {

		Automap_visited[ playerSegnum ] = 1;

	}

}

// Pre-allocated vectors for gun point rotation (Golden Rule #5)
const _gunPt = new THREE.Vector3();

// Compute gun position in Descent world coordinates
// gun_num indexes into Player_gun_points
// Returns position via _gunResult (pre-allocated)
const _gunResult = { x: 0, y: 0, z: 0 };

function getGunWorldPos( gun_num ) {

	const gun = Player_gun_points[ gun_num ];

	// Rotate gun point from ship-local (Descent) to world via camera quaternion
	// Gun coords are Descent (X=right, Y=up, Z=forward), convert Z for Three.js
	_gunPt.set( gun.x, gun.y, - gun.z );
	_gunPt.applyQuaternion( camera.quaternion );

	// Add to camera position, convert result to Descent coords
	_gunResult.x = camera.position.x + _gunPt.x;
	_gunResult.y = camera.position.y + _gunPt.y;
	_gunResult.z = - ( camera.position.z + _gunPt.z );

	return _gunResult;

}

// Process weapon firing (called each frame from game loop)
// Ported from: LASER.C do_laser_firing() + Laser_player_fire_spread_delay()
// Fires parallel bolts along the player's forward vector, matching original Descent.
function processWeapons() {

	if ( playerDead === true ) return;
	if ( camera === null ) return;

	// --- Fusion cannon charge mechanic ---
	// Ported from: GAME.C lines 4048-4112
	if ( Primary_weapon === FUSION_INDEX ) {

		processFusionCharge();
		return;

	}

	// Reset fusion charge if not using fusion
	if ( Fusion_charge > 0 ) {

		Fusion_charge = 0;
		Auto_fire_fusion_cannon_time = 0;

	}

	if ( controls_is_fire_down() !== true ) return;

	// Determine gun numbers based on weapon type (ported from do_laser_firing)
	// Laser: dual fire from guns 0,1
	// Plasma: dual fire from guns 0,1
	// Vulcan/Spreadfire: gun 6 (center)
	const isLaser = ( Primary_weapon === 0 );
	const isPlasma = ( Primary_weapon === 3 );
	const gun0 = ( isLaser || isPlasma ) ? 0 : 6;

	// Compute spawn position from gun point
	const gp0 = getGunWorldPos( gun0 );
	const spawnSeg = find_point_seg( gp0.x, gp0.y, gp0.z, playerSegnum );
	if ( spawnSeg === - 1 ) return;

	// Vulcan spread: apply random spread to fire direction
	// Ported from: LASER.C line 1146 — rand()/8 - 32767/16 in fixed-point
	// Converts to ±0.031 in float (spread along right and up vectors)
	let fire_x = _fireDir.x;
	let fire_y = _fireDir.y;
	let fire_z = _fireDir.z;

	if ( Primary_weapon === 1 ) {

		// Use _right and _up in Descent coordinates (negate Z from Three.js)
		const spreadR = ( Math.random() - 0.5 ) * 0.063;
		const spreadU = ( Math.random() - 0.5 ) * 0.063;
		fire_x += _right.x * spreadR + _up.x * spreadU;
		fire_y += _right.y * spreadR + _up.y * spreadU;
		fire_z += ( - _right.z ) * spreadR + ( - _up.z ) * spreadU;

	}

	// Quad laser check
	// Ported from: LASER.C do_laser_firing() — PLAYER_FLAGS_QUAD_LASERS fires 4 bolts with 0.75x damage
	const hasQuad = ( isLaser && _getPlayerQuadLasers !== null && _getPlayerQuadLasers() === true );
	const quadMultiplier = hasQuad ? 0.75 : 1.0;

	// Fire through laser.js (handles fire rate, weapon type, energy/ammo)
	// Parallel fire direction along player's forward vector (original Descent behavior)
	const fired = Laser_player_fire( fire_x, fire_y, fire_z, gp0.x, gp0.y, gp0.z, spawnSeg, GameTime, quadMultiplier );
	if ( fired === true ) {

		// Per-weapon fire sound from Weapon_info[].flash_sound
		// Use laser-level-aware weapon_info_index for correct sound
		const laserWiIndex = get_player_laser_weapon_info_index();
		const wi = Weapon_info[ laserWiIndex ];
		const fireSound = ( wi !== undefined && wi.flash_sound >= 0 ) ? wi.flash_sound : SOUND_LASER_FIRED;
		digi_play_sample( fireSound, 0.5 );

		// For laser and plasma, also fire from the second gun (gun 1) — dual fire
		// Ported from: LASER.C do_laser_firing() LASER_INDEX and PLASMA_INDEX cases
		if ( isLaser || isPlasma ) {

			const gp1 = getGunWorldPos( 1 );
			const seg1 = find_point_seg( gp1.x, gp1.y, gp1.z, playerSegnum );
			if ( seg1 !== - 1 ) {

				// Use laser-level-aware weapon_info_index
				Laser_create_new( _fireDir.x, _fireDir.y, _fireDir.z, gp1.x, gp1.y, gp1.z, seg1, PARENT_PLAYER, laserWiIndex, quadMultiplier );

			}

			// Quad lasers: fire 2 additional bolts from guns 2 and 3
			// Ported from: LASER.C do_laser_firing() lines 1127-1132
			if ( hasQuad ) {

				const gp2 = getGunWorldPos( 2 );
				const seg2 = find_point_seg( gp2.x, gp2.y, gp2.z, playerSegnum );
				if ( seg2 !== - 1 ) {

					Laser_create_new( _fireDir.x, _fireDir.y, _fireDir.z, gp2.x, gp2.y, gp2.z, seg2, PARENT_PLAYER, laserWiIndex, quadMultiplier );

				}

				const gp3 = getGunWorldPos( 3 );
				const seg3 = find_point_seg( gp3.x, gp3.y, gp3.z, playerSegnum );
				if ( seg3 !== - 1 ) {

					Laser_create_new( _fireDir.x, _fireDir.y, _fireDir.z, gp3.x, gp3.y, gp3.z, seg3, PARENT_PLAYER, laserWiIndex, quadMultiplier );

				}

			}

		}

		// Trigger muzzle flash (sprite + point light)
		if ( muzzleFlashLeft !== null ) {

			muzzleFlashLeft.material.opacity = 1.0;
			muzzleFlashRight.material.opacity = 1.0;
			muzzleFlashTimer = 0.06;

		}

	}

}

// Fusion cannon charge process
// Ported from: GAME.C lines 4048-4112
function processFusionCharge() {

	const dt = FrameTime;

	// Check if auto-fire is pending
	if ( Auto_fire_fusion_cannon_time > 0 ) {

		// If player switched away from fusion, cancel
		if ( Primary_weapon !== FUSION_INDEX ) {

			Auto_fire_fusion_cannon_time = 0;
			Fusion_charge = 0;
			return;

		}

		// Time to fire the charged shot
		if ( GameTime >= Auto_fire_fusion_cannon_time ) {

			fireFusionShot();
			Auto_fire_fusion_cannon_time = 0;
			return;

		}

		return;

	}

	// Not charging and button not pressed — nothing to do
	if ( controls_is_fire_down() !== true ) {

		// Button released while charging — fire!
		if ( Fusion_charge > 0 ) {

			fireFusionShot();

		}

		return;

	}

	// --- Button is held: accumulate charge ---
	if ( _getPlayerEnergy === null || _setPlayerEnergy === null ) return;

	const energy = _getPlayerEnergy();

	// Need at least 2.0 energy to start charging
	if ( energy < 2.0 && Fusion_charge === 0 ) return;

	// Initial energy cost on first frame of charge
	if ( Fusion_charge === 0 ) {

		_setPlayerEnergy( energy - 2.0 );

	}

	// Increment charge
	Fusion_charge += dt;

	// Continuous energy drain while charging
	const newEnergy = _getPlayerEnergy() - dt * 4.0;
	_setPlayerEnergy( Math.max( newEnergy, 0 ) );
	if ( _updateHUD !== null ) _updateHUD();

	// Auto-fire when out of energy
	if ( _getPlayerEnergy() <= 0 ) {

		_setPlayerEnergy( 0 );
		Auto_fire_fusion_cannon_time = GameTime;	// fire immediately next frame

	}

	// Visual feedback: screen flash
	// Purple while charging (< 2.0), yellow when fully charged (>= 2.0)
	if ( _flashDamage !== null ) _flashDamage();

	// Sound feedback
	// Ported from: GAME.C lines 4072-4085
	if ( GameTime >= Fusion_next_sound_time ) {

		if ( Fusion_charge > 2.0 ) {

			// Fully charged: explosion sound + self-damage
			digi_play_sample( SOUND_WEAPON_HIT_BLASTABLE, 0.8 );

			if ( _applyPlayerDamage !== null ) {

				_applyPlayerDamage( Math.random() * 2.0 );

			}

		} else {

			// Charging: warmup sound
			digi_play_sample( SOUND_FUSION_WARMUP, 0.8 );

		}

		Fusion_next_sound_time = GameTime + 0.125 + Math.random() * 0.25;

	}

}

// Fire the fusion shot with charge multiplier
// Ported from: LASER.C do_laser_firing() FUSION_INDEX case, lines 1177-1200
function fireFusionShot() {

	if ( camera === null ) return;

	// Fire from both gun points (0 and 1)
	const gp0 = getGunWorldPos( 0 );
	const seg0 = find_point_seg( gp0.x, gp0.y, gp0.z, playerSegnum );
	if ( seg0 === - 1 ) { Fusion_charge = 0; return; }

	const weapon_info_index = Primary_weapon_to_weapon_info[ FUSION_INDEX ];

	// Calculate damage multiplier based on charge level
	// Ported from: LASER.C lines 253-275
	// multiplier = 1.0 + charge/2, capped at 4.0 (single player)
	let multiplier = 1.0;
	if ( Fusion_charge > 0 ) {

		multiplier = 1.0 + Fusion_charge / 2;
		if ( multiplier > 4.0 ) multiplier = 4.0;

	}

	// First bolt (parallel fire direction)
	Laser_create_new( _fireDir.x, _fireDir.y, _fireDir.z, gp0.x, gp0.y, gp0.z, seg0, PARENT_PLAYER, weapon_info_index, multiplier );

	// Second bolt from gun 1
	const gp1 = getGunWorldPos( 1 );
	const seg1 = find_point_seg( gp1.x, gp1.y, gp1.z, playerSegnum );
	if ( seg1 !== - 1 ) {

		Laser_create_new( _fireDir.x, _fireDir.y, _fireDir.z, gp1.x, gp1.y, gp1.z, seg1, PARENT_PLAYER, weapon_info_index, multiplier );

	}

	// Per-weapon fire sound for fusion
	const fusionWi = Weapon_info[ weapon_info_index ];
	const fusionFireSound = ( fusionWi !== undefined && fusionWi.flash_sound >= 0 ) ? fusionWi.flash_sound : SOUND_LASER_FIRED;
	digi_play_sample( fusionFireSound, 0.7 );

	// Trigger muzzle flash (sprite + point light)
	if ( muzzleFlashLeft !== null ) {

		muzzleFlashLeft.material.opacity = 1.0;
		muzzleFlashRight.material.opacity = 1.0;
		muzzleFlashTimer = 0.06;

	}

	// Fusion recoil: push player backward with random tumble (same as mega missile)
	// Ported from: LASER.C do_laser_firing() FUSION_INDEX case, lines 1189-1200
	phys_apply_force_to_player( - _fireDir.x * 128.0, - _fireDir.y * 128.0, - _fireDir.z * 128.0 );
	phys_apply_rot(
		- _fireDir.x * 8.0 + ( Math.random() - 0.5 ) * 0.5,
		- _fireDir.y * 8.0 + ( Math.random() - 0.5 ) * 0.5,
		- _fireDir.z * 8.0 + ( Math.random() - 0.5 ) * 0.5
	);

	// Reset charge
	Fusion_charge = 0;
	Fusion_next_sound_time = 0;

}

// Process secondary weapon firing (missiles)
// Ported from: LASER.C do_missile_firing() — gun point selection
function processSecondaryWeapons() {

	if ( playerDead === true ) return;
	if ( controls_is_secondary_fire_down() !== true ) return;
	if ( camera === null ) return;

	controls_set_secondary_fire_down( false );	// Single-shot per click

	// Gun selection per secondary weapon type (ported from do_missile_firing)
	// Concussion/Homing: alternate guns 4,5; Proximity/Smart/Mega: gun 7
	let gun_num = 7;

	if ( Secondary_weapon === 0 || Secondary_weapon === 1 ) {

		// Concussion or Homing: alternate between guns 4 and 5
		gun_num = 4 + ( Missile_gun & 1 );
		Missile_gun ++;

	}

	const gp = getGunWorldPos( gun_num );
	const spawnSeg = find_point_seg( gp.x, gp.y, gp.z, playerSegnum );
	if ( spawnSeg === - 1 ) return;

	// Parallel fire direction along player's forward vector
	const fired = Laser_player_fire_secondary( _fireDir.x, _fireDir.y, _fireDir.z, gp.x, gp.y, gp.z, spawnSeg, GameTime );
	if ( fired === true ) {

		// Per-weapon fire sound from Weapon_info[].flash_sound
		const secWi = Weapon_info[ Secondary_weapon_to_weapon_info[ Secondary_weapon ] ];
		const secFireSound = ( secWi !== undefined && secWi.flash_sound >= 0 ) ? secWi.flash_sound : SOUND_LASER_FIRED;
		digi_play_sample( secFireSound, 0.6 );

	}

}

// Handle key actions (weapon selection, automap toggle)
// Called by controls.js onKeyDown callback
function handleKeyAction( e ) {

	// Weapon selection: 1-5 for primary weapons
	// waitForRearm=true adds 1s delay before firing (ported from select_weapon in WEAPON.C)
	{

		let primaryResult = null;
		if ( e.code === 'Digit1' ) primaryResult = set_primary_weapon( 0, true );
		if ( e.code === 'Digit2' ) primaryResult = set_primary_weapon( 1, true );
		if ( e.code === 'Digit3' ) primaryResult = set_primary_weapon( 2, true );
		if ( e.code === 'Digit4' ) primaryResult = set_primary_weapon( 3, true );
		if ( e.code === 'Digit5' ) primaryResult = set_primary_weapon( 4, true );

		if ( primaryResult === WEAPON_SELECT_CHANGED ) digi_play_sample( SOUND_GOOD_SELECTION_PRIMARY, 0.7 );
		else if ( primaryResult === WEAPON_SELECT_ALREADY ) digi_play_sample( SOUND_ALREADY_SELECTED, 0.7 );
		else if ( primaryResult === WEAPON_SELECT_UNAVAILABLE ) digi_play_sample( SOUND_BAD_SELECTION, 0.7 );

	}

	// Secondary weapon selection: 6-0 for secondary weapons
	{

		let secondaryResult = null;
		if ( e.code === 'Digit6' ) secondaryResult = set_secondary_weapon( 0, true );
		if ( e.code === 'Digit7' ) secondaryResult = set_secondary_weapon( 1, true );
		if ( e.code === 'Digit8' ) secondaryResult = set_secondary_weapon( 2, true );
		if ( e.code === 'Digit9' ) secondaryResult = set_secondary_weapon( 3, true );
		if ( e.code === 'Digit0' ) secondaryResult = set_secondary_weapon( 4, true );

		if ( secondaryResult === WEAPON_SELECT_CHANGED ) digi_play_sample( SOUND_GOOD_SELECTION_SECONDARY, 0.7 );
		else if ( secondaryResult === WEAPON_SELECT_ALREADY ) digi_play_sample( SOUND_ALREADY_SELECTED, 0.7 );
		else if ( secondaryResult === WEAPON_SELECT_UNAVAILABLE ) digi_play_sample( SOUND_BAD_SELECTION, 0.7 );

	}

	// F key to fire flare
	// Ported from: Flare_create() in LASER.C lines 857-887
	if ( e.code === 'KeyF' && playerDead !== true && camera !== null ) {

		// Fire from gun 6 (center gun)
		const gp = getGunWorldPos( 6 );
		const spawnSeg = find_point_seg( gp.x, gp.y, gp.z, playerSegnum );

		if ( spawnSeg !== - 1 ) {

			const fired = Flare_create( _fireDir.x, _fireDir.y, _fireDir.z, gp.x, gp.y, gp.z, spawnSeg );
			if ( fired === true ) {

				digi_play_sample( SOUND_LASER_FIRED, 0.4 );

			}

		}

	}

	// Tab to toggle automap
	if ( e.code === 'Tab' ) {

		e.preventDefault();
		toggleAutomap();

	}

	// F3 to cycle cockpit modes (full cockpit → full screen → full cockpit)
	// Ported from: toggle_cockpit() in GAME.C lines 772-801
	if ( e.code === 'F3' ) {

		e.preventDefault();

		if ( Rear_view !== true && isAutomap !== true ) {

			if ( Cockpit_mode === CM_FULL_COCKPIT ) {

				Cockpit_mode = CM_FULL_SCREEN;

			} else {

				Cockpit_mode = CM_FULL_COCKPIT;

			}

			if ( _onCockpitModeChanged !== null ) {

				_onCockpitModeChanged( Cockpit_mode );

			}

		}

	}

	// Backspace to reset cruise speed
	// Ported from: KCONFIG.C lines 2075-2078 — cruise off key
	if ( e.code === 'Backspace' ) {

		Cruise_speed = 0;

	}

	// H to toggle rear view
	// Ported from: GAME.C lines 2517-2558 rear view handling
	if ( e.code === 'KeyH' ) {

		if ( playerDead !== true && isAutomap !== true ) {

			if ( Rear_view !== true ) {

				// Enter rear view
				old_cockpit_mode = Cockpit_mode;
				Cockpit_mode = CM_REAR_VIEW;
				Rear_view = true;

			} else {

				// Exit rear view
				Cockpit_mode = old_cockpit_mode;
				Rear_view = false;

			}

			if ( _onCockpitModeChanged !== null ) {

				_onCockpitModeChanged( Cockpit_mode );

			}

		}

	}

	// P or Escape to toggle pause
	// Ported from: GAME.C — game pause functionality
	if ( e.code === 'KeyP' || e.code === 'Escape' ) {

		e.preventDefault();
		togglePause();

	}

}

export function getRenderer() { return renderer; }
export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getAmbientLight() { return null; }
export function setPlayerSegnum( s ) { playerSegnum = s; }
export function getPlayerSegnum() { return playerSegnum; }

// Get player position in Descent coordinates (negate Z from Three.js)
// Pre-allocated result object (Golden Rule #5: no allocations in render loop)
const _playerPos = { x: 0, y: 0, z: 0 };

export function getPlayerPos() {

	if ( camera === null ) return _playerPos;

	_playerPos.x = camera.position.x;
	_playerPos.y = camera.position.y;
	_playerPos.z = - camera.position.z;

	return _playerPos;

}

// --- Automap ---

export function game_set_automap( group ) {

	// Reset automap, pause, and cockpit mode on level change
	isAutomap = false;
	isPaused = false;
	Cockpit_mode = CM_FULL_COCKPIT;
	Rear_view = false;
	if ( pauseOverlay !== null ) pauseOverlay.style.display = 'none';

	if ( automapGroup !== null && scene !== null ) {

		scene.remove( automapGroup );

	}

	automapGroup = group;

	if ( automapGroup !== null && scene !== null ) {

		automapGroup.visible = false;
		scene.add( automapGroup );

	}

	// Ensure mine + gun are visible
	if ( mineGroup !== null ) mineGroup.visible = true;
	if ( gunGroup !== null ) gunGroup.visible = true;

}

export function getIsAutomap() { return isAutomap; }


function togglePause() {

	isPaused = ! isPaused;

	if ( isPaused === true ) {

		// Show pause overlay with menu
		if ( pauseOverlay === null ) {

			pauseOverlay = document.createElement( 'div' );
			pauseOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:150;background:rgba(0,0,0,0.6);';

			const title = document.createElement( 'div' );
			title.textContent = 'PAUSED';
			title.style.cssText = 'color:#00ff00;font-family:monospace;font-size:48px;font-weight:bold;text-shadow:2px 2px 4px #000;margin-bottom:40px;';
			pauseOverlay.appendChild( title );

			const btnStyle = 'color:#00ff00;font-family:monospace;font-size:24px;font-weight:bold;background:none;border:2px solid #00ff00;padding:10px 40px;margin:8px;cursor:pointer;text-shadow:1px 1px 2px #000;';
			const btnHover = 'background:rgba(0,255,0,0.15);';

			const resumeBtn = document.createElement( 'button' );
			resumeBtn.textContent = 'RESUME (ESC)';
			resumeBtn.style.cssText = btnStyle;
			resumeBtn.onmouseenter = function () { resumeBtn.style.cssText = btnStyle + btnHover; };
			resumeBtn.onmouseleave = function () { resumeBtn.style.cssText = btnStyle; };
			resumeBtn.onclick = function () { togglePause(); };
			pauseOverlay.appendChild( resumeBtn );

			const saveBtn = document.createElement( 'button' );
			saveBtn.textContent = 'SAVE GAME';
			saveBtn.style.cssText = btnStyle;
			saveBtn.onmouseenter = function () { saveBtn.style.cssText = btnStyle + btnHover; };
			saveBtn.onmouseleave = function () { saveBtn.style.cssText = btnStyle; };
			saveBtn.onclick = function () {

				if ( _onSaveGame !== null ) {

					const result = _onSaveGame();
					saveBtn.textContent = result === true ? 'GAME SAVED!' : 'SAVE FAILED';
					setTimeout( function () { saveBtn.textContent = 'SAVE GAME'; }, 2000 );

				}

			};
			pauseOverlay.appendChild( saveBtn );

			const loadBtn = document.createElement( 'button' );
			loadBtn.textContent = 'LOAD GAME';
			loadBtn.style.cssText = btnStyle;
			loadBtn.onmouseenter = function () { loadBtn.style.cssText = btnStyle + btnHover; };
			loadBtn.onmouseleave = function () { loadBtn.style.cssText = btnStyle; };
			loadBtn.onclick = function () {

				if ( _onLoadGame !== null ) {

					const result = _onLoadGame();
					if ( result !== true ) {

						loadBtn.textContent = 'NO SAVE FOUND';
						setTimeout( function () { loadBtn.textContent = 'LOAD GAME'; }, 2000 );

					} else {

						isPaused = false;
						pauseOverlay.style.display = 'none';
						lastTime = 0;

					}

				}

			};
			pauseOverlay.appendChild( loadBtn );

			const quitBtn = document.createElement( 'button' );
			quitBtn.textContent = 'QUIT TO MENU';
			quitBtn.style.cssText = btnStyle;
			quitBtn.onmouseenter = function () { quitBtn.style.cssText = btnStyle + btnHover; };
			quitBtn.onmouseleave = function () { quitBtn.style.cssText = btnStyle; };
			quitBtn.onclick = function () {

				isPaused = false;
				pauseOverlay.style.display = 'none';
				if ( _onQuitToMenu !== null ) _onQuitToMenu();

			};
			pauseOverlay.appendChild( quitBtn );

			document.body.appendChild( pauseOverlay );

		}

		pauseOverlay.style.display = 'flex';

		// Release pointer lock so mouse can click buttons
		if ( document.pointerLockElement !== null ) {

			document.exitPointerLock();

		}

	} else {

		// Hide pause overlay
		if ( pauseOverlay !== null ) {

			pauseOverlay.style.display = 'none';

		}

		// Reset lastTime to avoid large dt on unpause
		lastTime = 0;

	}

}

export function game_set_quit_callback( cb ) {

	_onQuitToMenu = cb;

}

export function game_set_cockpit_mode_callback( cb ) {

	_onCockpitModeChanged = cb;

}

export function game_set_save_callback( cb ) {

	_onSaveGame = cb;

}

export function game_set_load_callback( cb ) {

	_onLoadGame = cb;

}

function toggleAutomap() {

	if ( automapGroup === null ) return;
	if ( camera === null ) return;

	isAutomap = ! isAutomap;

	if ( isAutomap === true ) {

		// Save camera state
		_savedCameraPos.copy( camera.position );
		_savedCameraQuat.copy( camera.quaternion );

		// Rebuild automap to show only visited segments
		// Ported from: AUTOMAP.C — rebuild each toggle to reflect current visited state
		const oldGroup = automapGroup;
		automapGroup = buildAutomapGeometry();
		automapGroup.visible = true;
		scene.add( automapGroup );

		if ( oldGroup !== null ) {

			scene.remove( oldGroup );
			oldGroup.traverse( ( child ) => {

				if ( child.geometry !== undefined ) child.geometry.dispose();
				if ( child.material !== undefined ) child.material.dispose();

			} );

		}

		// Hide textured mine
		if ( mineGroup !== null ) mineGroup.visible = false;

		// Hide gun model in automap
		if ( gunGroup !== null ) gunGroup.visible = false;

		// Add player position marker
		if ( playerMarker === null ) {

			playerMarker = new THREE.Sprite( new THREE.SpriteMaterial( {
				color: 0x00ff00,
				depthTest: false
			} ) );

		}

		playerMarker.position.copy( _savedCameraPos );
		playerMarker.scale.set( 3, 3, 1 );
		playerMarker.visible = true;
		scene.add( playerMarker );

	} else {

		// Restore camera
		camera.position.copy( _savedCameraPos );
		camera.quaternion.copy( _savedCameraQuat );

		// Hide automap, show mine
		automapGroup.visible = false;
		if ( mineGroup !== null ) mineGroup.visible = true;

		// Show gun model
		if ( gunGroup !== null ) gunGroup.visible = true;

		// Hide player marker
		if ( playerMarker !== null ) {

			playerMarker.visible = false;
			scene.remove( playerMarker );

		}

	}

}

// --- First-person weapon model ---

function createGunModel() {

	if ( camera === null ) return;

	gunGroup = new THREE.Group();

	// Gun body (flattened box — ship nose)
	const bodyGeometry = new THREE.BoxGeometry( 0.6, 0.06, 0.4 );
	const bodyMat = new THREE.MeshBasicMaterial( { color: 0x555566 } );
	const body = new THREE.Mesh( bodyGeometry, bodyMat );
	body.position.set( 0, - 0.22, - 0.9 );
	gunGroup.add( body );

	// Two gun barrels — wider apart to match the side-fire feel of the original
	const barrelGeometry = new THREE.CylinderGeometry( 0.025, 0.03, 0.6, 6 );
	barrelGeometry.rotateX( Math.PI / 2 );

	const barrelMat = new THREE.MeshBasicMaterial( { color: 0x777788 } );

	const leftBarrel = new THREE.Mesh( barrelGeometry, barrelMat );
	leftBarrel.position.set( - 0.45, - 0.18, - 1.0 );
	gunGroup.add( leftBarrel );

	const rightBarrel = new THREE.Mesh( barrelGeometry, barrelMat );
	rightBarrel.position.set( 0.45, - 0.18, - 1.0 );
	gunGroup.add( rightBarrel );

	// Muzzle flash sprites (initially invisible)
	const flashMatL = new THREE.SpriteMaterial( {
		color: 0xff6600,
		transparent: true,
		opacity: 0,
		blending: THREE.AdditiveBlending
	} );

	muzzleFlashLeft = new THREE.Sprite( flashMatL );
	muzzleFlashLeft.scale.set( 0.15, 0.15, 1 );
	muzzleFlashLeft.position.set( - 0.45, - 0.18, - 1.35 );
	gunGroup.add( muzzleFlashLeft );

	const flashMatR = new THREE.SpriteMaterial( {
		color: 0xff6600,
		transparent: true,
		opacity: 0,
		blending: THREE.AdditiveBlending
	} );

	muzzleFlashRight = new THREE.Sprite( flashMatR );
	muzzleFlashRight.scale.set( 0.15, 0.15, 1 );
	muzzleFlashRight.position.set( 0.45, - 0.18, - 1.35 );
	gunGroup.add( muzzleFlashRight );

	camera.add( gunGroup );

}
