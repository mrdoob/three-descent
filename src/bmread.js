// Ported from: descent-master/MAIN/BMREAD.C
// Reads bitmaps.bin (encrypted text) to build texture tables, effects, sounds, etc.

import { MAX_TEXTURES } from './segment.js';
import { Textures, set_NumTextures, NumTextures } from './mglobal.js';
import { WallAnims, set_Num_wall_anims, WCF_EXPLODES, WCF_BLASTABLE, WCF_TMAP1, WCF_HIDDEN, MAX_WALL_ANIMS } from './wall.js';
import { VCLIP_MAX_FRAMES } from './vclip.js';
import { bm_parse_shareware_vclips } from './vclip.js';
import { bm_parse_shareware_robots, bm_parse_shareware_robot_ai } from './robot.js';
import { bm_parse_shareware_weapons } from './weapon.js';
import {
	Effects, MAX_EFFECTS, EF_CRITICAL, set_Num_effects,
	Sounds, cockpit_bitmap, N_COCKPIT_BITMAPS, Gauges, MAX_GAUGE_BMS,
	TmapInfos, TMI_VOLATILE,
	Powerup_info, Powerup_names, MAX_POWERUP_TYPES, set_N_powerup_types,
	N_robot_types,
	ObjType, ObjId, ObjStrength, MAX_OBJTYPE,
	OL_PLAYER, OL_ROBOT, OL_CONTROL_CENTER, OL_CLUTTER, OL_EXIT,
	Num_total_object_types, set_Num_total_object_types
} from './bm.js';
import { SHAREWARE_MODEL_TABLE } from './polyobj.js';

// Decode XOR/rotate-encrypted bitmaps.bin text
// Mirrors decode_text_line() in BMREAD.C
function decodeBitmapsBin( data ) {

	const decoded = new Uint8Array( data.length );

	for ( let i = 0; i < data.length; i ++ ) {

		let b = data[ i ];

		// rotate left
		const bit7a = ( b & 0x80 ) !== 0 ? 1 : 0;
		b = ( ( b << 1 ) | bit7a ) & 0xFF;

		// XOR with 0xD3
		b = b ^ 0xD3;

		// rotate left again
		const bit7b = ( b & 0x80 ) !== 0 ? 1 : 0;
		b = ( ( b << 1 ) | bit7b ) & 0xFF;

		decoded[ i ] = b;

	}

	// Convert to string
	let text = '';
	for ( let i = 0; i < decoded.length; i ++ ) {

		text += String.fromCharCode( decoded[ i ] );

	}

	return text;

}

