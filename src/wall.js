// Ported from: descent-master/MAIN/WALL.H, WALL.C
// Wall system - doors, force fields, etc.

import {
	MAX_SIDES_PER_SEGMENT, IS_CHILD
} from './segment.js';
import { digi_play_sample_3d } from './digi.js';

// Wall types
export const WALL_NORMAL = 0;
export const WALL_BLASTABLE = 1;
export const WALL_DOOR = 2;
export const WALL_ILLUSION = 3;
export const WALL_OPEN = 4;
export const WALL_CLOSED = 5;

// Wall flags
export const WALL_BLASTED = 1;
export const WALL_DOOR_OPENED = 2;
export const WALL_DOOR_LOCKED = 8;
export const WALL_DOOR_AUTO = 16;
export const WALL_ILLUSION_OFF = 32;
export const WALL_WALL_SWITCH = 64;
export const WALL_BUDDY_PROOF = 128;

// Wall states
export const WALL_DOOR_CLOSED = 0;
export const WALL_DOOR_OPENING = 1;
export const WALL_DOOR_WAITING = 2;
export const WALL_DOOR_CLOSING = 3;

// Key types
export const KEY_NONE = 1;
export const KEY_BLUE = 2;
export const KEY_RED = 4;
export const KEY_GOLD = 8;

export const MAX_WALLS = 175;
export const MAX_DOORS = 50;
export const MAX_WALL_ANIMS = 30;
export const MAX_CLIP_FRAMES = 20;

// Wall clip flags
export const WCF_EXPLODES = 1;
export const WCF_BLASTABLE = 2;
export const WCF_TMAP1 = 4;
export const WCF_HIDDEN = 8;

// WALL_IS_DOORWAY flags (from WALL.H lines 149-161)
// Ported from: WID_FLY_FLAG, WID_RENDER_FLAG, WID_RENDPAST_FLAG etc.
export const WID_FLY_FLAG = 1;		// can fly through
export const WID_RENDER_FLAG = 2;	// should render
export const WID_RENDPAST_FLAG = 4;	// can see through

export const WID_WALL = 2;				// 0/1/0 — wall (render only)
export const WID_TRANSPARENT_WALL = 6;	// 0/1/1 — transparent wall (render + see through, no fly)
export const WID_ILLUSORY_WALL = 3;		// 1/1/0 — illusory wall (fly + render)
export const WID_TRANSILLUSORY_WALL = 7;	// 1/1/1 — transparent illusory (fly + render + see through)
export const WID_NO_WALL = 5;			// 1/0/1 — no wall (fly + see through)
export const WID_EXTERNAL = 8;			// external wall

// Door timing (in seconds, converted from fixed-point)
const DOOR_WAIT_TIME = 5.0;

export class Wall {

	constructor() {

		this.segnum = 0;
		this.sidenum = 0;
		this.hps = 0;			// hit points (fix -> float)
		this.linked_wall = - 1;
		this.type = 0;
		this.flags = 0;
		this.state = 0;
		this.trigger = - 1;
		this.clip_num = - 1;
		this.keys = 0;

	}

}

// Wall animation clip (wclip) - defines door animation sequence
export class WClip {

	constructor() {

		this.play_time = 0;		// total animation time in seconds
		this.num_frames = 0;
		this.frames = [];		// array of texture indices (tmap_num values)
		this.open_sound = - 1;
		this.close_sound = - 1;
		this.flags = 0;
		this.filename = '';

	}

}

// Active door - tracks a door currently in motion
export class ActiveDoor {

	constructor() {

		this.n_parts = 0;			// 1 or 2 (for linked walls)
		this.front_wallnum = [ - 1, - 1 ];
		this.back_wallnum = [ - 1, - 1 ];
		this.time = 0;				// elapsed time in seconds

	}

}

// Global arrays
export const WallAnims = [];
for ( let i = 0; i < MAX_WALL_ANIMS; i ++ ) {

	WallAnims.push( new WClip() );

}

export let Num_wall_anims = 0;
export function set_Num_wall_anims( n ) { Num_wall_anims = n; }

export const ActiveDoors = [];
for ( let i = 0; i < MAX_DOORS; i ++ ) {

	ActiveDoors.push( new ActiveDoor() );

}

export let Num_open_doors = 0;

export function wall_reset() {

	Num_open_doors = 0;

}

// Callback for updating door mesh textures in the renderer
// Set by main.js during init: fn(segnum, sidenum)
let _doorRenderCallback = null;

export function wall_set_render_callback( fn ) {

	_doorRenderCallback = fn;

}

