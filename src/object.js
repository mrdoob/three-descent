// Ported from: descent-master/MAIN/OBJECT.H, OBJECT.C
// Object system - players, robots, weapons, powerups, etc.

// Object types
export const OBJ_NONE = 255;
export const OBJ_WALL = 0;
export const OBJ_FIREBALL = 1;
export const OBJ_ROBOT = 2;
export const OBJ_HOSTAGE = 3;
export const OBJ_PLAYER = 4;
export const OBJ_WEAPON = 5;
export const OBJ_CAMERA = 6;
export const OBJ_POWERUP = 7;
export const OBJ_DEBRIS = 8;
export const OBJ_CNTRLCEN = 9;
export const OBJ_FLARE = 10;
export const OBJ_CLUTTER = 11;
export const OBJ_GHOST = 12;
export const OBJ_LIGHT = 13;
export const OBJ_COOP = 14;

// Movement types
export const MT_NONE = 0;
export const MT_PHYSICS = 1;
export const MT_SPINNING = 3;

// Control types
export const CT_NONE = 0;
export const CT_AI = 1;
export const CT_EXPLOSION = 2;
export const CT_FLYING = 4;
export const CT_SLEW = 5;
export const CT_FLYTHROUGH = 6;
export const CT_WEAPON = 9;
export const CT_REPAIRCEN = 10;
export const CT_MORPH = 11;
export const CT_DEBRIS = 12;
export const CT_POWERUP = 13;
export const CT_LIGHT = 14;
export const CT_REMOTE = 15;
export const CT_CNTRLCEN = 16;

// Render types
export const RT_NONE = 0;
export const RT_POLYOBJ = 1;
export const RT_FIREBALL = 2;
export const RT_LASER = 3;
export const RT_HOSTAGE = 4;
export const RT_POWERUP = 5;
export const RT_MORPH = 6;
export const RT_WEAPON_VCLIP = 7;

// Physics flags
export const PF_TURNROLL = 0x01;
export const PF_LEVELLING = 0x02;
export const PF_BOUNCE = 0x04;
export const PF_WIGGLE = 0x08;
export const PF_STICK = 0x10;
export const PF_PERSISTENT = 0x20;
export const PF_USES_THRUST = 0x40;

// Object flags
export const OF_EXPLODING = 1;
export const OF_SHOULD_BE_DEAD = 2;
export const OF_DESTROYED = 4;
export const OF_SILENT = 8;
export const OF_ATTACHED = 16;

// Constants
export const MAX_OBJECTS = 350;
const MAX_AI_FLAGS = 11;
const MAX_SUBMODELS = 10;

export class PhysicsInfo {

	constructor() {

		// velocity (vms_vector) - as floats
		this.velocity_x = 0;
		this.velocity_y = 0;
		this.velocity_z = 0;

		// thrust (vms_vector)
		this.thrust_x = 0;
		this.thrust_y = 0;
		this.thrust_z = 0;

		this.mass = 0;
		this.drag = 0;
		this.brakes = 0;

		// rotational velocity (vms_vector)
		this.rotvel_x = 0;
		this.rotvel_y = 0;
		this.rotvel_z = 0;

		// rotational thrust (vms_vector)
		this.rotthrust_x = 0;
		this.rotthrust_y = 0;
		this.rotthrust_z = 0;

		this.turnroll = 0;	// fixang
		this.flags = 0;

	}

}

export class AIInfo {

	constructor() {

		this.behavior = 0;
		this.flags = new Int8Array( MAX_AI_FLAGS );
		this.hide_segment = 0;
		this.hide_index = 0;
		this.path_length = 0;
		this.cur_path_index = 0;
		this.follow_path_start_seg = 0;
		this.follow_path_end_seg = 0;

	}

}

export class PolyObjInfo {

	constructor() {

		this.model_num = 0;
		// anim_angles: array of MAX_SUBMODELS angvecs {p, b, h}
		this.anim_angles = [];
		for ( let i = 0; i < MAX_SUBMODELS; i ++ ) {

			this.anim_angles.push( { p: 0, b: 0, h: 0 } );

		}

		this.subobj_flags = 0;
		this.tmap_override = 0;

	}

}

export class VClipInfo {

	constructor() {

		this.vclip_num = 0;
		this.frametime = 0;
		this.framenum = 0;

	}

}

export class GameObject {

