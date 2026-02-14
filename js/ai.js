// Ported from: descent-master/MAIN/AI.C
// Robot AI: awareness, rotation, firing, movement

import { find_point_seg, compute_center_point_on_side, compute_segment_center } from './gameseg.js';
import { find_vector_intersection, HIT_NONE, HIT_WALL, HIT_BAD_P0 } from './fvi.js';
import { Laser_create_new, PARENT_ROBOT, PROXIMITY_ID, laser_get_weapon } from './laser.js';
import { object_create_explosion } from './fireball.js';
import { Weapon_info } from './weapon.js';
import { digi_play_sample_3d, SOUND_LASER_FIRED, SOUND_BOSS_SHARE_SEE, SOUND_BOSS_SHARE_DIE } from './digi.js';
import { Robot_info, N_robot_types,
	N_ANIM_STATES, AS_REST, AS_ALERT, AS_FIRE, AS_RECOIL, AS_FLINCH,
	AIS_NONE, AIS_REST, AIS_SRCH, AIS_LOCK, AIS_FLIN, AIS_FIRE, AIS_RECO, AIS_ERR_,
	Mike_to_matt_xlate, ANIM_RATE, Flinch_scale, Attack_scale } from './bm.js';
import { Segments, Num_segments, Walls, GameTime } from './mglobal.js';
import { IS_CHILD, MAX_SIDES_PER_SEGMENT } from './segment.js';
import { wall_open_door, wall_is_doorway, WID_FLY_FLAG, WALL_DOOR, WALL_DOOR_CLOSED, WALL_DOOR_LOCKED, KEY_NONE } from './wall.js';
import { create_path_to_player, create_path_to_station, create_n_segment_path,
	ai_follow_path, check_line_of_sight, aipath_reset,
	aipath_set_externals, aipath_set_frame_count } from './aipath.js';
import { Polygon_models, polyobj_calc_gun_points } from './polyobj.js';

// ------- Gun point calculation -------
// Ported from: calc_gun_point() in ROBOT.C lines 169-213
// Computes world-space gun position for a robot given its model, orientation, and gun number

// Cache of model-local gun points per model_num (computed once, reused)
// Key: model_num, Value: array of { x, y, z } in model-local space
const _gunPointCache = {};

// Pre-allocated result object (Golden Rule #5)
const _gunPoint = { x: 0, y: 0, z: 0 };

// Get model-local gun points for a model (cached)
function get_model_gun_points( model_num ) {

	if ( _gunPointCache[ model_num ] !== undefined ) return _gunPointCache[ model_num ];

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined || model.n_guns === 0 ) return null;

	// polyobj_calc_gun_points transforms from submodel-local to model-local space
	const points = polyobj_calc_gun_points( model );
	_gunPointCache[ model_num ] = points;
	return points;

}

// Calculate world-space gun position for a robot
// Ported from: calc_gun_point() in ROBOT.C lines 169-213
// obj = robot object, gun_num = which gun (0-based)
// Returns _gunPoint (pre-allocated, overwritten each call)
function calc_gun_point( obj, gun_num ) {

	const model_num = ( obj.rtype !== null ) ? obj.rtype.model_num : - 1;
	if ( model_num < 0 ) {

		// Fallback: fire from center + forward offset
		const offset = ( obj.size !== undefined ? obj.size : 3.0 ) * 0.8;
		_gunPoint.x = obj.pos_x + obj.orient_fvec_x * offset;
		_gunPoint.y = obj.pos_y + obj.orient_fvec_y * offset;
		_gunPoint.z = obj.pos_z + obj.orient_fvec_z * offset;
		return _gunPoint;

	}

	const points = get_model_gun_points( model_num );
	if ( points === null || gun_num >= points.length ) {

		// Fallback
		const offset = ( obj.size !== undefined ? obj.size : 3.0 ) * 0.8;
		_gunPoint.x = obj.pos_x + obj.orient_fvec_x * offset;
		_gunPoint.y = obj.pos_y + obj.orient_fvec_y * offset;
		_gunPoint.z = obj.pos_z + obj.orient_fvec_z * offset;
		return _gunPoint;

	}

	// Get model-local gun point
	const gp = points[ gun_num ];

	// Transform by object orientation matrix (transposed = inverse rotation)
	// Ported from: vm_copy_transpose_matrix + vm_vec_rotate in ROBOT.C line 211
	// C code: m = transpose(obj->orient), then gun_point = m * pnt
	// transpose(orient) applied to pnt is the same as:
	//   result.x = rvec . pnt
	//   result.y = uvec . pnt
	//   result.z = fvec . pnt
	const wx = obj.orient_rvec_x * gp.x + obj.orient_uvec_x * gp.y + obj.orient_fvec_x * gp.z;
	const wy = obj.orient_rvec_y * gp.x + obj.orient_uvec_y * gp.y + obj.orient_fvec_y * gp.z;
	const wz = obj.orient_rvec_z * gp.x + obj.orient_uvec_z * gp.y + obj.orient_fvec_z * gp.z;

	// Add object position
	_gunPoint.x = obj.pos_x + wx;
	_gunPoint.y = obj.pos_y + wy;
	_gunPoint.z = obj.pos_z + wz;

	return _gunPoint;

}

// Reset gun point cache (call on level change)
// Get current Overall_agitation level (0-100)
// Ported from: AI.C line 350 — extern int Overall_agitation
export function ai_get_overall_agitation() {

	return Overall_agitation;

}

// Reset Overall_agitation to 0 (called on level start)
// Ported from: init_robots_for_level() in AI.C line 3768
export function ai_reset_overall_agitation() {

	Overall_agitation = 0;

}

export function ai_reset_gun_point_cache() {

	for ( const key in _gunPointCache ) {

		delete _gunPointCache[ key ];

	}

}

// Behavior constants (from AISTRUCT.H)
const AIB_STILL = 0x80;
const AIB_NORMAL = 0x81;
const AIB_HIDE = 0x82;
const AIB_RUN_FROM = 0x83;
const AIB_FOLLOW_PATH = 0x84;
const AIB_STATION = 0x85;

// Number of difficulty levels (from GAME.H)
const NDL = 5;

// Mode constants
const AIM_STILL = 0;
const AIM_CHASE_OBJECT = 3;
const AIM_RUN_FROM_OBJECT = 5;
const AIM_HIDE = 8;
const AIM_FOLLOW_PATH = 6;
const AIM_OPEN_DOOR = 7;

// AIM_HIDE submodes (stored in flags[4] / SUBMODE)
const AISM_GOHIDE = 0;
const AISM_HIDING = 1;

// Robot type constants (from AI.H)
const ROBOT_BRAIN = 7;

// Escape path length for run-from robots (AVOID_SEG_LENGTH in AIPATH.C)
const AVOID_SEG_LENGTH = 7;

// Boss robot constants (from AI.C lines 331-362)
const BOSS_CLOAK_DURATION = 7.0;		// F1_0*7
const BOSS_DEATH_DURATION = 6.0;		// F1_0*6
const BOSS_DEATH_SOUND_DURATION = 2.68;	// 0x2ae14 fix ≈ 2.68 seconds
const MAX_BOSS_TELEPORT_SEGS = 200;

// Boss state variables (from AI.C lines 339-365)
const Boss_teleport_segs = new Int16Array( MAX_BOSS_TELEPORT_SEGS );
let Num_boss_teleport_segs = 0;
const Boss_gate_segs = new Int16Array( MAX_BOSS_TELEPORT_SEGS );
let Num_boss_gate_segs = 0;
let Boss_cloak_start_time = 0;
let Boss_cloak_end_time = 0;
let Last_teleport_time = 0;
let Boss_teleport_interval = 8.0;	// F1_0*8
let Boss_cloak_interval = 10.0;		// F1_0*10
let Boss_dying = false;
let Boss_dying_start_time = 0;
let Boss_dying_sound_playing = false;
let Boss_hit_this_frame = false;
let Boss_cloaked = false;
let _bossRobot = null;	// Reference to the boss robot entry in liveRobots

// Boss gating state (from AI.C lines 361-362, 399-401)
let Last_gate_time = 0;
let Gate_interval = 6.0;	// F1_0*6, adjusted by difficulty in init_boss_segments

// Robot types the boss can gate in (from AI.C line 400)
// Ported from: Super_boss_gate_list[] — indices are robot type IDs
const Super_boss_gate_list = [ 0, 1, 8, 9, 10, 11, 12, 15, 16, 18, 19, 20, 22, 0, 8, 11, 19, 20, 8, 20, 8 ];

// Max gated robots = 2*difficulty + 3 (from AI.C line 2131)
const BOSS_GATE_MATCEN_NUM = - 1;	// from AI.H line 150
const BOSS_TO_PLAYER_GATE_DISTANCE = 150.0;	// F1_0*150

// Overall_agitation: increases when player fires/explodes, affects robot behavior
// Ported from: AI.C line 322, 350
// - Widens robot FOV by Overall_agitation/128
// - Increases path search distance by Overall_agitation/8 segments
// - When > 70, non-still robots spontaneously create paths to player
// Only increments (probabilistically) on awareness events, resets on level start
const OVERALL_AGITATION_MAX = 100;
let Overall_agitation = 0;

// Awareness type constants (from AISTRUCT.H)
const PA_NEARBY_ROBOT_FIRED = 1;
const PA_WEAPON_WALL_COLLISION = 2;
const PA_PLAYER_COLLISION = 3;
const PA_WEAPON_ROBOT_COLLISION = 4;
const PLAYER_AWARENESS_INITIAL_TIME = 3.0; // seconds (F1_0 * 3 in C)

// Ai_transition_table[event][current_state][goal_state] → new_goal_state
// Ported from: AI.C lines 486-534
// Events: AIE_FIRE=0, AIE_HITT=1, AIE_COLL=2, AIE_HURT=3
// States: AIS_NONE=0, AIS_REST=1, AIS_SRCH=2, AIS_LOCK=3, AIS_FLIN=4, AIS_FIRE=5, AIS_RECO=6
const E = AIS_ERR_, N = AIS_NONE, R = AIS_REST, S = AIS_SRCH, L = AIS_LOCK, F = AIS_FLIN, I = AIS_FIRE, C = AIS_RECO;

const Ai_transition_table = [
	// Event = AIE_FIRE, a nearby object fired
	// columns: none  rest  srch  lock  flin  fire  reco   (GOAL)
	[
		[ E, L, L, L, F, I, C ],	// current = none
		[ E, L, L, L, F, I, C ],	// current = rest
		[ E, L, L, L, F, I, C ],	// current = search
		[ E, L, L, L, F, I, C ],	// current = lock
		[ E, R, L, L, L, I, C ],	// current = flinch
		[ E, I, I, I, F, I, C ],	// current = fire
		[ E, L, L, L, F, I, I ],	// current = recoil
	],
	// Event = AIE_HITT, a nearby object was hit (or a wall was hit)
	[
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, L, F, F ],
		[ E, R, L, L, L, I, C ],
		[ E, L, L, L, F, I, I ],
	],
	// Event = AIE_COLL, player collided with robot
	[
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, F, I, C ],
		[ E, L, L, L, F, I, C ],
		[ E, F, F, F, L, F, F ],
		[ E, R, L, L, L, I, C ],
		[ E, L, L, L, F, I, I ],
	],
	// Event = AIE_HURT, player hurt robot (by firing at and hitting it)
	[
		[ E, F, F, F, F, F, F ],
		[ E, F, F, F, F, F, F ],
		[ E, F, F, F, F, F, F ],
		[ E, F, F, F, F, F, F ],
		[ E, F, F, F, F, F, F ],
		[ E, F, F, F, F, F, F ],
		[ E, F, F, F, F, F, F ],
	],
];

// Awareness event queue (from AI.C lines 3549-3593)
const MAX_AWARENESS_EVENTS = 64;
const Awareness_events = [];

for ( let i = 0; i < MAX_AWARENESS_EVENTS; i ++ ) {

	Awareness_events.push( { segnum: 0, pos_x: 0, pos_y: 0, pos_z: 0, type: 0 } );

}

let Num_awareness_events = 0;

// Ai_cloak_info: per-robot-slot tracking of believed player position when cloaked
// Ported from: AI.C lines 326-332 — ai_cloak_info struct and Ai_cloak_info[] array
// Each robot uses slot (robotIndex % MAX_AI_CLOAK_INFO)
// Position drifts randomly, simulating robots losing track of cloaked player
const MAX_AI_CLOAK_INFO = 8;
const Ai_cloak_info = [];

for ( let i = 0; i < MAX_AI_CLOAK_INFO; i ++ ) {

	Ai_cloak_info.push( { last_time: 0, last_x: 0, last_y: 0, last_z: 0 } );

}

// Initialize all cloak info slots to current player position
// Ported from: ai_do_cloak_stuff() in AI.C lines 3549-3560
// Called when player picks up cloak powerup
export function ai_do_cloak_stuff() {

	if ( _getPlayerPos === null ) return;
	const pp = _getPlayerPos();

	for ( let i = 0; i < MAX_AI_CLOAK_INFO; i ++ ) {

		Ai_cloak_info[ i ].last_time = GameTime;
		Ai_cloak_info[ i ].last_x = pp.x;
		Ai_cloak_info[ i ].last_y = pp.y;
		Ai_cloak_info[ i ].last_z = pp.z;

	}

}

// New_awareness array: one entry per segment, stores max awareness level
// Pre-allocated, reused each frame (Golden Rule #5)
const New_awareness = new Uint8Array( 1000 ); // max segments

// AI tuning
const AI_TURN_SCALE = 1;
const AWARENESS_DISTANCE = 120.0;	// how far robot can detect player
const FIRE_DOT_THRESHOLD = 0.875;	// 7/8 — robot must be nearly facing player to fire

// Frame counter for pseudo-random movement direction changes (ported from FrameCount in AI.C)
let FrameCount = 0;

// Get robot AI parameters for given robot type, indexed by difficulty level
// Returns an object with field_of_view, firing_wait, turn_time, max_speed, etc.
// Uses parsed Robot_info from bm.js ($ROBOT + $ROBOT_AI data)
// Pre-allocated result object (Golden Rule #5: no allocations in render loop)
const _robotParams = {
	field_of_view: 0.4,
	firing_wait: 3.0,
	turn_time: 1.0,
	max_speed: 15.0,
	fire_power: 1.0,
	shield: 1.0,
	circle_distance: 30.0,
	rapidfire_count: 0,
	evade_speed: 0,
	weapon_type: 0,
	attack_type: 0,
	see_sound: - 1,
	attack_sound: - 1,
	claw_sound: - 1,
	strength: 10.0,
	boss_flag: 0
};

function getRobotParams( robotId ) {

	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;

	if ( robotId < N_robot_types ) {

		const ri = Robot_info[ robotId ];
		_robotParams.field_of_view = ri.field_of_view[ d ];
		_robotParams.firing_wait = ri.firing_wait[ d ];
		_robotParams.turn_time = ri.turn_time[ d ];
		_robotParams.max_speed = ri.max_speed[ d ];
		_robotParams.fire_power = ri.fire_power[ d ];
		_robotParams.shield = ri.shield[ d ];
		_robotParams.circle_distance = ri.circle_distance[ d ];
		_robotParams.rapidfire_count = ri.rapidfire_count[ d ];
		_robotParams.evade_speed = ri.evade_speed[ d ];
		_robotParams.weapon_type = ri.weapon_type;
		_robotParams.attack_type = ri.attack_type;
		_robotParams.see_sound = ri.see_sound;
		_robotParams.attack_sound = ri.attack_sound;
		_robotParams.claw_sound = ri.claw_sound;
		_robotParams.strength = ri.strength;
		_robotParams.boss_flag = ri.boss_flag;

	}

	return _robotParams;

}

// AI local state for each robot (runtime, not saved to disk)
export class AILocalInfo {

