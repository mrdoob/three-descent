// Ported from: descent-master/MAIN/BM.C and BM.H
// Bitmap and palette loading functions - data structures and HAM reader

import { MAX_TEXTURES } from './segment.js';
import { Textures, set_NumTextures } from './mglobal.js';

// Re-export from new modules for backward compatibility during transition
export { Vclip, Vclips, Num_vclips, set_Num_vclips, VCLIP_MAXNUM, VCLIP_MAX_FRAMES } from './vclip.js';
export { RobotInfo, Robot_info, N_robot_types, set_N_robot_types, MAX_ROBOT_TYPES,
	N_ANIM_STATES, AS_REST, AS_ALERT, AS_FIRE, AS_RECOIL, AS_FLINCH,
	AIS_NONE, AIS_REST, AIS_SRCH, AIS_LOCK, AIS_FLIN, AIS_FIRE, AIS_RECO, AIS_ERR_,
	Mike_to_matt_xlate, ANIM_RATE, Flinch_scale, Attack_scale } from './robot.js';
export {
	WeaponInfo, Weapon_info, N_weapon_types, set_N_weapon_types, MAX_WEAPON_TYPES,
	MAX_PRIMARY_WEAPONS, MAX_SECONDARY_WEAPONS,
	WEAPON_RENDER_NONE, WEAPON_RENDER_LASER, WEAPON_RENDER_BLOB, WEAPON_RENDER_POLYMODEL, WEAPON_RENDER_VCLIP,
	LASER_ID, CONCUSSION_ID, FLARE_ID, VULCAN_ID, SPREADFIRE_ID, PLASMA_ID, FUSION_ID,
	HOMING_ID, PROXIMITY_ID, SMART_ID, MEGA_ID,
	Primary_weapon_to_weapon_info, Secondary_weapon_to_weapon_info,
	WEAPON_NAMES, SECONDARY_NAMES
} from './weapon.js';
export { bm_build_shareware_texture_table } from './bmread.js';

// tmap_info structure: filename[13], flags(ubyte), lighting(fix), damage(fix), eclip_num(int)
// Total: 13 + 1 + 4 + 4 + 4 = 26 bytes

export const TMI_VOLATILE = 1;	// this material blows up when hit

export const MAX_OBJ_BITMAPS = 210;

// Object bitmap arrays — used for polygon model textures
// Ported from: BM.C lines 105-106
// ObjBitmaps[]: actual bitmap indices (into GameBitmaps/PIG)
// ObjBitmapPtrs[]: indirection used during model rendering
//   model texture i -> ObjBitmaps[ObjBitmapPtrs[model.first_texture + i]]
export const ObjBitmaps = new Int16Array( MAX_OBJ_BITMAPS ).fill( - 1 );
export const ObjBitmapPtrs = new Uint16Array( MAX_OBJ_BITMAPS ).fill( 0 );
export let N_ObjBitmaps = 0;
export function set_N_ObjBitmaps( n ) { N_ObjBitmaps = n; }

// Powerup type info (from POWERUP.H)
export const MAX_POWERUP_TYPES = 29;

export class PowerupInfo {

	constructor() {

		this.vclip_num = - 1;	// which vclip to animate
		this.hit_sound = - 1;	// sound to play when picked up
		this.size = 3.0;	// 3D size (default i2f(3))
		this.light = 1.0 / 3;	// light cast (default F1_0/3)

	}

}

export const Powerup_info = [];
export const Powerup_names = [];
export let N_powerup_types = 0;
export function set_N_powerup_types( n ) { N_powerup_types = n; }

for ( let i = 0; i < MAX_POWERUP_TYPES; i ++ ) {

	Powerup_info.push( new PowerupInfo() );
	Powerup_names.push( '' );

}

// Eclip constants (from EFFECTS.H)
export const MAX_EFFECTS = 60;
export const EF_CRITICAL = 1;	// only plays when mine critical
export const EF_ONE_SHOT = 2;	// plays once then shows destroyed bitmap
export const EF_STOPPED = 4;	// has been stopped

// Eclip class - animated wall/object texture effect
export class Eclip {

	constructor() {

		// Embedded vclip data
		this.vc_play_time = 0;		// total time in seconds
		this.vc_num_frames = 0;
		this.vc_frame_time = 0;		// time per frame in seconds
		this.vc_flags = 0;
		this.vc_sound_num = - 1;
		this.vc_frames = [];		// array of PIG bitmap indices
		this.vc_light_value = 0;

		// Eclip-specific
		this.time_left = 0;			// for sequencing
		this.frame_count = 0;		// current frame index
		this.changing_wall_texture = - 1;	// Textures[] index to replace
		this.changing_object_texture = - 1;	// ObjBitmaps[] index to replace
		this.flags = 0;
		this.crit_clip = - 1;		// alternate clip when mine critical
		this.dest_bm_num = - 1;		// bitmap for destroyed state
		this.dest_vclip = - 1;
		this.dest_eclip = - 1;
		this.dest_size = 0;
		this.sound_num = - 1;
		this.segnum = - 1;
		this.sidenum = - 1;

	}

}

// Global effects array
export const Effects = [];
for ( let i = 0; i < MAX_EFFECTS; i ++ ) {

	Effects.push( new Eclip() );

}

export let Num_effects = 0;

export function set_Num_effects( n ) {

	Num_effects = n;

}

