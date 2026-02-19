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
import { automap_enter, automap_exit, automap_frame, automap_set_externals, automap_reset, getIsAutomap } from './automap.js';
import { updateMineVisibility } from './render.js';
import { lighting_add_muzzle_flash } from './lighting.js';
import { controls_init, controls_set_resize_refs, controls_set_key_action_callback,
	controls_get_keys, controls_consume_mouse, controls_consume_wheel, controls_is_pointer_locked,
	controls_is_fire_down, controls_is_secondary_fire_down, controls_set_secondary_fire_down } from './controls.js';
import { PLAYER_MASS, PLAYER_DRAG, PLAYER_MAX_THRUST, PLAYER_MAX_ROTTHRUST, PLAYER_WIGGLE, PLAYER_RADIUS,
	do_physics_sim_rot, do_physics_sim, do_physics_move, physics_reset,
	set_object_turnroll, getTurnroll, phys_apply_force_to_player, phys_apply_rot,
	do_physics_align_object } from './physics.js';
import { gauges_get_canvas_ctx, gauges_mark_dirty, gauges_needs_upload, gauges_get_hud_scene, gauges_get_hud_camera } from './gauges.js';
import { gr_string } from './font.js';
import { NORMAL_FONT, CURRENT_FONT, SUBTITLE_FONT, GAME_FONT } from './gamefont.js';
import { config_get_invert_mouse_y, config_set_invert_mouse_y,
	config_get_texture_filtering, config_set_texture_filtering } from './config.js';

const GAME_ASPECT = 320 / 200;
const COCKPIT_WINDOW_ASPECT = 320 / 140;

let renderer = null;
let scene = null;
let camera = null;
let mineGroup = null;

let lastTime = 0;

// Pause state
let isPaused = false;
let _onQuitToMenu = null;	// callback for quit to main menu
let _onCockpitModeChanged = null;	// callback when cockpit mode changes (F3/H)
let _onSaveGame = null;		// callback for save game
let _onLoadGame = null;		// callback for load game

// Pause menu canvas resources
let _gamePalette = null;
let _pauseCanvas = null;
let _pauseCtx = null;
let _pauseWrapper = null;
let _pauseSelectedIndex = 0;
let _pauseStatusText = null;	// temporary status message ("GAME SAVED!", etc.)
let _pauseStatusTimer = 0;
let _pauseState = 'menu';	// 'menu' or 'settings'
let _settingsSelectedIndex = 0;
let _settingsItemYPositions = [];

const PAUSE_W = 320;
const PAUSE_H = 200;

const PAUSE_MENU_ITEMS = [
	{ label: 'RESUME', id: 'resume' },
	{ label: 'SAVE GAME', id: 'save' },
	{ label: 'LOAD GAME', id: 'load' },
	{ label: 'SETTINGS', id: 'settings' },
	{ label: 'QUIT TO MENU', id: 'quit' },
];

let _pauseItemYPositions = []; // { y, h } for each item in 320x200 space

export function game_set_palette( palette ) {

	_gamePalette = palette;

}

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