	constructor() {

		this.mode = AIM_STILL;
		this.player_awareness_type = 0;
		this.player_awareness_time = 0;
		this.previous_visibility = 0;
		this.next_fire = 0;
		this.rapidfire_count = 0;
		this.time_player_seen = 0;

		// Velocity (Descent coordinates) — ported from physics_info.velocity in AI.C
		this.vel_x = 0;
		this.vel_y = 0;
		this.vel_z = 0;

		// Pathfinding state (from ai_static in AISTRUCT.H)
		this.hide_index = - 1;		// index into Point_segs[]
		this.path_length = 0;		// number of waypoints
		this.cur_path_index = 0;	// current waypoint index
		this.PATH_DIR = 1;			// +1 forward, -1 backward
		this.goal_segment = - 1;	// target segment
		this.path_regen_timer = 0;	// cooldown before regenerating path
		this.bump_cooldown = 0;		// cooldown timer for bump collision
		this.current_gun = 0;		// which gun to fire from next (cycles through n_guns)
		this.hide_segment = - 1;	// home segment for AIB_STATION robots (from ai_static)
		this.behavior = AIB_NORMAL;	// behavior type (from ai_static)
		this.mode_is_run_from = false;	// true when in AIM_RUN_FROM_OBJECT mode (for path following)
		this.submode = AISM_HIDING;	// submode for AIM_HIDE (AISM_GOHIDE or AISM_HIDING)
		this.needs_new_path = false;	// set by ai_follow_path when path ends and needs regeneration

		// Rotational velocity for random turning (from phys_info.rotvel in AISTRUCT.H)
		this.rotvel_x = 0;
		this.rotvel_y = 0;
		this.rotvel_z = 0;

		// Door opening: which side to open (from ai_static.GOALSIDE)
		// Ported from: AI.C line 3054 — aip->GOALSIDE = r
		this.goal_side = - 1;
		this.prev_mode = AIM_STILL;	// mode to restore after door opens

		// Wall-hit retry tracking for stuck robot detection
		// Ported from: ai_local.retry_count / consecutive_retries in AI.C lines 2835-2887
		this.consecutive_retries = 0;

		// Proximity bomb dropping timer for run-from robots
		// Ported from: AI.C lines 3207-3222
		this.bomb_drop_timer = 5.0 + Math.random() * 5.0;

		// Danger laser tracking for evasion (from AISTRUCT.H: danger_laser_num, danger_laser_signature)
		// Ported from: set_robot_location_info() in OBJECT.C lines 742-759
		this.danger_laser_idx = - 1;	// index into weapon pool (-1 = no danger)
		this.danger_laser_id = - 1;		// unique ID to validate weapon still exists

		// Animation state tracking (from AISTRUCT.H: GOAL_STATE, CURRENT_STATE)
		this.goal_state = AIS_NONE;
		this.current_state = AIS_NONE;

		// Per-submodel animation angles and rates (from AISTRUCT.H ai_local)
		this.goal_angles = [];
		this.delta_angles = [];

		for ( let i = 0; i < MAX_SUBMODELS_AI; i ++ ) {

			this.goal_angles.push( { p: 0, b: 0, h: 0 } );
			this.delta_angles.push( { p: 0, b: 0, h: 0 } );

		}

		// Per-gun animation state tracking
		this.anim_achieved_state = new Uint8Array( MAX_SUBMODELS_AI );
		this.anim_goal_state = new Uint8Array( MAX_SUBMODELS_AI );

	}

}

const MAX_SUBMODELS_AI = 10;

// Player size for melee distance check (matches PLAYER_RADIUS in game.js)
const PLAYER_SIZE = 2.5;

// External references
let _getPlayerPos = null;	// () => { x, y, z } in Descent coords
let _getPlayerVelocity = null;	// () => { x, y, z } in Descent coords
let _getPlayerSeg = null;	// () => segnum
let _robots = null;			// liveRobots array
let _getDifficultyLevel = null;	// () => int (0-4)
let _getPlayerDead = null;		// () => bool
let _isPlayerCloaked = null;	// () => bool
let _onMeleeAttack = null;		// ( damage, claw_sound, pos_x, pos_y, pos_z ) => void
let _onBumpPlayer = null;		// ( robot, vel_x, vel_y, vel_z, mass ) => void
let _onBossDeath = null;		// ( robot ) => void — called when boss death sequence completes
let _onCreateExplosion = null;	// ( x, y, z, size ) => void — create explosion effect
let _onSpawnGatedRobot = null;	// ( segnum, robotType, pos_x, pos_y, pos_z ) => robot — spawn gated robot
let _dt = 0;

// Bump collision cooldown per robot (prevent rapid re-bumping)
const BUMP_COOLDOWN = 0.5;	// seconds between bump events
const ROBOT_BUMP_COOLDOWN = 0.25;	// seconds between robot-robot bump events

// Set external references
export function ai_set_externals( ext ) {

	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.getPlayerVelocity !== undefined ) _getPlayerVelocity = ext.getPlayerVelocity;
	if ( ext.getPlayerSeg !== undefined ) _getPlayerSeg = ext.getPlayerSeg;
	if ( ext.robots !== undefined ) _robots = ext.robots;
	if ( ext.getDifficultyLevel !== undefined ) _getDifficultyLevel = ext.getDifficultyLevel;
	if ( ext.getPlayerDead !== undefined ) _getPlayerDead = ext.getPlayerDead;
	if ( ext.isPlayerCloaked !== undefined ) _isPlayerCloaked = ext.isPlayerCloaked;
	if ( ext.onMeleeAttack !== undefined ) _onMeleeAttack = ext.onMeleeAttack;
	if ( ext.onBumpPlayer !== undefined ) _onBumpPlayer = ext.onBumpPlayer;
	if ( ext.onBossDeath !== undefined ) _onBossDeath = ext.onBossDeath;
	if ( ext.onCreateExplosion !== undefined ) _onCreateExplosion = ext.onCreateExplosion;
	if ( ext.onSpawnGatedRobot !== undefined ) _onSpawnGatedRobot = ext.onSpawnGatedRobot;

	// Pass robots reference to aipath for garbage collection
	if ( ext.robots !== undefined ) aipath_set_externals( { robots: ext.robots } );

}

// Initialize AI for level — create ai_local data for each robot
// Ported from: init_robots_for_level() in AI.C line 3766-3769
export function init_robots_for_level() {

	if ( _robots === null ) return;

	// Reset overall agitation for new level
	// Ported from: AI.C line 3768
	Overall_agitation = 0;

	// Reset cloak tracking info
	for ( let c = 0; c < MAX_AI_CLOAK_INFO; c ++ ) {

		Ai_cloak_info[ c ].last_time = 0;
		Ai_cloak_info[ c ].last_x = 0;
		Ai_cloak_info[ c ].last_y = 0;
		Ai_cloak_info[ c ].last_z = 0;

	}

	// Reset pathfinding storage
	aipath_reset();

	for ( let i = 0; i < _robots.length; i ++ ) {

		const robot = _robots[ i ];

		// Create ai_local state (skip if already has one — matcen spawned robots)
		if ( robot.aiLocal === undefined ) {

			robot.aiLocal = new AILocalInfo();

		}

		// Set initial mode and behavior based on object's ctype (from level file)
		// Ported from: init_ai_object() in AI.C lines 610-676
		const ctype = robot.obj.ctype;
		const behavior = ( ctype !== null ) ? ctype.behavior : AIB_NORMAL;
		robot.aiLocal.behavior = behavior;

		// Store hide_segment for station/hide/follow_path/run_from behaviors
		// Ported from: AI.C line 647-650 — these behaviors use hide_segment from level data
		if ( behavior === AIB_STATION || behavior === AIB_HIDE ||
			behavior === AIB_FOLLOW_PATH || behavior === AIB_RUN_FROM ) {

			const hs = ( ctype !== null && ctype.hide_segment !== undefined ) ? ctype.hide_segment : - 1;
			robot.aiLocal.hide_segment = hs;
			robot.aiLocal.goal_segment = hs;

		}

		// Set initial mode from behavior (ported from ai_behavior_to_mode in AI.C lines 585-599)
		if ( behavior === AIB_STILL || behavior === AIB_STATION ) {

			robot.aiLocal.mode = AIM_STILL;

		} else if ( behavior === AIB_FOLLOW_PATH ) {

			robot.aiLocal.mode = AIM_FOLLOW_PATH;

		} else if ( behavior === AIB_RUN_FROM ) {

			robot.aiLocal.mode = AIM_RUN_FROM_OBJECT;
			robot.aiLocal.mode_is_run_from = true;

		} else if ( behavior === AIB_HIDE ) {

			robot.aiLocal.mode = AIM_HIDE;
			robot.aiLocal.submode = AISM_HIDING;

		} else if ( behavior === AIB_NORMAL ) {

			robot.aiLocal.mode = AIM_CHASE_OBJECT; // Ported from: ai_behavior_to_mode() in AI.C

		} else if ( robot.aiLocal.mode !== AIM_CHASE_OBJECT ) {

			robot.aiLocal.mode = AIM_STILL;

		}

		// Randomize initial fire timer so not all robots fire at once
		const params = getRobotParams( robot.obj.id );
		if ( robot.aiLocal.next_fire <= 0 ) {

			robot.aiLocal.next_fire = Math.random() * params.firing_wait;

		}

	}

	// Initialize boss teleport segments (from AI.C init_ai_objects lines 709-721)
	init_boss_segments();

}

// Called when a robot is hit by a weapon — immediately become fully aware
// Ported from: do_ai_robot_hit() in AI.C lines 1792-1806
export function ai_do_robot_hit( robotIndex ) {

	if ( _robots === null ) return;
	const robot = _robots[ robotIndex ];
	if ( robot === undefined || robot.alive !== true ) return;

	const ailp = robot.aiLocal;
	if ( ailp === undefined ) return;

	ailp.player_awareness_type = PA_WEAPON_ROBOT_COLLISION;
	ailp.player_awareness_time = PLAYER_AWARENESS_INITIAL_TIME;

	// Hiding robots find a new hiding spot instead of chasing
	// Ported from: AI.C line 1798 — case AIM_HIDE: SUBMODE = AISM_GOHIDE
	if ( ailp.behavior === AIB_HIDE ) {

		ailp.mode = AIM_HIDE;
		ailp.submode = AISM_GOHIDE;

	} else {

		ailp.mode = AIM_CHASE_OBJECT;

	}

	// Trigger flinch animation
	ailp.goal_state = AIS_FLIN;

}

// Set Boss_hit_this_frame flag (called from collide.js when boss is hit by weapon)
// Ported from: COLLIDE.C line 1279-1280
export function ai_set_boss_hit() {

	Boss_hit_this_frame = true;

}

// ---------------------------------------------------------------
// Danger laser notification — called when player fires a weapon
// Sets danger_laser on robots that are near the player's aim direction
// Ported from: set_robot_location_info() in OBJECT.C lines 742-759
// In the C code, this checks if the robot is near the center of the screen.
// We simplify: check dot product of (aim dir, dir-to-robot) > threshold.
export function ai_notify_player_fired_laser( weaponIdx, dir_x, dir_y, dir_z ) {

	if ( _robots === null ) return;
	if ( _getPlayerPos === null ) return;

	const pp = _getPlayerPos();
	const px = pp.x;
	const py = pp.y;
	const pz = pp.z;

	// Normalize fire direction (should already be normalized, but be safe)
	const dmag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
	if ( dmag < 0.001 ) return;
	const ndx = dir_x / dmag;
	const ndy = dir_y / dmag;
	const ndz = dir_z / dmag;

	// C code checks: abs(screen_x) < F1_0*4 && abs(screen_y) < F1_0*4
	// This roughly corresponds to a cone around the aim direction
	// We use dot > 0.9 (~25 degree half-angle) as equivalent
	const AIM_DOT_THRESHOLD = 0.9;

	for ( let i = 0; i < _robots.length; i ++ ) {

		const robot = _robots[ i ];
		if ( robot.alive !== true ) continue;
		if ( robot.aiLocal === undefined ) continue;

		// Direction from player to robot
		const rx = robot.obj.pos_x - px;
		const ry = robot.obj.pos_y - py;
		const rz = robot.obj.pos_z - pz;
		const rdist = Math.sqrt( rx * rx + ry * ry + rz * rz );
		if ( rdist < 1.0 ) continue;	// too close

		const dot = ( rx * ndx + ry * ndy + rz * ndz ) / rdist;

		if ( dot > AIM_DOT_THRESHOLD ) {

			// Robot is near the aim direction — assign danger laser
			robot.aiLocal.danger_laser_idx = weaponIdx;
			robot.aiLocal.danger_laser_id = weaponIdx;	// used as a simple identifier

		}

	}

}

// ---------------------------------------------------------------
// Boss robot behavior
// Ported from: AI.C lines 2271-2528
// ---------------------------------------------------------------

// BFS to find segments the boss can teleport to
// Ported from: init_boss_segments() in AI.C lines 2271-2355
function init_boss_segments() {

	Num_boss_teleport_segs = 0;
	_bossRobot = null;

	if ( _robots === null ) return;

	// Find the boss robot
	for ( let i = 0; i < _robots.length; i ++ ) {

		const robot = _robots[ i ];
		if ( robot.alive !== true ) continue;
		const rtype = robot.obj.id;
		if ( rtype >= 0 && rtype < N_robot_types && Robot_info[ rtype ].boss_flag > 0 ) {

			_bossRobot = robot;
			break;

		}

	}

	if ( _bossRobot === null ) return;

	const startSeg = _bossRobot.obj.segnum;
	if ( startSeg < 0 || startSeg >= Num_segments ) return;

	// BFS through connected segments (QUEUE_SIZE=256 from AI.C line 2263)
	const QUEUE_SIZE = 256;
	const queue = new Int32Array( QUEUE_SIZE );
	const visited = new Uint8Array( Num_segments );
	let head = 0;
	let tail = 0;

	queue[ head ++ ] = startSeg;
	visited[ startSeg ] = 1;
	Boss_teleport_segs[ Num_boss_teleport_segs ++ ] = startSeg;

	while ( tail !== head ) {

		const curSeg = queue[ tail ++ ];
		tail &= ( QUEUE_SIZE - 1 );

		const seg = Segments[ curSeg ];

		for ( let side = 0; side < MAX_SIDES_PER_SEGMENT; side ++ ) {

			const child = seg.children[ side ];
			if ( IS_CHILD( child ) !== true ) continue;
			if ( visited[ child ] === 1 ) continue;

			// Check if side is flyable (WALL_IS_DOORWAY & WID_FLY_FLAG)
			// No wall = open passage (flyable), otherwise check wall_is_doorway
			const wall_num = seg.sides[ side ].wall_num;
			let canFly = false;

			if ( wall_num === - 1 ) {

				canFly = true;	// Open passage

			} else {

				canFly = ( ( wall_is_doorway( curSeg, side ) & WID_FLY_FLAG ) !== 0 );

			}

			if ( canFly !== true ) continue;

			queue[ head ++ ] = child;
			head &= ( QUEUE_SIZE - 1 );
			visited[ child ] = 1;

			// Add to teleport segments (skip size check — simplified from C)
			if ( Num_boss_teleport_segs < MAX_BOSS_TELEPORT_SEGS ) {

				Boss_teleport_segs[ Num_boss_teleport_segs ++ ] = child;

			}

			if ( Num_boss_teleport_segs >= MAX_BOSS_TELEPORT_SEGS ) {

				tail = head;	// Force BFS end

			}

		}

	}

	// Build gate segments list (no size check — any reachable segment is valid)
	// Ported from: init_boss_segments(Boss_gate_segs, &Num_boss_gate_segs, 0) in AI.C line 712
	Num_boss_gate_segs = 0;

	// Reuse BFS but without size check — gate segs are for small spawned robots
	visited.fill( 0 );
	head = 0;
	tail = 0;
	queue[ head ++ ] = startSeg;
	visited[ startSeg ] = 1;
	Boss_gate_segs[ Num_boss_gate_segs ++ ] = startSeg;

	while ( tail !== head ) {

		const curSeg2 = queue[ tail ++ ];
		tail &= ( QUEUE_SIZE - 1 );

		const seg2 = Segments[ curSeg2 ];

		for ( let side = 0; side < MAX_SIDES_PER_SEGMENT; side ++ ) {

			const child2 = seg2.children[ side ];
			if ( IS_CHILD( child2 ) !== true ) continue;
			if ( visited[ child2 ] === 1 ) continue;

			const wall_num2 = seg2.sides[ side ].wall_num;
			let canFly2 = false;

			if ( wall_num2 === - 1 ) {

				canFly2 = true;

			} else {

				canFly2 = ( ( wall_is_doorway( curSeg2, side ) & WID_FLY_FLAG ) !== 0 );

			}

			if ( canFly2 !== true ) continue;

			queue[ head ++ ] = child2;
			head &= ( QUEUE_SIZE - 1 );
			visited[ child2 ] = 1;

			if ( Num_boss_gate_segs < MAX_BOSS_TELEPORT_SEGS ) {

				Boss_gate_segs[ Num_boss_gate_segs ++ ] = child2;

			}

			if ( Num_boss_gate_segs >= MAX_BOSS_TELEPORT_SEGS ) {

				tail = head;

			}

		}

	}

	// Reset boss state
	Boss_dying = false;
	Boss_dying_start_time = 0;
	Boss_dying_sound_playing = false;
	Boss_hit_this_frame = false;
	Boss_cloaked = false;
	Boss_cloak_start_time = 0;
	Boss_cloak_end_time = 0;
	Last_teleport_time = 0;
	Last_gate_time = 0;

	// Gate interval: 5s - difficulty*0.5s (from AI.C line 719)
	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
	Gate_interval = 5.0 - d * 0.5;

	console.log( 'BOSS: Found boss robot type ' + _bossRobot.obj.id +
		' in seg ' + startSeg + ', ' + Num_boss_teleport_segs + ' teleport segs, ' +
		Num_boss_gate_segs + ' gate segs' );

}

