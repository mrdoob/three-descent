// Ported from: descent-master/MAIN/ROBOT.C and ROBOT.H
// Robot type definitions and parsing

// Number of difficulty levels (Trainee, Rookie, Hotshot, Ace, Insane)
const NDL = 5;

export const MAX_ROBOT_TYPES = 30;

// Animation state constants (from ROBOT.H lines 111-117)
export const N_ANIM_STATES = 5;
export const AS_REST = 0;
export const AS_ALERT = 1;
export const AS_FIRE = 2;
export const AS_RECOIL = 3;
export const AS_FLINCH = 4;

// AI sub-state constants for animation mapping (from AISTRUCT.H)
export const AIS_NONE = 0;
export const AIS_REST = 1;
export const AIS_SRCH = 2;
export const AIS_LOCK = 3;
export const AIS_FLIN = 4;
export const AIS_FIRE = 5;
export const AIS_RECO = 6;
export const AIS_ERR_ = 7;

// AI state -> animation state mapping (from AI.C line 317)
export const Mike_to_matt_xlate = [
	AS_REST,	// AIS_NONE
	AS_REST,	// AIS_REST
	AS_ALERT,	// AIS_SRCH
	AS_ALERT,	// AIS_LOCK
	AS_FLINCH,	// AIS_FLIN
	AS_FIRE,	// AIS_FIRE
	AS_RECOIL,	// AIS_RECO
	AS_REST		// AIS_ERR_
];

// Animation speed constants (from AI.C lines 311-315)
export const ANIM_RATE = 2.0 * Math.PI / 16.0;	// Base rate: (F1_0/16) in fixang = 2*PI/16 rad/s
export const Flinch_scale = 4;			// Speed multiplier when flinching
export const Attack_scale = 24;			// Speed multiplier for melee attacks

// RobotInfo class — mirrors robot_info struct in ROBOT.H
export class RobotInfo {

	constructor() {

		this.model_num = - 1;		// which polygon model
		this.n_guns = 0;			// how many gun positions
		this.weapon_type = 0;		// which weapon type this robot fires

		// Explosion effects
		this.exp1_vclip_num = - 1;
		this.exp1_sound_num = - 1;
		this.exp2_vclip_num = - 1;
		this.exp2_sound_num = - 1;

		// Item drops
		this.contains_id = 0;		// ID of powerup/robot this can contain
		this.contains_count = 0;	// max number of things contained
		this.contains_prob = 0;		// probability N/16
		this.contains_type = 0;		// 0=powerup, 1=robot

		this.score_value = 1000;	// score from destroying this robot
		this.lighting = 0.5;		// lighting value (0..1)
		this.strength = 10.0;		// initial shields (fix -> float)

		this.mass = 4.0;			// how heavy
		this.drag = 0.5;			// drag coefficient

		// Per-difficulty-level arrays (NDL=5)
		this.field_of_view = new Float32Array( NDL );	// cosine of FOV half-angle
		this.firing_wait = new Float32Array( NDL );		// seconds between shots
		this.turn_time = new Float32Array( NDL );		// seconds to rotate 360
		this.fire_power = new Float32Array( NDL );		// damage per hit
		this.shield = new Float32Array( NDL );			// shield strength per difficulty
		this.max_speed = new Float32Array( NDL );		// max speed in units/sec
		this.circle_distance = new Float32Array( NDL );	// distance to circle player
		this.rapidfire_count = new Int8Array( NDL );	// rapid fire shots
		this.evade_speed = new Int8Array( NDL );		// evasion rate (0=none, 4=very fast)

		this.cloak_type = 0;		// 0=never, 1=always, 2=except-when-firing
		this.attack_type = 0;		// 0=ranged, 1=melee (charge)
		this.boss_flag = 0;			// 0=not boss, 1=boss

		this.see_sound = - 1;		// sound when robot first sees player
		this.attack_sound = - 1;	// sound when robot attacks
		this.claw_sound = - 1;		// sound when robot claws (melee)

		this.name = '';

		// Set reasonable defaults for per-difficulty arrays
		for ( let i = 0; i < NDL; i ++ ) {

			this.field_of_view[ i ] = 0.4;		// ~66 degree FOV
			this.firing_wait[ i ] = 3.0;
			this.turn_time[ i ] = 1.0;
			this.fire_power[ i ] = 1.0;
			this.shield[ i ] = 1.0;
			this.max_speed[ i ] = 15.0;
			this.circle_distance[ i ] = 30.0;

		}

	}

}

