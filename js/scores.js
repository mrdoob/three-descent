// Ported from: descent-master/MAIN/SCORES.C
// High score display

import { pcx_read, pcx_to_canvas } from './pcx.js';
import { get_title_canvas } from './titles.js';
import { gr_string, gr_get_string_size } from './font.js';
import { SUBTITLE_FONT, GAME_FONT } from './gamefont.js';

const MAX_HIGH_SCORES = 10;

// Default high scores (from SCORES.C lines 327-344)
const DEFAULT_SCORES = [
	{ name: 'Parallax', score: 10000, diff_level: 4, starting_level: 1, ending_level: 7, seconds: 7200 },
	{ name: 'Mike', score: 9000, diff_level: 3, starting_level: 1, ending_level: 7, seconds: 5400 },
	{ name: 'Matt', score: 8000, diff_level: 3, starting_level: 1, ending_level: 6, seconds: 4800 },
	{ name: 'John', score: 7000, diff_level: 2, starting_level: 1, ending_level: 5, seconds: 3600 },
	{ name: 'Yuan', score: 6000, diff_level: 2, starting_level: 1, ending_level: 4, seconds: 3000 },
	{ name: 'Adam', score: 5000, diff_level: 1, starting_level: 1, ending_level: 3, seconds: 2400 },
	{ name: 'Mark', score: 4000, diff_level: 1, starting_level: 1, ending_level: 3, seconds: 1800 },
	{ name: 'Allender', score: 3000, diff_level: 1, starting_level: 1, ending_level: 2, seconds: 1200 },
	{ name: 'Jasen', score: 2000, diff_level: 0, starting_level: 1, ending_level: 2, seconds: 900 },
	{ name: 'Rob', score: 1000, diff_level: 0, starting_level: 1, ending_level: 1, seconds: 600 },
];

// Difficulty names (from GAME.H)
const DIFFICULTY_NAMES = [ 'Trainee', 'Rookie', 'Hotshot', 'Ace', 'Insane' ];

// Format number with commas (from SCORES.C int_to_string)
function int_to_string( number ) {

	const str = String( number );
	if ( str.length <= 3 ) return str;

	let result = '';
	let count = 0;

	for ( let i = str.length - 1; i >= 0; i -- ) {

		if ( count === 3 ) {

			result = ',' + result;
			count = 0;

		}

		result = str[ i ] + result;
		count ++;

	}

	return result;

}

// Format seconds as h:mm:ss
function format_time( totalSeconds ) {

	const h = Math.floor( totalSeconds / 3600 );
	const remainder = totalSeconds % 3600;
	const m = Math.floor( remainder / 60 );
	const s = remainder % 60;

	return h + ':' + String( m ).padStart( 2, '0' ) + ':' + String( s ).padStart( 2, '0' );

}

// Find closest palette color to target RGB values
function findClosestColor( palette, r, g, b ) {

	let bestIdx = 0;
	let bestDist = Infinity;

	for ( let i = 0; i < 256; i ++ ) {

		const dr = palette[ i * 3 ] - r;
		const dg = palette[ i * 3 + 1 ] - g;
		const db = palette[ i * 3 + 2 ] - b;
		const dist = dr * dr + dg * dg + db * db;

		if ( dist < bestDist ) {

			bestDist = dist;
			bestIdx = i;

		}

	}

	return bestIdx;

}

// Right-aligned text rendering
// Ported from: scores_rprintf() in SCORES.C lines 487-505
function gr_string_right( imageData, font, rightX, y, text, gamePalette, fgColorIndex ) {

	const size = gr_get_string_size( font, text );
	gr_string( imageData, font, rightX - size.width, y, text, gamePalette, fgColorIndex );

}