// Initialize the Three.js renderer and scene
export function game_init() {

	// Renderer
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	let w, h;

	if ( vw / vh > GAME_ASPECT ) {

		h = vh;
		w = Math.floor( vh * GAME_ASPECT );

	} else {

		w = vw;
		h = Math.floor( vw / GAME_ASPECT );

	}

	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setSize( w, h );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setClearColor( 0x000000 );
	renderer.domElement.style.position = 'absolute';
	renderer.domElement.style.left = '50%';
	renderer.domElement.style.top = '50%';
	renderer.domElement.style.transform = 'translate(-50%, -50%)';
	document.body.appendChild( renderer.domElement );

	// Scene
	scene = new THREE.Scene();

	// Camera
	camera = new THREE.PerspectiveCamera(
		90,
		GAME_ASPECT,
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

	scene.add( camera );

	// Input handling (ported from CONTROLS.C)
	controls_init( renderer.domElement );
	controls_set_resize_refs( camera, renderer );
	controls_set_key_action_callback( handleKeyAction );

	// Pause when pointer lock is lost during gameplay
	// (browser consumes Escape key to exit pointer lock, so keydown may not fire)
	document.addEventListener( 'pointerlockchange', () => {

		if ( document.pointerLockElement === null && isPaused !== true && getIsAutomap() !== true ) {

			isPaused = true;
			showPauseMenu();

		}

	} );

	// Wire up automap externals
	automap_set_externals( { scene: scene, camera: camera } );

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

	// Update automap with new mine group reference
	automap_set_externals( { mineGroup: mineGroup } );

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
		renderFrame();
		return;

	}

	// Update free-fly camera
	updateCamera( dt );

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

	// Update portal visibility before frame callback (needed by dynamic lighting)
	updateMineVisibility( playerSegnum, camera );

	// Frame callback (powerup collection, reactor check, dynamic lighting, etc.)
	if ( _frameCallback !== null ) {

		_frameCallback( dt );

	}

	// Draw cruise speed on HUD when active
	// Ported from: GAME.C lines 1530-1546 — show "CRUISE XX%" when speed > 0
	drawCruiseSpeed();

	// Render scene + HUD overlay with cockpit viewport clipping
	renderFrame();

}

// Pre-allocated vectors for camera update (Golden Rule #5: no allocations in render loop)
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

// Pre-allocated quaternion for rear view 180° Y rotation (Golden Rule #5)
const _rearViewQuat = new THREE.Quaternion();
_rearViewQuat.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), Math.PI );
const _savedRenderQuat = new THREE.Quaternion();

// Pre-allocated for renderer size queries (Golden Rule #5)
const _rendererSize = new THREE.Vector2();

// Two-pass render: 3D scene + HUD overlay
// Ported from: RENDER.C render_frame() — cockpit window viewport clipping
function renderFrame() {

	const hudScene = gauges_get_hud_scene();
	const hudCamera = gauges_get_hud_camera();

	const isRear = ( Rear_view === true && camera !== null );
	const isAutomap = ( getIsAutomap() === true );
	const useCockpitViewport = ( ( Cockpit_mode === CM_FULL_COCKPIT || Cockpit_mode === CM_REAR_VIEW ) && isAutomap !== true );

	// Rear view: rotate camera 180°
	if ( isRear ) {

		_savedRenderQuat.copy( camera.quaternion );
		camera.quaternion.multiply( _rearViewQuat );

	}

	if ( useCockpitViewport ) {

		// Two-pass: 3D in cockpit window, then full-screen HUD overlay
		renderer.getSize( _rendererSize );
		const rw = _rendererSize.x;
		const rh = _rendererSize.y;

		renderer.autoClear = false;
		renderer.clear();

		// Scissor to top 70% of viewport (cockpit window area)
		const scissorY = Math.floor( rh * 0.3 );
		const scissorH = rh - scissorY;

		renderer.setScissorTest( true );
		renderer.setScissor( 0, scissorY, rw, scissorH );
		renderer.setViewport( 0, scissorY, rw, scissorH );
		camera.aspect = COCKPIT_WINDOW_ASPECT;
		camera.updateProjectionMatrix();

		renderer.render( scene, camera );

		// Full viewport for HUD overlay
		renderer.setScissorTest( false );
		renderer.setViewport( 0, 0, rw, rh );

		if ( hudScene !== null && hudCamera !== null ) {

			renderer.render( hudScene, hudCamera );

		}

		renderer.autoClear = true;

	} else {

		// Full screen or automap: standard single-pass render
		camera.aspect = GAME_ASPECT;
		camera.updateProjectionMatrix();

		renderer.render( scene, camera );

		// HUD overlay (skip during automap)
		if ( isAutomap !== true && hudScene !== null && hudCamera !== null ) {

			renderer.autoClear = false;
			renderer.render( hudScene, hudCamera );
			renderer.autoClear = true;

		}

	}

	// Restore rear view
	if ( isRear ) {

		camera.quaternion.copy( _savedRenderQuat );

	}

}

