// Ported from: descent-master/MAIN/FUELCEN.C
// Fuel centers, matcens (robot materialization centers)

import { Segments, Vertices } from './mglobal.js';
import { VCLIP_MORPHING_ROBOT } from './fireball.js';
import { Vclips } from './bm.js';
import { digi_play_sample_3d } from './digi.js';

// Segment special types (from SEGMENT.H)
export const SEGMENT_IS_NOTHING = 0;
export const SEGMENT_IS_FUELCEN = 1;
export const SEGMENT_IS_REPAIRCEN = 2;
export const SEGMENT_IS_CONTROLCEN = 3;
export const SEGMENT_IS_ROBOTMAKER = 4;

// Constants
const MAX_ROBOT_CENTERS = 20;
const MATCEN_LIFE_BASE = 30.0;		// seconds (30 - 2*Difficulty)
const ROBOT_GEN_TIME = 5.0;		// seconds base spawn timer
const NUM_EXTRY_ROBOTS = 15;		// Ported from: FUELCEN.C line 577 — extra robot slots beyond original count
let _getDifficultyLevel = null;		// callback from main.js

// RobotCenters[] — matcen static data loaded from level
const RobotCenters = [];
let Num_robot_centers = 0;

// Station[] — runtime state for each matcen
const Station = [];

// External callbacks (set via fuelcen_set_externals)
let _getPlayerPos = null;
let _spawnRobot = null;			// (segnum, robotType, pos_x, pos_y, pos_z) => robot
let _createExplosion = null;	// (x, y, z, size, vclipNum) => void
let _getFrameTime = null;
let _countRobotsFromMatcen = null;	// (matcenNum) => number of alive robots from this matcen
let _countLiveRobots = null;		// () => number of total alive robots
let _getOrgRobotCount = null;		// () => number of original robots placed in level
let _getPlayerSegnum = null;		// () => player's current segment number
let _damagePlayerMatcen = null;		// (damage) => void — damage player from matcen
let _damageRobotInSegment = null;	// (segnum) => true if robot was found and damaged

export function fuelcen_set_externals( ext ) {

	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.spawnRobot !== undefined ) _spawnRobot = ext.spawnRobot;
	if ( ext.createExplosion !== undefined ) _createExplosion = ext.createExplosion;
	if ( ext.getFrameTime !== undefined ) _getFrameTime = ext.getFrameTime;
	if ( ext.getDifficultyLevel !== undefined ) _getDifficultyLevel = ext.getDifficultyLevel;
	if ( ext.countRobotsFromMatcen !== undefined ) _countRobotsFromMatcen = ext.countRobotsFromMatcen;
	if ( ext.countLiveRobots !== undefined ) _countLiveRobots = ext.countLiveRobots;
	if ( ext.getOrgRobotCount !== undefined ) _getOrgRobotCount = ext.getOrgRobotCount;
	if ( ext.getPlayerSegnum !== undefined ) _getPlayerSegnum = ext.getPlayerSegnum;
	if ( ext.damagePlayerMatcen !== undefined ) _damagePlayerMatcen = ext.damagePlayerMatcen;
	if ( ext.damageRobotInSegment !== undefined ) _damageRobotInSegment = ext.damageRobotInSegment;

}

// Reset all fuel center state (called at start of level load)
// Ported from: fuelcen_reset() in FUELCEN.C lines 311-324
export function fuelcen_reset() {

	RobotCenters.length = 0;
	Station.length = 0;
	Num_robot_centers = 0;

}