// Show high scores display
// Ported from: scores_view() in SCORES.C lines 554-660
export async function scores_view( hogFile, gamePalette ) {

	const { canvas: titleCanvas, ctx: titleCtx, inner: titleInner } = get_title_canvas();

	// Try to load scores.pcx background (used by nm_draw_background in NEWMENU.C)
	const pcxData = pcx_read( hogFile, 'scores.pcx' );

	if ( pcxData !== null ) {

		const pcxCanvas = pcx_to_canvas( pcxData );

		if ( pcxCanvas !== null ) {

			titleCanvas.width = pcxCanvas.width;
			titleCanvas.height = pcxCanvas.height;
			titleCtx.drawImage( pcxCanvas, 0, 0 );

		}

	} else {

		// Fallback: dark blue background
		titleCanvas.width = 320;
		titleCanvas.height = 200;
		titleCtx.fillStyle = '#0a0a2a';
		titleCtx.fillRect( 0, 0, 320, 200 );

	}

	const imageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );
	titleCanvas.style.display = 'block';

	const titleFont = SUBTITLE_FONT();
	const dataFont = GAME_FONT();

	if ( titleFont === null || dataFont === null ) {

		console.warn( 'SCORES: Fonts not loaded' );
		return;

	}

	// Find palette colors for text rendering
	// BM_XRGB(31,26,5) → golden (VGA 6-bit scaled: 124,104,20)
	// BM_XRGB(28,28,28) → bright gray (112,112,112)
	const goldenIdx = findClosestColor( gamePalette, 124, 104, 20 );
	const brightIdx = findClosestColor( gamePalette, 224, 224, 224 );

	// Layout constants (from SCORES.C lines 297-298)
	const XX = 7;
	const YY = - 3;

	// Title "HIGH SCORES" — centered at y=15, using SUBTITLE_FONT (color font)
	// Ported from: SCORES.C line 573
	gr_string( imageData, titleFont, 0x8000, 15, 'HIGH SCORES', gamePalette );

	// Cool saying quote — centered at y=31
	// Ported from: SCORES.C line 591
	gr_string( imageData, dataFont, 0x8000, 31, '"REGISTER DESCENT TODAY!" - Parallax', gamePalette, brightIdx );

	// Column headers — using GAME_FONT with golden color
	// Ported from: SCORES.C lines 578-584
	gr_string( imageData, dataFont, 31 + 33 + XX, 46 + 7 + YY, 'NAME', gamePalette, goldenIdx );
	gr_string( imageData, dataFont, 82 + 33 + XX, 46 + 7 + YY, 'SCORE', gamePalette, goldenIdx );
	gr_string( imageData, dataFont, 127 + 33 + XX, 46 + 7 + YY, 'SKILL', gamePalette, goldenIdx );
	gr_string( imageData, dataFont, 170 + 33 + XX, 46 + 7 + YY, 'LEVELS', gamePalette, goldenIdx );
	gr_string( imageData, dataFont, 288 - 42 + XX, 46 + 7 + YY, 'TIME', gamePalette, goldenIdx );

	// Score entries
	// Ported from: scores_draw_item() in SCORES.C lines 508-552
	for ( let i = 0; i < MAX_HIGH_SCORES; i ++ ) {

		const stats = DEFAULT_SCORES[ i ];
		let y = 7 + 70 + i * 9 + YY;

		// First entry gets extra space above (from SCORES.C line 516)
		if ( i === 0 ) y -= 8;

		// Rank (right-aligned)
		gr_string_right( imageData, dataFont, 17 + 33 + XX, y, ( i + 1 ) + '.', gamePalette, brightIdx );

		// Name
		gr_string( imageData, dataFont, 26 + 33 + XX, y, stats.name, gamePalette, brightIdx );

		// Score (right-aligned)
		gr_string_right( imageData, dataFont, 109 + 33 + XX, y, int_to_string( stats.score ), gamePalette, brightIdx );

		// Skill
		gr_string( imageData, dataFont, 125 + 33 + XX, y, DIFFICULTY_NAMES[ stats.diff_level ], gamePalette, brightIdx );

		// Levels (right-aligned)
		gr_string_right( imageData, dataFont, 192 + 33 + XX, y, stats.starting_level + '-' + stats.ending_level, gamePalette, brightIdx );

		// Time (right-aligned)
		gr_string_right( imageData, dataFont, 311 - 42 + XX, y, format_time( stats.seconds ), gamePalette, brightIdx );

	}

	// Bottom message
	gr_string( imageData, dataFont, 0x8000, 175, 'PRESS ANY KEY OR BUTTON TO RETURN', gamePalette, goldenIdx );

	titleCtx.putImageData( imageData, 0, 0 );

	// Wait for input
	// Ported from: SCORES.C lines 606-652
	await new Promise( ( resolve ) => {

		let resolved = false;

		const finish = () => {

			if ( resolved === true ) return;
			resolved = true;
			document.removeEventListener( 'keydown', onKey );
			titleInner.removeEventListener( 'click', onClickLocal );
			resolve();

		};

		const onKey = ( e ) => {

			e.preventDefault();
			finish();

		};

		const onClickLocal = () => {

			finish();

		};

		document.addEventListener( 'keydown', onKey );
		titleInner.addEventListener( 'click', onClickLocal );

	} );

}
