// Ported from: descent-master/MAIN/AIPATH.C
// Robot AI pathfinding: BFS path computation, path following, line of sight

import { find_point_seg, compute_center_point_on_side, find_connect_side } from './gameseg.js';
import { find_vector_intersection, HIT_NONE, FQ_TRANSWALL } from './fvi.js';
import { Segments, Num_segments, Vertices, Walls } from './mglobal.js';
import { IS_CHILD, MAX_SIDES_PER_SEGMENT } from './segment.js';
import { wall_is_doorway, WID_FLY_FLAG, WALL_DOOR, WALL_DOOR_LOCKED, KEY_NONE } from './wall.js';

// Pathfinding constants (from AISTRUCT.H / AI.H)
const MAX_PATH_LENGTH = 30;
const MAX_DEPTH_TO_SEARCH = 10;
const MAX_POINT_SEGS = 2500;

// Mode/behavior constants (duplicated from ai.js to avoid circular imports)
const AIM_HIDE = 8;
const AIM_STILL = 0;
const AIB_HIDE = 0x82;
const AISM_HIDING = 1;

// ------- Pathfinding global storage -------
// Ported from: AIPATH.C — Point_segs is a flat array storing all robot paths back-to-back
// Each entry: { segnum, point_x, point_y, point_z }
// Pre-allocate to avoid GC pressure (Golden Rule #5)
const Point_segs = [];

for ( let i = 0; i < MAX_POINT_SEGS; i ++ ) {

	Point_segs.push( { segnum: 0, point_x: 0, point_y: 0, point_z: 0 } );

}

let Point_segs_free_index = 0;

// BFS working arrays (pre-allocated, reused across calls)
const _visited = new Uint8Array( 1000 );	// Max segments we can handle
const _queue_start = new Int16Array( 2500 );
const _queue_end = new Int16Array( 2500 );
const _queue_depth = new Int16Array( 2500 );
const _path_segs = new Int16Array( MAX_PATH_LENGTH * 2 + 4 );	// Extra room for center-point insertion

// Random side ordering for exploration paths (pre-allocated, Golden Rule #5)
// Ported from: create_random_xlate() in AIPATH.C
const _random_xlate = new Int16Array( MAX_SIDES_PER_SEGMENT );

// Compute segment center (pre-allocated result, Golden Rule #5)
const _segCenter = { x: 0, y: 0, z: 0 };