// Teleport boss to a random reachable segment
// Ported from: teleport_boss() in AI.C lines 2358-2396
function teleport_boss() {

	if ( _bossRobot === null || Num_boss_teleport_segs === 0 ) return;

	const robot = _bossRobot;
	const obj = robot.obj;

	// Pick random segment from teleport list
	// C: rand_seg = (rand() * Num_boss_teleport_segs) >> 15
	const randIdx = Math.floor( Math.random() * Num_boss_teleport_segs );
	const randSeg = Boss_teleport_segs[ randIdx ];

	// Move to segment center
	const center = compute_segment_center( randSeg );
	obj.pos_x = center.x;
	obj.pos_y = center.y;
	obj.pos_z = center.z;
	obj.segnum = randSeg;

	Last_teleport_time = GameTime;

	// Make boss face the player
	// Ported from: AI.C lines 2383-2384
	if ( _getPlayerPos !== null ) {

		const pp = _getPlayerPos();
		const dx = pp.x - obj.pos_x;
		const dy = pp.y - obj.pos_y;
		const dz = pp.z - obj.pos_z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist > 0.001 ) {

			obj.orient_fvec_x = dx / dist;
			obj.orient_fvec_y = dy / dist;
			obj.orient_fvec_z = dz / dist;

			// Reconstruct right/up vectors from new forward
			let ux = 0, uy = 1, uz = 0;
			let rx = obj.orient_fvec_y * uz - obj.orient_fvec_z * uy;
			let ry = obj.orient_fvec_z * ux - obj.orient_fvec_x * uz;
			let rz = obj.orient_fvec_x * uy - obj.orient_fvec_y * ux;
			let rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );

			if ( rmag > 0.001 ) {

				rx /= rmag; ry /= rmag; rz /= rmag;
				ux = ry * obj.orient_fvec_z - rz * obj.orient_fvec_y;
				uy = rz * obj.orient_fvec_x - rx * obj.orient_fvec_z;
				uz = rx * obj.orient_fvec_y - ry * obj.orient_fvec_x;
				obj.orient_rvec_x = rx; obj.orient_rvec_y = ry; obj.orient_rvec_z = rz;
				obj.orient_uvec_x = ux; obj.orient_uvec_y = uy; obj.orient_uvec_z = uz;

			}

		}

	}

	// Update mesh position and orientation
	if ( robot.mesh !== null ) {

		robot.mesh.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
		updateMeshOrientation( robot );

		// Mesh stays invisible if boss is cloaked
		robot.mesh.visible = ( Boss_cloaked !== true );

	}

	// Can fire immediately after teleport (AI.C line 2394)
	if ( robot.aiLocal !== undefined && robot.aiLocal !== null ) {

		robot.aiLocal.next_fire = 0;

	}

	// Play teleport sound and create arrival effect
	digi_play_sample_3d( SOUND_BOSS_SHARE_SEE, 1.0, obj.pos_x, obj.pos_y, obj.pos_z );

	if ( _onCreateExplosion !== null ) {

		_onCreateExplosion( obj.pos_x, obj.pos_y, obj.pos_z, 10.0 );

	}

}

// Gate in a robot near the player
// Ported from: gate_in_robot() + create_gated_robot() in AI.C lines 2115-2209
function gate_in_robot() {

	if ( _robots === null || _onSpawnGatedRobot === null ) return false;
	if ( Num_boss_gate_segs === 0 ) return false;

	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
	const maxGated = 2 * d + 3;

	// Count currently alive gated robots (matcen_creator === BOSS_GATE_MATCEN_NUM)
	let gatedCount = 0;

	for ( let i = 0; i < _robots.length; i ++ ) {

		if ( _robots[ i ].alive === true && _robots[ i ].obj.matcen_creator === BOSS_GATE_MATCEN_NUM ) {

			gatedCount ++;

		}

	}

	if ( gatedCount >= maxGated ) {

		// Too many gated robots alive — delay slightly
		Last_gate_time = GameTime - Gate_interval * 3 / 4;
		return false;

	}

	// Pick a random gate segment
	const randIdx = Math.floor( Math.random() * Num_boss_gate_segs );
	const segnum = Boss_gate_segs[ randIdx ];

	if ( segnum < 0 || segnum >= Num_segments ) return false;

	// Pick a random robot type from the gate list
	const randType = Math.floor( Math.random() * Super_boss_gate_list.length );
	let robotType = Super_boss_gate_list[ randType ];

	// Clamp to valid range
	if ( robotType >= N_robot_types ) robotType = 0;

	// Compute spawn position at segment center
	const center = compute_segment_center( segnum );

	// Spawn the robot via callback
	_onSpawnGatedRobot( segnum, robotType, center.x, center.y, center.z );

	Last_gate_time = GameTime;

	return true;

}

// Boss behavior state machine: cloak, teleport, dying, gating
// Ported from: do_boss_stuff() in AI.C lines 2480-2528
function do_boss_stuff() {

	if ( _bossRobot === null ) return;

	const robot = _bossRobot;

	// Fix timer wraparound (from AI.C lines 2483-2487)
	if ( Last_teleport_time > GameTime ) Last_teleport_time = GameTime;

	if ( Boss_dying !== true ) {

		if ( Boss_cloaked === true ) {

			// Currently cloaked — teleport during middle third of cloak duration
			// Ported from: AI.C lines 2498-2504
			const elapsed = GameTime - Boss_cloak_start_time;
			const remaining = Boss_cloak_end_time - GameTime;
			const timeSinceTeleport = GameTime - Last_teleport_time;

			if ( elapsed > BOSS_CLOAK_DURATION / 3 &&
				remaining > BOSS_CLOAK_DURATION / 3 &&
				timeSinceTeleport > Boss_teleport_interval ) {

				teleport_boss();

			} else if ( Boss_hit_this_frame === true ) {

				// Getting hit while cloaked — accelerate next teleport
				Boss_hit_this_frame = false;
				Last_teleport_time -= Boss_teleport_interval / 4;

			}

			// Check if cloak expired (AI.C line 2506)
			if ( GameTime > Boss_cloak_end_time ) {

				Boss_cloaked = false;
				if ( robot.mesh !== null ) {

					robot.mesh.visible = true;

				}

			}

		} else {

			// Not cloaked — check if should start cloaking
			// Ported from: AI.C lines 2509-2523
			if ( ( GameTime - Boss_cloak_end_time > Boss_cloak_interval ) || Boss_hit_this_frame === true ) {

				Boss_hit_this_frame = false;
				Boss_cloak_start_time = GameTime;
				Boss_cloak_end_time = GameTime + BOSS_CLOAK_DURATION;
				Boss_cloaked = true;

				if ( robot.mesh !== null ) {

					robot.mesh.visible = false;

				}

			}

		}

	} else {

		do_boss_dying_frame();

	}

	// Boss gating: spawn robots near the player at intervals
	// Ported from: do_boss_stuff() in AI.C lines 2530-2591
	if ( Boss_dying !== true && Num_boss_gate_segs > 0 ) {

		// Fix timer wraparound
		if ( Last_gate_time > GameTime ) Last_gate_time = GameTime;

		// Gate when player is within range or boss can see them
		const playerPos = _getPlayerPos !== null ? _getPlayerPos() : null;

		if ( playerPos !== null ) {

			const bx = robot.obj.pos_x - playerPos.x;
			const by = robot.obj.pos_y - playerPos.y;
			const bz = robot.obj.pos_z - playerPos.z;
			const distToPlayer = Math.sqrt( bx * bx + by * by + bz * bz );

			if ( distToPlayer < BOSS_TO_PLAYER_GATE_DISTANCE ) {

				if ( GameTime - Last_gate_time > Gate_interval ) {

					gate_in_robot();

				}

			}

		}

	}

}

// Start boss death sequence
// Ported from: start_boss_death_sequence() in AI.C lines 2399-2406
export function start_boss_death_sequence( robot ) {

	if ( robot === null || robot === undefined ) return;
	const rtype = robot.obj.id;
	if ( rtype < 0 || rtype >= N_robot_types ) return;
	if ( Robot_info[ rtype ].boss_flag <= 0 ) return;

	Boss_dying = true;
	Boss_dying_start_time = GameTime;
	Boss_dying_sound_playing = false;

	// Uncloak if currently cloaked
	if ( Boss_cloaked === true ) {

		Boss_cloaked = false;
		if ( robot.mesh !== null ) {

			robot.mesh.visible = true;

		}

	}

	console.log( 'BOSS: Death sequence started!' );

}

// Boss dying animation frame — spinning, fireballs, then explosion
// Ported from: do_boss_dying_frame() in AI.C lines 2409-2437
function do_boss_dying_frame() {

	if ( _bossRobot === null ) return;

	const robot = _bossRobot;
	const obj = robot.obj;
	const elapsed = GameTime - Boss_dying_start_time;

	// Spin the boss with increasing rotational velocity
	// Ported from: AI.C lines 2419-2421
	// rotvel = elapsed / N, in fixang/s where F1_0 = 1 revolution
	// Converted to radians: elapsed * (2π / N)
	if ( robot.mesh !== null ) {

		const angVelX = elapsed * ( 2 * Math.PI / 9 );
		const angVelY = elapsed * ( 2 * Math.PI / 5 );
		const angVelZ = elapsed * ( 2 * Math.PI / 7 );
		robot.mesh.rotateX( angVelX * _dt );
		robot.mesh.rotateY( angVelY * _dt );
		robot.mesh.rotateZ( angVelZ * _dt );

	}

	// Create random fireballs on the boss
	// Ported from: AI.C lines 2423-2431
	if ( elapsed > BOSS_DEATH_DURATION - BOSS_DEATH_SOUND_DURATION ) {

		// Near end of death — play death sound and create frequent fireballs
		if ( Boss_dying_sound_playing !== true ) {

			Boss_dying_sound_playing = true;
			digi_play_sample_3d( SOUND_BOSS_SHARE_DIE, 1.0, obj.pos_x, obj.pos_y, obj.pos_z );

		}

		// C: rand() < FrameTime*16 — frequent fireballs during death sound
		if ( Math.random() < _dt * 16 && _onCreateExplosion !== null ) {

			const rx = ( Math.random() - 0.5 ) * obj.size;
			const ry = ( Math.random() - 0.5 ) * obj.size;
			const rz = ( Math.random() - 0.5 ) * obj.size;
			_onCreateExplosion( obj.pos_x + rx, obj.pos_y + ry, obj.pos_z + rz,
				2.0 + Math.random() * 3.0 );

		}

	} else {

		// Earlier in death — less frequent fireballs
		// C: rand() < FrameTime*8
		if ( Math.random() < _dt * 8 && _onCreateExplosion !== null ) {

			const rx = ( Math.random() - 0.5 ) * obj.size;
			const ry = ( Math.random() - 0.5 ) * obj.size;
			const rz = ( Math.random() - 0.5 ) * obj.size;
			_onCreateExplosion( obj.pos_x + rx, obj.pos_y + ry, obj.pos_z + rz,
				1.0 + Math.random() * 2.0 );

		}

	}

	// Boss death sequence complete
	// Ported from: AI.C lines 2433-2437
	if ( elapsed >= BOSS_DEATH_DURATION ) {

		// Trigger self-destruct and final explosion
		if ( _onBossDeath !== null ) {

			_onBossDeath( robot );

		}

		// Mark boss as dead
		robot.alive = false;
		Boss_dying = false;
		_bossRobot = null;

	}

}

// ---------------------------------------------------------------
// Robot joint animation
// Ported from: do_silly_animation() and ai_frame_animation() in AI.C lines 1039-1234
// ---------------------------------------------------------------

// Compute gun-to-submodel mapping for a model
// Ported from: robot_set_angles() in ROBOT.C lines 274-317 (gun_nums initialization)
const _gunNumsCache = {};

function get_gun_nums( model_num, n_guns ) {

	const key = model_num + '_' + n_guns;
	if ( _gunNumsCache[ key ] !== undefined ) return _gunNumsCache[ key ];

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return null;

	const gunNums = new Int8Array( model.n_models );

	// Default: all submodels are "body" (indexed as n_guns)
	for ( let m = 0; m < model.n_models; m ++ ) {

		gunNums[ m ] = n_guns;

	}

	gunNums[ 0 ] = - 1;	// Submodel 0 (body root) never animates

	// Walk parent chains from each gun's submodel to assign gun groups
	for ( let g = 0; g < n_guns && g < model.n_guns; g ++ ) {

		let m = model.gun_submodels[ g ];

		while ( m !== 0 && m < model.n_models ) {

			gunNums[ m ] = g;
			m = model.submodel_parents[ m ];

		}

	}

	_gunNumsCache[ key ] = gunNums;
	return gunNums;

}