// Late-bound references to avoid circular imports
// Set by wall_set_externals() called from main.js
let _Segments = null;
let _Walls = null;
let _Num_walls = 0;
let _FrameTime = null;
let _Vertices = null;
let _Side_to_verts = null;
let _checkObjectsInDoorway = null;	// (segnum, sidenum, csegnum, csidenum) => bool — true if objects are blocking
let _pigFile = null;	// PIG file reference for check_transparency
let _Textures = null;	// Textures[] table mapping tmap_num → PIG bitmap index

export function wall_set_externals( externals ) {

	_Segments = externals.Segments;
	_Walls = externals.Walls;
	_FrameTime = externals.getFrameTime;
	_Vertices = externals.Vertices;
	_Side_to_verts = externals.Side_to_verts;
	if ( externals.checkObjectsInDoorway !== undefined ) _checkObjectsInDoorway = externals.checkObjectsInDoorway;
	if ( externals.pigFile !== undefined ) _pigFile = externals.pigFile;
	if ( externals.Textures !== undefined ) _Textures = externals.Textures;

}

// Compute center point on a side (average of 4 vertices)
// Ported from: compute_side_center() in GAMESEG.C
// Pre-allocated result (Golden Rule #5)
const _side_cp = { x: 0, y: 0, z: 0 };

function compute_side_center( segnum, sidenum ) {

	const seg = _Segments[ segnum ];
	const sv = _Side_to_verts[ sidenum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 4; v ++ ) {

		const vi = seg.verts[ sv[ v ] ];
		cx += _Vertices[ vi * 3 + 0 ];
		cy += _Vertices[ vi * 3 + 1 ];
		cz += _Vertices[ vi * 3 + 2 ];

	}

	_side_cp.x = cx / 4;
	_side_cp.y = cy / 4;
	_side_cp.z = cz / 4;

	return _side_cp;

}

export function wall_update_num_walls( n ) {

	_Num_walls = n;

}

// Read a wall from file
// Ported from: descent-master/MAIN/GAMESAVE.C
export function read_wall( fp ) {

	const wall = new Wall();

	wall.segnum = fp.readInt();
	wall.sidenum = fp.readInt();
	wall.hps = fp.readFix();
	wall.linked_wall = fp.readInt();
	wall.type = fp.readUByte();
	wall.flags = fp.readUByte();
	wall.state = fp.readUByte();
	wall.trigger = fp.readByte();
	wall.clip_num = fp.readByte();
	wall.keys = fp.readUByte();

	// 2 bytes padding to keep longword aligned
	fp.readShort();

	return wall;

}

// Find which side of con_seg connects back to base_seg
// Ported from: find_connect_side() in GAMESEG.C
export function find_connect_side( base_segnum, con_segnum ) {

	const con_seg = _Segments[ con_segnum ];

	for ( let s = 0; s < MAX_SIDES_PER_SEGMENT; s ++ ) {

		if ( con_seg.children[ s ] === base_segnum ) {

			return s;

		}

	}

	return - 1;

}

// Set the texture on a door side (and its connected backside)
// Ported from: wall_set_tmap_num() in WALL.C
export function wall_set_tmap_num( segnum, side, csegnum, cside, anim_num, frame_num ) {

	const anim = WallAnims[ anim_num ];
	if ( anim.num_frames === 0 ) return;
	if ( frame_num >= anim.num_frames ) frame_num = anim.num_frames - 1;

	const tmap = anim.frames[ frame_num ];
	const seg = _Segments[ segnum ];
	const cseg = _Segments[ csegnum ];

	if ( ( anim.flags & WCF_TMAP1 ) !== 0 ) {

		// Primary texture mode
		seg.sides[ side ].tmap_num = tmap;
		cseg.sides[ cside ].tmap_num = tmap;

	} else {

		// Overlay texture mode (tmap_num2) - preserve rotation bits
		const rotation_front = seg.sides[ side ].tmap_num2 & 0xC000;
		const rotation_back = cseg.sides[ cside ].tmap_num2 & 0xC000;
		seg.sides[ side ].tmap_num2 = tmap | rotation_front;
		cseg.sides[ cside ].tmap_num2 = tmap | rotation_back;

	}

	// Notify renderer to update meshes
	if ( _doorRenderCallback !== null ) {

		_doorRenderCallback( segnum, side );
		_doorRenderCallback( csegnum, cside );

	}

}