// Build texture table from decoded bitmaps.tbl text and PIG file bitmap names
// For shareware PIG format where HAM data is not in the PIG file
export function bm_build_shareware_texture_table( hogFile, pigFile ) {

	// Find bitmaps.bin in HOG
	const bmBinFile = hogFile.findFile( 'bitmaps.bin' );
	if ( bmBinFile === null ) {

		console.warn( 'BM: bitmaps.bin not found in HOG, using identity texture mapping' );
		set_NumTextures( Math.min( pigFile.N_bitmaps, MAX_TEXTURES ) );
		for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

			Textures[ i ] = i;

		}

		return;

	}

	// Read and decrypt bitmaps.bin
	const rawData = bmBinFile.readBytes( bmBinFile.length() );
	const text = decodeBitmapsBin( rawData );

	// Build bitmap name -> PIG index map
	const bmNameToIndex = new Map();
	for ( let i = 0; i < pigFile.N_bitmaps; i ++ ) {

		const bm = pigFile.bitmaps[ i + 1 ]; // +1 because index 0 is bogus
		if ( bm !== undefined ) {

			// Strip any #frame suffix for base name lookup
			const baseName = bm.name.split( '#' )[ 0 ];
			if ( bmNameToIndex.has( baseName ) === false ) {

				bmNameToIndex.set( baseName, i + 1 );

			}

		}

	}

	// Extract $TEXTURES section
	const texStart = text.indexOf( '$TEXTURES' );
	const texEnd = text.indexOf( '$EFFECTS' );

	if ( texStart === - 1 ) {

		console.warn( 'BM: $TEXTURES section not found, using identity mapping' );
		set_NumTextures( Math.min( pigFile.N_bitmaps, MAX_TEXTURES ) );
		for ( let i = 0; i < MAX_TEXTURES; i ++ ) {

			Textures[ i ] = i;

		}

		return;

	}

	const texSection = text.substring( texStart + 9, texEnd !== - 1 ? texEnd : text.length );

	// Parse bitmap names (they end with .bbm) and their properties
	const textureNames = [];
	const textureProps = []; // { lighting, damage, flags } per texture
	let pos = 0;

	while ( pos < texSection.length ) {

		const bbmIdx = texSection.indexOf( '.bbm', pos );
		if ( bbmIdx === - 1 ) break;

		// Walk backwards from .bbm to find start of name
		let nameStart = bbmIdx;
		while ( nameStart > 0 ) {

			const ch = texSection.charCodeAt( nameStart - 1 );
			// Allow alphanumeric, underscore, @
			if ( ( ch >= 48 && ch <= 57 ) || ( ch >= 65 && ch <= 90 ) || ( ch >= 97 && ch <= 122 ) || ch === 95 || ch === 64 ) {

				nameStart --;

			} else {

				break;

			}

		}

		let bmName = texSection.substring( nameStart, bbmIdx );

		// Strip @ prefix (registered-only marker)
		if ( bmName.charAt( 0 ) === '@' ) {

			bmName = bmName.substring( 1 );

		}

		textureNames.push( bmName );

		// Extract properties between this .bbm and the next one (or next $ section)
		const afterBbm = bbmIdx + 4;
		const nextBbm = texSection.indexOf( '.bbm', afterBbm );
		const nextSection = texSection.indexOf( '$', afterBbm );
		let propEnd = texSection.length;
		if ( nextBbm !== - 1 ) propEnd = nextBbm;
		if ( nextSection !== - 1 && nextSection < propEnd ) propEnd = nextSection;

		// Walk back from propEnd to skip the next bitmap name
		if ( nextBbm !== - 1 && propEnd === nextBbm ) {

			let backtrack = nextBbm;
			while ( backtrack > afterBbm ) {

				const ch = texSection.charCodeAt( backtrack - 1 );
				if ( ( ch >= 48 && ch <= 57 ) || ( ch >= 65 && ch <= 90 ) || ( ch >= 97 && ch <= 122 ) || ch === 95 || ch === 64 ) {

					backtrack --;

				} else {

					break;

				}

			}

			propEnd = backtrack;

		}

		const propText = texSection.substring( afterBbm, propEnd );

		let lighting = 0;
		let damage = 0;
		let flags = 0;

		// Parse "lighting" token followed by value
		// Ported from: BMREAD.C line 526
		const lightMatch = propText.match( /lighting[=\s]+([\d.]+)/ );
		if ( lightMatch !== null ) {

			lighting = parseFloat( lightMatch[ 1 ] );

		}

		// Parse "damage" token followed by value
		// Ported from: BMREAD.C line 527
		const damageMatch = propText.match( /damage[=\s]+([\d.]+)/ );
		if ( damageMatch !== null ) {

			damage = parseFloat( damageMatch[ 1 ] );

		}

		// Parse "volatile" keyword (no value)
		// Ported from: BMREAD.C line 528
		if ( propText.indexOf( 'volatile' ) !== - 1 ) {

			flags |= TMI_VOLATILE;

		}

		textureProps.push( { lighting, damage, flags } );

		pos = afterBbm;

	}

	// Build Textures[] mapping
	const numTextures = Math.min( textureNames.length, MAX_TEXTURES );
	set_NumTextures( numTextures );

	let found = 0;
	let missing = 0;

	let numWithLighting = 0;
	let numWithDamage = 0;
	let numVolatile = 0;

	for ( let i = 0; i < numTextures; i ++ ) {

		const bmIdx = bmNameToIndex.get( textureNames[ i ] );
		if ( bmIdx !== undefined ) {

			Textures[ i ] = bmIdx;
			found ++;

		} else {

			// Use bogus bitmap (index 0) for missing textures
			Textures[ i ] = 0;
			missing ++;

		}

		// Populate TmapInfo properties
		// Ported from: BMREAD.C lines 526-528
		const props = textureProps[ i ];
		if ( props !== undefined ) {

			TmapInfos[ i ].lighting = props.lighting;
			TmapInfos[ i ].damage = props.damage;
			TmapInfos[ i ].flags = props.flags;
			TmapInfos[ i ].filename = textureNames[ i ];

			if ( props.lighting > 0 ) numWithLighting ++;
			if ( props.damage > 0 ) numWithDamage ++;
			if ( ( props.flags & TMI_VOLATILE ) !== 0 ) numVolatile ++;

		}

	}

	// Fill remaining with identity
	for ( let i = numTextures; i < MAX_TEXTURES; i ++ ) {

		Textures[ i ] = 0;

	}

	console.log( 'BM: Built shareware texture table: ' + found + ' found, ' + missing + ' missing out of ' + numTextures );
	if ( numWithLighting > 0 || numWithDamage > 0 || numVolatile > 0 ) {

		console.log( 'BM: TmapInfo properties: ' + numWithLighting + ' with lighting, ' + numWithDamage + ' with damage, ' + numVolatile + ' volatile' );

	}

	// Also parse vclip data from bitmaps.bin
	bm_parse_shareware_vclips( text, pigFile );

	// Parse effect clips (animated textures) from bitmaps.bin
	// Must come BEFORE wclips — in original code, eclips allocate Textures[] slots
	// between the regular textures and the door frame textures
	const eclipTextureCount = bm_parse_shareware_eclips( text, pigFile );

	// Parse wall animation clips from bitmaps.bin
	// Door frame textures come after eclip textures
	bm_parse_shareware_wclips( text, pigFile, eclipTextureCount );

	// Parse sound mapping table from bitmaps.bin
	bm_parse_shareware_sounds( text, pigFile );

	// Initialize ObjType table — player is always entry 0
	// Ported from: bm_init_use_tbl() in BMREAD.C lines 397-399
	ObjType[ 0 ] = OL_PLAYER;
	ObjId[ 0 ] = 0;
	set_Num_total_object_types( 1 );

	// Parse robot data from bitmaps.bin
	bm_parse_shareware_robots( text );
	bm_parse_shareware_robot_ai( text );

	// Add robot entries to ObjType table
	// Ported from: bm_read_robot() in BMREAD.C lines 1232-1233, 1264
	bm_populate_robot_obj_types();

	// Parse weapon data from bitmaps.bin
	bm_parse_shareware_weapons( text, pigFile, hogFile );

	// Parse powerup data from bitmaps.bin
	bm_parse_shareware_powerups( text );

	// Parse object data (reactors, exit models, clutter) from bitmaps.bin
	// Ported from: bm_read_object() in BMREAD.C lines 1268-1359
	bm_parse_shareware_objects( text );

	// Parse cockpit and gauge bitmap data from bitmaps.bin
	bm_parse_shareware_cockpit( text, pigFile );
	bm_parse_shareware_gauges( text, pigFile );

}