// Initialize matcens from loaded level data
// matcens = array of { robot_flags, hit_points, interval, segnum, fuelcen_num }
export function fuelcen_init( matcens ) {

	RobotCenters.length = 0;
	Station.length = 0;
	Num_robot_centers = 0;

	if ( matcens === null || matcens === undefined ) return;

	for ( let i = 0; i < matcens.length; i ++ ) {

		const mc = matcens[ i ];

		// Copy static data
		RobotCenters.push( {
			robot_flags: mc.robot_flags,
			hit_points: mc.hit_points,
			interval: mc.interval,
			segnum: mc.segnum,
			fuelcen_num: mc.fuelcen_num
		} );

		// Compute segment center for spawn position
		const seg = Segments[ mc.segnum ];
		let cx = 0, cy = 0, cz = 0;

		for ( let v = 0; v < 8; v ++ ) {

			const vi = seg.verts[ v ];
			cx += Vertices[ vi * 3 + 0 ];
			cy += Vertices[ vi * 3 + 1 ];
			cz += Vertices[ vi * 3 + 2 ];

		}

		cx /= 8;
		cy /= 8;
		cz /= 8;

		// Create runtime state
		Station.push( {
			Type: SEGMENT_IS_ROBOTMAKER,
			segnum: mc.segnum,
			Flag: 0,			// 0 = waiting, 1 = morphing animation in progress
			Enabled: 0,			// 0 = disabled, 1 = enabled (activated by trigger)
			Lives: 3,			// number of times this can be triggered
			Capacity: 0,		// energy for spawning robots (each robot costs 1.0)
			MaxCapacity: 0,
			Timer: 0,			// accumulates time for spawn timing
			Disable_time: 0,	// time remaining until auto-disable
			Center_x: cx,		// pre-computed segment center
			Center_y: cy,
			Center_z: cz
		} );

	}

	Num_robot_centers = matcens.length;
	console.log( 'FUELCEN: Initialized ' + Num_robot_centers + ' robot centers' );

}

// Activate a matcen in a given segment
// Called when a TRIGGER_MATCEN trigger fires
// Ported from: trigger_matcen() in FUELCEN.C lines 443-484
export function trigger_matcen( segnum ) {

	// Find which matcen is in this segment
	let matcen_num = - 1;

	for ( let i = 0; i < Num_robot_centers; i ++ ) {

		if ( RobotCenters[ i ].segnum === segnum ) {

			matcen_num = i;
			break;

		}

	}

	if ( matcen_num === - 1 ) {

		console.warn( 'FUELCEN: No matcen found in segment ' + segnum );
		return;

	}

	const robotcen = Station[ matcen_num ];

	// Already enabled — don't re-trigger
	if ( robotcen.Enabled === 1 ) return;

	// Check remaining lives
	if ( robotcen.Lives <= 0 ) return;

	robotcen.Lives --;
	robotcen.Enabled = 1;
	robotcen.Timer = 1000.0;	// Force immediate spawn check (large value > top_time)
	const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
	robotcen.Capacity = d + 3;	// Refuel capacity
	robotcen.Disable_time = MATCEN_LIFE_BASE - 2 * d;	// Auto-disable timer

	console.log( 'FUELCEN: Matcen ' + matcen_num + ' triggered in seg ' + segnum +
		' (lives=' + robotcen.Lives + ', capacity=' + robotcen.Capacity + ')' );

}