// Open a door
// Ported from: wall_open_door() in WALL.C
export function wall_open_door( segnum, sidenum ) {

	const seg = _Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;

	if ( wall_num === - 1 ) return;

	const w = _Walls[ wall_num ];

	if ( w.type !== WALL_DOOR ) return;

	// Don't reopen if already opening or waiting
	if ( w.state === WALL_DOOR_OPENING ) return;
	if ( w.state === WALL_DOOR_WAITING ) return;

	let d;

	if ( w.state !== WALL_DOOR_CLOSED ) {

		// Door is in motion (closing) — reverse it
		d = null;
		for ( let i = 0; i < Num_open_doors; i ++ ) {

			d = ActiveDoors[ i ];
			if ( d.front_wallnum[ 0 ] === wall_num || d.back_wallnum[ 0 ] === wall_num ||
				( d.n_parts === 2 && ( d.front_wallnum[ 1 ] === wall_num || d.back_wallnum[ 1 ] === wall_num ) ) ) {

				break;

			}

		}

		if ( d !== null && w.clip_num >= 0 ) {

			// Reverse the timer
			d.time = WallAnims[ w.clip_num ].play_time - d.time;
			if ( d.time < 0 ) d.time = 0;

		}

	} else {

		// Create new active door
		if ( Num_open_doors >= MAX_DOORS ) return;

		d = ActiveDoors[ Num_open_doors ];
		d.time = 0;
		Num_open_doors ++;

	}

	w.state = WALL_DOOR_OPENING;

	// Set back wall to same state
	const child_segnum = seg.children[ sidenum ];
	if ( IS_CHILD( child_segnum ) !== true ) return;

	const connect_side = find_connect_side( segnum, child_segnum );
	if ( connect_side === - 1 ) return;

	const cseg = _Segments[ child_segnum ];
	const back_wall_num = cseg.sides[ connect_side ].wall_num;
	if ( back_wall_num !== - 1 ) {

		_Walls[ back_wall_num ].state = WALL_DOOR_OPENING;

	}

	d.front_wallnum[ 0 ] = wall_num;
	d.back_wallnum[ 0 ] = back_wall_num !== - 1 ? back_wall_num : wall_num;

	// Handle linked walls (2-part doors)
	if ( w.linked_wall !== - 1 ) {

		const w2 = _Walls[ w.linked_wall ];
		const seg2 = _Segments[ w2.segnum ];
		w2.state = WALL_DOOR_OPENING;

		const child2 = seg2.children[ w2.sidenum ];
		if ( IS_CHILD( child2 ) === true ) {

			const cside2 = find_connect_side( w2.segnum, child2 );
			if ( cside2 !== - 1 ) {

				const bw2 = _Segments[ child2 ].sides[ cside2 ].wall_num;
				if ( bw2 !== - 1 ) {

					_Walls[ bw2 ].state = WALL_DOOR_OPENING;

				}

				d.n_parts = 2;
				d.front_wallnum[ 1 ] = w.linked_wall;
				d.back_wallnum[ 1 ] = bw2 !== - 1 ? bw2 : w.linked_wall;

			}

		}

	} else {

		d.n_parts = 1;

	}

	// Play door open sound at side center position
	if ( w.clip_num >= 0 && WallAnims[ w.clip_num ].open_sound > - 1 ) {

		const cp = compute_side_center( segnum, sidenum );
		digi_play_sample_3d( WallAnims[ w.clip_num ].open_sound, 1.0, cp.x, cp.y, cp.z );

	}

}

// Process a single opening door
// Ported from: do_door_open() in WALL.C
function do_door_open( door_num ) {

	const d = ActiveDoors[ door_num ];
	const frameTime = _FrameTime();

	d.time += frameTime;

	for ( let p = 0; p < d.n_parts; p ++ ) {

		const w = _Walls[ d.front_wallnum[ p ] ];
		const seg = _Segments[ w.segnum ];
		const side = w.sidenum;
		const child_segnum = seg.children[ side ];

		if ( IS_CHILD( child_segnum ) !== true ) continue;

		const connect_side = find_connect_side( w.segnum, child_segnum );
		if ( connect_side === - 1 ) continue;

		if ( w.clip_num < 0 ) continue;

		const n = WallAnims[ w.clip_num ].num_frames;
		const time_total = WallAnims[ w.clip_num ].play_time;

		if ( n === 0 || time_total <= 0 ) continue;

		const one_frame = time_total / n;
		let i = Math.floor( d.time / one_frame );

		// Set texture to current frame
		if ( i < n ) {

			wall_set_tmap_num( w.segnum, side, child_segnum, connect_side, w.clip_num, i );

		}

		// Set OPENED flag when more than half way
		if ( i > Math.floor( n / 2 ) ) {

			const front_wn = seg.sides[ side ].wall_num;
			const cseg = _Segments[ child_segnum ];
			const back_wn = cseg.sides[ connect_side ].wall_num;

			if ( front_wn !== - 1 ) _Walls[ front_wn ].flags |= WALL_DOOR_OPENED;
			if ( back_wn !== - 1 ) _Walls[ back_wn ].flags |= WALL_DOOR_OPENED;

		}

		// Check if animation complete
		if ( i >= n - 1 ) {

			wall_set_tmap_num( w.segnum, side, child_segnum, connect_side, w.clip_num, n - 1 );

			const front_wn = seg.sides[ side ].wall_num;

			if ( ( _Walls[ front_wn ].flags & WALL_DOOR_AUTO ) === 0 ) {

				// Not auto-door: remove from active list
				remove_active_door( door_num );

			} else {

				// Auto-door: go to waiting state
				const cseg = _Segments[ child_segnum ];
				const back_wn = cseg.sides[ connect_side ].wall_num;

				_Walls[ front_wn ].state = WALL_DOOR_WAITING;
				if ( back_wn !== - 1 ) _Walls[ back_wn ].state = WALL_DOOR_WAITING;
				d.time = 0;	// Reset for waiting phase

			}

		}

	}

}