// Parse $WCLIP entries from decoded bitmaps.bin text
// Each entry defines a door/wall animation sequence
// Door frames are added as new Textures[] entries beyond the normal texture table
// Ported from: bm_read_wclip() in BMREAD.C
function bm_parse_shareware_wclips( text, pigFile, startTextureCount ) {

	let maxClipNum = 0;
	let count = 0;

	// Current texture_count starts after existing textures (including eclip textures)
	let texture_count = startTextureCount !== undefined ? startTextureCount : NumTextures;

	let pos = 0;

	while ( true ) {

		const idx = text.indexOf( '$WCLIP', pos );
		if ( idx === - 1 ) break;

		pos = idx + 6;

		// Parse clip_num (format: clip_num=N or clip_num N)
		const clipNumMatch = text.substring( pos, pos + 60 ).match( /clip_num[=\s]+(\d+)/ );
		if ( clipNumMatch === null ) continue;

		const clipNum = parseInt( clipNumMatch[ 1 ] );
		if ( clipNum >= MAX_WALL_ANIMS ) continue;

		// Parse time (format: time=N or time N)
		const timeMatch = text.substring( pos, pos + 200 ).match( /time[=\s]+([\d.]+)/ );
		const playTime = timeMatch !== null ? parseFloat( timeMatch[ 1 ] ) : 1.0;

		// Parse open_sound
		const openSoundMatch = text.substring( pos, pos + 200 ).match( /open_sound[=\s]+(-?\d+)/ );
		const openSound = openSoundMatch !== null ? parseInt( openSoundMatch[ 1 ] ) : - 1;

		// Parse close_sound
		const closeSoundMatch = text.substring( pos, pos + 200 ).match( /close_sound[=\s]+(-?\d+)/ );
		const closeSound = closeSoundMatch !== null ? parseInt( closeSoundMatch[ 1 ] ) : - 1;

		// Parse flags
		let flags = 0;
		const tmap1Match = text.substring( pos, pos + 200 ).match( /tmap1_flag[=\s]+(\d+)/ );
		if ( tmap1Match !== null && parseInt( tmap1Match[ 1 ] ) !== 0 ) flags |= WCF_TMAP1;

		const blastableMatch = text.substring( pos, pos + 200 ).match( /blastable[=\s]+(\d+)/ );
		if ( blastableMatch !== null && parseInt( blastableMatch[ 1 ] ) !== 0 ) flags |= WCF_BLASTABLE;

		const explodesMatch = text.substring( pos, pos + 200 ).match( /explodes[=\s]+(\d+)/ );
		if ( explodesMatch !== null && parseInt( explodesMatch[ 1 ] ) !== 0 ) flags |= WCF_EXPLODES;

		const hiddenMatch = text.substring( pos, pos + 200 ).match( /hidden[=\s]+(\d+)/ );
		if ( hiddenMatch !== null && parseInt( hiddenMatch[ 1 ] ) !== 0 ) flags |= WCF_HIDDEN;

		// Find the .abm filename
		const abmMatch = text.substring( pos, pos + 300 ).match( /([a-zA-Z][a-zA-Z0-9]*)\.abm/ );
		if ( abmMatch === null ) continue;

		const baseName = abmMatch[ 1 ];

		// Find frames in PIG: baseName#0, baseName#1, etc.
		const frames = [];
		for ( let f = 0; f < 20; f ++ ) {

			const frameName = baseName + '#' + f;
			const bmIdx = pigFile.findBitmapIndexByName( frameName );
			if ( bmIdx < 0 ) break;

			// Add as new texture entry
			if ( texture_count < MAX_TEXTURES ) {

				Textures[ texture_count ] = bmIdx;
				frames.push( texture_count );
				texture_count ++;

			}

		}

		if ( frames.length === 0 ) continue;

		// Store wall animation clip
		const wc = WallAnims[ clipNum ];
		wc.play_time = playTime;
		wc.num_frames = frames.length;
		wc.frames = frames;
		wc.open_sound = openSound;
		wc.close_sound = closeSound;
		wc.flags = flags;
		wc.filename = baseName + '.abm';

		if ( clipNum > maxClipNum ) maxClipNum = clipNum;
		count ++;

	}

	set_Num_wall_anims( maxClipNum + 1 );

	// Update NumTextures to include door frame textures
	set_NumTextures( texture_count );

	console.log( 'BM: Parsed ' + count + ' wall animation clips, texture_count now=' + texture_count );

}