	constructor() {

		this.signature = 0;
		this.type = OBJ_NONE;
		this.id = 0;
		this.next = - 1;
		this.prev = - 1;
		this.control_type = CT_NONE;
		this.movement_type = MT_NONE;
		this.render_type = RT_NONE;
		this.flags = 0;
		this.segnum = 0;
		this.attached_obj = - 1;

		// Position (floats, converted from fixed-point)
		this.pos_x = 0;
		this.pos_y = 0;
		this.pos_z = 0;

		// Orientation matrix (3x3, stored as 9 floats: rvec, uvec, fvec)
		this.orient_rvec_x = 1;
		this.orient_rvec_y = 0;
		this.orient_rvec_z = 0;

		this.orient_uvec_x = 0;
		this.orient_uvec_y = 1;
		this.orient_uvec_z = 0;

		this.orient_fvec_x = 0;
		this.orient_fvec_y = 0;
		this.orient_fvec_z = 1;

		this.size = 0;		// collision radius
		this.shields = 0;	// hit points

		// Last position
		this.last_pos_x = 0;
		this.last_pos_y = 0;
		this.last_pos_z = 0;

		// Containment
		this.contains_type = 0;
		this.contains_id = 0;
		this.contains_count = 0;

		this.lifeleft = 0;

		// Movement data (union - set based on movement_type)
		this.mtype = null;

		// Control data (union - set based on control_type)
		this.ctype = null;

		// Render data (union - set based on render_type)
		this.rtype = null;

	}

}

// Read a vector (3 fix values = 12 bytes) from file, return {x, y, z} as floats
function readVector( fp ) {

	return {
		x: fp.readFix(),
		y: fp.readFix(),
		z: fp.readFix()
	};

}

// Read a 3x3 matrix (9 fix values = 36 bytes) from file
function readMatrix( fp ) {

	return {
		rvec: readVector( fp ),
		uvec: readVector( fp ),
		fvec: readVector( fp )
	};

}

// Read an angvec (3 fixang = 6 bytes) from file
function readAngVec( fp ) {

	return {
		p: fp.readShort(),
		b: fp.readShort(),
		h: fp.readShort()
	};

}