// Set target joint angles and interpolation rates based on current AI state
// Ported from: do_silly_animation() in AI.C lines 1039-1166
function do_silly_animation( robot ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;
	if ( ailp === undefined ) return 0;

	const robotType = obj.id;
	if ( robotType < 0 || robotType >= N_robot_types ) return 0;

	const ri = Robot_info[ robotType ];
	const model_num = ( obj.rtype !== null ) ? obj.rtype.model_num : - 1;
	if ( model_num < 0 ) return 0;

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return 0;
	if ( model.anim_angs === null ) return 0;

	const n_guns = model.n_guns;
	if ( n_guns === 0 ) return 0;

	const gunNums = get_gun_nums( model_num, n_guns );
	if ( gunNums === null ) return;

	// Map AI state to animation state
	const stateIdx = ailp.goal_state;
	const robot_state = ( stateIdx >= 0 && stateIdx < Mike_to_matt_xlate.length )
		? Mike_to_matt_xlate[ stateIdx ] : AS_REST;

	if ( robot_state >= model.anim_angs.length ) return;

	const targetAngles = model.anim_angs[ robot_state ];

	// Speed modifier based on attack/flinch
	let flinch_attack_scale = 1;
	if ( ri.attack_type > 0 ) {

		flinch_attack_scale = Attack_scale;

	} else if ( robot_state === AS_FLINCH || robot_state === AS_RECOIL ) {

		flinch_attack_scale = Flinch_scale;

	}

	let at_goal = 1;

	// Process each gun group + body
	for ( let gun_num = 0; gun_num <= n_guns; gun_num ++ ) {

		let gun_at_goal = 1;

		for ( let m = 1; m < model.n_models; m ++ ) {

			if ( gunNums[ m ] !== gun_num ) continue;
			if ( m >= targetAngles.length ) continue;

			const jp = targetAngles[ m ];	// Target angles for this state
			const curp = obj.rtype.anim_angles[ m ];	// Current angles
			const goalp = ailp.goal_angles[ m ];
			const deltap = ailp.delta_angles[ m ];

			// Process each axis: pitch, bank, heading
			const axes = [ 'p', 'b', 'h' ];

			for ( let a = 0; a < 3; a ++ ) {

				const axis = axes[ a ];

				if ( jp[ axis ] !== curp[ axis ] ) {

					if ( gun_num === 0 ) at_goal = 0;
					gun_at_goal = 0;

					goalp[ axis ] = jp[ axis ];

					// Compute shortest-path direction
					const delta_angle = jp[ axis ] - curp[ axis ];
					let delta_2;

					if ( delta_angle >= Math.PI ) {

						delta_2 = - ANIM_RATE;

					} else if ( delta_angle >= 0 ) {

						delta_2 = ANIM_RATE;

					} else if ( delta_angle >= - Math.PI ) {

						delta_2 = - ANIM_RATE;

					} else {

						delta_2 = ANIM_RATE;

					}

					deltap[ axis ] = delta_2 * flinch_attack_scale;

				}

			}

		}

		// Check if gun reached its goal
		if ( gun_at_goal === 1 ) {

			ailp.anim_achieved_state[ gun_num ] = ailp.anim_goal_state[ gun_num ];

			// Auto-transitions
			if ( ailp.anim_achieved_state[ gun_num ] === AIS_RECO ) {

				ailp.anim_goal_state[ gun_num ] = AIS_FIRE;

			}

			if ( ailp.anim_achieved_state[ gun_num ] === AIS_FLIN ) {

				ailp.anim_goal_state[ gun_num ] = AIS_LOCK;

			}

		}

	}

	// Update global AI state when all guns reach goal
	if ( at_goal === 1 ) {

		ailp.current_state = ailp.goal_state;

	}

	return 1;

}

// Interpolate current animation angles toward goals each frame
// Ported from: ai_frame_animation() in AI.C lines 1173-1234
function ai_frame_animation( robot, dt ) {

	const obj = robot.obj;
	if ( obj.rtype === null ) return;

	const model_num = obj.rtype.model_num;
	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return;
	if ( model.anim_angs === null ) return;

	const ailp = robot.aiLocal;
	if ( ailp === undefined ) return;

	const num_joints = model.n_models;

	// Skip submodel 0 (body root, never animates)
	for ( let joint = 1; joint < num_joints; joint ++ ) {

		const curang = obj.rtype.anim_angles[ joint ];
		const goalang = ailp.goal_angles[ joint ];
		const deltaang = ailp.delta_angles[ joint ];

		// Process each axis
		const axes = [ 'p', 'b', 'h' ];

		for ( let a = 0; a < 3; a ++ ) {

			const axis = axes[ a ];

			let delta_to_goal = goalang[ axis ] - curang[ axis ];

			// Wrap to [-PI, PI]
			if ( delta_to_goal > Math.PI ) {

				delta_to_goal -= 2.0 * Math.PI;

			} else if ( delta_to_goal < - Math.PI ) {

				delta_to_goal += 2.0 * Math.PI;

			}

			if ( Math.abs( delta_to_goal ) > 0.001 ) {

				const scaled_delta = deltaang[ axis ] * dt;
				curang[ axis ] += scaled_delta;

				// Snap to goal if overshot
				if ( Math.abs( delta_to_goal ) < Math.abs( scaled_delta ) ) {

					curang[ axis ] = goalang[ axis ];

				}

				// Wrap current angle to [-PI, PI]
				if ( curang[ axis ] > Math.PI ) {

					curang[ axis ] -= 2.0 * Math.PI;

				} else if ( curang[ axis ] < - Math.PI ) {

					curang[ axis ] += 2.0 * Math.PI;

				}

			}

		}

	}

}

// Apply current animation angles to the robot's mesh submodel groups
// Called after ai_frame_animation to update Three.js rotations
function apply_robot_anim_angles( robot ) {

	if ( robot.submodelGroups === undefined || robot.submodelGroups === null ) return;

	const obj = robot.obj;
	if ( obj.rtype === null ) return;

	const anims = obj.rtype.anim_angles;
	const groups = robot.submodelGroups;

	for ( let i = 1; i < groups.length; i ++ ) {

		const g = groups[ i ];
		if ( g === undefined || g === null ) continue;

		const a = anims[ i ];
		if ( a === undefined ) continue;

		// Convert Descent angles to Three.js rotations (Z-negate coordinate conversion)
		// Pitch (X) and Heading (Y) are negated, Bank (Z) stays same
		// Euler order 'YXZ' matches Descent's H,P,B application order
		g.rotation.x = - a.p;
		g.rotation.y = - a.h;
		g.rotation.z = a.b;

	}

}

// Reset gun nums cache (call on level change)
export function ai_reset_anim_cache() {

	for ( const key in _gunNumsCache ) {

		delete _gunNumsCache[ key ];

	}

}

// ---------------------------------------------------------------
// Awareness propagation system
// Ported from: AI.C lines 3549-3660
// ---------------------------------------------------------------

// Queue an awareness event at a position and probabilistically bump Overall_agitation
// Ported from: create_awareness_event() + add_awareness_event() in AI.C lines 3549-3599
// type: PA_NEARBY_ROBOT_FIRED(1), PA_WEAPON_WALL_COLLISION(2), PA_PLAYER_COLLISION(3), PA_WEAPON_ROBOT_COLLISION(4)
export function create_awareness_event( segnum, pos_x, pos_y, pos_z, type ) {

	if ( Num_awareness_events >= MAX_AWARENESS_EVENTS ) return;
	if ( segnum < 0 || segnum >= Num_segments ) return;

	const evt = Awareness_events[ Num_awareness_events ];
	evt.segnum = segnum;
	evt.pos_x = pos_x;
	evt.pos_y = pos_y;
	evt.pos_z = pos_z;
	evt.type = type;
	Num_awareness_events ++;

	// Probabilistically increment Overall_agitation
	// Ported from: AI.C lines 3593-3598
	// C code: if (((rand() * (type+4)) >> 15) > 4) Overall_agitation++;
	// rand() returns 0..32767, so (rand()*(type+4)) >> 15 gives 0..(type+3)
	// Result > 4 only possible when type >= 2 (wall hits, collisions)
	const randVal = Math.floor( Math.random() * 32768 );
	if ( ( ( randVal * ( type + 4 ) ) >> 15 ) > 4 ) {

		Overall_agitation ++;
		if ( Overall_agitation > OVERALL_AGITATION_MAX ) {

			Overall_agitation = OVERALL_AGITATION_MAX;

		}

	}

}

// Recursive segment graph traversal to propagate awareness
// Ported from: pae_aux() in AI.C lines 3604-3622
// Spreads awareness through connected segments up to depth 4
function pae_aux( segnum, type, level ) {

	if ( level > 4 ) return;
	if ( segnum < 0 || segnum >= Num_segments ) return;

	// Only update if new awareness is higher than existing
	if ( New_awareness[ segnum ] >= type ) return;

	New_awareness[ segnum ] = type;

	// Propagate to neighbors (downgrade PA_WEAPON_ROBOT_COLLISION in children)
	const childType = ( type === PA_WEAPON_ROBOT_COLLISION ) ? PA_PLAYER_COLLISION : type;
	const seg = Segments[ segnum ];
	if ( seg === undefined ) return;

	for ( let j = 0; j < MAX_SIDES_PER_SEGMENT; j ++ ) {

		const child = seg.children[ j ];
		if ( IS_CHILD( child ) === true ) {

			pae_aux( child, childType, level + 1 );

		}

	}

}

// Process all queued awareness events into segment awareness map
// Ported from: process_awareness_events() in AI.C lines 3623-3635
function process_awareness_events() {

	// Clear New_awareness for all segments
	const numSegs = Num_segments;
	for ( let i = 0; i < numSegs; i ++ ) {

		New_awareness[ i ] = 0;

	}

	// Process each queued event
	for ( let i = 0; i < Num_awareness_events; i ++ ) {

		const evt = Awareness_events[ i ];
		pae_aux( evt.segnum, evt.type, 0 );

	}

	// Reset event queue
	Num_awareness_events = 0;

}

// Broadcast segment awareness to all robots
// Ported from: set_player_awareness_all() in AI.C lines 3637-3660
function set_player_awareness_all() {

	process_awareness_events();

	if ( _robots === null ) return;

	for ( let i = 0; i < _robots.length; i ++ ) {

		const robot = _robots[ i ];
		if ( robot.alive !== true ) continue;
		if ( robot.aiLocal === undefined ) continue;

		const segnum = robot.obj.segnum;
		if ( segnum < 0 || segnum >= Num_segments ) continue;

		const newAwareness = New_awareness[ segnum ];
		if ( newAwareness > robot.aiLocal.player_awareness_type ) {

			robot.aiLocal.player_awareness_type = newAwareness;
			robot.aiLocal.player_awareness_time = PLAYER_AWARENESS_INITIAL_TIME;

		}

	}

}

// Main AI frame — process all live robots
// ------- Robot-Robot Collision -------
// Ported from: collide_robot_and_robot() → bump_two_objects() in COLLIDE.C lines 1023-1031, 613-637
// Post-integration pass: separate overlapping robots with impulse forces
function ai_check_robot_robot_collisions() {

	if ( _robots === null ) return;

	const n = _robots.length;

	for ( let i = 0; i < n; i ++ ) {

		const r0 = _robots[ i ];
		if ( r0.alive !== true ) continue;
		if ( r0.aiLocal === undefined ) continue;

		const obj0 = r0.obj;
		const ailp0 = r0.aiLocal;
		const size0 = obj0.size !== undefined ? obj0.size : 3.0;
		const mass0 = ( obj0.mtype != null && obj0.mtype.mass > 0 ) ? obj0.mtype.mass : 4.0;

		for ( let j = i + 1; j < n; j ++ ) {

			const r1 = _robots[ j ];
			if ( r1.alive !== true ) continue;
			if ( r1.aiLocal === undefined ) continue;

			const obj1 = r1.obj;
			const ailp1 = r1.aiLocal;
			const size1 = obj1.size !== undefined ? obj1.size : 3.0;

			// Distance check
			const dx = obj0.pos_x - obj1.pos_x;
			const dy = obj0.pos_y - obj1.pos_y;
			const dz = obj0.pos_z - obj1.pos_z;
			const distSq = dx * dx + dy * dy + dz * dz;
			const minDist = size0 + size1;

			if ( distSq >= minDist * minDist ) continue;
			if ( distSq < 0.0001 ) continue;

			const dist = Math.sqrt( distSq );
			const overlap = minDist - dist;

			// Normalized collision axis (from obj1 toward obj0)
			const invDist = 1.0 / dist;
			const nx = dx * invDist;
			const ny = dy * invDist;
			const nz = dz * invDist;

			// Separate positions: push each robot half the overlap distance apart
			const sep = overlap * 0.5;
			obj0.pos_x += nx * sep;
			obj0.pos_y += ny * sep;
			obj0.pos_z += nz * sep;
			obj1.pos_x -= nx * sep;
			obj1.pos_y -= ny * sep;
			obj1.pos_z -= nz * sep;

			// Apply impulse forces (from bump_two_objects in COLLIDE.C lines 630-635)
			// force = 2 * m0 * m1 / (m0 + m1) * (v0 - v1)
			const mass1 = ( obj1.mtype != null && obj1.mtype.mass > 0 ) ? obj1.mtype.mass : 4.0;
			const massScale = 2.0 * mass0 * mass1 / ( mass0 + mass1 );

			const dvx = ailp0.vel_x - ailp1.vel_x;
			const dvy = ailp0.vel_y - ailp1.vel_y;
			const dvz = ailp0.vel_z - ailp1.vel_z;

			// Project velocity difference onto collision normal
			const relVelNormal = dvx * nx + dvy * ny + dvz * nz;

			// Only apply impulse if robots are moving toward each other
			if ( relVelNormal > 0 ) {

				const impulse = massScale * relVelNormal;
				const impulse0 = impulse / mass0;
				const impulse1 = impulse / mass1;

				ailp0.vel_x -= nx * impulse0;
				ailp0.vel_y -= ny * impulse0;
				ailp0.vel_z -= nz * impulse0;
				ailp1.vel_x += nx * impulse1;
				ailp1.vel_y += ny * impulse1;
				ailp1.vel_z += nz * impulse1;

			}

		}

	}

}

export function ai_do_frame( dt ) {

	if ( _robots === null || _getPlayerPos === null ) return;

	_dt = dt;
	FrameCount ++;
	aipath_set_frame_count( FrameCount );

	// Process queued awareness events and broadcast to all robots
	// Ported from: do_ai_frame_all() -> set_player_awareness_all() in AI.C line 3738
	set_player_awareness_all();

	const playerPos = _getPlayerPos();

	for ( let i = 0; i < _robots.length; i ++ ) {

		const robot = _robots[ i ];
		if ( robot.alive !== true ) continue;
		if ( robot.aiLocal === undefined ) continue;

		// Distance-based time-slicing: skip distant robots on some frames
		// Ported from: AI.C lines 3021-3038 — robot LOD processing
		// > 250 units: process every 4th frame, > 150 units: every 2nd frame
		const rdx = robot.obj.pos_x - playerPos.x;
		const rdy = robot.obj.pos_y - playerPos.y;
		const rdz = robot.obj.pos_z - playerPos.z;
		const rdistSq = rdx * rdx + rdy * rdy + rdz * rdz;

		if ( rdistSq > 62500 ) { // 250^2 = 62500

			if ( ( FrameCount + i ) % 4 !== 0 ) continue;

		} else if ( rdistSq > 22500 ) { // 150^2 = 22500

			if ( ( FrameCount + i ) % 2 !== 0 ) continue;

		}

		do_ai_for_robot( robot, playerPos, i );

	}

	// Post-integration: resolve robot-robot overlaps
	// Ported from: collide_robot_and_robot() in COLLIDE.C line 1023
	ai_check_robot_robot_collisions();

}