// Process all matcens each frame
// Ported from: robotmaker_proc() in FUELCEN.C lines 584-784
export function fuelcen_frame_process() {

	if ( _getFrameTime === null ) return;

	const dt = _getFrameTime();

	for ( let i = 0; i < Num_robot_centers; i ++ ) {

		const robotcen = Station[ i ];

		// Skip disabled centers
		if ( robotcen.Enabled !== 1 ) continue;

		// Auto-disable timer
		if ( robotcen.Disable_time > 0 ) {

			robotcen.Disable_time -= dt;

			if ( robotcen.Disable_time <= 0 ) {

				robotcen.Enabled = 0;
				console.log( 'FUELCEN: Matcen ' + i + ' auto-disabled' );
				continue;

			}

		}

		// Check capacity
		if ( robotcen.Capacity <= 0 ) continue;

		// Global robot count limit — don't spawn if total alive robots >= original + extra slots
		// Ported from: FUELCEN.C line 637 — (num_robots_level - num_kills_level) >= (Gamesave_num_org_robots + Num_extry_robots)
		if ( _countLiveRobots !== null && _getOrgRobotCount !== null ) {

			const liveCount = _countLiveRobots();
			const maxRobots = _getOrgRobotCount() + NUM_EXTRY_ROBOTS;
			if ( liveCount >= maxRobots ) continue;

		}

		robotcen.Timer += dt;

		if ( robotcen.Flag === 0 ) {

			// Waiting state — check if it's time to start spawning
			// In single player: spawn time varies with distance to player
			let top_time = ROBOT_GEN_TIME;

			if ( _getPlayerPos !== null ) {

				const pp = _getPlayerPos();
				const dx = pp.x - robotcen.Center_x;
				const dy = pp.y - robotcen.Center_y;
				const dz = pp.z - robotcen.Center_z;
				const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

				top_time = Math.min( dist / 64.0 + Math.random() * 2.0 + 2.0, ROBOT_GEN_TIME );

			}

			if ( robotcen.Timer > top_time ) {

				// Whack any robot or player in the matcen segment before spawning
				// Ported from: FUELCEN.C lines 683-702
				let occupantFound = false;

				if ( _damageRobotInSegment !== null ) {

					if ( _damageRobotInSegment( robotcen.segnum ) === true ) {

						robotcen.Timer = top_time / 2;
						occupantFound = true;

					}

				}

				if ( occupantFound !== true && _getPlayerSegnum !== null && _damagePlayerMatcen !== null ) {

					if ( _getPlayerSegnum() === robotcen.segnum ) {

						_damagePlayerMatcen( 4.0 );
						robotcen.Timer = top_time / 2;
						occupantFound = true;

					}

				}

				if ( occupantFound !== true ) {

					// Start morphing effect
					if ( _createExplosion !== null ) {

						_createExplosion(
							robotcen.Center_x, robotcen.Center_y, robotcen.Center_z,
							4.0, VCLIP_MORPHING_ROBOT
						);

					}

					// Play matcen spawn sound
					// Ported from: FUELCEN.C line 712 — digi_link_sound_to_pos(Vclip[VCLIP_MORPHING_ROBOT].sound_num, ...)
					const morphVclip = Vclips[ VCLIP_MORPHING_ROBOT ];
					if ( morphVclip !== undefined && morphVclip.sound_num >= 0 ) {

						digi_play_sample_3d( morphVclip.sound_num, 0.8,
							robotcen.Center_x, robotcen.Center_y, robotcen.Center_z );

					}

					robotcen.Flag = 1;
					robotcen.Timer = 0;

				}

			}

		} else if ( robotcen.Flag === 1 ) {

			// Morphing state — wait for animation to finish, then spawn
			// VCLIP_MORPHING_ROBOT play time is typically ~1 second
			const MORPH_TIME = 0.5;	// Spawn halfway through animation

			if ( robotcen.Timer > MORPH_TIME ) {

				// Check per-matcen alive robot count limit
				// Ported from: FUELCEN.C lines 668-681 — count only robots from THIS matcen
				// Each matcen tracks robots via matcen_creator, limit = Difficulty_level + 3
				const d = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
				const maxPerMatcen = d + 3;
				let canSpawn = true;

				if ( _countRobotsFromMatcen !== null ) {

					const count = _countRobotsFromMatcen( i );
					if ( count > maxPerMatcen ) {

						canSpawn = false;
						robotcen.Timer /= 2;

					}

				}

				if ( canSpawn === true ) {

					// Pick a random robot type from the flags bitmask
					const robotType = pickRobotType( RobotCenters[ i ].robot_flags );

					if ( robotType !== - 1 ) {

						// Spawn the robot, tagging it with this matcen's index
						if ( _spawnRobot !== null ) {

							_spawnRobot(
								robotcen.segnum, robotType,
								robotcen.Center_x, robotcen.Center_y, robotcen.Center_z,
								i
							);

						}

						robotcen.Capacity -= 1.0;

					}

				}

				robotcen.Flag = 0;
				robotcen.Timer = 0;

			}

		}

	}

}

// Pick a random robot type from the robot_flags bitmask
// Each bit position = robot type index
// Pre-allocated array to avoid per-call allocation (Golden Rule #5)
const _legalTypes = new Array( 32 );

function pickRobotType( flags ) {

	let count = 0;
	let f = flags >>> 0;	// treat as unsigned
	let index = 0;

	while ( f !== 0 ) {

		if ( ( f & 1 ) !== 0 ) {

			_legalTypes[ count ] = index;
			count ++;

		}

		f >>>= 1;
		index ++;

	}

	if ( count === 0 ) return - 1;

	if ( count === 1 ) return _legalTypes[ 0 ];

	return _legalTypes[ Math.floor( Math.random() * count ) ];

}