// Process a single closing door
// Ported from: do_door_close() in WALL.C
function do_door_close( door_num ) {

	const d = ActiveDoors[ door_num ];
	const w0 = _Walls[ d.front_wallnum[ 0 ] ];

	// Check for objects in doorway before closing (auto-doors only)
	// Ported from: WALL.C lines 671-694 — check_poke() for each object in both segments
	if ( ( w0.flags & WALL_DOOR_AUTO ) !== 0 && _checkObjectsInDoorway !== null ) {

		for ( let p = 0; p < d.n_parts; p ++ ) {

			const wp = _Walls[ d.front_wallnum[ p ] ];
			const segp = _Segments[ wp.segnum ];
			const sidep = wp.sidenum;
			const child_segnump = segp.children[ sidep ];

			if ( IS_CHILD( child_segnump ) !== true ) continue;

			const connect_sidep = find_connect_side( wp.segnum, child_segnump );
			if ( connect_sidep === - 1 ) continue;

			// Check objects in both adjacent segments
			if ( _checkObjectsInDoorway( wp.segnum, sidep, child_segnump, connect_sidep ) === true ) {

				return;		// abort close — object is in the doorway

			}

		}

	}

	const frameTime = _FrameTime();

	d.time += frameTime;

	for ( let p = 0; p < d.n_parts; p ++ ) {

		const w = _Walls[ d.front_wallnum[ p ] ];
		const seg = _Segments[ w.segnum ];
		const side = w.sidenum;
		const child_segnum = seg.children[ side ];

		if ( IS_CHILD( child_segnum ) !== true ) continue;

		const connect_side = find_connect_side( w.segnum, child_segnum );
		if ( connect_side === - 1 ) continue;

		if ( w.clip_num < 0 ) continue;

		const n = WallAnims[ w.clip_num ].num_frames;
		const time_total = WallAnims[ w.clip_num ].play_time;

		if ( n === 0 || time_total <= 0 ) continue;

		const one_frame = time_total / n;

		// Closing: count DOWN from n-1 to 0
		let i = n - Math.floor( d.time / one_frame ) - 1;

		// Clear OPENED flag when less than half way
		if ( i < Math.floor( n / 2 ) ) {

			const front_wn = seg.sides[ side ].wall_num;
			const cseg = _Segments[ child_segnum ];
			const back_wn = cseg.sides[ connect_side ].wall_num;

			if ( front_wn !== - 1 ) _Walls[ front_wn ].flags &= ~ WALL_DOOR_OPENED;
			if ( back_wn !== - 1 ) _Walls[ back_wn ].flags &= ~ WALL_DOOR_OPENED;

		}

		if ( i > 0 ) {

			wall_set_tmap_num( w.segnum, side, child_segnum, connect_side, w.clip_num, i );

		} else {

			// Fully closed
			wall_close_door( door_num );
			return;	// door_num is now invalid after removal

		}

	}

}