// Process AI for a single robot
function do_ai_for_robot( robot, playerPos, robotIndex ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;
	const params = getRobotParams( obj.id );

	// Whether this robot can open doors (for pathfinding through closed doors)
	// Ported from: ai_door_is_openable() in AI.C lines 1983-2004
	const canOpenDoors = ai_can_open_doors( obj, ailp.behavior );

	// Decrement timers
	ailp.next_fire -= _dt;

	if ( ailp.path_regen_timer > 0 ) {

		ailp.path_regen_timer -= _dt;

	}

	// Ported from: AI.C lines 2920-2933 — tiered awareness decay
	// Awareness decrements through levels (e.g. 4→3→2→1→0) with 2s per tier
	if ( ailp.player_awareness_type > 0 ) {

		if ( ailp.player_awareness_time > 0 ) {

			ailp.player_awareness_time -= _dt;
			if ( ailp.player_awareness_time <= 0 ) {

				ailp.player_awareness_time = 2.0;	// F1_0*2 = 2 seconds per tier
				ailp.player_awareness_type --;

			}

		} else {

			ailp.player_awareness_type --;
			ailp.player_awareness_time = 2.0;

		}

	}

	// Compute target position: real player pos, or believed pos if cloaked
	// Ported from: compute_vis_and_vec() in AI.C lines 1829-1904
	let target_x = playerPos.x;
	let target_y = playerPos.y;
	let target_z = playerPos.z;
	const playerIsCloaked = ( _isPlayerCloaked !== null && _isPlayerCloaked() === true );

	if ( playerIsCloaked === true ) {

		const ci = Ai_cloak_info[ robotIndex % MAX_AI_CLOAK_INFO ];
		const delta_time = GameTime - ci.last_time;

		// Every 2 seconds, drift believed position randomly (~8 units/sec)
		// Ported from: AI.C lines 1841-1852
		if ( delta_time > 2.0 ) {

			ci.last_x += ( Math.random() - 0.5 ) * 16.0 * delta_time;
			ci.last_y += ( Math.random() - 0.5 ) * 16.0 * delta_time;
			ci.last_z += ( Math.random() - 0.5 ) * 16.0 * delta_time;
			ci.last_time = GameTime;

		}

		target_x = ci.last_x;
		target_y = ci.last_y;
		target_z = ci.last_z;

	}

	// Compute vector to target (Descent coordinates)
	const dx = target_x - obj.pos_x;
	const dy = target_y - obj.pos_y;
	const dz = target_z - obj.pos_z;
	const distSq = dx * dx + dy * dy + dz * dz;
	let dist = Math.sqrt( distSq );

	// Boss behavior: always active, cloak/teleport/dying
	// Ported from: AI.C lines 2982-3018
	const isBoss = ( params.boss_flag > 0 );

	if ( isBoss === true ) {

		do_boss_stuff();

		// Boss dying — skip normal AI, spinning handled by do_boss_dying_frame
		if ( Boss_dying === true ) return;

	}

	// Skip very distant robots (but NOT boss — boss is always active)
	if ( isBoss !== true && dist > AWARENESS_DISTANCE * 2 && ailp.player_awareness_type === 0 ) return;

	// Normalized direction to player
	let dirToPlayer_x = 0, dirToPlayer_y = 0, dirToPlayer_z = 0;

	if ( dist > 0.001 ) {

		const invDist = 1.0 / dist;
		dirToPlayer_x = dx * invDist;
		dirToPlayer_y = dy * invDist;
		dirToPlayer_z = dz * invDist;

	}

	// Compute visibility: dot product of robot forward vector with direction to player
	const fvec_x = obj.orient_fvec_x;
	const fvec_y = obj.orient_fvec_y;
	const fvec_z = obj.orient_fvec_z;

	const dot = fvec_x * dirToPlayer_x + fvec_y * dirToPlayer_y + fvec_z * dirToPlayer_z;

	// Determine visibility level:
	// 0 = not visible, 1 = visible but not in FOV, 2 = visible and in FOV
	let visibility = 0;

	if ( dist < AWARENESS_DISTANCE ) {

		// Simple line-of-sight check: test a few points along the ray
		const canSee = check_line_of_sight(
			obj.pos_x, obj.pos_y, obj.pos_z, obj.segnum,
			target_x, target_y, target_z
		);

		if ( canSee === true ) {

			// Overall_agitation widens FOV: subtract Overall_agitation/128 from threshold
			// Ported from: AI.C line 1024 — if (dot > field_of_view - (Overall_agitation << 9))
			// In fixed-point: agitation << 9 = agitation * 512; field_of_view is 0..F1_0 (65536)
			// Converting to float: 512/65536 = 1/128
			const fov_threshold = params.field_of_view - ( Overall_agitation / 128.0 );

			if ( dot > fov_threshold ) {

				visibility = 2; // In FOV

			} else {

				visibility = 1; // Behind but visible

			}

		}

	}

	// Update awareness based on visibility
	if ( visibility === 2 ) {

		// Play see_sound when robot first spots the player
		if ( ailp.previous_visibility === 0 && params.see_sound !== - 1 ) {

			digi_play_sample_3d( params.see_sound, 0.6, obj.pos_x, obj.pos_y, obj.pos_z );

		}

		ailp.player_awareness_type = PA_WEAPON_ROBOT_COLLISION; // max awareness
		ailp.player_awareness_time = PLAYER_AWARENESS_INITIAL_TIME;
		ailp.time_player_seen = 0; // could track GameTime here

	} else if ( visibility === 1 && ailp.player_awareness_type < 2 ) {

		ailp.player_awareness_type = 2;
		ailp.player_awareness_time = PLAYER_AWARENESS_INITIAL_TIME / 2;

	}

	// Occasionally make non-still robots create a path to the player based on agitation
	// Ported from: AI.C lines 2818-2828
	// When Overall_agitation > 70, robots within 200 units that are not run-from or still
	// have a random chance to spontaneously path toward the player
	if ( ailp.behavior !== AIB_RUN_FROM && ailp.behavior !== AIB_STILL ) {

		if ( Overall_agitation > 70 ) {

			// C code: (rand() < FrameTime/4) where rand()=0..32767, FrameTime is fix
			// Probability per frame: FrameTime/(4*32768) = dt*65536/(4*32768) = dt*0.5
			if ( dist < 200.0 && Math.random() < ( _dt * 0.5 ) ) {

				// C code: if (rand() * (Overall_agitation - 40) > F1_0*5)
				// rand() is 0..32767, F1_0*5 = 327680
				// Dividing both sides by 32768: Math.random() * (agitation-40) > 10.0
				if ( Math.random() * ( Overall_agitation - 40 ) > 10.0 ) {

					const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					const pathLen = 4 + Math.floor( Overall_agitation / 8 ) + d;
					const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
					if ( playerSeg !== - 1 ) {

						create_path_to_player( robot, obj.segnum, playerSeg, canOpenDoors, pathLen );
						ailp.previous_visibility = visibility;
						return;

					}

				}

			}

		}

	}

	// Mode transitions
	if ( ailp.player_awareness_type > 0 && ailp.mode === AIM_STILL ) {

		if ( ailp.behavior === AIB_RUN_FROM ) {

			// Run-from robots create escape path when becoming aware
			const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
			create_n_segment_path( robot, AVOID_SEG_LENGTH, playerSeg, canOpenDoors );
			ailp.mode = AIM_RUN_FROM_OBJECT;
			ailp.mode_is_run_from = true;

		} else if ( visibility > 0 ) {

			ailp.mode = AIM_CHASE_OBJECT;

		} else {

			// Aware but can't see player — use pathfinding
			ailp.mode = AIM_FOLLOW_PATH;

		}

	}

	if ( ailp.player_awareness_type === 0 ) {

		if ( ailp.mode === AIM_CHASE_OBJECT || ailp.mode === AIM_FOLLOW_PATH ) {

			// Ported from: AI.C — station robots return home when awareness decays
			if ( ailp.behavior === AIB_STATION && ailp.hide_segment >= 0 &&
				obj.segnum !== ailp.hide_segment ) {

				// Create path back to station
				ailp.goal_segment = ailp.hide_segment;
				create_path_to_station( robot, 15 );

			} else {

				ailp.mode = AIM_STILL;
				ailp.path_length = 0;	// Clear path
				ailp.vel_x = 0;
				ailp.vel_y = 0;
				ailp.vel_z = 0;

			}

		}

	}

	// Switch between chase and path-follow based on visibility
	if ( ailp.mode === AIM_CHASE_OBJECT && visibility === 0 && ailp.player_awareness_type > 0 ) {

		// Lost sight of player — switch to pathfinding
		// Ported from: AI.C lines 3114-3121
		if ( dist > 80.0 ) {

			if ( ailp.behavior === AIB_STATION ) {

				// Station robots return to station when losing sight
				ailp.goal_segment = ailp.hide_segment;
				create_path_to_station( robot, 15 );

			} else {

				// Normal robots explore randomly when losing sight
				create_n_segment_path( robot, 5, - 1, canOpenDoors );

			}

		} else {

			ailp.mode = AIM_FOLLOW_PATH;

		}

	}

	if ( ailp.mode === AIM_FOLLOW_PATH && visibility === 2 ) {

		// Can see player again — switch to direct chase
		ailp.mode = AIM_CHASE_OBJECT;
		ailp.path_length = 0;	// Clear path

	}

	// Random turning for idle robots
	// Ported from: AI.C lines 3165, 3467, 3497 — ai_turn_randomly() in AIM_STILL
	if ( ailp.mode === AIM_STILL && ailp.player_awareness_type === 0 ) {

		ai_turn_randomly( robot, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, params.turn_time, ailp.previous_visibility );

	}

	// Act based on mode
	if ( ailp.mode === AIM_CHASE_OBJECT ) {

		// Rotate toward player
		ai_turn_towards_vector(
			dirToPlayer_x, dirToPlayer_y, dirToPlayer_z,
			robot, params.turn_time
		);

		// Movement — velocity-based circling/evasion/approach
		// Ported from: ai_move_relative_to_player() in AI.C
		ai_move_relative_to_player( robot, dist, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, robotIndex, params );

		// Firing
		if ( params.attack_type === 1 ) {

			// Melee attack — charge and hit when close enough
			// Ported from: do_firing_stuff() in AI.C lines 2640-2654
			// Range check: robot.size + player.size + 2.0 (F1_0*2)
			if ( dot >= FIRE_DOT_THRESHOLD && ailp.next_fire <= 0 ) {

				const meleeRange = obj.size + PLAYER_SIZE + 2.0;
				if ( dist < meleeRange ) {

					do_ai_robot_melee_attack( robot, params );

				}

			}

		} else {

			// Ranged fire at player (with rapidfire burst support)
			if ( visibility === 2 && dot > FIRE_DOT_THRESHOLD && ailp.next_fire <= 0 ) {

				ai_fire_at_player( robot, robotIndex, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, params );

				// Rapidfire burst behavior
				ailp.rapidfire_count ++;
				if ( params.rapidfire_count > 0 && ailp.rapidfire_count < params.rapidfire_count ) {

					// Short delay between burst shots
					ailp.next_fire = Math.min( 0.125, params.firing_wait * 0.5 );

				} else {

					// Burst complete — full cooldown
					ailp.rapidfire_count = 0;
					ailp.next_fire = params.firing_wait;

				}

			}

		}

	} else if ( ailp.mode === AIM_RUN_FROM_OBJECT ) {

		// Run-from mode: follow escape path, drop proximity bombs backward
		// Ported from: AI.C lines 3180-3228

		if ( visibility > 0 ) {

			if ( ailp.player_awareness_type === 0 ) {

				ailp.player_awareness_type = PA_WEAPON_ROBOT_COLLISION;

			}

		}

		// Create escape path if none or path ended
		if ( ailp.path_length === 0 || ailp.needs_new_path === true ) {

			ailp.needs_new_path = false;
			const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
			create_n_segment_path( robot, AVOID_SEG_LENGTH, playerSeg, canOpenDoors );
			ailp.mode = AIM_RUN_FROM_OBJECT;
			ailp.mode_is_run_from = true;

		}

		// Check if player is on the escape path (ahead of robot)
		// If so, create new escape path immediately
		// Ported from: AIPATH.C lines 918-950
		if ( visibility > 0 && ailp.path_length > 0 ) {

			const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
			if ( playerSeg !== - 1 ) {

				let playerOnPath = false;
				const baseIdx = ailp.hide_index;
				for ( let pi = ailp.cur_path_index; pi < ailp.path_length; pi ++ ) {

					const psIdx = baseIdx + pi;
					if ( psIdx >= 0 && psIdx < 2500 ) {

						// Access Point_segs — import not available, use segnum check
						// We can't directly access Point_segs from ai.js, so check via create_n_segment_path
						// Simplification: just regenerate if player segment == goal
						break;

					}

				}

				// If player is very close and in the same segment, definitely reroute
				if ( playerSeg === obj.segnum && dist < 30.0 ) {

					create_n_segment_path( robot, AVOID_SEG_LENGTH, - 1, canOpenDoors );
					ailp.mode = AIM_RUN_FROM_OBJECT;
					ailp.mode_is_run_from = true;

				}

			}

		}

		// Follow escape path
		if ( ailp.path_length > 0 ) {

			ai_follow_path( robot, params, visibility, _dt, ai_turn_towards_vector );

		} else if ( visibility === 0 && ailp.player_awareness_type === 0 ) {

			// No path, no awareness — slow down
			// Ported from: AIPATH.C lines 918-930
			const velScale = Math.max( 0.5, 1.0 - _dt / 2.0 );
			ailp.vel_x *= velScale;
			ailp.vel_y *= velScale;
			ailp.vel_z *= velScale;

		}

		// Run-from robots drop proximity bombs behind them while fleeing
		// Ported from: AI.C lines 3207-3222
		if ( ailp.bomb_drop_timer > 0 ) {

			ailp.bomb_drop_timer -= _dt;

		}

		if ( ailp.bomb_drop_timer <= 0 && visibility > 0 ) {

			ailp.bomb_drop_timer = 5.0 + Math.random() * 5.0;

			// Fire backward (opposite of forward vector)
			const bdir_x = - obj.orient_fvec_x;
			const bdir_y = - obj.orient_fvec_y;
			const bdir_z = - obj.orient_fvec_z;

			// Spawn slightly behind the robot
			const offset = obj.size !== undefined ? obj.size : 3.0;
			const bpos_x = obj.pos_x + bdir_x * offset;
			const bpos_y = obj.pos_y + bdir_y * offset;
			const bpos_z = obj.pos_z + bdir_z * offset;

			const bombSeg = find_point_seg( bpos_x, bpos_y, bpos_z, obj.segnum );

			if ( bombSeg !== - 1 ) {

				Laser_create_new( bdir_x, bdir_y, bdir_z, bpos_x, bpos_y, bpos_z, bombSeg, PARENT_ROBOT, PROXIMITY_ID );

			}

		}

	} else if ( ailp.mode === AIM_FOLLOW_PATH ) {

		// Check for openable doors in current segment (brain and run-from robots)
		// Ported from: AI.C lines 3050-3072 — ROBOT_BRAIN case
		if ( ai_can_open_doors( obj, ailp.behavior ) === true ) {

			const doorSide = openable_doors_in_segment( obj );
			if ( doorSide !== - 1 ) {

				ailp.prev_mode = AIM_FOLLOW_PATH;
				ailp.goal_side = doorSide;
				ailp.mode = AIM_OPEN_DOOR;

			}

		}

		// Create path to player if we don't have one or need to refresh
		if ( ailp.path_length === 0 && ailp.path_regen_timer <= 0 ) {

			const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;

			if ( playerSeg !== - 1 ) {

				create_path_to_player( robot, obj.segnum, playerSeg, canOpenDoors );

			}

			ailp.path_regen_timer = 2.0;	// Don't regenerate for 2 seconds

		}

		// Follow the computed path
		if ( ailp.path_length > 0 ) {

			ai_follow_path( robot, params, visibility, _dt, ai_turn_towards_vector );

		}

		// Fire at player if we can see them while pathfinding
		if ( visibility === 2 && dot > FIRE_DOT_THRESHOLD && ailp.next_fire <= 0 ) {

			ai_fire_at_player( robot, robotIndex, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, params );
			ailp.next_fire = params.firing_wait;

		}

	} else if ( ailp.mode === AIM_OPEN_DOOR ) {

		// Robot is trying to open a door
		// Ported from: AI.C lines 3362-3376 — AIM_OPEN_DOOR case
		const doorSide = ailp.goal_side;

		if ( doorSide >= 0 && doorSide < MAX_SIDES_PER_SEGMENT ) {

			// Check if the door is still closed
			const wall_num = Segments[ obj.segnum ].sides[ doorSide ].wall_num;
			if ( wall_num !== - 1 && Walls[ wall_num ] !== undefined &&
				Walls[ wall_num ].type === WALL_DOOR &&
				Walls[ wall_num ].state === WALL_DOOR_CLOSED ) {

				// Compute center of door side and move toward it
				const center = compute_center_point_on_side( obj.segnum, doorSide );
				const dx = center.x - obj.pos_x;
				const dy = center.y - obj.pos_y;
				const dz = center.z - obj.pos_z;
				const doorDist = Math.sqrt( dx * dx + dy * dy + dz * dz );

				if ( doorDist > 0.01 ) {

					const ndx = dx / doorDist;
					const ndy = dy / doorDist;
					const ndz = dz / doorDist;

					// Turn toward door
					ai_turn_towards_vector( ndx, ndy, ndz, robot, params.turn_time );

					// Move toward door
					const speed = params.max_speed * 0.5;
					ailp.vel_x = ndx * speed;
					ailp.vel_y = ndy * speed;
					ailp.vel_z = ndz * speed;

				}

				// If close enough to the door, open it
				if ( doorDist < obj.size + 5.0 ) {

					wall_open_door( obj.segnum, doorSide );

				}

			} else {

				// Door is no longer closed — resume previous mode
				ailp.mode = ailp.prev_mode;
				ailp.goal_side = - 1;

			}

		} else {

			// Invalid goal side — resume previous mode
			ailp.mode = ailp.prev_mode;
			ailp.goal_side = - 1;

		}

	} else if ( ailp.mode === AIM_HIDE ) {

		// Hiding robot — wait at hiding spot, fire if player visible
		// Ported from: AI.C lines 3279-3298

		// If submode is HIDING, robot is at its spot — mostly idle
		if ( ailp.submode === AISM_HIDING ) {

			// Just wait. If we get hit, the hit handler sets AISM_GOHIDE.
			// But still fire at player if visible
			if ( visibility === 2 && dot > FIRE_DOT_THRESHOLD && ailp.next_fire <= 0 ) {

				ai_fire_at_player( robot, robotIndex, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, params );
				ailp.next_fire = params.firing_wait;

			}

			// Turn toward player if visible
			if ( visibility >= 1 ) {

				ai_turn_towards_vector( dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, robot, params.turn_time );

			}

		} else {

			// AISM_GOHIDE — need to find a new hiding spot
			// Ported from: AI.C lines 2863-2873
			if ( ailp.path_length === 0 && ailp.path_regen_timer <= 0 ) {

				// If highly agitated, hunt the player instead
				if ( Overall_agitation > ( 50 - d * 4 ) ) {

					const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
					if ( playerSeg !== - 1 ) {

						create_path_to_player( robot, obj.segnum, playerSeg, false, 4 + Math.floor( Overall_agitation / 8 ) );

					}

				} else {

					// Create random escape path
					create_n_segment_path( robot, 5, - 1 );

				}

				ailp.path_regen_timer = 2.0;

			}

			// Follow path to hiding spot
			if ( ailp.path_length > 0 ) {

				ai_follow_path( robot, params, visibility, _dt, ai_turn_towards_vector );

			}

			// Fire at player while moving if visible
			if ( visibility === 2 && dot > FIRE_DOT_THRESHOLD && ailp.next_fire <= 0 ) {

				ai_fire_at_player( robot, robotIndex, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, params );
				ailp.next_fire = params.firing_wait;

			}

		}

	}

	// Apply velocity drag — prevents infinite sliding after knockback
	// Ported from: drag applied per frame in PHYSICS.C
	{

		const robotDrag = ( obj.mtype != null && obj.mtype.drag > 0 ) ? obj.mtype.drag : 0.05;
		const dragFactor = 1.0 - robotDrag;
		ailp.vel_x *= dragFactor;
		ailp.vel_y *= dragFactor;
		ailp.vel_z *= dragFactor;

	}

	// Integrate velocity — position += velocity * dt
	// Applies to all active modes (chase, path follow, run-from, open-door, hide all use velocity)
	if ( ailp.mode === AIM_CHASE_OBJECT || ailp.mode === AIM_FOLLOW_PATH ||
		ailp.mode === AIM_RUN_FROM_OBJECT || ailp.mode === AIM_OPEN_DOOR ||
		ailp.mode === AIM_HIDE ) {

		ai_integrate_velocity( robot );

		// Stuck detection: if too many consecutive wall-hit retries, unstick the robot
		// Ported from: AI.C lines 2835-2887 — consecutive_retries > 3
		if ( ailp.consecutive_retries > 3 ) {

			if ( ailp.mode === AIM_RUN_FROM_OBJECT ) {

				// Run-from robots: move to center, zero velocity, create new escape path
				move_towards_segment_center( robot );
				ailp.vel_x = 0;
				ailp.vel_y = 0;
				ailp.vel_z = 0;
				const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
				create_n_segment_path( robot, 5, playerSeg, ai_can_open_doors( obj, ailp.behavior ) );
				ailp.mode = AIM_RUN_FROM_OBJECT;

			} else if ( ailp.mode === AIM_CHASE_OBJECT ) {

				// Chase robots: create a new path to player
				// Ported from: AI.C line 2842 — path length extended by agitation
				const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
				if ( playerSeg !== - 1 ) {

					const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					const pathLen = 4 + Math.floor( Overall_agitation / 8 ) + d;
					create_path_to_player( robot, obj.segnum, playerSeg, ai_can_open_doors( obj, ailp.behavior ), pathLen );

				}

			} else if ( ailp.mode === AIM_FOLLOW_PATH ) {

				// Path-following robots: create a new path
				const playerSeg = _getPlayerSeg !== null ? _getPlayerSeg() : - 1;
				if ( playerSeg !== - 1 ) {

					create_path_to_player( robot, obj.segnum, playerSeg, ai_can_open_doors( obj, ailp.behavior ) );

				}

			} else if ( ailp.mode === AIM_HIDE ) {

				// Hiding robots: move to center, create new hiding path
				move_towards_segment_center( robot );
				ailp.vel_x = 0;
				ailp.vel_y = 0;
				ailp.vel_z = 0;
				create_n_segment_path( robot, 5, - 1 );
				ailp.submode = AISM_GOHIDE;

			}

			ailp.consecutive_retries = 0;

		}

	}

	// Robot-player bump collision check
	// Ported from: collide_robot_and_player() in COLLIDE.C lines 1052-1066
	if ( _onBumpPlayer !== null && ailp.bump_cooldown <= 0 ) {

		const bumpDist = obj.size + PLAYER_SIZE;
		if ( dist < bumpDist && dist > 0.01 ) {

			const robotMass = ( obj.mtype != null && obj.mtype.mass > 0 ) ? obj.mtype.mass : 4.0;
			_onBumpPlayer( robot, ailp.vel_x, ailp.vel_y, ailp.vel_z, robotMass );
			ailp.bump_cooldown = BUMP_COOLDOWN;

			// Hiding robots find new hiding spot when bumped by player
			// Ported from: do_ai_robot_hit() AI.C line 1798
			if ( ailp.behavior === AIB_HIDE ) {

				ailp.mode = AIM_HIDE;
				ailp.submode = AISM_GOHIDE;

			}

		}

	}

	// Decrement bump cooldown
	if ( ailp.bump_cooldown > 0 ) {

		ailp.bump_cooldown -= _dt;

	}

	ailp.previous_visibility = visibility;

	// If the robot can see you, increase his awareness of you.
	// This prevents the problem of a robot looking right at you but doing nothing.
	// Ported from: AI.C lines 3389-3391
	if ( visibility === 2 ) {

		if ( ailp.player_awareness_type === 0 ) {

			ailp.player_awareness_type = PA_PLAYER_COLLISION;

		}

	}

	// Handle non-animating robots: skip animation, just sync current to goal
	// Ported from: AI.C lines 3394-3397
	const object_animates = do_silly_animation( robot );

	if ( object_animates === 0 ) {

		ailp.current_state = ailp.goal_state;

	}

	// Animation state transitions using Ai_transition_table
	// Ported from: AI.C lines 3404-3420
	if ( ailp.player_awareness_type > 0 ) {

		const event_index = ailp.player_awareness_type - 1;
		let new_goal_state = Ai_transition_table[ event_index ][ ailp.current_state ][ ailp.goal_state ];

		if ( ailp.player_awareness_type === PA_WEAPON_ROBOT_COLLISION ) {

			// Decrease awareness, else this robot will flinch every frame.
			ailp.player_awareness_type --;
			ailp.player_awareness_time = PLAYER_AWARENESS_INITIAL_TIME;

		}

		if ( new_goal_state === AIS_ERR_ ) {

			new_goal_state = AIS_REST;

		}

		if ( ailp.current_state === AIS_NONE ) {

			ailp.current_state = AIS_REST;

		}

		ailp.goal_state = new_goal_state;

	}

	// If new state = fire, then set all gun states to fire.
	// Ported from: AI.C lines 3424-3429
	if ( ailp.goal_state === AIS_FIRE ) {

		const robotType = robot.obj.id;
		if ( robotType >= 0 && robotType < N_robot_types ) {

			const num_guns = Robot_info[ robotType ].n_guns;
			for ( let i = 0; i < num_guns; i ++ ) {

				ailp.anim_goal_state[ i ] = AIS_FIRE;

			}

		}

	}

	// Hack: if fire timer expired and goal is fire but haven't animated there yet, bash current state
	// Ported from: AI.C lines 3433-3434
	if ( ailp.next_fire < 0 && ailp.goal_state === AIS_FIRE ) {

		ailp.current_state = AIS_FIRE;

	}

	// Process joint animation
	ai_frame_animation( robot, _dt );
	apply_robot_anim_angles( robot );

}