// Parse $ECLIP entries from decoded bitmaps.bin text
// Each entry defines an animated texture effect (fans, monitors, lava, warning lights, etc.)
// In the original code, each non-obj non-crit eclip allocates a NEW Textures[] entry for its
// first frame bitmap. The level data references these indices for animated texture sides.
// Ported from: bm_read_eclip() in BMREAD.C
function bm_parse_shareware_eclips( text, pigFile ) {

	let maxClipNum = 0;
	let count = 0;

	// Eclip textures are allocated after regular textures
	let texture_count = NumTextures;

	// Build map of existing TmapInfo filenames for dest_bm deduplication
	// Ported from: BMREAD.C lines 772-774 — search existing TmapInfo[].filename
	const existingTextureNames = new Map();
	for ( let i = 0; i < texture_count; i ++ ) {

		if ( TmapInfos[ i ].filename !== undefined && TmapInfos[ i ].filename !== '' ) {

			existingTextureNames.set( TmapInfos[ i ].filename.toLowerCase(), i );

		}

	}

	// Track dest_bm allocations made during this loop for deduplication
	const destBmAllocations = new Map();

	let pos = 0;

	while ( true ) {

		const idx = text.indexOf( '$ECLIP', pos );
		if ( idx === - 1 ) break;

		pos = idx + 6;

		// Find end of this entry (next $ marker or end of text)
		// bitmaps.bin entries may not have newlines between them
		let entryEnd = text.length;
		const nextDollar = text.indexOf( '$', pos );
		if ( nextDollar !== - 1 ) entryEnd = nextDollar;
		const entry = text.substring( pos, entryEnd );

		// Parse clip_num
		const clipNumMatch = entry.match( /clip_num[=\s]+(\d+)/ );
		if ( clipNumMatch === null ) continue;

		const clipNum = parseInt( clipNumMatch[ 1 ] );
		if ( clipNum >= MAX_EFFECTS ) continue;

		// Parse time
		const timeMatch = entry.match( /time[=\s]+([\d.]+)/ );
		const playTime = timeMatch !== null ? parseFloat( timeMatch[ 1 ] ) : 1.0;

		// Parse obj_eclip flag
		const objEclipMatch = entry.match( /obj_eclip[=\s]+(\d+)/ );
		const objEclip = objEclipMatch !== null ? parseInt( objEclipMatch[ 1 ] ) : 0;

		// Parse crit_clip
		const critClipMatch = entry.match( /crit_clip[=\s]+(-?\d+)/ );
		const critClip = critClipMatch !== null ? parseInt( critClipMatch[ 1 ] ) : - 1;

		// Parse crit_flag
		const critFlagMatch = entry.match( /crit_flag[=\s]+(\d+)/ );
		const critFlag = critFlagMatch !== null ? parseInt( critFlagMatch[ 1 ] ) : 0;

		// Parse sound_num
		const soundMatch = entry.match( /sound_num[=\s]+(-?\d+)/ );
		const soundNum = soundMatch !== null ? parseInt( soundMatch[ 1 ] ) : - 1;

		// Parse dest_bm
		const destBmMatch = entry.match( /dest_bm[=\s]+([a-zA-Z][a-zA-Z0-9]*\.bbm)/ );

		// Parse dest_vclip
		const destVclipMatch = entry.match( /dest_vclip[=\s]+(-?\d+)/ );
		const destVclip = destVclipMatch !== null ? parseInt( destVclipMatch[ 1 ] ) : - 1;

		// Parse dest_eclip
		const destEclipMatch = entry.match( /dest_eclip[=\s]+(-?\d+)/ );
		const destEclip = destEclipMatch !== null ? parseInt( destEclipMatch[ 1 ] ) : - 1;

		// Parse dest_size
		const destSizeMatch = entry.match( /dest_size[=\s]+([\d.]+)/ );
		const destSize = destSizeMatch !== null ? parseFloat( destSizeMatch[ 1 ] ) : 0;

		// Parse vlighting
		const lightMatch = entry.match( /vlighting[=\s]+(-?[\d.]+)/ );
		const lightValue = lightMatch !== null ? parseFloat( lightMatch[ 1 ] ) : 0;

		// Find the .abm filename
		const abmMatch = entry.match( /([a-zA-Z@][a-zA-Z0-9_]*)\.abm/ );
		if ( abmMatch === null ) continue;

		let baseName = abmMatch[ 1 ];

		// Strip @ prefix (registered-only marker)
		if ( baseName.charAt( 0 ) === '@' ) {

			baseName = baseName.substring( 1 );

		}

		// Find frames in PIG: baseName#0, baseName#1, etc.
		const frames = [];
		for ( let f = 0; f < VCLIP_MAX_FRAMES; f ++ ) {

			const frameName = baseName + '#' + f;
			const bmIdx = pigFile.findBitmapIndexByName( frameName );
			if ( bmIdx < 0 ) break;
			frames.push( bmIdx );

		}

		// Allocate Textures[] entry for non-object, non-critical eclips
		// Slot is always allocated even for missing ABMs (index 0 placeholder)
		// to keep texture indices aligned with level data
		// Ported from: bm_read_eclip() in BMREAD.C lines 733-742
		let changingWallTexture = - 1;

		if ( objEclip === 0 && critFlag === 0 ) {

			if ( texture_count < MAX_TEXTURES ) {

				changingWallTexture = texture_count;
				Textures[ texture_count ] = frames.length > 0 ? frames[ 0 ] : 0;
				texture_count ++;

			}

		}

		// Allocate dest_bm texture slot (destroyed bitmap for breakable monitors)
		// Must happen before the frames.length check — registered-only eclips
		// still need dest_bm slots allocated to keep indices aligned
		// Ported from: bm_read_eclip() in BMREAD.C lines 767-782
		let destBmNum = - 1;

		if ( destBmMatch !== null ) {

			const destBmName = destBmMatch[ 1 ].replace( /\.bbm$/i, '' );
			const destBmNameLower = destBmName.toLowerCase();

			// Search existing textures first (deduplication)
			const existingIdx = existingTextureNames.get( destBmNameLower );
			if ( existingIdx !== undefined ) {

				destBmNum = existingIdx;

			} else {

				const allocIdx = destBmAllocations.get( destBmNameLower );
				if ( allocIdx !== undefined ) {

					destBmNum = allocIdx;

				} else if ( texture_count < MAX_TEXTURES ) {

					// Allocate new slot (use index 0 if bitmap not in PIG)
					const destBmIdx = pigFile.findBitmapIndexByName( destBmName );
					Textures[ texture_count ] = destBmIdx >= 0 ? destBmIdx : 0;
					TmapInfos[ texture_count ].filename = destBmName;
					destBmNum = texture_count;
					destBmAllocations.set( destBmNameLower, texture_count );
					texture_count ++;

				}

			}

		}

		// Registered-only eclip — slots allocated above, skip animation data
		if ( frames.length === 0 ) {

			if ( clipNum > maxClipNum ) maxClipNum = clipNum;
			count ++;
			continue;

		}

		// Store effect clip
		const ec = Effects[ clipNum ];
		ec.vc_play_time = playTime;
		ec.vc_num_frames = frames.length;
		ec.vc_frame_time = frames.length > 0 ? playTime / frames.length : 0;
		ec.vc_light_value = lightValue;
		ec.vc_sound_num = soundNum;
		ec.vc_frames = frames;
		ec.time_left = ec.vc_frame_time;
		ec.frame_count = 0;
		ec.changing_wall_texture = changingWallTexture;
		ec.changing_object_texture = - 1;

		// Set reverse mapping: TmapInfo for this texture knows which eclip animates it
		if ( changingWallTexture !== - 1 && changingWallTexture < TmapInfos.length ) {

			TmapInfos[ changingWallTexture ].eclip_num = clipNum;

		}

		ec.flags = critFlag !== 0 ? EF_CRITICAL : 0;
		ec.crit_clip = critClip;
		ec.sound_num = soundNum;
		ec.dest_bm_num = destBmNum;
		ec.dest_vclip = destVclip;
		ec.dest_eclip = destEclip;
		ec.dest_size = destSize;
		ec.segnum = - 1;
		ec.sidenum = - 1;

		if ( clipNum > maxClipNum ) maxClipNum = clipNum;
		count ++;

	}

	set_Num_effects( maxClipNum + 1 );

	// Update NumTextures to include eclip texture entries
	set_NumTextures( texture_count );

	let withWallTex = 0;
	for ( let i = 0; i < maxClipNum + 1; i ++ ) {

		if ( Effects[ i ].changing_wall_texture !== - 1 ) withWallTex ++;

	}

	console.log( 'BM: Parsed ' + count + ' eclips (max clip_num=' + maxClipNum + ', ' + withWallTex + ' with wall textures, texture_count now=' + texture_count + ')' );

	return texture_count;

}