export function compute_segment_center( segnum ) {

	const seg = Segments[ segnum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 8; v ++ ) {

		const vi = seg.verts[ v ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	_segCenter.x = cx / 8;
	_segCenter.y = cy / 8;
	_segCenter.z = cz / 8;

	return _segCenter;

}

// Shuffle side ordering for random exploration paths
// Ported from: create_random_xlate() in AIPATH.C
function create_random_xlate() {

	for ( let i = 0; i < MAX_SIDES_PER_SEGMENT; i ++ ) {

		_random_xlate[ i ] = i;

	}

	// Fisher-Yates shuffle
	for ( let i = MAX_SIDES_PER_SEGMENT - 1; i > 0; i -- ) {

		const j = Math.floor( Math.random() * ( i + 1 ) );
		const tmp = _random_xlate[ i ];
		_random_xlate[ i ] = _random_xlate[ j ];
		_random_xlate[ j ] = tmp;

	}

}

// BFS pathfinding through segment graph
// Ported from: create_path_points() in AIPATH.C lines 247-446
// random_flag: if true, randomize side exploration order (for varied paths)
// avoid_seg: segment to avoid (-1 = none)
// end_seg === -2: random exploration (no specific target, just explore max_depth segments)
// can_open_doors: if true, treat closed but openable doors as passable (for brain/run-from robots)
// Returns number of waypoints stored, or 0 on failure
function create_path_points( start_seg, end_seg, max_depth, random_flag, avoid_seg, can_open_doors ) {

	if ( start_seg < 0 ) return 0;
	if ( end_seg < - 2 ) return 0;	// -2 = random exploration, -1 = invalid, >=0 = target
	if ( end_seg >= 0 && start_seg === end_seg ) return 0;
	if ( start_seg >= Num_segments ) return 0;
	if ( end_seg >= 0 && end_seg >= Num_segments ) return 0;

	const is_random = ( end_seg === - 2 );

	if ( max_depth <= 0 ) max_depth = MAX_DEPTH_TO_SEARCH;

	// Clear visited array
	const numSegs = Num_segments;
	for ( let i = 0; i < numSegs; i ++ ) {

		_visited[ i ] = 0;

	}

	if ( avoid_seg >= 0 && avoid_seg < numSegs ) {

		_visited[ avoid_seg ] = 1;

	}

	// BFS initialization
	_visited[ start_seg ] = 1;
	let qhead = 0;
	let qtail = 0;
	let cur_seg = start_seg;
	let cur_depth = 0;
	let found = false;

	// For random exploration, generate random side ordering
	if ( random_flag === true ) {

		create_random_xlate();

	}

	// BFS loop
	while ( is_random === true || cur_seg !== end_seg ) {

		const segp = Segments[ cur_seg ];

		// Explore all 6 sides of current segment
		for ( let si = 0; si < MAX_SIDES_PER_SEGMENT; si ++ ) {

			const sidenum = ( random_flag === true ) ? _random_xlate[ si ] : si;
			const child = segp.children[ sidenum ];

			// Check if there's a connected segment on this side
			if ( IS_CHILD( child ) !== true ) continue;
			if ( child >= numSegs ) continue;
			if ( _visited[ child ] === 1 ) continue;

			// Check if passage is open (no wall, or door that can be opened)
			// Ported from: AIPATH.C line 314 — check WID_FLY_FLAG || ai_door_is_openable()
			const side = segp.sides[ sidenum ];

			if ( side.wall_num !== - 1 ) {

				// Has a wall — check if passable using wall_is_doorway (WID_FLY_FLAG check)
				if ( ( wall_is_doorway( cur_seg, sidenum ) & WID_FLY_FLAG ) === 0 ) {

					// Not passable — but robots that can open doors treat closed, key-less,
					// unlocked doors as passable for pathfinding purposes
					// Ported from: ai_door_is_openable() in AI.C lines 1983-2004
					if ( can_open_doors === true ) {

						const w = Walls[ side.wall_num ];
						if ( w !== undefined && w.type === WALL_DOOR &&
							w.keys === KEY_NONE &&
							( w.flags & WALL_DOOR_LOCKED ) === 0 ) {

							// Door is openable — allow pathfinding through it

						} else {

							continue;

						}

					} else {

						continue;

					}

				}

			}

			_queue_start[ qtail ] = cur_seg;
			_queue_end[ qtail ] = child;
			_queue_depth[ qtail ] = cur_depth + 1;
			_visited[ child ] = 1;
			qtail ++;

			// Check if we reached the target or max depth
			if ( is_random !== true && child === end_seg ) {

				found = true;
				break;

			}

			if ( cur_depth + 1 >= max_depth ) {

				// Use the last segment we can reach
				end_seg = child;
				found = true;
				break;

			}

		}

		if ( found === true ) break;

		// Advance to next in queue
		if ( qhead >= qtail ) {

			// Dead end — use furthest segment reached
			if ( qtail > 0 ) {

				end_seg = _queue_end[ qtail - 1 ];

			} else {

				return 0;	// No path possible

			}

			break;

		}

		cur_seg = _queue_end[ qhead ];
		cur_depth = _queue_depth[ qhead ];
		qhead ++;

	}

	// Backtrack to build path from end_seg to start_seg
	let path_length = 0;
	cur_seg = end_seg;
	_path_segs[ path_length ] = cur_seg;
	path_length ++;

	// Walk backwards through the BFS queue to find the path
	for ( let q = qtail - 1; q >= 0; q -- ) {

		if ( _queue_end[ q ] === cur_seg ) {

			cur_seg = _queue_start[ q ];
			_path_segs[ path_length ] = cur_seg;
			path_length ++;

			if ( cur_seg === start_seg ) break;
			if ( path_length >= MAX_PATH_LENGTH ) break;

		}

	}

	// Reverse the path (currently end→start, need start→end)
	for ( let i = 0; i < path_length / 2; i ++ ) {

		const j = path_length - 1 - i;
		const tmp = _path_segs[ i ];
		_path_segs[ i ] = _path_segs[ j ];
		_path_segs[ j ] = tmp;

	}

	return path_length;

}

// Store path from _path_segs into Point_segs with proper waypoints
// If insert_centers is true, inserts side-center waypoints between segment centers
// Ported from: insert_center_points() in AIPATH.C lines 192-227
// Returns starting index in Point_segs, or -1 on failure
function store_path_in_point_segs( ailp, pathLen, insert_centers ) {

	// Calculate final length: with center-points, each pair gets an intermediate point
	const finalLen = ( insert_centers === true && pathLen >= 2 ) ? ( pathLen * 2 - 1 ) : pathLen;

	// Check if we have room in Point_segs
	if ( Point_segs_free_index + finalLen > MAX_POINT_SEGS ) {

		// Try garbage collection to free space
		ai_path_garbage_collect();

		// If still not enough room after GC, reset all paths
		if ( Point_segs_free_index + finalLen > MAX_POINT_SEGS ) {

			ai_reset_all_paths();

		}

	}

	// Store path in Point_segs
	ailp.hide_index = Point_segs_free_index;
	ailp.path_length = finalLen;
	ailp.cur_path_index = 0;
	ailp.PATH_DIR = 1;

	if ( insert_centers === true && pathLen >= 2 ) {

		// Store with center-point insertion
		// For each consecutive pair of segments (A, B), store:
		//   segment_center(A), side_center(A→B), segment_center(B)
		let outIdx = 0;

		for ( let i = 0; i < pathLen; i ++ ) {

			const segnum = _path_segs[ i ];

			// Store segment center
			const ps = Point_segs[ Point_segs_free_index + outIdx ];
			ps.segnum = segnum;
			compute_segment_center( segnum );
			ps.point_x = _segCenter.x;
			ps.point_y = _segCenter.y;
			ps.point_z = _segCenter.z;
			outIdx ++;

			// Insert side-center waypoint between this segment and next
			if ( i < pathLen - 1 ) {

				const next_segnum = _path_segs[ i + 1 ];
				const connect_side = find_connect_side( segnum, next_segnum );

				const ps2 = Point_segs[ Point_segs_free_index + outIdx ];
				ps2.segnum = next_segnum;	// Belongs to next segment (same as C code)

				if ( connect_side !== - 1 ) {

					// Compute side center with slight offset toward previous segment center
					// Ported from: C code line 222-225:
					//   new_point = (prev_center - side_center) / 16
					//   result = side_center - new_point
					const sc = compute_center_point_on_side( segnum, connect_side );
					const sc_x = sc.x, sc_y = sc.y, sc_z = sc.z;

					// _segCenter still has segment center from above
					const off_x = ( _segCenter.x - sc_x ) / 16;
					const off_y = ( _segCenter.y - sc_y ) / 16;
					const off_z = ( _segCenter.z - sc_z ) / 16;

					ps2.point_x = sc_x - off_x;
					ps2.point_y = sc_y - off_y;
					ps2.point_z = sc_z - off_z;

				} else {

					// Fallback: use next segment center
					compute_segment_center( next_segnum );
					ps2.point_x = _segCenter.x;
					ps2.point_y = _segCenter.y;
					ps2.point_z = _segCenter.z;

				}

				outIdx ++;

			}

		}

	} else {

		// Simple path: just segment centers
		for ( let i = 0; i < pathLen; i ++ ) {

			const segnum = _path_segs[ i ];
			const ps = Point_segs[ Point_segs_free_index + i ];
			ps.segnum = segnum;

			compute_segment_center( segnum );
			ps.point_x = _segCenter.x;
			ps.point_y = _segCenter.y;
			ps.point_z = _segCenter.z;

		}

	}

	const startIdx = Point_segs_free_index;
	Point_segs_free_index += finalLen;
	return startIdx;

}

// Create a path from robot to player and store in Point_segs
// Ported from: create_path_to_player() in AIPATH.C lines 588-642
export function create_path_to_player( robot, start_seg, end_seg, can_open_doors, max_length ) {

	const ailp = robot.aiLocal;

	const depth = ( max_length !== undefined && max_length > 0 ) ? max_length : MAX_DEPTH_TO_SEARCH;
	const pathLen = create_path_points( start_seg, end_seg, depth, true, - 1, can_open_doors === true );

	if ( pathLen === 0 ) {

		ailp.path_length = 0;
		return;

	}

	store_path_in_point_segs( ailp, pathLen, true );
	ailp.goal_segment = end_seg;

	maybe_ai_path_garbage_collect();

}

// Create a path from robot back to its station (hide_segment)
// Ported from: create_path_to_station() in AIPATH.C lines 650-693
export function create_path_to_station( robot, max_length ) {

	const ailp = robot.aiLocal;
	const hide_segment = ailp.hide_segment;

	if ( hide_segment < 0 || hide_segment >= Num_segments ) {

		ailp.path_length = 0;
		return;

	}

	if ( max_length < 0 ) max_length = MAX_DEPTH_TO_SEARCH;

	const obj = robot.obj;
	const start_seg = obj.segnum;

	if ( start_seg === hide_segment ) {

		ailp.path_length = 0;
		return;

	}

	const pathLen = create_path_points( start_seg, hide_segment, max_length, true, - 1 );

	if ( pathLen === 0 ) {

		ailp.path_length = 0;
		return;

	}

	store_path_in_point_segs( ailp, pathLen, true );
	ailp.goal_segment = hide_segment;
	ailp.player_awareness_type = 0;

	maybe_ai_path_garbage_collect();

}

// Create a random exploration path of a given length
// Ported from: create_n_segment_path() in AIPATH.C lines 698-734
// avoid_seg: segment to avoid visiting (-1 = none)
export function create_n_segment_path( robot, path_length, avoid_seg, can_open_doors ) {

	const ailp = robot.aiLocal;
	const obj = robot.obj;
	const openDoors = ( can_open_doors === true );

	let pathLen = create_path_points( obj.segnum, - 2, path_length, true, avoid_seg, openDoors );

	if ( pathLen === 0 ) {

		// Try again without avoid_seg, reducing length
		let tryLen = path_length;
		while ( tryLen > 0 ) {

			tryLen --;
			pathLen = create_path_points( obj.segnum, - 2, tryLen, true, - 1, openDoors );
			if ( pathLen > 0 ) break;

		}

		if ( pathLen === 0 ) {

			ailp.path_length = 0;
			return;

		}

	}

	store_path_in_point_segs( ailp, pathLen, false );
	ailp.goal_segment = _path_segs[ pathLen - 1 ];

	maybe_ai_path_garbage_collect();

}

// Set robot velocity and orientation toward a goal point — velocity-based movement
// Ported from: ai_path_set_orient_and_vel() in AIPATH.C lines 1071-1128
// Instead of teleporting the robot, sets velocity toward the goal and lets
// ai_integrate_velocity() in ai.js handle the actual position update with collision
function ai_path_set_orient_and_vel( robot, goal_x, goal_y, goal_z, params, dt, ai_turn_towards_vector_fn, is_run_from ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;

	// Compute direction from current position to goal
	const dx = goal_x - obj.pos_x;
	const dy = goal_y - obj.pos_y;
	const dz = goal_z - obj.pos_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	if ( dist < 0.01 ) return;

	const invDist = 1.0 / dist;
	let norm_goal_x = dx * invDist;
	let norm_goal_y = dy * invDist;
	let norm_goal_z = dz * invDist;

	// Max speed — run-from robots get 1.5x speed boost
	// Ported from: AIPATH.C line 1083
	let max_speed = params.max_speed;
	if ( is_run_from === true ) max_speed = max_speed * 3 / 2;

	// Dot product of goal direction with current forward vector
	const fvec_x = obj.orient_fvec_x;
	const fvec_y = obj.orient_fvec_y;
	const fvec_z = obj.orient_fvec_z;
	const dot = norm_goal_x * fvec_x + norm_goal_y * fvec_y + norm_goal_z * fvec_z;

	// Blend current velocity toward goal direction
	// Ported from: AIPATH.C lines 1096-1106
	let vel_x = ailp.vel_x;
	let vel_y = ailp.vel_y;
	let vel_z = ailp.vel_z;

	if ( dot < - 15.0 / 16.0 ) {

		// Facing nearly opposite to goal — snap velocity to goal direction
		vel_x = norm_goal_x;
		vel_y = norm_goal_y;
		vel_z = norm_goal_z;

	} else {

		// Blend: velocity += goal_dir / 2
		vel_x += norm_goal_x / 2;
		vel_y += norm_goal_y / 2;
		vel_z += norm_goal_z / 2;

	}

	// Normalize blended velocity
	const vmag = Math.sqrt( vel_x * vel_x + vel_y * vel_y + vel_z * vel_z );
	if ( vmag > 0.001 ) {

		const invVmag = 1.0 / vmag;
		vel_x *= invVmag;
		vel_y *= invVmag;
		vel_z *= invVmag;

	}

	// Scale speed: slower when turning sharply (dot < 0 => speed_scale = -dot/4)
	// Ported from: AIPATH.C lines 1114-1118
	let speed_dot = dot;
	if ( speed_dot < 0 ) speed_dot = - speed_dot / 4;
	const speed_scale = max_speed * speed_dot;

	ailp.vel_x = vel_x * speed_scale;
	ailp.vel_y = vel_y * speed_scale;
	ailp.vel_z = vel_z * speed_scale;

	// Turn toward goal direction
	// Run-from robots use fastest difficulty turn time / 2
	// Ported from: AIPATH.C lines 1120-1123
	if ( is_run_from === true ) {

		ai_turn_towards_vector_fn( norm_goal_x, norm_goal_y, norm_goal_z, robot, params.turn_time / 2 );

	} else {

		ai_turn_towards_vector_fn( norm_goal_x, norm_goal_y, norm_goal_z, robot, params.turn_time );

	}

}

// Follow a computed path — move toward current waypoint, advance when close
// Ported from: ai_follow_path() in AIPATH.C lines 819-1053
export function ai_follow_path( robot, params, visibility, dt, ai_turn_towards_vector_fn ) {

	const obj = robot.obj;
	const ailp = robot.aiLocal;

	if ( ailp.hide_index < 0 || ailp.path_length === 0 ) return;

	// Hiding robots in AISM_HIDING submode don't follow paths — they stay put
	// Ported from: AIPATH.C line 875-876
	if ( ailp.submode === AISM_HIDING && ailp.behavior === AIB_HIDE ) return;

	// Get current waypoint
	const wpIndex = ailp.hide_index + ailp.cur_path_index;

	if ( wpIndex < 0 || wpIndex >= MAX_POINT_SEGS ) {

		ailp.path_length = 0;
		return;

	}

	const wp = Point_segs[ wpIndex ];
	const goal_x = wp.point_x;
	const goal_y = wp.point_y;
	const goal_z = wp.point_z;

	// Distance to current waypoint
	const dx = goal_x - obj.pos_x;
	const dy = goal_y - obj.pos_y;
	const dz = goal_z - obj.pos_z;
	const distToGoal = Math.sqrt( dx * dx + dy * dy + dz * dz );

	// Threshold: advance to next waypoint when close enough
	const threshold = params.max_speed * dt * 2 + 4.0;

	if ( distToGoal < threshold ) {

		// Advance to next waypoint
		ailp.cur_path_index += ailp.PATH_DIR;

		// Check bounds
		if ( ailp.cur_path_index >= ailp.path_length || ailp.cur_path_index < 0 ) {

			// Reached end of path — check mode-specific behavior
			// Ported from: AIPATH.C line 950 — run-from creates new escape path
			if ( ailp.mode_is_run_from === true ) {

				// Signal to ai.js that we need a new escape path
				ailp.needs_new_path = true;

			}

			// Hiding robots: reached hiding spot — switch to still and wait
			// Ported from: AIPATH.C line 979-981
			if ( ailp.mode === AIM_HIDE ) {

				ailp.mode = AIM_STILL;
				ailp.submode = AISM_HIDING;

			}

			ailp.path_length = 0;
			ailp.cur_path_index = 0;
			return;

		}

	}

	// Set velocity toward current waypoint using physics-based movement
	// Ported from: AIPATH.C line 1012 — ai_path_set_orient_and_vel()
	const is_run_from = ( ailp.mode_is_run_from === true );
	ai_path_set_orient_and_vel( robot, goal_x, goal_y, goal_z, params, dt, ai_turn_towards_vector_fn, is_run_from );

}

// ------- Line of sight -------

// Simple line-of-sight check using segment traversal
// Walk along the ray in steps, checking if each point is in a valid segment
// Check line of sight between two points using FVI ray intersection
// Ported from: player_is_visible_from_object() in AI.C lines 993-1035
// Uses find_vector_intersection with FQ_TRANSWALL to properly test
// visibility through the segment structure instead of step sampling.
// Returns true if the line is clear (no wall hit), false otherwise.
export function check_line_of_sight( x0, y0, z0, startSeg, x1, y1, z1 ) {

	if ( startSeg < 0 ) return false;

	const result = find_vector_intersection(
		x0, y0, z0,
		x1, y1, z1,
		startSeg,
		0.25,		// rad = F1_0/4 (small radius for visibility ray)
		- 1,		// thisobjnum = -1 (no object to ignore)
		FQ_TRANSWALL	// allow seeing through transparent walls
	);

	return ( result.hit_type === HIT_NONE );

}

// ---- Path garbage collection ----
// Ported from: ai_path_garbage_collect() in AIPATH.C lines 1134-1207
// Compacts Point_segs by removing unused entries and updating robot hide_index references

// Robots reference — set via aipath_set_externals()
let _gc_robots = null;
let _gc_frame_count = 0;
let _last_frame_garbage_collected = - 999;

export function aipath_set_externals( ext ) {

	if ( ext.robots !== undefined ) _gc_robots = ext.robots;

}

export function aipath_set_frame_count( f ) {

	_gc_frame_count = f;

}

// Pre-allocated sort buffer (Golden Rule #5)
const _gc_list = []; // { path_start, robotIndex }

function ai_path_garbage_collect() {

	_last_frame_garbage_collected = _gc_frame_count;

	if ( _gc_robots === null ) {

		Point_segs_free_index = 0;
		return;

	}

	// Build list of robots with active paths
	_gc_list.length = 0;

	for ( let r = 0; r < _gc_robots.length; r ++ ) {

		const robot = _gc_robots[ r ];
		if ( robot.alive !== true ) continue;
		if ( robot.aiLocal === undefined ) continue;

		const ailp = robot.aiLocal;

		if ( ailp.path_length > 0 ) {

			_gc_list.push( { path_start: ailp.hide_index, robotIndex: r } );

		}

	}

	// Sort by path_start (ascending) so we can compact in-place
	_gc_list.sort( ( a, b ) => a.path_start - b.path_start );

	// Compact: copy each path to the front of Point_segs
	let free_index = 0;

	for ( let i = 0; i < _gc_list.length; i ++ ) {

		const entry = _gc_list[ i ];
		const robot = _gc_robots[ entry.robotIndex ];
		const ailp = robot.aiLocal;
		const old_index = ailp.hide_index;

		ailp.hide_index = free_index;

		for ( let j = 0; j < ailp.path_length; j ++ ) {

			const src = Point_segs[ old_index + j ];
			const dst = Point_segs[ free_index ];
			dst.segnum = src.segnum;
			dst.point_x = src.point_x;
			dst.point_y = src.point_y;
			dst.point_z = src.point_z;
			free_index ++;

		}

	}

	Point_segs_free_index = free_index;

}

// Called after creating each path to check if garbage collection is needed
// Ported from: maybe_ai_path_garbage_collect() in AIPATH.C lines 1211-1234
// Three-tier thresholds: critical (95%), high (75%), normal (50%)
function maybe_ai_path_garbage_collect() {

	const used = Point_segs_free_index;

	if ( used > MAX_POINT_SEGS - MAX_PATH_LENGTH ) {

		// Critical: nearly full
		if ( _last_frame_garbage_collected + 1 >= _gc_frame_count ) {

			// Already GC'd recently — nuke all paths
			ai_reset_all_paths();

		} else {

			ai_path_garbage_collect();

		}

	} else if ( used > ( 3 * MAX_POINT_SEGS ) / 4 ) {

		// High: 75%+ full, GC if not done in last 16 frames
		if ( _last_frame_garbage_collected + 16 < _gc_frame_count ) {

			ai_path_garbage_collect();

		}

	} else if ( used > MAX_POINT_SEGS / 2 ) {

		// Normal: 50%+ full, GC if not done in last 256 frames
		if ( _last_frame_garbage_collected + 256 < _gc_frame_count ) {

			ai_path_garbage_collect();

		}

	}

}

// Reset all robot paths when Point_segs is critically full
// Ported from: ai_reset_all_paths() in AIPATH.C
function ai_reset_all_paths() {

	if ( _gc_robots !== null ) {

		for ( let r = 0; r < _gc_robots.length; r ++ ) {

			const robot = _gc_robots[ r ];
			if ( robot.alive !== true ) continue;
			if ( robot.aiLocal === undefined ) continue;

			robot.aiLocal.path_length = 0;
			robot.aiLocal.hide_index = - 1;

		}

	}

	Point_segs_free_index = 0;

}

// Reset pathfinding storage (called on level init)
export function aipath_reset() {

	Point_segs_free_index = 0;
	_last_frame_garbage_collected = - 999;

}