// Close a door completely (reset to frame 0)
// Ported from: wall_close_door() in WALL.C
function wall_close_door( door_num ) {

	const d = ActiveDoors[ door_num ];

	for ( let p = 0; p < d.n_parts; p ++ ) {

		const w = _Walls[ d.front_wallnum[ p ] ];
		const seg = _Segments[ w.segnum ];
		const side = w.sidenum;
		const child_segnum = seg.children[ side ];

		if ( IS_CHILD( child_segnum ) !== true ) continue;

		const connect_side = find_connect_side( w.segnum, child_segnum );
		if ( connect_side === - 1 ) continue;

		// Reset states
		const front_wn = seg.sides[ side ].wall_num;
		const cseg = _Segments[ child_segnum ];
		const back_wn = cseg.sides[ connect_side ].wall_num;

		if ( front_wn !== - 1 ) {

			_Walls[ front_wn ].state = WALL_DOOR_CLOSED;
			_Walls[ front_wn ].flags &= ~ WALL_DOOR_OPENED;

		}

		if ( back_wn !== - 1 ) {

			_Walls[ back_wn ].state = WALL_DOOR_CLOSED;
			_Walls[ back_wn ].flags &= ~ WALL_DOOR_OPENED;

		}

		// Set texture to first frame (closed)
		if ( w.clip_num >= 0 ) {

			wall_set_tmap_num( w.segnum, side, child_segnum, connect_side, w.clip_num, 0 );

		}

	}

	remove_active_door( door_num );

}

// Remove an active door from the list
function remove_active_door( door_num ) {

	for ( let i = door_num; i < Num_open_doors - 1; i ++ ) {

		const src = ActiveDoors[ i + 1 ];
		const dst = ActiveDoors[ i ];
		dst.n_parts = src.n_parts;
		dst.front_wallnum[ 0 ] = src.front_wallnum[ 0 ];
		dst.front_wallnum[ 1 ] = src.front_wallnum[ 1 ];
		dst.back_wallnum[ 0 ] = src.back_wallnum[ 0 ];
		dst.back_wallnum[ 1 ] = src.back_wallnum[ 1 ];
		dst.time = src.time;

	}

	Num_open_doors --;

}

// Process all active doors per frame
// Ported from: wall_frame_process() in WALL.C
// Called once per frame from game_loop
export function wall_frame_process() {

	let i = 0;

	while ( i < Num_open_doors ) {

		const d = ActiveDoors[ i ];
		const w = _Walls[ d.front_wallnum[ 0 ] ];
		const prevCount = Num_open_doors;

		if ( w.state === WALL_DOOR_OPENING ) {

			do_door_open( i );

		} else if ( w.state === WALL_DOOR_CLOSING ) {

			do_door_close( i );

		} else if ( w.state === WALL_DOOR_WAITING ) {

			d.time += _FrameTime();

			if ( d.time > DOOR_WAIT_TIME ) {

				w.state = WALL_DOOR_CLOSING;
				d.time = 0;

				// Play door close sound at side center position
				if ( w.clip_num >= 0 && WallAnims[ w.clip_num ].close_sound > - 1 ) {

					const cp = compute_side_center( w.segnum, w.sidenum );
					digi_play_sample_3d( WallAnims[ w.clip_num ].close_sound, 1.0, cp.x, cp.y, cp.z );

				}

			}

		}

		// Only advance index if a door wasn't removed
		if ( Num_open_doors >= prevCount ) {

			i ++;

		}

	}

}

// Initialize all door sides to their wall clip's frame 0
// In the original C code, bm_read_wclip() calls wall_set_tmap_num(..., 0) for each door
// to ensure the side texture matches the animation's first frame.
// The level file may store texture indices from the registered version that don't match
// our shareware wall clip frame indices, so we must re-initialize them.
export function wall_init_door_textures() {

	if ( _Walls === null || _Segments === null ) return;

	let count = 0;

	for ( let i = 0; i < _Walls.length; i ++ ) {

		const w = _Walls[ i ];
		if ( w.type !== WALL_DOOR ) continue;
		if ( w.clip_num < 0 || w.clip_num >= MAX_WALL_ANIMS ) continue;

		const anim = WallAnims[ w.clip_num ];
		if ( anim.num_frames === 0 ) continue;

		const seg = _Segments[ w.segnum ];
		const child_segnum = seg.children[ w.sidenum ];
		if ( IS_CHILD( child_segnum ) !== true ) continue;

		const connect_side = find_connect_side( w.segnum, child_segnum );
		if ( connect_side === - 1 ) continue;

		wall_set_tmap_num( w.segnum, w.sidenum, child_segnum, connect_side, w.clip_num, 0 );
		count ++;

	}

	console.log( 'WALL: Initialized ' + count + ' door textures to clip frame 0' );

}

// Illusion wall control
// Ported from: wall_illusion_off() / wall_illusion_on() in WALL.C
// When illusion OFF: wall becomes invisible and fully passable
// When illusion ON: wall is visible (but still passable — it's an illusion!)

let _illusionCallback = null;

export function wall_set_illusion_callback( fn ) {

	_illusionCallback = fn;

}