// ------- Random Turning -------

// Apply pseudo-random rotation to idle robots for lifelike motion
// Ported from: ai_turn_randomly() in AI.C lines 875-902
function ai_turn_randomly( robot, dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, turn_time, previous_visibility ) {

	const ailp = robot.aiLocal;

	// 1/4 of the time, cheat and turn toward player if previously visible
	// Ported from: AI.C line 880-883
	if ( previous_visibility > 0 ) {

		if ( Math.random() > 0.91 ) {

			ai_turn_towards_vector( dirToPlayer_x, dirToPlayer_y, dirToPlayer_z, robot, turn_time );
			return;

		}

	}

	// Chaotic pseudo-random rotation: rotvel feeds back on itself
	// Ported from: AI.C lines 888-900
	// F1_0/64 = 1/64 ≈ 0.015625, F1_0/8 = 0.125
	ailp.rotvel_y += 0.015625;

	ailp.rotvel_x += ailp.rotvel_y / 6;
	ailp.rotvel_y += ailp.rotvel_z / 4;
	ailp.rotvel_z += ailp.rotvel_x / 10;

	if ( Math.abs( ailp.rotvel_x ) > 0.125 ) ailp.rotvel_x /= 4;
	if ( Math.abs( ailp.rotvel_y ) > 0.125 ) ailp.rotvel_y /= 4;
	if ( Math.abs( ailp.rotvel_z ) > 0.125 ) ailp.rotvel_z /= 4;

	// Apply rotational velocity to orientation (rotate around Y axis primarily)
	// Use the rotvel to build a small goal direction offset from current forward
	const obj = robot.obj;
	const goal_x = obj.orient_fvec_x + ailp.rotvel_y * _dt * 2;
	const goal_y = obj.orient_fvec_y + ailp.rotvel_x * _dt * 2;
	const goal_z = obj.orient_fvec_z + ailp.rotvel_z * _dt * 2;
	const mag = Math.sqrt( goal_x * goal_x + goal_y * goal_y + goal_z * goal_z );

	if ( mag > 0.001 ) {

		ai_turn_towards_vector( goal_x / mag, goal_y / mag, goal_z / mag, robot, turn_time * 2 );

	}

}

// ------- Door Opening -------

// Return side index of an openable door in the robot's current segment, or -1 if none
// Ported from: openable_doors_in_segment() in AI.C lines 2019-2034
function openable_doors_in_segment( obj ) {

	const segnum = obj.segnum;
	const seg = Segments[ segnum ];

	for ( let i = 0; i < MAX_SIDES_PER_SEGMENT; i ++ ) {

		const wall_num = seg.sides[ i ].wall_num;
		if ( wall_num === - 1 ) continue;

		const w = Walls[ wall_num ];
		if ( w === undefined ) continue;

		if ( w.type === WALL_DOOR &&
			w.keys === KEY_NONE &&
			w.state === WALL_DOOR_CLOSED &&
			( w.flags & WALL_DOOR_LOCKED ) === 0 ) {

			return i;

		}

	}

	return - 1;

}

// Check if a robot type can open doors
// Ported from: ai_door_is_openable() in AI.C lines 1983-2004
// Only ROBOT_BRAIN and AIB_RUN_FROM robots can open doors
function ai_can_open_doors( obj, behavior ) {

	return ( obj.id === ROBOT_BRAIN || behavior === AIB_RUN_FROM );

}

// ------- Rotation -------

// Rotate robot to face a direction
// Ported from: ai_turn_towards_vector() in AI.C
function ai_turn_towards_vector( goal_x, goal_y, goal_z, robot, turn_time ) {

	const obj = robot.obj;

	// Current forward vector
	let fvec_x = obj.orient_fvec_x;
	let fvec_y = obj.orient_fvec_y;
	let fvec_z = obj.orient_fvec_z;

	// Dot product of current forward with goal
	const dot = fvec_x * goal_x + fvec_y * goal_y + fvec_z * goal_z;

	if ( dot < ( 1.0 - _dt / 2.0 ) ) {

		// Blend goal direction into current forward
		// new_scale = FrameTime * AI_TURN_SCALE / turn_time
		const new_scale = _dt * AI_TURN_SCALE / turn_time;

		fvec_x += goal_x * new_scale;
		fvec_y += goal_y * new_scale;
		fvec_z += goal_z * new_scale;

		// Normalize
		const mag = Math.sqrt( fvec_x * fvec_x + fvec_y * fvec_y + fvec_z * fvec_z );

		if ( mag < 0.001 ) {

			fvec_x = goal_x;
			fvec_y = goal_y;
			fvec_z = goal_z;

		} else {

			const invMag = 1.0 / mag;
			fvec_x *= invMag;
			fvec_y *= invMag;
			fvec_z *= invMag;

		}

	} else {

		fvec_x = goal_x;
		fvec_y = goal_y;
		fvec_z = goal_z;

	}

	// Reconstruct orientation matrix from new forward + old right
	// Ported from vm_vector_2_matrix with rvec hint
	// up = cross(fvec, rvec), then rvec = cross(uvec, fvec)
	let rvec_x = obj.orient_rvec_x;
	let rvec_y = obj.orient_rvec_y;
	let rvec_z = obj.orient_rvec_z;

	// uvec = cross(fvec, rvec)
	let uvec_x = fvec_y * rvec_z - fvec_z * rvec_y;
	let uvec_y = fvec_z * rvec_x - fvec_x * rvec_z;
	let uvec_z = fvec_x * rvec_y - fvec_y * rvec_x;

	// Normalize up vector
	let umag = Math.sqrt( uvec_x * uvec_x + uvec_y * uvec_y + uvec_z * uvec_z );

	if ( umag < 0.001 ) return; // Degenerate, skip

	let uinv = 1.0 / umag;
	uvec_x *= uinv;
	uvec_y *= uinv;
	uvec_z *= uinv;

	// rvec = cross(uvec, fvec)
	rvec_x = uvec_y * fvec_z - uvec_z * fvec_y;
	rvec_y = uvec_z * fvec_x - uvec_x * fvec_z;
	rvec_z = uvec_x * fvec_y - uvec_y * fvec_x;

	// Normalize right vector
	let rmag = Math.sqrt( rvec_x * rvec_x + rvec_y * rvec_y + rvec_z * rvec_z );

	if ( rmag < 0.001 ) return;

	let rinv = 1.0 / rmag;
	rvec_x *= rinv;
	rvec_y *= rinv;
	rvec_z *= rinv;

	// Update object orientation
	obj.orient_fvec_x = fvec_x;
	obj.orient_fvec_y = fvec_y;
	obj.orient_fvec_z = fvec_z;
	obj.orient_uvec_x = uvec_x;
	obj.orient_uvec_y = uvec_y;
	obj.orient_uvec_z = uvec_z;
	obj.orient_rvec_x = rvec_x;
	obj.orient_rvec_y = rvec_y;
	obj.orient_rvec_z = rvec_z;

	// Update Three.js mesh orientation
	if ( robot.mesh !== null ) {

		updateMeshOrientation( robot );

	}

}