// Parse $SOUND entries from decoded bitmaps.bin text
// Each entry: $SOUND sound_id alt_sound_id filename.raw
// Maps game sound IDs to PIG file sound indices
function bm_parse_shareware_sounds( text, pigFile ) {

	// Build PIG sound name -> index map
	const sndNameToIndex = new Map();
	for ( let i = 0; i < pigFile.sounds.length; i ++ ) {

		const name = pigFile.sounds[ i ].name.toLowerCase();
		sndNameToIndex.set( name, i );

	}

	const MAX_SOUNDS = 250;
	let count = 0;
	let pos = 0;

	while ( true ) {

		const idx = text.indexOf( '$SOUND', pos );
		if ( idx === - 1 ) break;

		pos = idx + 6;

		// Skip $SOUNDS (section header) — we want individual $SOUND entries
		// $SOUNDS would have an 'S' at pos, while $SOUND entries have a space or digit
		const nextChar = text.charAt( pos );
		if ( nextChar === 'S' || nextChar === 's' ) continue;

		// Find end of this entry (next $ marker)
		let endPos = text.indexOf( '$', pos );
		if ( endPos === - 1 ) endPos = text.length;

		const entry = text.substring( pos, endPos );

		// Parse: sound_id filename.raw
		// Shareware format has just sound_id and filename (no alt_sound_id)
		const match = entry.match( /\s*(\d+)\s+(\S+\.raw)/ );
		if ( match === null ) continue;

		const soundId = parseInt( match[ 1 ] );
		if ( soundId >= MAX_SOUNDS ) continue;

		let filename = match[ 2 ].toLowerCase();

		// Strip .raw extension if present
		if ( filename.endsWith( '.raw' ) ) {

			filename = filename.substring( 0, filename.length - 4 );

		}

		// Strip @ prefix (registered-only marker)
		if ( filename.charAt( 0 ) === '@' ) {

			filename = filename.substring( 1 );

		}

		// Look up PIG sound index
		const pigIdx = sndNameToIndex.get( filename );
		if ( pigIdx !== undefined ) {

			Sounds[ soundId ] = pigIdx;
			count ++;

		}

	}

	console.log( 'BM: Parsed ' + count + ' sound mappings (PIG has ' + pigFile.sounds.length + ' sounds)' );

}

