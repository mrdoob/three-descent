// Ported from: descent-master/MAIN/WEAPON.C and WEAPON.H
// Weapon type definitions, selection, and parsing

import { Polygon_models, N_polygon_models, set_N_polygon_models, load_polygon_model } from './polyobj.js';

// Number of difficulty levels
const NDL = 5;

// Weapon constants (from WEAPON.H and LASER.H)
export const MAX_WEAPON_TYPES = 30;
export const MAX_PRIMARY_WEAPONS = 5;
export const MAX_SECONDARY_WEAPONS = 5;

// Render types
export const WEAPON_RENDER_NONE = - 1;
export const WEAPON_RENDER_LASER = 0;
export const WEAPON_RENDER_BLOB = 1;
export const WEAPON_RENDER_POLYMODEL = 2;
export const WEAPON_RENDER_VCLIP = 3;

// Weapon type IDs (from LASER.H)
export const LASER_ID = 10;
export const CONCUSSION_ID = 8;
export const FLARE_ID = 9;
export const VULCAN_ID = 11;
export const SPREADFIRE_ID = 20;
export const PLASMA_ID = 13;
export const FUSION_ID = 14;
export const HOMING_ID = 15;
export const PROXIMITY_ID = 16;
export const SMART_ID = 17;
export const MEGA_ID = 18;

// Weapon slot -> weapon_info index mapping
export const Primary_weapon_to_weapon_info = [ 0, 11, 12, 13, 14 ];
export const Secondary_weapon_to_weapon_info = [ 8, 15, 16, 17, 18 ];

// Ammo caps (from WEAPON.C / POWERUP.H)
// Ported from: Primary_ammo_max[] and Secondary_ammo_max[] in WEAPON.C lines 219-220
// VULCAN_AMMO_MAX from POWERUP.H line 196: #define VULCAN_AMMO_MAX (392*2)
export const VULCAN_AMMO_MAX = 784;
export const Primary_ammo_max = [ 0, VULCAN_AMMO_MAX, 0, 0, 0 ];
export const Secondary_ammo_max = [ 20, 10, 10, 5, 5 ];

// Weapon name tables (ported from WEAPON.C)
export const WEAPON_NAMES = [ 'Laser', 'Vulcan Cannon', 'Spreadfire Cannon', 'Plasma Cannon', 'Fusion Cannon' ];
export const SECONDARY_NAMES = [ 'Concussion Missile', 'Homing Missile', 'Proximity Bomb', 'Smart Missile', 'Mega Missile' ];

// WeaponInfo class — mirrors weapon_info struct in WEAPON.H
export class WeaponInfo {

	constructor() {

		this.render_type = WEAPON_RENDER_NONE;
		this.model_num = 0;
		this.model_num_inner = 0;
		this.persistent = 0;

		this.flash_vclip = - 1;
		this.flash_sound = - 1;
		this.robot_hit_vclip = - 1;
		this.robot_hit_sound = - 1;
		this.wall_hit_vclip = - 1;
		this.wall_hit_sound = - 1;

		this.fire_count = 1;
		this.ammo_usage = 0;

		this.weapon_vclip = - 1;
		this.destroyable = 0;
		this.matter = 0;
		this.bounce = 0;
		this.homing_flag = 0;

		this.energy_usage = 0;
		this.fire_wait = 0.25;

		this.bitmap = - 1;
		this.blob_size = 0.0625;
		this.flash_size = 0;
		this.impact_size = 0;

		this.strength = new Float32Array( NDL ).fill( 1.0 );
		this.speed = new Float32Array( NDL ).fill( 10.0 );

		this.mass = 1.0;
		this.drag = 0;
		this.thrust = 0;
		this.po_len_to_width_ratio = 10.0;
		this.light = 0;
		this.lifetime = 12.0;
		this.damage_radius = 0;

	}

}

// Global weapon info array
export const Weapon_info = [];
for ( let i = 0; i < MAX_WEAPON_TYPES; i ++ ) {

	Weapon_info.push( new WeaponInfo() );

}

export let N_weapon_types = 0;

export function set_N_weapon_types( n ) {

	N_weapon_types = n;

}