// ------- Mesh orientation -------

// Update Three.js mesh from Descent orientation matrix
function updateMeshOrientation( robot ) {

	const obj = robot.obj;

	// Build rotation matrix elements (Descent -> Three.js: negate Z)
	// Same conversion as in main.js placeObjects()
	const m00 = obj.orient_rvec_x;
	const m01 = obj.orient_uvec_x;
	const m02 = - obj.orient_fvec_x;

	const m10 = obj.orient_rvec_y;
	const m11 = obj.orient_uvec_y;
	const m12 = - obj.orient_fvec_y;

	const m20 = - obj.orient_rvec_z;
	const m21 = - obj.orient_uvec_z;
	const m22 = obj.orient_fvec_z;

	// Set quaternion from rotation matrix
	// Using the standard algorithm for matrix -> quaternion conversion
	const trace = m00 + m11 + m22;
	const mesh = robot.mesh;

	if ( trace > 0 ) {

		const s = 0.5 / Math.sqrt( trace + 1.0 );
		mesh.quaternion.w = 0.25 / s;
		mesh.quaternion.x = ( m21 - m12 ) * s;
		mesh.quaternion.y = ( m02 - m20 ) * s;
		mesh.quaternion.z = ( m10 - m01 ) * s;

	} else if ( m00 > m11 && m00 > m22 ) {

		const s = 2.0 * Math.sqrt( 1.0 + m00 - m11 - m22 );
		mesh.quaternion.w = ( m21 - m12 ) / s;
		mesh.quaternion.x = 0.25 * s;
		mesh.quaternion.y = ( m01 + m10 ) / s;
		mesh.quaternion.z = ( m02 + m20 ) / s;

	} else if ( m11 > m22 ) {

		const s = 2.0 * Math.sqrt( 1.0 + m11 - m00 - m22 );
		mesh.quaternion.w = ( m02 - m20 ) / s;
		mesh.quaternion.x = ( m01 + m10 ) / s;
		mesh.quaternion.y = 0.25 * s;
		mesh.quaternion.z = ( m12 + m21 ) / s;

	} else {

		const s = 2.0 * Math.sqrt( 1.0 + m22 - m00 - m11 );
		mesh.quaternion.w = ( m10 - m01 ) / s;
		mesh.quaternion.x = ( m02 + m20 ) / s;
		mesh.quaternion.y = ( m12 + m21 ) / s;
		mesh.quaternion.z = 0.25 * s;

	}

}

// ------- Movement -------

// Move robot toward a goal direction — velocity-based with acceleration
// Ported from: move_towards_vector() in AI.C lines 1404-1444
function move_towards_vector( robot, vec_goal_x, vec_goal_y, vec_goal_z, params ) {

	const ailp = robot.aiLocal;
	const obj = robot.obj;

	// Normalize current velocity to check alignment with forward vector
	const speed = Math.sqrt( ailp.vel_x * ailp.vel_x + ailp.vel_y * ailp.vel_y + ailp.vel_z * ailp.vel_z );
	let dot = 0;

	if ( speed > 0.001 ) {

		const invSpeed = 1.0 / speed;
		dot = ( ailp.vel_x * invSpeed ) * obj.orient_fvec_x
			+ ( ailp.vel_y * invSpeed ) * obj.orient_fvec_y
			+ ( ailp.vel_z * invSpeed ) * obj.orient_fvec_z;

	}

	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;

	if ( dot < 0.75 ) {

		// Velocity not aligned with forward — bash more aggressively toward goal
		// C: velocity/2 + fixmul(vec_goal, FrameTime*32)
		ailp.vel_x = ailp.vel_x / 2 + vec_goal_x * _dt * 32;
		ailp.vel_y = ailp.vel_y / 2 + vec_goal_y * _dt * 32;
		ailp.vel_z = ailp.vel_z / 2 + vec_goal_z * _dt * 32;

	} else {

		// Normal acceleration toward goal
		// C: velocity += fixmul(vec_goal, FrameTime*64) * (Difficulty_level+5)/4
		const scale = _dt * 64 * ( d + 5 ) / 4;
		ailp.vel_x += vec_goal_x * scale;
		ailp.vel_y += vec_goal_y * scale;
		ailp.vel_z += vec_goal_z * scale;

	}

	// Cap speed
	const newSpeed = Math.sqrt( ailp.vel_x * ailp.vel_x + ailp.vel_y * ailp.vel_y + ailp.vel_z * ailp.vel_z );
	let max_speed = params.max_speed;

	// Green guy (melee) attacks twice as fast as he retreats
	if ( params.attack_type === 1 ) max_speed *= 2;

	if ( newSpeed > max_speed ) {

		ailp.vel_x = ( ailp.vel_x * 3 ) / 4;
		ailp.vel_y = ( ailp.vel_y * 3 ) / 4;
		ailp.vel_z = ( ailp.vel_z * 3 ) / 4;

	}

}

// Circling/strafing movement — perpendicular to player direction
// Ported from: move_around_player() in AI.C lines 1455-1542
function move_around_player( robot, vec_x, vec_y, vec_z, fast_flag, robotIndex, params ) {

	if ( fast_flag === 0 ) return;

	const ailp = robot.aiLocal;

	// Compute direction change rate based on frame time
	// Ported from: dir_change logic in AI.C
	let dir_change = 48;
	let count = 0;
	let ft = _dt;

	if ( ft < 1.0 / 32.0 ) {

		dir_change *= 8;
		count += 3;

	} else {

		while ( ft < 0.25 ) {

			dir_change *= 2;
			ft *= 2;
			count ++;

		}

	}

	// Pseudo-random direction selection using FrameCount and object index
	const objHash = robotIndex * 8 + robotIndex * 4 + robotIndex;
	let dir = ( FrameCount + ( count + 1 ) * objHash ) & dir_change;
	dir >>= ( 4 + count );

	if ( dir < 0 ) dir = 0;
	if ( dir > 3 ) dir = 3;

	// Compute evade vector perpendicular to vec_to_player
	let evade_x = 0, evade_y = 0, evade_z = 0;
	const scale = _dt * 32;

	switch ( dir ) {

		case 0:
			evade_x = vec_z * scale;
			evade_y = vec_y * scale;
			evade_z = - vec_x * scale;
			break;
		case 1:
			evade_x = - vec_z * scale;
			evade_y = vec_y * scale;
			evade_z = vec_x * scale;
			break;
		case 2:
			evade_x = - vec_y * scale;
			evade_y = vec_x * scale;
			evade_z = vec_z * scale;
			break;
		case 3:
			evade_x = vec_y * scale;
			evade_y = - vec_x * scale;
			evade_z = vec_z * scale;
			break;

	}

	// Fast evasion scaling (when dodging lasers)
	if ( fast_flag > 0 ) {

		const obj = robot.obj;
		const dotFwd = vec_x * obj.orient_fvec_x + vec_y * obj.orient_fvec_y + vec_z * obj.orient_fvec_z;

		if ( dotFwd > params.field_of_view ) {

			// Scale evasion by remaining shield percentage
			let damage_scale = ( obj.shields !== undefined && params.strength > 0 )
				? obj.shields / params.strength : 1.0;
			if ( damage_scale > 1.0 ) damage_scale = 1.0;
			if ( damage_scale < 0 ) damage_scale = 0;

			const evasion_scale = fast_flag + damage_scale;
			evade_x *= evasion_scale;
			evade_y *= evasion_scale;
			evade_z *= evasion_scale;

		}

	}

	ailp.vel_x += evade_x;
	ailp.vel_y += evade_y;
	ailp.vel_z += evade_z;

	// Cap speed
	const speed = Math.sqrt( ailp.vel_x * ailp.vel_x + ailp.vel_y * ailp.vel_y + ailp.vel_z * ailp.vel_z );

	if ( speed > params.max_speed ) {

		ailp.vel_x = ( ailp.vel_x * 3 ) / 4;
		ailp.vel_y = ( ailp.vel_y * 3 ) / 4;
		ailp.vel_z = ( ailp.vel_z * 3 ) / 4;

	}

}

// Move away from player with optional lateral dodge
// Ported from: move_away_from_player() in AI.C lines 1545-1604
function move_away_from_player( robot, vec_x, vec_y, vec_z, attack_type, robotIndex, params ) {

	const ailp = robot.aiLocal;
	const obj = robot.obj;

	// Push velocity away from player direction
	ailp.vel_x -= vec_x * _dt * 16;
	ailp.vel_y -= vec_y * _dt * 16;
	ailp.vel_z -= vec_z * _dt * 16;

	if ( attack_type !== 0 ) {

		// Add lateral dodge using orientation vectors
		const objref = ( robotIndex ^ ( ( FrameCount + 3 * robotIndex ) >> 5 ) ) & 3;
		const lateralScale = _dt * 32;

		switch ( objref ) {

			case 0:
				ailp.vel_x += obj.orient_uvec_x * lateralScale;
				ailp.vel_y += obj.orient_uvec_y * lateralScale;
				ailp.vel_z += obj.orient_uvec_z * lateralScale;
				break;
			case 1:
				ailp.vel_x -= obj.orient_uvec_x * lateralScale;
				ailp.vel_y -= obj.orient_uvec_y * lateralScale;
				ailp.vel_z -= obj.orient_uvec_z * lateralScale;
				break;
			case 2:
				ailp.vel_x += obj.orient_rvec_x * lateralScale;
				ailp.vel_y += obj.orient_rvec_y * lateralScale;
				ailp.vel_z += obj.orient_rvec_z * lateralScale;
				break;
			case 3:
				ailp.vel_x -= obj.orient_rvec_x * lateralScale;
				ailp.vel_y -= obj.orient_rvec_y * lateralScale;
				ailp.vel_z -= obj.orient_rvec_z * lateralScale;
				break;

		}

	}

	// Cap speed
	const speed = Math.sqrt( ailp.vel_x * ailp.vel_x + ailp.vel_y * ailp.vel_y + ailp.vel_z * ailp.vel_z );

	if ( speed > params.max_speed ) {

		ailp.vel_x = ( ailp.vel_x * 3 ) / 4;
		ailp.vel_y = ( ailp.vel_y * 3 ) / 4;
		ailp.vel_z = ( ailp.vel_z * 3 ) / 4;

	}

}

// Main movement dispatcher — choose movement based on distance and robot type
// Ported from: ai_move_relative_to_player() in AI.C lines 1610-1689
function ai_move_relative_to_player( robot, dist, vec_x, vec_y, vec_z, robotIndex, params ) {

	const ailp = robot.aiLocal;
	const playerDead = _getPlayerDead !== null ? _getPlayerDead() : false;

	// --- Danger laser evasion ---
	// Ported from: AI.C lines 1618-1657
	// If a player weapon is heading toward this robot, dodge sideways
	if ( ailp.danger_laser_idx !== - 1 ) {

		const dweapon = laser_get_weapon( ailp.danger_laser_idx );

		if ( dweapon !== null ) {

			// Vector from robot to laser
			const vtlx = dweapon.pos_x - robot.obj.pos_x;
			const vtly = dweapon.pos_y - robot.obj.pos_y;
			const vtlz = dweapon.pos_z - robot.obj.pos_z;
			let dist_to_laser = Math.sqrt( vtlx * vtlx + vtly * vtly + vtlz * vtlz );

			if ( dist_to_laser > 0.001 ) {

				const invDTL = 1.0 / dist_to_laser;
				const nvtlx = vtlx * invDTL;
				const nvtly = vtly * invDTL;
				const nvtlz = vtlz * invDTL;

				// Check if robot can "see" the laser (dot with forward vector)
				const dot = nvtlx * robot.obj.orient_fvec_x
					+ nvtly * robot.obj.orient_fvec_y
					+ nvtlz * robot.obj.orient_fvec_z;

				if ( dot > params.field_of_view ) {

					// Laser is in robot's field of view — check if it's heading toward robot
					// Get laser direction from its velocity
					let lfx = dweapon.vel_x;
					let lfy = dweapon.vel_y;
					let lfz = dweapon.vel_z;
					const lmag = Math.sqrt( lfx * lfx + lfy * lfy + lfz * lfz );

					if ( lmag > 0.001 ) {

						lfx /= lmag; lfy /= lmag; lfz /= lmag;

						// Vector from laser to robot
						const lvrx = robot.obj.pos_x - dweapon.pos_x;
						const lvry = robot.obj.pos_y - dweapon.pos_y;
						const lvrz = robot.obj.pos_z - dweapon.pos_z;
						let lvrmag = Math.sqrt( lvrx * lvrx + lvry * lvry + lvrz * lvrz );
						if ( lvrmag < 0.001 ) lvrmag = 0.001;

						// Dot product of laser direction with laser-to-robot direction
						// C: laser_robot_dot > F1_0*7/8 = 0.875
						const laser_robot_dot = ( lfx * lvrx + lfy * lvry + lfz * lvrz ) / lvrmag;

						if ( laser_robot_dot > 0.875 && dist_to_laser < 80.0 ) {

							// Laser is heading toward this robot and close enough — evade!
							move_around_player( robot, vec_x, vec_y, vec_z,
								params.evade_speed, robotIndex, params );

							// Clear danger laser and return (evasion takes priority)
							ailp.danger_laser_idx = - 1;
							ailp.danger_laser_id = - 1;
							return;

						}

					}

				}

			}

		}

		// Weapon no longer valid or not heading at us — clear it
		ailp.danger_laser_idx = - 1;
		ailp.danger_laser_id = - 1;

	}

	// If only allowed to do evade code, melee robots continue charging
	// C: if (!robptr->attack_type && evade_only) return;
	// (We don't have evade_only parameter — melee always charges)

	if ( params.attack_type === 1 ) {

		// Melee robot (green guy): circle/evade when not ready to charge
		// C: if ((next_fire > firing_wait/4 && dist < 30) || Player_is_dead)
		if ( ( ailp.next_fire > params.firing_wait / 4 && dist < 30.0 ) || playerDead === true ) {

			// 25% chance to circle, 75% chance to retreat with dodge
			if ( Math.random() < 0.25 ) {

				move_around_player( robot, vec_x, vec_y, vec_z, - 1, robotIndex, params );

			} else {

				move_away_from_player( robot, vec_x, vec_y, vec_z, 1, robotIndex, params );

			}

		} else {

			// Charge toward player
			move_towards_vector( robot, vec_x, vec_y, vec_z, params );

		}

	} else {

		// Ranged robot: distance-based movement selection
		const circleDist = params.circle_distance > 0 ? params.circle_distance : 30.0;

		if ( dist < circleDist ) {

			// Too close — back away (no lateral dodge for ranged)
			move_away_from_player( robot, vec_x, vec_y, vec_z, 0, robotIndex, params );

		} else if ( dist < circleDist * 2 ) {

			// Good range — circle/strafe
			move_around_player( robot, vec_x, vec_y, vec_z, - 1, robotIndex, params );

		} else {

			// Too far — approach
			move_towards_vector( robot, vec_x, vec_y, vec_z, params );

		}

	}

}