// Read a single object from file
// Ported from: descent-master/MAIN/GAMESAVE.C read_object() (lines 827-1018)
export function read_object( fp, version ) {

	const obj = new GameObject();

	// Basic object properties (6 bytes)
	obj.type = fp.readUByte();
	obj.id = fp.readUByte();
	obj.control_type = fp.readUByte();
	obj.movement_type = fp.readUByte();
	obj.render_type = fp.readUByte();
	obj.flags = fp.readUByte();

	// Segment and attached_obj
	obj.segnum = fp.readShort();
	obj.attached_obj = - 1;

	// Position (12 bytes)
	const pos = readVector( fp );
	obj.pos_x = pos.x;
	obj.pos_y = pos.y;
	obj.pos_z = pos.z;

	// Orientation matrix (36 bytes)
	const orient = readMatrix( fp );
	obj.orient_rvec_x = orient.rvec.x;
	obj.orient_rvec_y = orient.rvec.y;
	obj.orient_rvec_z = orient.rvec.z;
	obj.orient_uvec_x = orient.uvec.x;
	obj.orient_uvec_y = orient.uvec.y;
	obj.orient_uvec_z = orient.uvec.z;
	obj.orient_fvec_x = orient.fvec.x;
	obj.orient_fvec_y = orient.fvec.y;
	obj.orient_fvec_z = orient.fvec.z;

	// Size and shields (8 bytes)
	obj.size = fp.readFix();
	obj.shields = fp.readFix();

	// Last position (12 bytes)
	const last_pos = readVector( fp );
	obj.last_pos_x = last_pos.x;
	obj.last_pos_y = last_pos.y;
	obj.last_pos_z = last_pos.z;

	// Containment (3 bytes)
	obj.contains_type = fp.readByte();
	obj.contains_id = fp.readByte();
	obj.contains_count = fp.readByte();

	// Movement-type specific data
	switch ( obj.movement_type ) {

		case MT_PHYSICS: {

			const phys = new PhysicsInfo();
			const vel = readVector( fp );
			phys.velocity_x = vel.x;
			phys.velocity_y = vel.y;
			phys.velocity_z = vel.z;

			const thrust = readVector( fp );
			phys.thrust_x = thrust.x;
			phys.thrust_y = thrust.y;
			phys.thrust_z = thrust.z;

			phys.mass = fp.readFix();
			phys.drag = fp.readFix();
			phys.brakes = fp.readFix();

			const rotvel = readVector( fp );
			phys.rotvel_x = rotvel.x;
			phys.rotvel_y = rotvel.y;
			phys.rotvel_z = rotvel.z;

			const rotthrust = readVector( fp );
			phys.rotthrust_x = rotthrust.x;
			phys.rotthrust_y = rotthrust.y;
			phys.rotthrust_z = rotthrust.z;

			phys.turnroll = fp.readShort();
			phys.flags = fp.readUShort();

			obj.mtype = phys;
			break;

		}

		case MT_SPINNING: {

			const spin = readVector( fp );
			obj.mtype = { spin_x: spin.x, spin_y: spin.y, spin_z: spin.z };
			break;

		}

		case MT_NONE:
		default:
			break;

	}

	// Control-type specific data
	switch ( obj.control_type ) {

		case CT_AI: {

			const ai = new AIInfo();
			ai.behavior = fp.readByte();

			for ( let i = 0; i < MAX_AI_FLAGS; i ++ ) {

				ai.flags[ i ] = fp.readByte();

			}

			ai.hide_segment = fp.readShort();
			ai.hide_index = fp.readShort();
			ai.path_length = fp.readShort();
			ai.cur_path_index = fp.readShort();

			if ( version <= 25 ) {

				ai.follow_path_start_seg = fp.readShort();
				ai.follow_path_end_seg = fp.readShort();

			}

			obj.ctype = ai;
			break;

		}

		case CT_EXPLOSION: {

			obj.ctype = {
				spawn_time: fp.readFix(),
				delete_time: fp.readFix(),
				delete_objnum: fp.readShort(),
				next_attach: - 1,
				prev_attach: - 1,
				attach_parent: - 1
			};
			break;

		}

		case CT_WEAPON: {

			obj.ctype = {
				parent_type: fp.readShort(),
				parent_num: fp.readShort(),
				parent_signature: fp.readInt()
			};
			break;

		}

		case CT_LIGHT: {

			obj.ctype = {
				intensity: fp.readFix()
			};
			break;

		}

		case CT_POWERUP:
		case CT_REMOTE: {

			// CT_REMOTE is used for multiplayer powerups - the count field
			// is still written to the file when the object type is OBJ_POWERUP
			if ( version >= 25 ) {

				obj.ctype = {
					count: fp.readInt()
				};

			} else {

				obj.ctype = {
					count: 1
				};

			}

			break;

		}

		case CT_NONE:
		case CT_FLYING:
		case CT_DEBRIS:
		case CT_SLEW:
		case CT_CNTRLCEN:
		case CT_REPAIRCEN:
		case CT_MORPH:
		case CT_FLYTHROUGH:
		default:
			break;

	}

	// Render-type specific data
	switch ( obj.render_type ) {

		case RT_MORPH:
		case RT_POLYOBJ: {

			const pobj = new PolyObjInfo();
			pobj.model_num = fp.readInt();

			for ( let i = 0; i < MAX_SUBMODELS; i ++ ) {

				const ang = readAngVec( fp );
				pobj.anim_angles[ i ].p = ang.p;
				pobj.anim_angles[ i ].b = ang.b;
				pobj.anim_angles[ i ].h = ang.h;

			}

			pobj.subobj_flags = fp.readInt();
			pobj.tmap_override = fp.readInt();

			obj.rtype = pobj;
			break;

		}

		case RT_WEAPON_VCLIP:
		case RT_HOSTAGE:
		case RT_POWERUP:
		case RT_FIREBALL: {

			const vclip = new VClipInfo();
			vclip.vclip_num = fp.readInt();
			vclip.frametime = fp.readFix();
			vclip.framenum = fp.readUByte();

			obj.rtype = vclip;
			break;

		}

		case RT_LASER:
		case RT_NONE:
		default:
			break;

	}

	return obj;

}

// Object type name for debugging
export function objectTypeName( type ) {

	const names = [
		'WALL', 'FIREBALL', 'ROBOT', 'HOSTAGE', 'PLAYER',
		'WEAPON', 'CAMERA', 'POWERUP', 'DEBRIS', 'CNTRLCEN',
		'FLARE', 'CLUTTER', 'GHOST', 'LIGHT', 'COOP'
	];

	if ( type >= 0 && type < names.length ) return names[ type ];
	if ( type === 255 ) return 'NONE';
	return 'UNKNOWN(' + type + ')';

}

// ---- Objects[] pool and lifecycle functions ----
// Ported from: descent-master/MAIN/OBJECT.C lines 1022-1557