// Parse $COCKPIT entries from decoded bitmaps.bin text
// Ported from: BMREAD.C BM_COCKPIT handling
// Each entry is a .bbm filename -> resolved to PIG bitmap index
function bm_parse_shareware_cockpit( text, pigFile ) {

	const cockpitStart = text.indexOf( '$COCKPIT' );
	const gaugesStart = text.indexOf( '$GAUGES' );

	if ( cockpitStart === - 1 ) {

		console.warn( 'BM: $COCKPIT section not found' );
		return;

	}

	const endPos = gaugesStart !== - 1 ? gaugesStart : text.length;
	const section = text.substring( cockpitStart + 8, endPos );

	// Extract .bbm filenames
	const fileRegex = /([a-zA-Z0-9_]+)\.bbm/g;
	let m;
	let count = 0;

	while ( ( m = fileRegex.exec( section ) ) !== null ) {

		if ( count >= N_COCKPIT_BITMAPS ) break;

		const bmName = m[ 1 ];
		const bmIdx = pigFile.findBitmapIndexByName( bmName );

		if ( bmIdx !== - 1 ) {

			cockpit_bitmap[ count ] = bmIdx;

		} else {

			console.warn( 'BM: Cockpit bitmap not found: ' + bmName );

		}

		count ++;

	}

	console.log( 'BM: Parsed ' + count + ' cockpit bitmaps' );

}