// Global robot info array
export const Robot_info = [];
for ( let i = 0; i < MAX_ROBOT_TYPES; i ++ ) {

	Robot_info.push( new RobotInfo() );

}

export let N_robot_types = 0;

export function set_N_robot_types( n ) {

	N_robot_types = n;

}

// Parse $ROBOT entries from decoded bitmaps.bin text
// Each entry: $ROBOT modelname.pof [key=value pairs and texture .bbm files]
// Robot types are numbered sequentially (0, 1, 2, ...)
// Ported from: bm_read_robot() in BMREAD.C
export function bm_parse_shareware_robots( text ) {

	let robotNum = 0;
	let pos = 0;

	while ( true ) {

		const idx = text.indexOf( '$ROBOT ', pos );
		if ( idx === - 1 ) break;

		// Make sure this isn't $ROBOT_AI
		if ( text.substring( idx, idx + 10 ) === '$ROBOT_AI ' ) {

			pos = idx + 10;
			continue;

		}

		pos = idx + 7;

		// Find end of this entry (next $ marker)
		let entryEnd = text.indexOf( '$', pos );
		if ( entryEnd === - 1 ) entryEnd = text.length;
		const entry = text.substring( pos, entryEnd );

		if ( robotNum >= MAX_ROBOT_TYPES ) break;

		const ri = Robot_info[ robotNum ];

		// Parse key=value pairs
		// name="quoted string"
		const nameMatch = entry.match( /name="([^"]*)"/ );
		if ( nameMatch !== null ) ri.name = nameMatch[ 1 ];

		// Integer values
		const scoreMatch = entry.match( /score_value=(\d+)/ );
		if ( scoreMatch !== null ) ri.score_value = parseInt( scoreMatch[ 1 ] );

		const weaponMatch = entry.match( /weapon_type=(\d+)/ );
		if ( weaponMatch !== null ) ri.weapon_type = parseInt( weaponMatch[ 1 ] );

		const strengthMatch = entry.match( /strength=(\d+)/ );
		if ( strengthMatch !== null ) ri.strength = parseInt( strengthMatch[ 1 ] );

		// Float values
		const massMatch = entry.match( /mass=([\d.]+)/ );
		if ( massMatch !== null ) ri.mass = parseFloat( massMatch[ 1 ] );

		const dragMatch = entry.match( /drag=([\d.]+)/ );
		if ( dragMatch !== null ) ri.drag = parseFloat( dragMatch[ 1 ] );

		const lightMatch = entry.match( /lighting=([\d.]+)/ );
		if ( lightMatch !== null ) ri.lighting = parseFloat( lightMatch[ 1 ] );

		// Explosion effects
		const exp1VclipMatch = entry.match( /exp1_vclip=(-?\d+)/ );
		if ( exp1VclipMatch !== null ) ri.exp1_vclip_num = parseInt( exp1VclipMatch[ 1 ] );

		const exp1SoundMatch = entry.match( /exp1_sound=(-?\d+)/ );
		if ( exp1SoundMatch !== null ) ri.exp1_sound_num = parseInt( exp1SoundMatch[ 1 ] );

		const exp2VclipMatch = entry.match( /exp2_vclip=(-?\d+)/ );
		if ( exp2VclipMatch !== null ) ri.exp2_vclip_num = parseInt( exp2VclipMatch[ 1 ] );

		const exp2SoundMatch = entry.match( /exp2_sound=(-?\d+)/ );
		if ( exp2SoundMatch !== null ) ri.exp2_sound_num = parseInt( exp2SoundMatch[ 1 ] );

		// Contains (item drops)
		const containsIdMatch = entry.match( /contains_id=(\d+)/ );
		if ( containsIdMatch !== null ) ri.contains_id = parseInt( containsIdMatch[ 1 ] );

		const containsCountMatch = entry.match( /contains_count=(\d+)/ );
		if ( containsCountMatch !== null ) ri.contains_count = parseInt( containsCountMatch[ 1 ] );

		const containsProbMatch = entry.match( /contains_prob=(\d+)/ );
		if ( containsProbMatch !== null ) ri.contains_prob = parseInt( containsProbMatch[ 1 ] );

		const containsTypeMatch = entry.match( /contains_type=(\d+)/ );
		if ( containsTypeMatch !== null ) ri.contains_type = parseInt( containsTypeMatch[ 1 ] ) !== 0 ? 1 : 0;

		// Behavior flags
		const cloakMatch = entry.match( /cloak_type=(\d+)/ );
		if ( cloakMatch !== null ) ri.cloak_type = parseInt( cloakMatch[ 1 ] );

		const attackMatch = entry.match( /attack_type=(\d+)/ );
		if ( attackMatch !== null ) ri.attack_type = parseInt( attackMatch[ 1 ] );

		const bossMatch = entry.match( /boss=(\d+)/ );
		if ( bossMatch !== null ) ri.boss_flag = parseInt( bossMatch[ 1 ] );

		// Sounds
		const seeSoundMatch = entry.match( /see_sound=(\d+)/ );
		if ( seeSoundMatch !== null ) ri.see_sound = parseInt( seeSoundMatch[ 1 ] );

		const attackSoundMatch = entry.match( /attack_sound=(\d+)/ );
		if ( attackSoundMatch !== null ) ri.attack_sound = parseInt( attackSoundMatch[ 1 ] );

		const clawSoundMatch = entry.match( /claw_sound=(\d+)/ );
		if ( clawSoundMatch !== null ) ri.claw_sound = parseInt( clawSoundMatch[ 1 ] );

		robotNum ++;

	}

	N_robot_types = robotNum;
	console.log( 'BM: Parsed ' + robotNum + ' robot types' );

}