// Auto-select best available primary weapon when current weapon can't fire
// Ported from: auto_select_weapon() in WEAPON.C
export function autoSelectPrimary( playerPrimaryFlags, playerVulcanAmmo, playerEnergy,
	setPrimaryWeapon, showMessage, updateHUD ) {

	// Try weapons in reverse order (best first), skip fusion (index 4) per original
	for ( let i = 3; i >= 0; i -- ) {

		if ( ( playerPrimaryFlags & ( 1 << i ) ) === 0 ) continue;

		if ( i === 1 ) {

			// Vulcan: check ammo
			if ( playerVulcanAmmo > 0 ) {

				setPrimaryWeapon( i );
				showMessage( WEAPON_NAMES[ i ] );
				updateHUD();
				return;

			}

		} else {

			// Check energy for this weapon
			const wi_index = Primary_weapon_to_weapon_info[ i ];
			let energyCost = 1.0;
			if ( wi_index < N_weapon_types ) {

				energyCost = Weapon_info[ wi_index ].energy_usage;
				if ( energyCost <= 0 ) energyCost = 1.0;

			}

			if ( playerEnergy >= energyCost ) {

				setPrimaryWeapon( i );
				showMessage( WEAPON_NAMES[ i ] );
				updateHUD();
				return;

			}

		}

	}

	// Always fall back to laser (always have it)
	setPrimaryWeapon( 0 );
	updateHUD();

}

// Auto-select best available secondary weapon
// Priority: Smart(3) -> Homing(1) -> Concussion(0), skip Proximity(2)
export function autoSelectSecondary( playerSecondaryAmmo, setSecondaryWeapon, showMessage, updateHUD ) {

	const priority = [ 3, 1, 0 ];

	for ( let p = 0; p < priority.length; p ++ ) {

		const slot = priority[ p ];
		if ( playerSecondaryAmmo[ slot ] > 0 ) {

			setSecondaryWeapon( slot );
			showMessage( SECONDARY_NAMES[ slot ] );
			updateHUD();
			return;

		}

	}

}

// Parse $WEAPON entries from decoded bitmaps.bin text
// Ported from: bm_read_weapon() in BMREAD.C
// Weapon POF models are stored after the shareware model table (28 robot/player models)
const WEAPON_MODEL_START_INDEX = 28;