// Parse $GAUGES entries from decoded bitmaps.bin text
// Ported from: BMREAD.C bm_read_gauges() / BM_GAUGES handling
// Entries are .bbm (single) or .abm (animated, preceded by abm_flag=1)
// ABM frames map to sequential Gauges[] slots
function bm_parse_shareware_gauges( text, pigFile ) {

	const gaugesStart = text.indexOf( '$GAUGES' );
	const weaponStart = text.indexOf( '$WEAPON' );

	if ( gaugesStart === - 1 ) {

		console.warn( 'BM: $GAUGES section not found' );
		return;

	}

	const endPos = weaponStart !== - 1 ? weaponStart : text.length;
	const section = text.substring( gaugesStart + 7, endPos );

	// Parse entries: abm_flag=1 followed by .abm, or standalone .bbm
	// Entries fill Gauges[] sequentially (clip_count in original)
	let clipCount = 0;
	let pos = 0;

	while ( pos < section.length && clipCount < MAX_GAUGE_BMS ) {

		// Look for next file entry (.bbm or .abm)
		const bbmIdx = section.indexOf( '.bbm', pos );
		const abmIdx = section.indexOf( '.abm', pos );

		// Find whichever comes first
		let nextIdx = - 1;
		let isAbm = false;

		if ( bbmIdx !== - 1 && abmIdx !== - 1 ) {

			if ( bbmIdx < abmIdx ) {

				nextIdx = bbmIdx;

			} else {

				nextIdx = abmIdx;
				isAbm = true;

			}

		} else if ( bbmIdx !== - 1 ) {

			nextIdx = bbmIdx;

		} else if ( abmIdx !== - 1 ) {

			nextIdx = abmIdx;
			isAbm = true;

		} else {

			break;

		}

		// Walk backwards to find start of filename
		let nameStart = nextIdx;

		while ( nameStart > 0 ) {

			const ch = section.charCodeAt( nameStart - 1 );

			if ( ( ch >= 48 && ch <= 57 ) || ( ch >= 65 && ch <= 90 ) || ( ch >= 97 && ch <= 122 ) || ch === 95 ) {

				nameStart --;

			} else {

				break;

			}

		}

		const bmName = section.substring( nameStart, nextIdx );
		pos = nextIdx + 4;

		if ( bmName.length === 0 ) continue;

		if ( isAbm === true ) {

			// Animated bitmap: look up frames basename#0, basename#1, ...
			let frameNum = 0;

			while ( clipCount < MAX_GAUGE_BMS ) {

				const frameName = bmName + '#' + frameNum;
				const bmIdx = pigFile.findBitmapIndexByName( frameName );

				if ( bmIdx === - 1 ) break;

				Gauges[ clipCount ] = bmIdx;
				clipCount ++;
				frameNum ++;

			}

		} else {

			// Single bitmap
			const bmIdx = pigFile.findBitmapIndexByName( bmName );

			if ( bmIdx !== - 1 ) {

				Gauges[ clipCount ] = bmIdx;

			} else {

				console.warn( 'BM: Gauge bitmap not found: ' + bmName );

			}

			clipCount ++;

		}

	}

	console.log( 'BM: Parsed ' + clipCount + ' gauge bitmap slots' );

}

// Parse $POWERUP entries from decoded bitmaps.bin text
// Each entry: $POWERUP vclip_num=N hit_sound=N light=F size=F name="Name"
// $POWERUP_UNUSED entries increment counter but don't parse properties
// Ported from: bm_read_powerup() in BMREAD.C lines 1785-1842
function bm_parse_shareware_powerups( text ) {

	let count = 0;
	let n = 0;
	let pos = 0;

	while ( pos < text.length ) {

		// Find next $POWERUP entry
		const idx = text.indexOf( '$POWERUP', pos );
		if ( idx === - 1 ) break;

		// Check if it's $POWERUP_UNUSED
		const afterTag = idx + 8;
		const isUnused = ( text.substring( afterTag, afterTag + 7 ) === '_UNUSED' );

		if ( isUnused ) {

			// $POWERUP_UNUSED: just increment counter
			n ++;
			pos = afterTag + 7;
			continue;

		}

		// Make sure it's exactly $POWERUP (not $POWERUP_something)
		const charAfter = text.charCodeAt( afterTag );
		// Must be whitespace or end-of-string to be a real $POWERUP
		if ( charAfter > 32 && charAfter !== 36 ) { // not space/tab/newline and not next '$'

			pos = afterTag;
			continue;

		}

		if ( n >= MAX_POWERUP_TYPES ) {

			pos = afterTag;
			continue;

		}

		// Find end of this entry (next $ or end of text)
		let entryEnd = text.indexOf( '$', afterTag );
		if ( entryEnd === - 1 ) entryEnd = text.length;
		const entry = text.substring( afterTag, entryEnd );

		// Parse vclip_num=N
		const vclipMatch = entry.match( /vclip_num[=\s]+(-?\d+)/ );
		if ( vclipMatch !== null ) {

			Powerup_info[ n ].vclip_num = parseInt( vclipMatch[ 1 ], 10 );

		}

		// Parse hit_sound=N
		const soundMatch = entry.match( /hit_sound[=\s]+(-?\d+)/ );
		if ( soundMatch !== null ) {

			Powerup_info[ n ].hit_sound = parseInt( soundMatch[ 1 ], 10 );

		}

		// Parse light=F
		const lightMatch = entry.match( /light[=\s]+([\d.]+)/ );
		if ( lightMatch !== null ) {

			Powerup_info[ n ].light = parseFloat( lightMatch[ 1 ] );

		}

		// Parse size=F
		const sizeMatch = entry.match( /size[=\s]+([\d.]+)/ );
		if ( sizeMatch !== null ) {

			Powerup_info[ n ].size = parseFloat( sizeMatch[ 1 ] );

		}

		// Parse name="Name"
		const nameMatch = entry.match( /name[=\s]+"([^"]*)"/ );
		if ( nameMatch !== null ) {

			Powerup_names[ n ] = nameMatch[ 1 ];

		}

		n ++;
		count ++;
		pos = afterTag;

	}

	set_N_powerup_types( n );
	console.log( 'BM: Parsed ' + count + ' powerup types (N_powerup_types=' + n + ')' );

}