// --- Ported from: CONTROLS.C read_flying_controls() + PHYSICS.C do_physics_sim() ---

function updateCamera( dt ) {

	if ( camera === null ) return;

	// --- Automap camera: delegated to automap.js ---
	if ( getIsAutomap() === true ) {

		const mouse = controls_consume_mouse();
		const wheel = controls_consume_wheel();
		const keys = controls_get_keys();
		const fireDown = controls_is_fire_down();

		automap_frame( dt, mouse, wheel, keys, controls_is_pointer_locked(), fireDown );

		// Extract forward/up for audio listener (keep audio positioned at player)
		// Use camera's current orientation (set by automap_frame)
		_forward.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( camera.quaternion );
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
		const invertY = config_get_invert_mouse_y() === true ? 1.0 : - 1.0;
		rotThrust_x = invertY * mouse.y * mouseSpeed * PLAYER_MAX_ROTTHRUST * 8.0;

	}

	const keys = controls_get_keys();
	const manualRollActive = ( keys[ 'KeyQ' ] === true || keys[ 'KeyE' ] === true );

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

	// Auto-level the ship toward current segment orientation (ported from PHYSICS.C line 1049).
	// Manual roll input (Q/E) takes precedence so auto-level doesn't counter-steer in the same frame.
	if ( manualRollActive !== true ) {

		do_physics_align_object( camera, playerSegnum, dt );

	}

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

		lighting_add_muzzle_flash( gp0.x, gp0.y, gp0.z, spawnSeg );

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

	lighting_add_muzzle_flash( gp0.x, gp0.y, gp0.z, seg0 );

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

	// When paused, only handle pause-related keys
	if ( isPaused === true ) {

		// Settings sub-screen has its own key handling
		if ( _pauseState === 'settings' ) {

			e.preventDefault();

			if ( e.key === 'Escape' ) {

				_pauseState = 'menu';
				renderPauseMenu();

			} else if ( e.key === 'ArrowUp' ) {

				_settingsSelectedIndex --;
				if ( _settingsSelectedIndex < 0 ) _settingsSelectedIndex = PAUSE_SETTINGS_ITEMS.length - 1;
				renderPauseMenu();

			} else if ( e.key === 'ArrowDown' ) {

				_settingsSelectedIndex ++;
				if ( _settingsSelectedIndex >= PAUSE_SETTINGS_ITEMS.length ) _settingsSelectedIndex = 0;
				renderPauseMenu();

			} else if ( e.key === 'Enter' ) {

				togglePauseSetting( PAUSE_SETTINGS_ITEMS[ _settingsSelectedIndex ].id );
				renderPauseMenu();

			}

			return;

		}

		if ( e.code === 'KeyP' || e.code === 'Escape' ) {

			e.preventDefault();
			// Escape/P while paused: do nothing — user must click RESUME
			return;

		}

		if ( e.key === 'ArrowUp' ) {

			e.preventDefault();
			_pauseSelectedIndex --;
			if ( _pauseSelectedIndex < 0 ) _pauseSelectedIndex = PAUSE_MENU_ITEMS.length - 1;
			renderPauseMenu();

		} else if ( e.key === 'ArrowDown' ) {

			e.preventDefault();
			_pauseSelectedIndex ++;
			if ( _pauseSelectedIndex >= PAUSE_MENU_ITEMS.length ) _pauseSelectedIndex = 0;
			renderPauseMenu();

		} else if ( e.key === 'Enter' ) {

			e.preventDefault();
			onPauseMenuSelect( _pauseSelectedIndex );

		}

		return;

	}

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

		if ( Rear_view !== true && getIsAutomap() !== true ) {

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

		if ( playerDead !== true && getIsAutomap() !== true ) {

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

	// P or Escape to open pause menu
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

export function game_set_automap() {

	// Reset automap, pause, and cockpit mode on level change
	automap_reset();
	isPaused = false;
	Cockpit_mode = CM_FULL_COCKPIT;
	Rear_view = false;
	hidePauseMenu();

	// Ensure mine is visible
	if ( mineGroup !== null ) mineGroup.visible = true;

}

export { getIsAutomap };


// --- Pause menu canvas rendering ---
// Uses bitmap fonts like menu.js, drawn onto a 320x200 canvas overlay

function ensurePauseCanvas() {

	if ( _pauseCanvas !== null ) return;

	// Wrapper div fills viewport with semi-transparent background
	_pauseWrapper = document.createElement( 'div' );
	_pauseWrapper.id = 'pause-wrapper';
	_pauseWrapper.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:150;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;cursor:default;';

	_pauseCanvas = document.createElement( 'canvas' );
	_pauseCanvas.width = PAUSE_W;
	_pauseCanvas.height = PAUSE_H;
	_pauseCanvas.style.cssText = 'image-rendering:pixelated;';
	_pauseCtx = _pauseCanvas.getContext( '2d', { willReadFrequently: true } );

	_pauseWrapper.appendChild( _pauseCanvas );
	document.body.appendChild( _pauseWrapper );

	// Mouse events on the wrapper
	_pauseWrapper.addEventListener( 'mousemove', onPauseMouseMove );
	_pauseWrapper.addEventListener( 'click', onPauseMouseClick );

	// Resize handler to maintain aspect ratio
	resizePauseCanvas();
	window.addEventListener( 'resize', resizePauseCanvas );

}

function resizePauseCanvas() {

	if ( _pauseCanvas === null ) return;

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const aspect = PAUSE_W / PAUSE_H; // 1.6

	let w, h;

	if ( vw / vh > aspect ) {

		h = vh;
		w = Math.floor( vh * aspect );

	} else {

		w = vw;
		h = Math.floor( vw / aspect );

	}

	_pauseCanvas.style.width = w + 'px';
	_pauseCanvas.style.height = h + 'px';

}

function renderPauseMenu() {

	if ( _pauseCtx === null ) return;

	if ( _pauseState === 'settings' ) {

		renderPauseSettings();
		return;

	}

	const normalFont = NORMAL_FONT();
	const currentFont = CURRENT_FONT();
	const subtitleFont = SUBTITLE_FONT();

	// Clear canvas to transparent (wrapper provides the dark background)
	_pauseCtx.clearRect( 0, 0, PAUSE_W, PAUSE_H );
	const imageData = _pauseCtx.createImageData( PAUSE_W, PAUSE_H );

	_pauseItemYPositions = [];

	if ( normalFont === null || currentFont === null ) return;

	// Draw "PAUSED" title using subtitle font (or normal font fallback)
	const titleFont = subtitleFont !== null ? subtitleFont : normalFont;
	const titleY = 60;
	gr_string( imageData, titleFont, 0x8000, titleY, 'PAUSED', _gamePalette );

	// Draw menu items below the title
	const itemHeight = normalFont.ft_h + 4;
	const itemsStartY = titleY + titleFont.ft_h + 16;

	for ( let i = 0; i < PAUSE_MENU_ITEMS.length; i ++ ) {

		let label = PAUSE_MENU_ITEMS[ i ].label;

		// Override label with status text for save/load feedback
		if ( _pauseStatusText !== null ) {

			if ( PAUSE_MENU_ITEMS[ i ].id === 'save' && _pauseStatusText === 'GAME SAVED!' ) {

				label = _pauseStatusText;

			} else if ( PAUSE_MENU_ITEMS[ i ].id === 'save' && _pauseStatusText === 'SAVE FAILED' ) {

				label = _pauseStatusText;

			} else if ( PAUSE_MENU_ITEMS[ i ].id === 'load' && _pauseStatusText === 'NO SAVE FOUND' ) {

				label = _pauseStatusText;

			}

		}

		const isSelected = ( i === _pauseSelectedIndex );
		const font = isSelected ? currentFont : normalFont;

		const y = itemsStartY + i * itemHeight;
		_pauseItemYPositions.push( { y: y, h: itemHeight } );

		gr_string( imageData, font, 0x8000, y, label, _gamePalette );

	}

	_pauseCtx.putImageData( imageData, 0, 0 );

}

// --- Pause settings sub-screen ---

const PAUSE_SETTINGS_ITEMS = [
	{ label: 'INVERT MOUSE', id: 'invert_mouse' },
	{ label: 'TEXTURE FILTERING', id: 'texture_filtering' },
];

function getPauseSettingValue( id ) {

	if ( id === 'invert_mouse' ) {

		return config_get_invert_mouse_y() === true ? 'YES' : 'NO';

	}

	if ( id === 'texture_filtering' ) {

		return config_get_texture_filtering() === 'linear' ? 'ON' : 'OFF';

	}

	return '';

}

function togglePauseSetting( id ) {

	if ( id === 'invert_mouse' ) {

		config_set_invert_mouse_y( config_get_invert_mouse_y() !== true );

	}

	if ( id === 'texture_filtering' ) {

		config_set_texture_filtering(
			config_get_texture_filtering() === 'linear' ? 'nearest' : 'linear'
		);

	}

}

function renderPauseSettings() {

	if ( _pauseCtx === null ) return;

	const normalFont = NORMAL_FONT();
	const currentFont = CURRENT_FONT();
	const subtitleFont = SUBTITLE_FONT();
	const smallFont = GAME_FONT();

	_pauseCtx.clearRect( 0, 0, PAUSE_W, PAUSE_H );
	const imageData = _pauseCtx.createImageData( PAUSE_W, PAUSE_H );

	_settingsItemYPositions = [];

	if ( normalFont === null || currentFont === null ) return;

	const titleFont = subtitleFont !== null ? subtitleFont : normalFont;
	const titleY = 60;
	gr_string( imageData, titleFont, 0x8000, titleY, 'SETTINGS', _gamePalette );

	const itemHeight = normalFont.ft_h + 4;
	const itemsStartY = titleY + titleFont.ft_h + 16;

	for ( let i = 0; i < PAUSE_SETTINGS_ITEMS.length; i ++ ) {

		const item = PAUSE_SETTINGS_ITEMS[ i ];
		const isSelected = ( i === _settingsSelectedIndex );
		const font = isSelected ? currentFont : normalFont;

		const y = itemsStartY + i * itemHeight;
		_settingsItemYPositions.push( { y: y, h: itemHeight } );

		const text = item.label + ': ' + getPauseSettingValue( item.id );
		gr_string( imageData, font, 0x8000, y, text, _gamePalette );

	}

	if ( smallFont !== null ) {

		const hintY = itemsStartY + PAUSE_SETTINGS_ITEMS.length * itemHeight + 10;
		gr_string( imageData, smallFont, 0x8000, hintY, 'ENTER TO TOGGLE  ESC TO BACK', _gamePalette );

	}

	_pauseCtx.putImageData( imageData, 0, 0 );

}

// Convert viewport mouse coordinates to 320x200 canvas space
function pauseViewportTo320x200( clientX, clientY ) {

	const rect = _pauseCanvas.getBoundingClientRect();
	const x = ( clientX - rect.left ) / rect.width * PAUSE_W;
	const y = ( clientY - rect.top ) / rect.height * PAUSE_H;
	return { x: Math.floor( x ), y: Math.floor( y ) };

}

function findPauseItemAtY( y200 ) {

	for ( let i = 0; i < _pauseItemYPositions.length; i ++ ) {

		const item = _pauseItemYPositions[ i ];

		if ( y200 >= item.y && y200 < item.y + item.h ) {

			return i;

		}

	}

	return - 1;

}

function findSettingsItemAtY( y200 ) {

	for ( let i = 0; i < _settingsItemYPositions.length; i ++ ) {

		const item = _settingsItemYPositions[ i ];

		if ( y200 >= item.y && y200 < item.y + item.h ) {

			return i;

		}

	}

	return - 1;

}

function onPauseMouseMove( e ) {

	if ( _pauseCanvas === null ) return;

	const pos = pauseViewportTo320x200( e.clientX, e.clientY );

	if ( _pauseState === 'settings' ) {

		const idx = findSettingsItemAtY( pos.y );

		if ( idx !== - 1 && idx !== _settingsSelectedIndex ) {

			_settingsSelectedIndex = idx;
			renderPauseMenu();

		}

		return;

	}

	const idx = findPauseItemAtY( pos.y );

	if ( idx !== - 1 && idx !== _pauseSelectedIndex ) {

		_pauseSelectedIndex = idx;
		renderPauseMenu();

	}

}

function onPauseMouseClick( e ) {

	if ( _pauseCanvas === null ) return;

	const pos = pauseViewportTo320x200( e.clientX, e.clientY );

	if ( _pauseState === 'settings' ) {

		const idx = findSettingsItemAtY( pos.y );

		if ( idx !== - 1 ) {

			_settingsSelectedIndex = idx;
			togglePauseSetting( PAUSE_SETTINGS_ITEMS[ idx ].id );
			renderPauseMenu();

		}

		return;

	}

	const idx = findPauseItemAtY( pos.y );

	if ( idx === - 1 ) return;

	_pauseSelectedIndex = idx;
	onPauseMenuSelect( idx );

}

function onPauseMenuSelect( idx ) {

	const id = PAUSE_MENU_ITEMS[ idx ].id;

	if ( id === 'resume' ) {

		resumeGame();

	} else if ( id === 'save' ) {

		if ( _onSaveGame !== null ) {

			const result = _onSaveGame();
			_pauseStatusText = result === true ? 'GAME SAVED!' : 'SAVE FAILED';
			renderPauseMenu();
			clearTimeout( _pauseStatusTimer );
			_pauseStatusTimer = setTimeout( function () {

				_pauseStatusText = null;
				renderPauseMenu();

			}, 2000 );

		}

	} else if ( id === 'load' ) {

		if ( _onLoadGame !== null ) {

			const result = _onLoadGame();

			if ( result !== true ) {

				_pauseStatusText = 'NO SAVE FOUND';
				renderPauseMenu();
				clearTimeout( _pauseStatusTimer );
				_pauseStatusTimer = setTimeout( function () {

					_pauseStatusText = null;
					renderPauseMenu();

				}, 2000 );

			} else {

				isPaused = false;
				hidePauseMenu();
				lastTime = 0;

			}

		}

	} else if ( id === 'settings' ) {

		_pauseState = 'settings';
		_settingsSelectedIndex = 0;
		renderPauseMenu();

	} else if ( id === 'quit' ) {

		isPaused = false;
		hidePauseMenu();
		if ( _onQuitToMenu !== null ) _onQuitToMenu();

	}

}

function showPauseMenu() {

	ensurePauseCanvas();
	_pauseSelectedIndex = 0;
	_pauseState = 'menu';
	_pauseStatusText = null;
	clearTimeout( _pauseStatusTimer );
	renderPauseMenu();
	_pauseWrapper.style.display = 'flex';

}

function hidePauseMenu() {

	if ( _pauseWrapper !== null ) {

		_pauseWrapper.style.display = 'none';

	}

}

function resumeGame() {

	isPaused = false;
	hidePauseMenu();
	lastTime = 0;

	// Re-lock pointer for gameplay
	if ( renderer !== null ) {

		renderer.domElement.requestPointerLock();

	}

}

function togglePause() {

	if ( isPaused === true ) {

		// Escape while paused: do nothing (user must click RESUME)
		return;

	}

	isPaused = true;
	showPauseMenu();

	// Release pointer lock so mouse can interact with menu
	if ( document.pointerLockElement !== null ) {

		document.exitPointerLock();

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

	if ( camera === null ) return;

	if ( getIsAutomap() !== true ) {

		automap_enter();

	} else {

		automap_exit();

	}

}