// Blastable wall constants
const WALL_HPS = 100.0;	// Default wall hit points (100 * F1_0 in original)

// Damage a blastable wall
// Ported from: wall_damage() in WALL.C
export function wall_damage( segnum, sidenum, damage ) {

	if ( _Segments === null || _Walls === null ) return;

	const seg = _Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return;

	const w = _Walls[ wall_num ];
	if ( w.type !== WALL_BLASTABLE ) return;
	if ( ( w.flags & WALL_BLASTED ) !== 0 ) return;

	const child_segnum = seg.children[ sidenum ];
	if ( IS_CHILD( child_segnum ) !== true ) return;

	const connect_side = find_connect_side( segnum, child_segnum );
	if ( connect_side === - 1 ) return;

	const cseg = _Segments[ child_segnum ];
	const back_wn = cseg.sides[ connect_side ].wall_num;

	// Apply damage to both sides
	w.hps -= damage;
	if ( back_wn !== - 1 ) {

		_Walls[ back_wn ].hps -= damage;

	}

	// Check if wall should be destroyed
	if ( w.clip_num >= 0 && w.clip_num < MAX_WALL_ANIMS ) {

		const n = WallAnims[ w.clip_num ].num_frames;

		if ( n > 0 ) {

			if ( w.hps < WALL_HPS / n ) {

				// Wall destroyed
				blast_blastable_wall( segnum, sidenum );

			} else {

				// Show damage frame based on remaining health
				for ( let i = 0; i < n; i ++ ) {

					if ( w.hps < WALL_HPS * ( n - i ) / n ) {

						wall_set_tmap_num( segnum, sidenum, child_segnum, connect_side, w.clip_num, i );
						break;

					}

				}

			}

		} else {

			// No animation frames - just check health
			if ( w.hps <= 0 ) {

				blast_blastable_wall( segnum, sidenum );

			}

		}

	} else if ( w.hps <= 0 ) {

		blast_blastable_wall( segnum, sidenum );

	}

}

// Destroy a blastable wall completely
// Ported from: blast_blastable_wall() in WALL.C
function blast_blastable_wall( segnum, sidenum ) {

	if ( _Segments === null || _Walls === null ) return;

	const seg = _Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return;

	const w = _Walls[ wall_num ];

	const child_segnum = seg.children[ sidenum ];
	if ( IS_CHILD( child_segnum ) !== true ) return;

	const connect_side = find_connect_side( segnum, child_segnum );
	if ( connect_side === - 1 ) return;

	const cseg = _Segments[ child_segnum ];
	const back_wn = cseg.sides[ connect_side ].wall_num;

	// Check if this wall clip has WCF_EXPLODES flag
	// Ported from: blast_blastable_wall() in WALL.C lines 348-356
	const hasExplodes = ( w.clip_num >= 0 && w.clip_num < MAX_WALL_ANIMS &&
		( WallAnims[ w.clip_num ].flags & WCF_EXPLODES ) !== 0 );

	if ( hasExplodes !== true ) {

		// Non-exploding: Set texture to final frame immediately
		if ( w.clip_num >= 0 && w.clip_num < MAX_WALL_ANIMS ) {

			const n = WallAnims[ w.clip_num ].num_frames;
			if ( n > 0 ) {

				wall_set_tmap_num( segnum, sidenum, child_segnum, connect_side, w.clip_num, n - 1 );

			}

		}

	}

	// Mark wall as blasted (passable)
	w.flags |= WALL_BLASTED;
	if ( back_wn !== - 1 ) {

		_Walls[ back_wn ].flags |= WALL_BLASTED;

	}

	if ( hasExplodes === true ) {

		// Exploding wall: start progressive fireball cascade
		// Texture change happens at 75% of animation time (handled by do_exploding_wall_frame)
		if ( _onExplodeWall !== null ) {

			_onExplodeWall( segnum, sidenum );

		}

	} else {

		// Non-exploding: single explosion at wall center
		if ( _onWallExplosion !== null ) {

			const center = compute_side_center( segnum, sidenum );
			_onWallExplosion( center.x, center.y, center.z, 10.0 );

		}

	}

}