// Populate ObjType table entries for robots (after robot parsing)
// Ported from: bm_read_robot() in BMREAD.C lines 1232-1233, 1264
function bm_populate_robot_obj_types() {

	let n = Num_total_object_types;

	for ( let i = 0; i < N_robot_types; i ++ ) {

		if ( n >= MAX_OBJTYPE ) break;

		ObjType[ n ] = OL_ROBOT;
		ObjId[ n ] = i;
		n ++;

	}

	set_Num_total_object_types( n );

}

// Parse $OBJECT entries from decoded bitmaps.bin text
// Each entry defines a non-robot polygon object (reactor, exit, clutter)
// Ported from: bm_read_object() in BMREAD.C lines 1268-1359
function bm_parse_shareware_objects( text ) {

	// Build POF filename -> model index lookup from SHAREWARE_MODEL_TABLE
	const pofNameToIndex = new Map();
	for ( let i = 0; i < SHAREWARE_MODEL_TABLE.length; i ++ ) {

		const name = SHAREWARE_MODEL_TABLE[ i ].toLowerCase();
		// Only store first occurrence (some models are reused with different indices)
		if ( pofNameToIndex.has( name ) !== true ) {

			pofNameToIndex.set( name, i );

		}

	}

	let count = 0;
	let pos = 0;

	while ( pos < text.length ) {

		const idx = text.indexOf( '$OBJECT ', pos );
		if ( idx === - 1 ) break;

		pos = idx + 8;

		// Find end of this entry (next $ marker or end of text)
		let entryEnd = text.indexOf( '$', pos );
		if ( entryEnd === - 1 ) entryEnd = text.length;
		const entry = text.substring( pos, entryEnd );

		// First token is the model filename (e.g. "reactor.pof")
		const modelMatch = entry.match( /^(\S+\.pof)/ );
		if ( modelMatch === null ) continue;

		const modelName = modelMatch[ 1 ].toLowerCase();

		// Look up model index from our model table
		const modelIndex = pofNameToIndex.get( modelName );
		if ( modelIndex === undefined ) {

			console.warn( 'BM: $OBJECT model not found: ' + modelName );
			continue;

		}

		// Parse type= field
		let type = - 1;
		const typeMatch = entry.match( /type=(\w+)/ );
		if ( typeMatch !== null ) {

			const typeStr = typeMatch[ 1 ].toLowerCase();
			if ( typeStr === 'controlcen' ) type = OL_CONTROL_CENTER;
			else if ( typeStr === 'clutter' ) type = OL_CLUTTER;
			else if ( typeStr === 'exit' ) type = OL_EXIT;

		}

		// Parse strength= field (fixed-point float)
		let strength = 0;
		const strengthMatch = entry.match( /strength=([\d.]+)/ );
		if ( strengthMatch !== null ) {

			strength = parseFloat( strengthMatch[ 1 ] );

		}

		// Add to ObjType table
		const n = Num_total_object_types;
		if ( n < MAX_OBJTYPE ) {

			ObjType[ n ] = type;
			ObjId[ n ] = modelIndex;
			ObjStrength[ n ] = strength;
			set_Num_total_object_types( n + 1 );

		}

		console.log( 'BM: $OBJECT ' + modelName + ' type=' + type +
			' model_num=' + modelIndex + ' strength=' + strength.toFixed( 1 ) );

		count ++;
		pos = entryEnd;

	}

	console.log( 'BM: Parsed ' + count + ' object types (Num_total_object_types=' + Num_total_object_types + ')' );

}