// Global object pool (pre-allocated, Golden Rule #5)
export const Objects = [];
for ( let i = 0; i < MAX_OBJECTS; i ++ ) {

	Objects.push( new GameObject() );

}

// Free list: free_obj_list[i] = object index that is free
// Objects are allocated from the front: free_obj_list[num_objects++]
const free_obj_list = new Int16Array( MAX_OBJECTS );

let num_objects = 0;
let Highest_object_index = 0;
let Object_next_signature = 0;
let Debris_object_count = 0;

export function get_num_objects() { return num_objects; }
export function get_Highest_object_index() { return Highest_object_index; }

// Reset a GameObject to its default (unused) state
// Used by init_objects and obj_create to zero out fields
function reset_object( obj ) {

	obj.signature = 0;
	obj.type = OBJ_NONE;
	obj.id = 0;
	obj.next = - 1;
	obj.prev = - 1;
	obj.control_type = CT_NONE;
	obj.movement_type = MT_NONE;
	obj.render_type = RT_NONE;
	obj.flags = 0;
	obj.segnum = - 1;
	obj.attached_obj = - 1;

	obj.pos_x = 0;
	obj.pos_y = 0;
	obj.pos_z = 0;

	obj.orient_rvec_x = 1;
	obj.orient_rvec_y = 0;
	obj.orient_rvec_z = 0;
	obj.orient_uvec_x = 0;
	obj.orient_uvec_y = 1;
	obj.orient_uvec_z = 0;
	obj.orient_fvec_x = 0;
	obj.orient_fvec_y = 0;
	obj.orient_fvec_z = 1;

	obj.size = 0;
	obj.shields = 0;

	obj.last_pos_x = 0;
	obj.last_pos_y = 0;
	obj.last_pos_z = 0;

	obj.contains_type = 0;
	obj.contains_id = 0;
	obj.contains_count = 0;

	obj.lifeleft = 0;

	obj.mtype = null;
	obj.ctype = null;
	obj.rtype = null;

}

// Segments reference (injected to avoid circular imports)
let _Segments = null;
let _Highest_segment_index = 0;

export function obj_set_segments( segments, getHighestSegIdx ) {

	_Segments = segments;
	_getHighestSegIdx = getHighestSegIdx;

}

let _getHighestSegIdx = () => 0;

// Initialize the object pool and free list
// Ported from: init_objects() in OBJECT.C lines 1023-1047
export function init_objects() {

	for ( let i = 0; i < MAX_OBJECTS; i ++ ) {

		free_obj_list[ i ] = i;
		reset_object( Objects[ i ] );

	}

	// Clear all segment object lists
	if ( _Segments !== null ) {

		const highSeg = _getHighestSegIdx();
		for ( let i = 0; i <= highSeg; i ++ ) {

			_Segments[ i ].objects = - 1;

		}

	}

	num_objects = 0;
	Highest_object_index = 0;
	Object_next_signature = 0;
	Debris_object_count = 0;

}

// Link an object into the per-segment doubly-linked list
// Ported from: obj_link() in OBJECT.C lines 1185-1214
export function obj_link( objnum, segnum ) {

	const obj = Objects[ objnum ];

	obj.segnum = segnum;
	obj.next = _Segments[ segnum ].objects;
	obj.prev = - 1;

	_Segments[ segnum ].objects = objnum;

	if ( obj.next !== - 1 ) {

		Objects[ obj.next ].prev = objnum;

	}

}

// Unlink an object from its segment's object list
// Ported from: obj_unlink() in OBJECT.C lines 1216-1234
export function obj_unlink( objnum ) {

	const obj = Objects[ objnum ];
	const seg = _Segments[ obj.segnum ];

	if ( obj.prev === - 1 ) {

		seg.objects = obj.next;

	} else {

		Objects[ obj.prev ].next = obj.next;

	}

	if ( obj.next !== - 1 ) {

		Objects[ obj.next ].prev = obj.prev;

	}

	obj.segnum = - 1;

}

// Allocate a free object slot
// Ported from: obj_allocate() in OBJECT.C lines 1246-1273
export function obj_allocate() {

	if ( num_objects >= MAX_OBJECTS ) {

		console.warn( 'OBJECT: obj_allocate failed - too many objects!' );
		return - 1;

	}

	const objnum = free_obj_list[ num_objects ];
	num_objects ++;

	if ( objnum > Highest_object_index ) {

		Highest_object_index = objnum;

	}

	return objnum;

}