export function bm_parse_shareware_weapons( text, pigFile, hogFile ) {

	let weaponIndex = 0;
	let count = 0;
	let pos = 0;
	let nextModelIndex = WEAPON_MODEL_START_INDEX;

	while ( true ) {

		const idx = text.indexOf( '$WEAPON', pos );
		if ( idx === - 1 ) break;

		pos = idx + 7;

		// Skip registered-only weapons (@ prefix in name)
		const preCheck = text.substring( pos, pos + 30 ).trim();
		if ( preCheck.charAt( 0 ) === '@' ) {

			// Still count the weapon index so IDs stay aligned
			weaponIndex ++;
			continue;

		}

		// Find entry boundaries
		let entryEnd = text.length;
		const nextDollar = text.indexOf( '$', pos );
		if ( nextDollar !== - 1 ) entryEnd = nextDollar;
		const entry = text.substring( pos, entryEnd );

		if ( weaponIndex >= MAX_WEAPON_TYPES ) break;

		const wi = Weapon_info[ weaponIndex ];

		// Parse key=value pairs
		const strengthMatch = entry.match( /strength[=\s]+([\d.\s,]+)/ );
		if ( strengthMatch !== null ) {

			const vals = strengthMatch[ 1 ].trim().split( /[\s,]+/ );
			for ( let d = 0; d < NDL && d < vals.length; d ++ ) {

				wi.strength[ d ] = parseFloat( vals[ d ] );

			}

			// If only one value provided, fill all difficulty levels
			if ( vals.length === 1 ) {

				for ( let d = 1; d < NDL; d ++ ) wi.strength[ d ] = wi.strength[ 0 ];

			}

		}

		const speedMatch = entry.match( /speed[=\s]+([\d.\s,]+)/ );
		if ( speedMatch !== null ) {

			const vals = speedMatch[ 1 ].trim().split( /[\s,]+/ );
			for ( let d = 0; d < NDL && d < vals.length; d ++ ) {

				wi.speed[ d ] = parseFloat( vals[ d ] );

			}

			if ( vals.length === 1 ) {

				for ( let d = 1; d < NDL; d ++ ) wi.speed[ d ] = wi.speed[ 0 ];

			}

		}

		// Float properties
		const floatProps = [
			[ 'energy_usage', 'energy_usage' ],
			[ 'fire_wait', 'fire_wait' ],
			[ 'blob_size', 'blob_size' ],
			[ 'flash_size', 'flash_size' ],
			[ 'impact_size', 'impact_size' ],
			[ 'mass', 'mass' ],
			[ 'drag', 'drag' ],
			[ 'thrust', 'thrust' ],
			[ 'lightcast', 'light' ],
			[ 'lifetime', 'lifetime' ],
			[ 'damage_radius', 'damage_radius' ],
			[ 'lw_ratio', 'po_len_to_width_ratio' ]
		];

		for ( let p = 0; p < floatProps.length; p ++ ) {

			const regex = new RegExp( floatProps[ p ][ 0 ] + '[=\\s]+([\\d.]+)' );
			const m = entry.match( regex );
			if ( m !== null ) {

				wi[ floatProps[ p ][ 1 ] ] = parseFloat( m[ 1 ] );

			}

		}

		// Integer properties
		const intProps = [
			[ 'fire_count', 'fire_count' ],
			[ 'ammo_usage', 'ammo_usage' ],
			[ 'flash_vclip', 'flash_vclip' ],
			[ 'flash_sound', 'flash_sound' ],
			[ 'robot_hit_vclip', 'robot_hit_vclip' ],
			[ 'robot_hit_sound', 'robot_hit_sound' ],
			[ 'wall_hit_vclip', 'wall_hit_vclip' ],
			[ 'wall_hit_sound', 'wall_hit_sound' ],
			[ 'matter', 'matter' ],
			[ 'bounce', 'bounce' ],
			[ 'persistent', 'persistent' ],
			[ 'destroyable', 'destroyable' ],
			[ 'homing', 'homing_flag' ]
		];

		for ( let p = 0; p < intProps.length; p ++ ) {

			const regex = new RegExp( intProps[ p ][ 0 ] + '[=\\s]+(-?\\d+)' );
			const m = entry.match( regex );
			if ( m !== null ) {

				wi[ intProps[ p ][ 1 ] ] = parseInt( m[ 1 ] );

			}

		}

		// Render type detection and bitmap resolution
		// Ported from: bm_read_weapon() in BMREAD.C
		const blobBmpMatch = entry.match( /blob_bmp[=\s]+(\S+)/ );
		const laserBmpMatch = entry.match( /laser_bmp[=\s]+(\S+)/ );

		if ( blobBmpMatch !== null ) {

			wi.render_type = WEAPON_RENDER_BLOB;
			let bmName = blobBmpMatch[ 1 ].replace( /\.bbm$/i, '' );
			if ( bmName.charAt( 0 ) === '@' ) bmName = bmName.substring( 1 );
			const bmIdx = pigFile.findBitmapIndexByName( bmName );
			if ( bmIdx !== - 1 ) wi.bitmap = bmIdx;

		} else if ( laserBmpMatch !== null ) {

			wi.render_type = WEAPON_RENDER_LASER;
			let bmName = laserBmpMatch[ 1 ].replace( /\.bbm$/i, '' );
			if ( bmName.charAt( 0 ) === '@' ) bmName = bmName.substring( 1 );
			const bmIdx = pigFile.findBitmapIndexByName( bmName );
			if ( bmIdx !== - 1 ) wi.bitmap = bmIdx;

		} else if ( entry.match( /weapon_pof[=\s]/ ) !== null ) {

			wi.render_type = WEAPON_RENDER_POLYMODEL;

			// Load weapon POF model from HOG
			// Ported from: bm_read_weapon() in BMREAD.C
			const pofMatch = entry.match( /weapon_pof[=\s]+(\S+)/ );
			if ( pofMatch !== null ) {

				const pofName = pofMatch[ 1 ].toLowerCase();
				const pofFile = hogFile.findFile( pofName );
				if ( pofFile !== null ) {

					const model = load_polygon_model( pofFile );
					if ( model !== null ) {

						Polygon_models[ nextModelIndex ] = model;
						wi.model_num = nextModelIndex;
						nextModelIndex ++;

					}

				}

			}

			// Load inner model if specified
			const pofInnerMatch = entry.match( /weapon_pof_inner[=\s]+(\S+)/ );
			if ( pofInnerMatch !== null ) {

				const pofName = pofInnerMatch[ 1 ].toLowerCase();
				const pofFile = hogFile.findFile( pofName );
				if ( pofFile !== null ) {

					const model = load_polygon_model( pofFile );
					if ( model !== null ) {

						Polygon_models[ nextModelIndex ] = model;
						wi.model_num_inner = nextModelIndex;
						nextModelIndex ++;

					}

				}

			}

		} else if ( entry.match( /weapon_vclip[=\s]/ ) !== null ) {

			const m = entry.match( /weapon_vclip[=\s]+(\d+)/ );
			if ( m !== null ) {

				wi.weapon_vclip = parseInt( m[ 1 ] );
				wi.render_type = WEAPON_RENDER_VCLIP;

			}

		} else if ( entry.match( /none_bmp[=\s]/ ) !== null ) {

			wi.render_type = WEAPON_RENDER_NONE;

		}

		weaponIndex ++;
		count ++;

	}

	N_weapon_types = weaponIndex;
	set_N_weapon_types( weaponIndex );

	// Update polygon model count to include weapon POFs
	if ( nextModelIndex > N_polygon_models ) {

		set_N_polygon_models( nextModelIndex );

	}

	const weaponModels = nextModelIndex - WEAPON_MODEL_START_INDEX;
	console.log( 'BM: Parsed ' + count + ' weapon types (total weapon indices: ' + weaponIndex + ', ' + weaponModels + ' weapon POFs loaded)' );

}