export function wall_illusion_off( segnum, sidenum ) {

	if ( _Segments === null || _Walls === null ) return;

	const seg = _Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return;

	// Set WALL_ILLUSION_OFF flag on this side
	_Walls[ wall_num ].flags |= WALL_ILLUSION_OFF;

	// Also set on the connected side
	const child_segnum = seg.children[ sidenum ];
	if ( IS_CHILD( child_segnum ) === true ) {

		const connect_side = find_connect_side( segnum, child_segnum );
		if ( connect_side !== - 1 ) {

			const cseg = _Segments[ child_segnum ];
			const back_wn = cseg.sides[ connect_side ].wall_num;
			if ( back_wn !== - 1 ) {

				_Walls[ back_wn ].flags |= WALL_ILLUSION_OFF;

			}

			if ( _illusionCallback !== null ) {

				_illusionCallback( child_segnum, connect_side, false );

			}

		}

	}

	if ( _illusionCallback !== null ) {

		_illusionCallback( segnum, sidenum, false );

	}

}

export function wall_illusion_on( segnum, sidenum ) {

	if ( _Segments === null || _Walls === null ) return;

	const seg = _Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return;

	// Clear WALL_ILLUSION_OFF flag on this side
	_Walls[ wall_num ].flags &= ~ WALL_ILLUSION_OFF;

	// Also clear on the connected side
	const child_segnum = seg.children[ sidenum ];
	if ( IS_CHILD( child_segnum ) === true ) {

		const connect_side = find_connect_side( segnum, child_segnum );
		if ( connect_side !== - 1 ) {

			const cseg = _Segments[ child_segnum ];
			const back_wn = cseg.sides[ connect_side ].wall_num;
			if ( back_wn !== - 1 ) {

				_Walls[ back_wn ].flags &= ~ WALL_ILLUSION_OFF;

			}

			if ( _illusionCallback !== null ) {

				_illusionCallback( child_segnum, connect_side, true );

			}

		}

	}

	if ( _illusionCallback !== null ) {

		_illusionCallback( segnum, sidenum, true );

	}

}

// Wall hit processing — checks keys before opening doors
// Ported from: wall_hit_process() in WALL.C
// Returns: 0 = no key (blocked), 1 = opened
// _playerKeys callback: () => { blue, red, gold }
// _showMessage callback: (msg) => void
let _playerKeys = null;
let _showMessage = null;

// Wall explosion callback: (pos_x, pos_y, pos_z, size) => void
// Called when a blastable wall is destroyed, to create explosion effect
let _onWallExplosion = null;

// Exploding wall callback: (segnum, sidenum) => void
// Called when a WCF_EXPLODES wall is destroyed, to start progressive fireball cascade
let _onExplodeWall = null;

export function wall_set_player_callbacks( getKeys, showMsg ) {

	_playerKeys = getKeys;
	_showMessage = showMsg;

}

export function wall_set_explosion_callback( fn ) {

	_onWallExplosion = fn;

}

export function wall_set_explode_wall_callback( fn ) {

	_onExplodeWall = fn;

}

export function wall_hit_process( segnum, sidenum ) {

	if ( _Segments === null || _Walls === null ) return 1;

	const seg = _Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return 1;

	const w = _Walls[ wall_num ];

	// Check key requirements
	if ( w.keys === KEY_BLUE ) {

		if ( _playerKeys === null || _playerKeys().blue !== true ) {

			if ( _showMessage !== null ) _showMessage( 'You need the BLUE key!' );
			return 0;

		}

	}

	if ( w.keys === KEY_RED ) {

		if ( _playerKeys === null || _playerKeys().red !== true ) {

			if ( _showMessage !== null ) _showMessage( 'You need the RED key!' );
			return 0;

		}

	}

	if ( w.keys === KEY_GOLD ) {

		if ( _playerKeys === null || _playerKeys().gold !== true ) {

			if ( _showMessage !== null ) _showMessage( 'You need the YELLOW key!' );
			return 0;

		}

	}

	// Check if locked (generic lock, not key-based)
	if ( w.type === WALL_DOOR ) {

		if ( ( w.flags & WALL_DOOR_LOCKED ) !== 0 ) {

			if ( _showMessage !== null ) _showMessage( 'This door is locked!' );
			return 0;

		}

	}

	// Try to open
	if ( w.type === WALL_DOOR ) {

		wall_open_door( segnum, sidenum );
		return 1;

	}

	// Blastable walls are handled by wall_damage() from weapon hits
	if ( w.type === WALL_BLASTABLE ) {

		return 0;	// Block passage until blasted

	}

	return 1;

}

// Toggle a wall — opens doors, destroys blastable walls
// Ported from: wall_toggle() in WALL.C
// Called by triggers via do_link()
export function wall_toggle( segnum, sidenum ) {

	if ( _Segments === null || _Walls === null ) return;

	const seg = _Segments[ segnum ];
	if ( seg === undefined ) return;

	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return;

	const w = _Walls[ wall_num ];

	if ( w.type === WALL_BLASTABLE ) {

		blast_blastable_wall( segnum, sidenum );
		return;

	}

	if ( w.type === WALL_DOOR && w.state === WALL_DOOR_CLOSED ) {

		wall_open_door( segnum, sidenum );

	}

}