// Parse $ROBOT_AI entries from decoded bitmaps.bin text
// Each entry: $ROBOT_AI <index> <5 fov_degrees> <5 firing_wait> <5 rapidfire_count>
//   <5 turn_time> <5 fire_power> <5 shield> <5 max_speed> <5 circle_dist> <5 evade_speed>
// FOV values are in degrees, converted to cosines via adjust_field_of_view()
// Ported from: bm_read_robot_ai() in BMREAD.C
export function bm_parse_shareware_robot_ai( text ) {

	let count = 0;
	let pos = 0;

	while ( true ) {

		const idx = text.indexOf( '$ROBOT_AI', pos );
		if ( idx === - 1 ) break;

		pos = idx + 9;

		// Find end of this entry (next $ marker)
		let entryEnd = text.indexOf( '$', pos );
		if ( entryEnd === - 1 ) entryEnd = text.length;
		const entry = text.substring( pos, entryEnd );

		// Parse all numbers from the entry
		const nums = entry.match( /[-\d.]+/g );
		if ( nums === null || nums.length < 46 ) continue; // index + 9*5 = 46

		const robotNum = parseInt( nums[ 0 ] );
		if ( robotNum >= MAX_ROBOT_TYPES ) continue;

		const ri = Robot_info[ robotNum ];
		let n = 1; // skip index

		// Field of view: NDL degree values -> convert to cosines
		// Ported from adjust_field_of_view() in BMREAD.C:
		// cos(degrees * PI / 180) gives the dot product threshold
		for ( let d = 0; d < NDL; d ++ ) {

			const degrees = parseFloat( nums[ n ++ ] );
			ri.field_of_view[ d ] = Math.cos( degrees * Math.PI / 180.0 );

		}

		// Firing wait: NDL float values (seconds between shots)
		for ( let d = 0; d < NDL; d ++ ) {

			ri.firing_wait[ d ] = parseFloat( nums[ n ++ ] );

		}

		// Rapidfire count: NDL byte values
		for ( let d = 0; d < NDL; d ++ ) {

			ri.rapidfire_count[ d ] = parseInt( nums[ n ++ ] );

		}

		// Turn time: NDL float values (seconds for 360 degree rotation)
		for ( let d = 0; d < NDL; d ++ ) {

			ri.turn_time[ d ] = parseFloat( nums[ n ++ ] );

		}

		// Fire power: NDL float values (damage per hit)
		for ( let d = 0; d < NDL; d ++ ) {

			ri.fire_power[ d ] = parseFloat( nums[ n ++ ] );

		}

		// Shield: NDL float values (shield strength per difficulty)
		for ( let d = 0; d < NDL; d ++ ) {

			ri.shield[ d ] = parseFloat( nums[ n ++ ] );

		}

		// Max speed: NDL float values (units per second)
		for ( let d = 0; d < NDL; d ++ ) {

			ri.max_speed[ d ] = parseFloat( nums[ n ++ ] );

		}

		// Circle distance: NDL float values
		for ( let d = 0; d < NDL; d ++ ) {

			ri.circle_distance[ d ] = parseFloat( nums[ n ++ ] );

		}

		// Evade speed: NDL byte values
		for ( let d = 0; d < NDL; d ++ ) {

			ri.evade_speed[ d ] = parseInt( nums[ n ++ ] );

		}

		count ++;

	}

	console.log( 'BM: Parsed ' + count + ' robot AI entries' );

}