// Free an object slot (return to free list)
// Ported from: obj_free() in OBJECT.C lines 1278-1285
export function obj_free( objnum ) {

	num_objects --;
	free_obj_list[ num_objects ] = objnum;

	if ( objnum === Highest_object_index ) {

		while ( Highest_object_index > 0 && Objects[ Highest_object_index - 1 ].type === OBJ_NONE ) {

			Highest_object_index --;

		}

		// Highest_object_index should point to the last used slot
		if ( Highest_object_index > 0 ) {

			Highest_object_index --;

		}

	}

}

// Create a new object and link it into the world
// Ported from: obj_create() in OBJECT.C lines 1385-1489
// Returns object index, or -1 on failure
export function obj_create( type, id, segnum, pos_x, pos_y, pos_z,
	orient_rvec_x, orient_rvec_y, orient_rvec_z,
	orient_uvec_x, orient_uvec_y, orient_uvec_z,
	orient_fvec_x, orient_fvec_y, orient_fvec_z,
	size, ctype, mtype, rtype ) {

	if ( segnum < 0 || segnum > _getHighestSegIdx() ) return - 1;

	// Allocate slot
	const objnum = obj_allocate();
	if ( objnum === - 1 ) return - 1;

	const obj = Objects[ objnum ];

	// Zero out the object
	reset_object( obj );

	// Set fields
	obj.signature = Object_next_signature ++;
	obj.type = type;
	obj.id = id;
	obj.pos_x = pos_x;
	obj.pos_y = pos_y;
	obj.pos_z = pos_z;
	obj.last_pos_x = pos_x;
	obj.last_pos_y = pos_y;
	obj.last_pos_z = pos_z;
	obj.size = size;
	obj.flags = 0;

	if ( orient_rvec_x !== undefined ) {

		obj.orient_rvec_x = orient_rvec_x;
		obj.orient_rvec_y = orient_rvec_y;
		obj.orient_rvec_z = orient_rvec_z;
		obj.orient_uvec_x = orient_uvec_x;
		obj.orient_uvec_y = orient_uvec_y;
		obj.orient_uvec_z = orient_uvec_z;
		obj.orient_fvec_x = orient_fvec_x;
		obj.orient_fvec_y = orient_fvec_y;
		obj.orient_fvec_z = orient_fvec_z;

	}

	obj.control_type = ctype;
	obj.movement_type = mtype;
	obj.render_type = rtype;
	obj.contains_type = - 1;
	obj.lifeleft = 0x3fffffff;	// IMMORTAL_TIME (large value)
	obj.attached_obj = - 1;
	obj.shields = 20.0;			// default shields (20*F1_0 in C, already float here)

	// Init physics if needed
	if ( mtype === MT_PHYSICS ) {

		obj.mtype = new PhysicsInfo();

	}

	// Init powerup count
	if ( ctype === CT_POWERUP ) {

		obj.ctype = { count: 1 };

	}

	// Init polyobj tmap_override
	if ( rtype === RT_POLYOBJ ) {

		obj.rtype = new PolyObjInfo();
		obj.rtype.tmap_override = - 1;

	}

	// Link into segment
	obj.segnum = - 1;	// obj_link expects segnum === -1
	obj_link( objnum, segnum );

	// Track debris count
	if ( type === OBJ_DEBRIS ) {

		Debris_object_count ++;

	}

	return objnum;

}

// Remove an object from the world
// Ported from: obj_delete() in OBJECT.C lines 1524-1557
export function obj_delete( objnum ) {

	if ( objnum <= 0 ) return;	// never delete player (object 0)

	const obj = Objects[ objnum ];
	if ( obj.type === OBJ_NONE ) return;

	if ( obj.type === OBJ_DEBRIS ) {

		Debris_object_count --;

	}

	obj_unlink( objnum );

	obj.type = OBJ_NONE;
	obj.signature = - 1;

	obj_free( objnum );

}

// Move an object from one segment to another
// Ported from: obj_relink() pattern used throughout the codebase
export function obj_relink( objnum, newsegnum ) {

	obj_unlink( objnum );
	obj_link( objnum, newsegnum );

}

// After loading a level, rebuild the free list from the Objects[] state
// Ported from: special_reset_objects() in OBJECT.C lines 1052-1067
export function reset_objects( n_objs ) {

	num_objects = MAX_OBJECTS;
	Highest_object_index = 0;

	for ( let i = MAX_OBJECTS - 1; i >= 0; i -- ) {

		if ( Objects[ i ].type === OBJ_NONE ) {

			num_objects --;
			free_obj_list[ num_objects ] = i;

		} else {

			if ( i > Highest_object_index ) {

				Highest_object_index = i;

			}

		}

	}

	console.log( 'OBJECT: reset_objects — ' + num_objects + ' active, highest=' + Highest_object_index );

}