// Check if a wall side has transparent textures
// Ported from: check_transparency() in WALL.C lines 175-188
function check_transparency( segnum, sidenum ) {

	if ( _pigFile === null || _Textures === null ) return 0;

	const seg = _Segments[ segnum ];
	const side = seg.sides[ sidenum ];
	const tmap2 = side.tmap_num2 & 0x3FFF;

	if ( tmap2 === 0 ) {

		// No overlay — check base texture for BM_FLAG_TRANSPARENT
		const bmIndex = _Textures[ side.tmap_num ];
		if ( bmIndex >= 0 && bmIndex < _pigFile.bitmapFlags.length ) {

			// Use bitmapFlags[] not bm.flags — flags may be masked by BM_FLAG_PAGED_OUT
			if ( ( _pigFile.bitmapFlags[ bmIndex ] & 1 ) !== 0 ) return 1;	// BM_FLAG_TRANSPARENT = 1

		}

		return 0;

	}

	// Has overlay — check overlay texture for BM_FLAG_SUPER_TRANSPARENT
	const bmIndex = _Textures[ tmap2 ];
	if ( bmIndex >= 0 && bmIndex < _pigFile.bitmapFlags.length ) {

		if ( ( _pigFile.bitmapFlags[ bmIndex ] & 2 ) !== 0 ) return 1;	// BM_FLAG_SUPER_TRANSPARENT = 2

	}

	return 0;

}

// WALL_IS_DOORWAY — returns WID flags indicating what can be done with a wall.
// Handles the WALL_IS_DOORWAY macro pre-checks inline.
// Ported from: WALL.H macro (line 211) + wall_is_doorway() in WALL.C lines 203-260
//
// Return values are composed bit flags:
//   WID_FLY_FLAG (1) — can fly/pass through
//   WID_RENDER_FLAG (2) — should render the wall
//   WID_RENDPAST_FLAG (4) — can see/render past the wall
//
// Common composed values:
//   WID_WALL (2) — solid wall (render only)
//   WID_TRANSPARENT_WALL (6) — grate/glass (render + see through)
//   WID_ILLUSORY_WALL (3) — illusion (fly + render)
//   WID_TRANSILLUSORY_WALL (7) — transparent illusion (fly + render + see through)
//   WID_NO_WALL (5) — open passage (fly + see through)
//   WID_EXTERNAL (8) — external boundary
export function wall_is_doorway( segnum, sidenum ) {

	if ( _Walls === null ) return WID_WALL;

	const seg = _Segments[ segnum ];

	// Macro pre-check: no child = solid boundary
	const child = seg.children[ sidenum ];

	if ( child === - 1 ) return WID_WALL;
	if ( child === - 2 ) return WID_EXTERNAL;

	const side = seg.sides[ sidenum ];

	// Macro pre-check: no wall data = open passage
	if ( side.wall_num === - 1 ) return WID_NO_WALL;

	const w = _Walls[ side.wall_num ];

	// WALL_OPEN: open doorway/trigger
	if ( w.type === WALL_OPEN ) return WID_NO_WALL;

	// WALL_ILLUSION: fake wall
	if ( w.type === WALL_ILLUSION ) {

		if ( ( w.flags & WALL_ILLUSION_OFF ) !== 0 ) return WID_NO_WALL;

		if ( check_transparency( segnum, sidenum ) !== 0 ) {

			return WID_TRANSILLUSORY_WALL;

		}

		return WID_ILLUSORY_WALL;

	}

	// WALL_BLASTABLE: destructible wall
	if ( w.type === WALL_BLASTABLE ) {

		if ( ( w.flags & WALL_BLASTED ) !== 0 ) return WID_TRANSILLUSORY_WALL;

		if ( check_transparency( segnum, sidenum ) !== 0 ) {

			return WID_TRANSPARENT_WALL;

		}

		return WID_WALL;

	}

	// WALL_DOOR: check opened flag first
	if ( ( w.flags & WALL_DOOR_OPENED ) !== 0 ) return WID_TRANSILLUSORY_WALL;

	// Opening door (partially open, can see through but not fly through)
	if ( w.type === WALL_DOOR && w.state === WALL_DOOR_OPENING ) {

		return WID_TRANSPARENT_WALL;

	}

	// Fallback: check transparency for grates/windows
	if ( check_transparency( segnum, sidenum ) !== 0 ) {

		return WID_TRANSPARENT_WALL;

	}

	return WID_WALL;

}