// ------- Robot Unstuck Logic -------
// Ported from: move_towards_segment_center() in AI.C lines 1946-1978
// Move robot one radius toward its segment center. If already close, snap to center.
// If still stuck after snapping, try move_object_to_legal_spot().
function move_towards_segment_center( robot ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;
	const robotSize = obj.size !== undefined ? obj.size : 3.0;

	const center = compute_segment_center( obj.segnum );
	const dx = center.x - obj.pos_x;
	const dy = center.y - obj.pos_y;
	const dz = center.z - obj.pos_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	if ( dist < robotSize ) {

		// Center is closer than one radius — snap to center
		obj.pos_x = center.x;
		obj.pos_y = center.y;
		obj.pos_z = center.z;

		// Verify we're in a valid segment after snapping
		const newSeg = find_point_seg( obj.pos_x, obj.pos_y, obj.pos_z, obj.segnum );
		if ( newSeg === - 1 ) {

			// Still stuck at center — try neighboring segments
			move_object_to_legal_spot( robot );

		} else if ( newSeg !== obj.segnum ) {

			obj.segnum = newSeg;

		}

	} else {

		// Move one radius toward center
		const invDist = 1.0 / dist;
		obj.pos_x += dx * invDist * robotSize;
		obj.pos_y += dy * invDist * robotSize;
		obj.pos_z += dz * invDist * robotSize;

		const newSeg = find_point_seg( obj.pos_x, obj.pos_y, obj.pos_z, obj.segnum );
		if ( newSeg === - 1 ) {

			// Ended up outside mine — snap to center instead
			obj.pos_x = center.x;
			obj.pos_y = center.y;
			obj.pos_z = center.z;
			move_object_to_legal_spot( robot );

		} else if ( newSeg !== obj.segnum ) {

			obj.segnum = newSeg;

		}

	}

	// Update mesh position
	if ( robot.mesh !== null ) {

		robot.mesh.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );

	}

}

// Ported from: move_object_to_legal_spot() in AI.C lines 1909-1941
// Try moving one radius toward each neighboring segment's center.
// If no valid spot found, kill the robot.
function move_object_to_legal_spot( robot ) {

	const obj = robot.obj;
	const robotSize = obj.size !== undefined ? obj.size : 3.0;
	const seg = Segments[ obj.segnum ];
	if ( seg === undefined ) return;

	const orig_x = obj.pos_x;
	const orig_y = obj.pos_y;
	const orig_z = obj.pos_z;

	for ( let side = 0; side < MAX_SIDES_PER_SEGMENT; side ++ ) {

		const child = seg.children[ side ];
		if ( ! IS_CHILD( child ) ) continue;

		const center = compute_segment_center( child );
		const dx = center.x - obj.pos_x;
		const dy = center.y - obj.pos_y;
		const dz = center.z - obj.pos_z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist < 0.001 ) continue;

		// Move one radius toward that neighbor's center
		const invDist = 1.0 / dist;
		obj.pos_x = orig_x + dx * invDist * robotSize;
		obj.pos_y = orig_y + dy * invDist * robotSize;
		obj.pos_z = orig_z + dz * invDist * robotSize;

		const newSeg = find_point_seg( obj.pos_x, obj.pos_y, obj.pos_z, obj.segnum );
		if ( newSeg !== - 1 ) {

			obj.segnum = newSeg;

			// Update mesh position
			if ( robot.mesh !== null ) {

				robot.mesh.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );

			}

			return;

		}

		// Restore original position before trying next side
		obj.pos_x = orig_x;
		obj.pos_y = orig_y;
		obj.pos_z = orig_z;

	}

	// Couldn't find a legal spot — kill the robot
	// Ported from: AI.C line 1940 — apply_damage_to_robot(objp, objp->shields*2, ...)
	robot.alive = false;
	if ( robot.mesh !== null && robot.mesh.parent !== null ) {

		robot.mesh.parent.remove( robot.mesh );

	}

}

// Integrate robot velocity into position with FVI collision detection + wall sliding
// Ported from: PHYSICS.C do_physics_sim() wall-slide behavior
function ai_integrate_velocity( robot ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;

	// Skip if no significant velocity
	const speedSq = ailp.vel_x * ailp.vel_x + ailp.vel_y * ailp.vel_y + ailp.vel_z * ailp.vel_z;
	if ( speedSq < 0.0001 ) return;

	const robotSize = obj.size !== undefined ? obj.size : 3.0;
	let p0_x = obj.pos_x;
	let p0_y = obj.pos_y;
	let p0_z = obj.pos_z;
	let curSeg = obj.segnum;
	const MAX_ITERS = 3;
	let wallHits = 0;

	for ( let iter = 0; iter < MAX_ITERS; iter ++ ) {

		const remaining_dt = _dt * ( 1.0 - iter / MAX_ITERS );
		if ( remaining_dt < 0.0001 ) break;

		const p1_x = p0_x + ailp.vel_x * remaining_dt;
		const p1_y = p0_y + ailp.vel_y * remaining_dt;
		const p1_z = p0_z + ailp.vel_z * remaining_dt;

		const hit = find_vector_intersection(
			p0_x, p0_y, p0_z,
			p1_x, p1_y, p1_z,
			curSeg, robotSize * 0.8,
			- 1, 0
		);

		if ( hit.hit_type === HIT_NONE ) {

			// Moved unobstructed
			p0_x = hit.hit_pnt_x;
			p0_y = hit.hit_pnt_y;
			p0_z = hit.hit_pnt_z;
			if ( hit.hit_seg !== - 1 ) curSeg = hit.hit_seg;
			break;

		} else if ( hit.hit_type === HIT_WALL ) {

			wallHits ++;

			// Move to hit point
			p0_x = hit.hit_pnt_x;
			p0_y = hit.hit_pnt_y;
			p0_z = hit.hit_pnt_z;
			if ( hit.hit_seg !== - 1 ) curSeg = hit.hit_seg;

			// Robot-wall collision: Brain and run-from robots open doors
			// Ported from: collide_robot_and_wall() in COLLIDE.C lines 479-492
			if ( obj.id === ROBOT_BRAIN || ailp.behavior === AIB_RUN_FROM ) {

				const hitSeg = hit.hit_side_seg !== - 1 ? hit.hit_side_seg : curSeg;
				const hitSide = hit.hit_side;

				if ( hitSide >= 0 && hitSide < MAX_SIDES_PER_SEGMENT ) {

					const seg = Segments[ hitSeg ];
					if ( seg !== undefined ) {

						const wall_num = seg.sides[ hitSide ].wall_num;
						if ( wall_num !== - 1 && Walls[ wall_num ] !== undefined &&
							Walls[ wall_num ].type === WALL_DOOR &&
							Walls[ wall_num ].keys === KEY_NONE &&
							Walls[ wall_num ].state === WALL_DOOR_CLOSED &&
							( Walls[ wall_num ].flags & WALL_DOOR_LOCKED ) === 0 ) {

							wall_open_door( hitSeg, hitSide );

						}

					}

				}

			}

			// Wall sliding: remove velocity component along wall normal
			const nx = hit.hit_wallnorm_x;
			const ny = hit.hit_wallnorm_y;
			const nz = hit.hit_wallnorm_z;
			const wall_part = ailp.vel_x * nx + ailp.vel_y * ny + ailp.vel_z * nz;

			if ( wall_part < 0 ) {

				ailp.vel_x -= nx * wall_part;
				ailp.vel_y -= ny * wall_part;
				ailp.vel_z -= nz * wall_part;

			}

			continue; // Try remaining movement with slid velocity

		} else if ( hit.hit_type === HIT_BAD_P0 ) {

			// Try to recover segment
			const newSeg = find_point_seg( p0_x, p0_y, p0_z, curSeg );
			if ( newSeg !== - 1 ) {

				curSeg = newSeg;
				continue;

			}

			// Robot is outside mine — move toward segment center to recover
			// Ported from: AI.C line 1005 — move_towards_segment_center(objp)
			ailp.vel_x = 0;
			ailp.vel_y = 0;
			ailp.vel_z = 0;
			move_towards_segment_center( robot );
			return; // Position already updated by move_towards_segment_center

		} else {

			break;

		}

	}

	// Track wall-hit retries for stuck detection
	// Ported from: PHYSICS.C lines 1018-1025 + AI.C lines 2835-2887
	if ( wallHits > 0 ) {

		ailp.consecutive_retries += wallHits;

	} else {

		ailp.consecutive_retries = Math.floor( ailp.consecutive_retries / 2 );

	}

	// Update position and segment
	obj.pos_x = p0_x;
	obj.pos_y = p0_y;
	obj.pos_z = p0_z;
	obj.segnum = curSeg;

	// Update mesh position (Descent -> Three.js: negate Z)
	if ( robot.mesh !== null ) {

		robot.mesh.position.set( p0_x, p0_y, - p0_z );

	}

}

// ------- Melee Attack -------

// Melee attack — robot charges into player and claws them
// Ported from: do_ai_robot_hit_attack() in AI.C lines 1249-1277
// Calls collide_player_and_nasty_robot() via callback
function do_ai_robot_melee_attack( robot, params ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;
	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;

	// Damage scales with difficulty: F1_0 * (Difficulty_level + 1)
	// Ported from: COLLIDE.C collide_player_and_nasty_robot() line 1665
	const damage = d + 1;

	// Call melee attack callback (applies damage, plays sound, creates explosion)
	if ( _onMeleeAttack !== null ) {

		_onMeleeAttack( damage, params.claw_sound, obj.pos_x, obj.pos_y, obj.pos_z );

	}

	// Play attack sound at robot position (separate from claw_sound)
	if ( params.attack_sound !== - 1 ) {

		digi_play_sample_3d( params.attack_sound, 0.7, obj.pos_x, obj.pos_y, obj.pos_z );

	}

	// Set next fire time (cooldown)
	// Ported from: set_next_fire_time() in AI.C lines 1237-1246
	ailp.rapidfire_count ++;
	if ( params.rapidfire_count > 0 && ailp.rapidfire_count < params.rapidfire_count ) {

		// Short delay between burst attacks
		ailp.next_fire = Math.min( 0.125, params.firing_wait * 0.5 );

	} else {

		ailp.rapidfire_count = 0;
		ailp.next_fire = params.firing_wait;

	}

}

// ------- Firing -------

// Fire a laser at the player
// Ported from: ai_fire_laser_at_player() in AI.C lines 1299-1393
function ai_fire_at_player( robot, robotIndex, dir_x, dir_y, dir_z, params ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;

	// Get gun number for multi-gun robots
	const model_num = ( obj.rtype !== null ) ? obj.rtype.model_num : - 1;
	let n_guns = 0;

	if ( model_num >= 0 ) {

		const model = Polygon_models[ model_num ];
		if ( model !== null && model !== undefined ) {

			n_guns = model.n_guns;

		}

	}

	// Determine which gun to fire from
	let gun_num = 0;

	if ( n_guns > 1 ) {

		gun_num = ailp.current_gun % n_guns;

	}

	// Calculate fire position from gun point
	// Ported from: calc_gun_point() in ROBOT.C
	const gp = calc_gun_point( obj, gun_num );
	const fire_x = gp.x;
	const fire_y = gp.y;
	const fire_z = gp.z;

	// Verify fire point is in a valid segment
	const fireSeg = find_point_seg( fire_x, fire_y, fire_z, obj.segnum );

	if ( fireSeg === - 1 ) return;

	// Compute fire direction with difficulty-based inaccuracy and lead prediction
	// Ported from: ai_fire_laser_at_player() in AI.C lines 1335-1380
	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
	const inaccuracy = ( NDL - d - 1 );	// 4=no spread, 0=max spread

	// Get believed player position (with difficulty-based random spread)
	// Ported from: AI.C lines 1340-1342
	const pp = _getPlayerPos !== null ? _getPlayerPos() : null;
	let target_x, target_y, target_z;

	if ( pp !== null ) {

		const spread_scale = 0.06;
		target_x = pp.x + ( Math.random() - 0.5 ) * inaccuracy * spread_scale;
		target_y = pp.y + ( Math.random() - 0.5 ) * inaccuracy * spread_scale;
		target_z = pp.z + ( Math.random() - 0.5 ) * inaccuracy * spread_scale;

	} else {

		// Fallback: fire forward
		target_x = fire_x + obj.orient_fvec_x;
		target_y = fire_y + obj.orient_fvec_y;
		target_z = fire_z + obj.orient_fvec_z;

	}

	// Direction from gun to player
	let fire_dir_x = target_x - fire_x;
	let fire_dir_y = target_y - fire_y;
	let fire_dir_z = target_z - fire_z;

	// Lead-fire prediction: 50% chance to predict where player will be
	// Ported from: AI.C lines 1345-1380
	if ( Math.random() > 0.5 && _getPlayerVelocity !== null && pp !== null ) {

		const pv = _getPlayerVelocity();

		// Only lead if player is actually moving
		if ( Math.abs( pv.x ) > 1.0 || Math.abs( pv.y ) > 1.0 || Math.abs( pv.z ) > 1.0 ) {

			// Get weapon speed for this difficulty level
			const wt = params.weapon_type;
			let weapon_speed = 40.0;	// Default weapon speed

			if ( wt >= 0 && wt < Weapon_info.length ) {

				weapon_speed = Weapon_info[ wt ].speed[ d ];

			}

			// Compute time for weapon to reach player (distance / speed)
			const dist = Math.sqrt( fire_dir_x * fire_dir_x + fire_dir_y * fire_dir_y + fire_dir_z * fire_dir_z );

			if ( dist > 0.001 && weapon_speed > 0.001 ) {

				const time_to_reach = dist / weapon_speed;

				// Lead target: add predicted player movement
				fire_dir_x += pv.x * time_to_reach;
				fire_dir_y += pv.y * time_to_reach;
				fire_dir_z += pv.z * time_to_reach;

			}

		}

	}

	// Normalize fire direction
	const mag = Math.sqrt( fire_dir_x * fire_dir_x + fire_dir_y * fire_dir_y + fire_dir_z * fire_dir_z );

	if ( mag > 0.001 ) {

		const invMag = 1.0 / mag;
		fire_dir_x *= invMag;
		fire_dir_y *= invMag;
		fire_dir_z *= invMag;

	} else {

		fire_dir_x = obj.orient_fvec_x;
		fire_dir_y = obj.orient_fvec_y;
		fire_dir_z = obj.orient_fvec_z;

	}

	Laser_create_new(
		fire_dir_x, fire_dir_y, fire_dir_z,
		fire_x, fire_y, fire_z,
		fireSeg,
		PARENT_ROBOT,
		params.weapon_type
	);

	// Create muzzle flash vclip at gun barrel position
	// Ported from: LASER.C line 330 — object_create_muzzle_flash()
	const wt = params.weapon_type;
	if ( wt >= 0 && wt < Weapon_info.length ) {

		const wi = Weapon_info[ wt ];
		if ( wi.flash_vclip >= 0 && wi.flash_size > 0 ) {

			object_create_explosion( fire_x, fire_y, fire_z, wi.flash_size, wi.flash_vclip );

		}

	}

	// Cycle to next gun for multi-gun robots
	if ( n_guns > 1 ) {

		ailp.current_gun = ( ailp.current_gun + 1 ) % n_guns;

	}

	// Play firing sound at robot position (3D)
	digi_play_sample_3d( SOUND_LASER_FIRED, 0.5, fire_x, fire_y, fire_z );

	// Alert nearby robots that a robot fired
	// Ported from: AI.C line 1393
	create_awareness_event( obj.segnum, obj.pos_x, obj.pos_y, obj.pos_z, PA_NEARBY_ROBOT_FIRED );

	// Trigger fire animation
	ailp.goal_state = AIS_FIRE;

}