// Delete all objects that have OF_SHOULD_BE_DEAD flag set
// Ported from: obj_delete_all_that_should_be_dead() pattern in OBJECT.C
export function obj_delete_all_that_should_be_dead() {

	for ( let i = Highest_object_index; i >= 1; i -- ) {

		if ( ( Objects[ i ].flags & OF_SHOULD_BE_DEAD ) !== 0 ) {

			obj_delete( i );

		}

	}

}

// Proactively reclaim object slots when pool is nearly full
// Frees lowest-priority objects first: debris > fireballs > flares > weapons
// Ported from: free_object_slots() in OBJECT.C lines 1289-1378
const MAX_USED_OBJECTS = MAX_OBJECTS - 20;
const _freeable_list = new Int16Array( MAX_OBJECTS );

export function free_object_slots( num_used ) {

	let olind = 0;
	let num_already_free = MAX_OBJECTS - Highest_object_index - 1;

	if ( MAX_OBJECTS - num_already_free < num_used ) return;

	for ( let i = 0; i <= Highest_object_index; i ++ ) {

		if ( ( Objects[ i ].flags & OF_SHOULD_BE_DEAD ) !== 0 ) {

			num_already_free ++;

		} else {

			const t = Objects[ i ].type;

			if ( t === OBJ_NONE ) {

				num_already_free ++;
				if ( MAX_OBJECTS - num_already_free < num_used ) return;

			} else if ( t === OBJ_FIREBALL || t === OBJ_WEAPON || t === OBJ_DEBRIS ) {

				_freeable_list[ olind ] = i;
				olind ++;

			}
			// All other types (robot, player, reactor, powerup, hostage, etc.) are protected

		}

	}

	let num_to_free = MAX_OBJECTS - num_used - num_already_free;

	if ( num_to_free <= 0 ) return;
	if ( num_to_free > olind ) num_to_free = olind;

	// Priority 1: Free debris (lowest priority objects)
	for ( let i = 0; i < olind && num_to_free > 0; i ++ ) {

		if ( Objects[ _freeable_list[ i ] ].type === OBJ_DEBRIS ) {

			Objects[ _freeable_list[ i ] ].flags |= OF_SHOULD_BE_DEAD;
			num_to_free --;

		}

	}

	if ( num_to_free <= 0 ) return;

	// Priority 2: Free fireballs without children
	for ( let i = 0; i < olind && num_to_free > 0; i ++ ) {

		const obj = Objects[ _freeable_list[ i ] ];
		if ( obj.type === OBJ_FIREBALL && obj.ctype !== null && obj.ctype.delete_objnum === - 1 ) {

			obj.flags |= OF_SHOULD_BE_DEAD;
			num_to_free --;

		}

	}

	if ( num_to_free <= 0 ) return;

	// Priority 3: Free flare weapons
	for ( let i = 0; i < olind && num_to_free > 0; i ++ ) {

		const obj = Objects[ _freeable_list[ i ] ];
		if ( obj.type === OBJ_WEAPON && obj.id === 10 ) { // FLARE_ID = 10

			obj.flags |= OF_SHOULD_BE_DEAD;
			num_to_free --;

		}

	}

	if ( num_to_free <= 0 ) return;

	// Priority 4: Free other weapons (highest priority to free)
	for ( let i = 0; i < olind && num_to_free > 0; i ++ ) {

		const obj = Objects[ _freeable_list[ i ] ];
		if ( obj.type === OBJ_WEAPON && obj.id !== 10 ) {

			obj.flags |= OF_SHOULD_BE_DEAD;
			num_to_free --;

		}

	}

}

export function get_MAX_USED_OBJECTS() { return MAX_USED_OBJECTS; }

// Clear transient objects (weapons, explosions, debris) between levels
// Keeps robots, player, reactor, hostages, powerups
export function clear_transient_objects() {

	for ( let i = Highest_object_index; i >= 1; i -- ) {

		const obj = Objects[ i ];
		if ( obj.type === OBJ_NONE ) continue;

		if ( obj.type === OBJ_WEAPON || obj.type === OBJ_FIREBALL || obj.type === OBJ_DEBRIS ) {

			obj_delete( i );

		}

	}

}
