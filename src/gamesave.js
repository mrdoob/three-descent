// Ported from: descent-master/MAIN/GAMESAVE.C
// Functions for loading game data (objects, walls, triggers, etc.) from level files

import { read_object, objectTypeName, OBJ_PLAYER, OBJ_NONE, OBJ_ROBOT, OBJ_HOSTAGE,
	OBJ_WEAPON, OBJ_POWERUP, OBJ_CNTRLCEN, MT_PHYSICS, RT_POLYOBJ, CT_POWERUP,
	Objects, obj_link, reset_objects } from './object.js';
import { read_wall } from './wall.js';
import { Walls, set_Num_walls } from './mglobal.js';
import { Triggers, set_Num_triggers, MAX_WALLS_PER_LINK } from './switch.js';
import { Robot_info, N_robot_types, Powerup_info, N_powerup_types } from './bm.js';
import { Polygon_models } from './polyobj.js';

const GAME_FILEINFO_SIGNATURE = 0x6705;

// Track original robot count for matcen global limit
// Ported from: GAMESAVE.C Gamesave_num_org_robots
let Gamesave_num_org_robots = 0;
export function get_Gamesave_num_org_robots() { return Gamesave_num_org_robots; }

// Validate and fix object data after loading from level file
// Ported from: verify_object() in GAMESAVE.C lines 580-688
function verify_object( obj ) {

	obj.lifeleft = 0x3fffffff;	// IMMORTAL_TIME — all loaded objects are immortal

	if ( obj.type === OBJ_ROBOT ) {

		Gamesave_num_org_robots ++;

		// Make sure valid robot ID
		if ( obj.id >= N_robot_types ) {

			obj.id = obj.id % N_robot_types;

		}

		// Make sure model number & size are correct
		if ( obj.render_type === RT_POLYOBJ && obj.rtype !== null ) {

			const ri = Robot_info[ obj.id ];
			if ( ri !== undefined && ri.model_num >= 0 ) {

				obj.rtype.model_num = ri.model_num;

				const pm = Polygon_models[ ri.model_num ];
				if ( pm !== null && pm !== undefined && pm.rad > 0 ) {

					obj.size = pm.rad;

				}

			}

		}

		// Fix physics mass and drag from Robot_info
		if ( obj.movement_type === MT_PHYSICS && obj.mtype !== null ) {

			const ri = Robot_info[ obj.id ];
			if ( ri !== undefined ) {

				obj.mtype.mass = ri.mass;
				obj.mtype.drag = ri.drag;

			}

		}

	}

	// Ported from: verify_object() in GAMESAVE.C lines 620-628
	if ( obj.type === OBJ_POWERUP ) {

		if ( obj.id >= N_powerup_types ) {

			obj.id = 0;

		}

		obj.control_type = CT_POWERUP;

		// Override size from Powerup_info (the original game always does this)
		if ( obj.id >= 0 && obj.id < N_powerup_types && Powerup_info[ obj.id ].size > 0 ) {

			obj.size = Powerup_info[ obj.id ].size;

		}

	}

	if ( obj.type === OBJ_HOSTAGE ) {

		obj.control_type = CT_POWERUP;

	}

}

// Game data result structure
export class GameData {

	constructor() {

		this.objects = [];
		this.walls = [];
		this.triggers = [];
		this.matcens = [];
		this.controlCenterTriggers = null;	// ControlCenterTriggers struct (doors opened on reactor destroy)
		this.playerObj = null;	// reference to the player object (OBJ_PLAYER, id=0)

	}

}

