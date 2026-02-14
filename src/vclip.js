// Ported from: descent-master/MAIN/VCLIP.C and VCLIP.H
// Video clip (animated sprite sequence) definitions and parsing

export const VCLIP_MAXNUM = 70;
export const VCLIP_MAX_FRAMES = 30;

// VClip class - animated sprite sequence
export class Vclip {

	constructor() {

		this.play_time = 0;		// total time in seconds
		this.num_frames = 0;
		this.frame_time = 0;	// time per frame in seconds
		this.flags = 0;
		this.sound_num = - 1;
		this.frames = [];		// array of bitmap names (base name + frame index)
		this.light_value = 0;

	}

}

// Global vclip array
export const Vclips = [];
for ( let i = 0; i < VCLIP_MAXNUM; i ++ ) {

	Vclips.push( new Vclip() );

}

export let Num_vclips = 0;

export function set_Num_vclips( n ) {

	Num_vclips = n;

}

// Parse $VCLIP entries from decoded bitmaps.bin text
// Each entry: $VCLIP clip_num=N time=T abm_flag=1 vlighting=V sound_num=S filename.abm
// The .abm frames map to PIG bitmaps as "basename#0", "basename#1", etc.
export function bm_parse_shareware_vclips( text, pigFile ) {

	let maxClipNum = 0;
	let count = 0;

	// Find all $VCLIP entries (may be preceded by @ for registered-only)
	let pos = 0;

	while ( true ) {

		const idx = text.indexOf( '$VCLIP', pos );
		if ( idx === - 1 ) break;

		pos = idx + 6;

		// Parse clip_num
		const clipNumMatch = text.substring( pos, pos + 40 ).match( /clip_num=(\d+)/ );
		if ( clipNumMatch === null ) continue;

		const clipNum = parseInt( clipNumMatch[ 1 ] );
		if ( clipNum >= VCLIP_MAXNUM ) continue;

		// Parse time
		const timeMatch = text.substring( pos, pos + 80 ).match( /time=([\d.]+)/ );
		const playTime = timeMatch !== null ? parseFloat( timeMatch[ 1 ] ) : 1.0;

		// Parse vlighting
		const lightMatch = text.substring( pos, pos + 100 ).match( /vlighting=(-?[\d.]+)/ );
		const lightValue = lightMatch !== null ? parseFloat( lightMatch[ 1 ] ) : 0;

		// Parse sound_num
		const soundMatch = text.substring( pos, pos + 120 ).match( /sound_num=(-?\d+)/ );
		const soundNum = soundMatch !== null ? parseInt( soundMatch[ 1 ] ) : - 1;

		// Find the .abm filename — bitmap names are alphanumeric (e.g. exp13, pwr01, hostage)
		// Note: no whitespace between sound_num=N and filename, so we match [a-zA-Z][a-zA-Z0-9]*
		const abmMatch = text.substring( pos, pos + 200 ).match( /([a-zA-Z][a-zA-Z0-9]*)\.abm/ );
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

		if ( frames.length === 0 ) continue;

		// Store vclip
		const vc = Vclips[ clipNum ];
		vc.play_time = playTime;
		vc.num_frames = frames.length;
		vc.frame_time = frames.length > 0 ? playTime / frames.length : 0;
		vc.light_value = lightValue;
		vc.sound_num = soundNum;
		vc.frames = frames;

		if ( clipNum > maxClipNum ) maxClipNum = clipNum;
		count ++;

	}

	Num_vclips = maxClipNum + 1;
	console.log( 'BM: Parsed ' + count + ' vclips (max clip_num=' + maxClipNum + ')' );

}