// Sound mapping: game sound ID -> PIG sound file index
export const Sounds = new Int16Array( 250 ).fill( - 1 );
export let Num_sounds = 0;
export function set_Num_sounds( n ) { Num_sounds = n; }

// Cockpit bitmaps (from $COCKPIT in bitmaps.bin)
// Ported from: BM.C cockpit_bitmap[], N_COCKPIT_BITMAPS = 4
export const N_COCKPIT_BITMAPS = 4;
export const cockpit_bitmap = new Int16Array( N_COCKPIT_BITMAPS ).fill( - 1 ); // PIG bitmap indices
export let Num_cockpits = 0;
export function set_Num_cockpits( n ) { Num_cockpits = n; }

// Gauge bitmaps (from $GAUGES in bitmaps.bin)
// Ported from: GAUGES.H MAX_GAUGE_BMS = 80, Gauges[]
export const MAX_GAUGE_BMS = 80;
export const Gauges = new Int16Array( MAX_GAUGE_BMS ).fill( - 1 ); // PIG bitmap indices

// Gauge bitmap index constants (from GAUGES.C)
export const GAUGE_SHIELDS = 0;			// 10 frames (100%..0%)
export const GAUGE_INVULNERABLE = 10;	// 10 frames
export const GAUGE_SPEED = 20;			// unused
export const GAUGE_ENERGY_LEFT = 21;
export const GAUGE_ENERGY_RIGHT = 22;
export const GAUGE_NUMERICAL = 23;
export const GAUGE_BLUE_KEY = 24;
export const GAUGE_GOLD_KEY = 25;
export const GAUGE_RED_KEY = 26;
export const GAUGE_BLUE_KEY_OFF = 27;
export const GAUGE_GOLD_KEY_OFF = 28;
export const GAUGE_RED_KEY_OFF = 29;
export const SB_GAUGE_BLUE_KEY = 30;
export const SB_GAUGE_GOLD_KEY = 31;
export const SB_GAUGE_RED_KEY = 32;
export const SB_GAUGE_BLUE_KEY_OFF = 33;
export const SB_GAUGE_GOLD_KEY_OFF = 34;
export const SB_GAUGE_RED_KEY_OFF = 35;
export const SB_GAUGE_ENERGY = 36;
export const GAUGE_LIVES = 37;
export const GAUGE_SHIPS = 38;			// 8 player ships (38-45)
export const RETICLE_CROSS = 46;		// 2 frames
export const RETICLE_PRIMARY = 48;		// 3 frames
export const RETICLE_SECONDARY = 51;	// 5 frames
export const GAUGE_HOMING_WARNING_ON = 56;
export const GAUGE_HOMING_WARNING_OFF = 57;
export const SML_RETICLE_CROSS = 58;	// 2 frames
export const SML_RETICLE_PRIMARY = 60;	// 3 frames
export const SML_RETICLE_SECONDARY = 63; // 5 frames
export const KEY_ICON_BLUE = 68;
export const KEY_ICON_YELLOW = 69;
export const KEY_ICON_RED = 70;

// Object type classification constants (from BM.H)
// Ported from: descent-master/MAIN/BM.H lines 267-273
export const OL_ROBOT = 1;
export const OL_CONTROL_CENTER = 4;
export const OL_PLAYER = 5;
export const OL_CLUTTER = 6;
export const OL_EXIT = 7;

// Object type tables — populated from $ROBOT/$OBJECT/$POWERUP/$HOSTAGE in bitmaps.bin
// Ported from: descent-master/MAIN/BM.H lines 278-280
export const MAX_OBJTYPE = 100;
export const ObjType = new Uint8Array( MAX_OBJTYPE );	// OL_ROBOT, OL_CONTROL_CENTER, etc.
export const ObjId = new Uint8Array( MAX_OBJTYPE );		// model_num for polyobj types
export const ObjStrength = new Float32Array( MAX_OBJTYPE );	// strength (fixed-point converted to float)
export let Num_total_object_types = 0;
export function set_Num_total_object_types( n ) { Num_total_object_types = n; }

export class TmapInfo {

	constructor() {

		this.filename = '';
		this.flags = 0;
		this.lighting = 0;	// 0 to 1 (float, converted from fix)
		this.damage = 0;	// how much damage being against this does
		this.eclip_num = - 1;	// if not -1, the eclip that changes this

	}

}

// Global tmap info array
export const TmapInfos = [];
for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

	TmapInfos.push( new TmapInfo() );

}

// Read all HAM data from PIG file (registered format)
// Mirrors bm_read_all() in BM.C
export function bm_read_all( fp ) {

	// NumTextures (int)
	const numTextures = fp.readInt();
	set_NumTextures( numTextures );

	// Textures[MAX_TEXTURES] - bitmap_index (ushort each)
	for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

		Textures[ i ] = fp.readUShort();

	}

	// TmapInfo[MAX_TEXTURES] - 26 bytes each
	for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

		TmapInfos[ i ].filename = fp.readString( 13 );
		TmapInfos[ i ].flags = fp.readUByte();
		TmapInfos[ i ].lighting = fp.readFix();
		TmapInfos[ i ].damage = fp.readFix();
		TmapInfos[ i ].eclip_num = fp.readInt();

	}

	// Skip remaining HAM data for Phase 1
	// (Sounds, AltSounds, Vclips, Effects, WallAnims, Robots, etc.)

	console.log( 'HAM: Read ' + numTextures + ' textures' );

}