// Load game data from level file
// fp should be positioned at the start of the gamedata section
// Ported from: load_game_data() in GAMESAVE.C (lines 1197-1562)
export function load_game_data( fp ) {

	const data = new GameData();

	// Remember the base offset for resolving field offsets
	const base = fp.tell();

	// Read game_top_fileinfo header
	const fileinfo_signature = fp.readUShort();
	const fileinfo_version = fp.readUShort();
	const fileinfo_sizeof = fp.readInt();

	if ( fileinfo_signature !== GAME_FILEINFO_SIGNATURE ) {

		console.error( 'GAMESAVE: Invalid fileinfo signature 0x' +
			fileinfo_signature.toString( 16 ) + ' (expected 0x6705)' );
		return null;

	}

	console.log( 'GAMESAVE: fileinfo version=' + fileinfo_version +
		', sizeof=' + fileinfo_sizeof );

	// Read the rest of the fileinfo structure
	// Fields are read in order, stopping when sizeof is exhausted
	// Ported from GAMESAVE.C lines 1204-1278
	let sizeof_offset = 0;

	// Default values for all fields (in case fileinfo is smaller)
	let mine_filename = '';
	let level = 0;
	let player_offset = - 1;
	let player_sizeof = 0;
	let object_offset = - 1;
	let object_howmany = 0;
	let object_sizeof = 0;
	let walls_offset = - 1;
	let walls_howmany = 0;
	let walls_sizeof = 0;
	let doors_offset = - 1;
	let doors_howmany = 0;
	let doors_sizeof = 0;
	let triggers_offset = - 1;
	let triggers_howmany = 0;
	let triggers_sizeof = 0;
	let links_offset = - 1;
	let links_howmany = 0;
	let links_sizeof = 0;
	let control_offset = - 1;
	let control_howmany = 0;
	let control_sizeof = 0;
	let matcen_offset = - 1;
	let matcen_howmany = 0;
	let matcen_sizeof = 0;

	// Seek past the 8-byte header we already read
	// Read fields in order, each conditionally based on remaining sizeof
	const header_size = fileinfo_sizeof;

	// mine_filename: 15 bytes
	if ( sizeof_offset + 15 <= header_size ) {

		mine_filename = fp.readString( 15 );
		sizeof_offset += 15;

	}

	// level: 4 bytes
	if ( sizeof_offset + 4 <= header_size ) {

		level = fp.readInt();
		sizeof_offset += 4;

	}

	// player_offset, player_sizeof: 4 + 4 = 8 bytes
	if ( sizeof_offset + 8 <= header_size ) {

		player_offset = fp.readInt();
		player_sizeof = fp.readInt();
		sizeof_offset += 8;

	}

	// object_offset, object_howmany, object_sizeof: 4 + 4 + 4 = 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		object_offset = fp.readInt();
		object_howmany = fp.readInt();
		object_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	// walls_offset, walls_howmany, walls_sizeof: 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		walls_offset = fp.readInt();
		walls_howmany = fp.readInt();
		walls_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	// doors_offset, doors_howmany, doors_sizeof: 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		doors_offset = fp.readInt();
		doors_howmany = fp.readInt();
		doors_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	// triggers_offset, triggers_howmany, triggers_sizeof: 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		triggers_offset = fp.readInt();
		triggers_howmany = fp.readInt();
		triggers_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	// links_offset, links_howmany, links_sizeof: 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		links_offset = fp.readInt();
		links_howmany = fp.readInt();
		links_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	// control_offset, control_howmany, control_sizeof: 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		control_offset = fp.readInt();
		control_howmany = fp.readInt();
		control_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	// matcen_offset, matcen_howmany, matcen_sizeof: 12 bytes
	if ( sizeof_offset + 12 <= header_size ) {

		matcen_offset = fp.readInt();
		matcen_howmany = fp.readInt();
		matcen_sizeof = fp.readInt();
		sizeof_offset += 12;

	}

	console.log( 'GAMESAVE: level=' + level +
		', objects=' + object_howmany +
		', walls=' + walls_howmany +
		', triggers=' + triggers_howmany +
		', matcens=' + matcen_howmany );

	// Read objects — populate both data.objects[] (for backwards compat) and global Objects[] pool
	Gamesave_num_org_robots = 0;

	if ( object_offset !== - 1 && object_howmany > 0 ) {

		fp.seek( object_offset );

		for ( let i = 0; i < object_howmany; i ++ ) {

			const obj = read_object( fp, fileinfo_version );
			verify_object( obj );
			data.objects.push( obj );

			// Copy loaded object data into global Objects[i] pool slot
			const gobj = Objects[ i ];
			gobj.signature = i;
			gobj.type = obj.type;
			gobj.id = obj.id;
			gobj.next = - 1;
			gobj.prev = - 1;
			gobj.control_type = obj.control_type;
			gobj.movement_type = obj.movement_type;
			gobj.render_type = obj.render_type;
			gobj.flags = obj.flags;
			gobj.segnum = - 1;	// will be set by obj_link
			gobj.attached_obj = obj.attached_obj;

			gobj.pos_x = obj.pos_x;
			gobj.pos_y = obj.pos_y;
			gobj.pos_z = obj.pos_z;

			gobj.orient_rvec_x = obj.orient_rvec_x;
			gobj.orient_rvec_y = obj.orient_rvec_y;
			gobj.orient_rvec_z = obj.orient_rvec_z;
			gobj.orient_uvec_x = obj.orient_uvec_x;
			gobj.orient_uvec_y = obj.orient_uvec_y;
			gobj.orient_uvec_z = obj.orient_uvec_z;
			gobj.orient_fvec_x = obj.orient_fvec_x;
			gobj.orient_fvec_y = obj.orient_fvec_y;
			gobj.orient_fvec_z = obj.orient_fvec_z;

			gobj.size = obj.size;
			gobj.shields = obj.shields;

			gobj.last_pos_x = obj.last_pos_x;
			gobj.last_pos_y = obj.last_pos_y;
			gobj.last_pos_z = obj.last_pos_z;

			gobj.contains_type = obj.contains_type;
			gobj.contains_id = obj.contains_id;
			gobj.contains_count = obj.contains_count;
			gobj.lifeleft = obj.lifeleft;

			gobj.mtype = obj.mtype;
			gobj.ctype = obj.ctype;
			gobj.rtype = obj.rtype;

			// Link into segment's object list
			const seg = obj.segnum;
			if ( seg >= 0 ) {

				obj_link( i, seg );

			}

			// Track the player object (type=OBJ_PLAYER, id=0)
			if ( obj.type === OBJ_PLAYER && obj.id === 0 ) {

				data.playerObj = obj;

			}

		}

		// Mark remaining pool slots as OBJ_NONE
		for ( let i = object_howmany; i < Objects.length; i ++ ) {

			Objects[ i ].type = OBJ_NONE;
			Objects[ i ].segnum = - 1;

		}

		// Rebuild free list from current Objects[] state
		reset_objects( object_howmany );

		// Log object types for debugging
		const typeCounts = {};
		for ( let i = 0; i < data.objects.length; i ++ ) {

			const name = objectTypeName( data.objects[ i ].type );
			if ( typeCounts[ name ] === undefined ) {

				typeCounts[ name ] = 0;

			}

			typeCounts[ name ] ++;

		}

		const typeList = [];
		for ( const name in typeCounts ) {

			typeList.push( name + ':' + typeCounts[ name ] );

		}

		console.log( 'GAMESAVE: Object types: ' + typeList.join( ', ' ) );

	}

	// Read walls (populate both local data.walls and global Walls[])
	if ( walls_offset !== - 1 && walls_howmany > 0 ) {

		fp.seek( walls_offset );

		for ( let i = 0; i < walls_howmany; i ++ ) {

			const wall = read_wall( fp );
			data.walls.push( wall );

			// Copy to global Walls[] array
			const gw = Walls[ i ];
			gw.segnum = wall.segnum;
			gw.sidenum = wall.sidenum;
			gw.hps = wall.hps;
			gw.linked_wall = wall.linked_wall;
			gw.type = wall.type;
			gw.flags = wall.flags;
			gw.state = wall.state;
			gw.trigger = wall.trigger;
			gw.clip_num = wall.clip_num;
			gw.keys = wall.keys;

		}

		set_Num_walls( walls_howmany );
		console.log( 'GAMESAVE: Loaded ' + data.walls.length + ' walls (global Walls[] populated)' );

	}

	// Read triggers
	// Ported from: GAMESAVE.C lines 1417-1437
	if ( triggers_offset !== - 1 && triggers_howmany > 0 ) {

		fp.seek( triggers_offset );

		for ( let i = 0; i < triggers_howmany; i ++ ) {

			const t = Triggers[ i ];
			t.type = fp.readByte();
			t.flags = fp.readShort();
			t.value = fp.readFix();
			t.time = fp.readFix();
			t.link_num = fp.readByte();
			t.num_links = fp.readShort();

			for ( let j = 0; j < MAX_WALLS_PER_LINK; j ++ ) {

				t.seg[ j ] = fp.readShort();

			}

			for ( let j = 0; j < MAX_WALLS_PER_LINK; j ++ ) {

				t.side[ j ] = fp.readShort();

			}

			data.triggers.push( t );

		}

		set_Num_triggers( triggers_howmany );
		console.log( 'GAMESAVE: Loaded ' + triggers_howmany + ' triggers' );

		// Log trigger details
		for ( let i = 0; i < triggers_howmany; i ++ ) {

			const t = Triggers[ i ];
			console.log( 'TRIGGER[' + i + ']: flags=0x' + t.flags.toString( 16 ) +
				' links=' + t.num_links +
				' seg[0]=' + t.seg[ 0 ] + ' side[0]=' + t.side[ 0 ] );

		}

	}

	// Read matcens (robot materialization centers)
	// Ported from: GAMESAVE.C lines 1461-1478
	if ( matcen_offset !== - 1 && matcen_howmany > 0 ) {

		fp.seek( matcen_offset );

		for ( let i = 0; i < matcen_howmany; i ++ ) {

			const mc = {
				robot_flags: fp.readInt(),		// bitmask: bit N = robot type N can spawn
				hit_points: fp.readFix(),		// how hard to destroy (fixed-point)
				interval: fp.readFix(),			// spawn interval (fixed-point seconds)
				segnum: fp.readShort(),			// segment this matcen is in
				fuelcen_num: fp.readShort()		// index into FuelCenter/Station array
			};

			data.matcens.push( mc );

		}

		console.log( 'GAMESAVE: Loaded ' + matcen_howmany + ' matcens' );

		for ( let i = 0; i < matcen_howmany; i ++ ) {

			const mc = data.matcens[ i ];
			console.log( 'MATCEN[' + i + ']: seg=' + mc.segnum +
				' robot_flags=0x' + ( mc.robot_flags >>> 0 ).toString( 16 ) +
				' interval=' + mc.interval.toFixed( 1 ) +
				' fuelcen=' + mc.fuelcen_num );

		}

	}

	// Read ControlCenterTriggers (doors that open when reactor is destroyed)
	// Ported from: GAMESAVE.C lines 1441-1456
	// Struct: num_links (short) + seg[10] (10 shorts) + side[10] (10 shorts) = 42 bytes
	if ( control_offset !== - 1 ) {

		fp.seek( control_offset );

		const cct = {
			num_links: 0,
			seg: new Int16Array( MAX_WALLS_PER_LINK ),
			side: new Int16Array( MAX_WALLS_PER_LINK )
		};

		cct.num_links = fp.readShort();

		for ( let j = 0; j < MAX_WALLS_PER_LINK; j ++ ) {

			cct.seg[ j ] = fp.readShort();

		}

		for ( let j = 0; j < MAX_WALLS_PER_LINK; j ++ ) {

			cct.side[ j ] = fp.readShort();

		}

		data.controlCenterTriggers = cct;
		console.log( 'GAMESAVE: Loaded ControlCenterTriggers with ' + cct.num_links + ' links' );

		for ( let j = 0; j < cct.num_links; j ++ ) {

			console.log( '  CCT[' + j + ']: seg=' + cct.seg[ j ] + ' side=' + cct.side[ j ] );

		}

	}

	return data;

}
