// Ported from: descent-master/MAIN/CREDITS.C
// Scrolling credits display over stars.pcx background

import { pcx_read, pcx_to_canvas } from './pcx.js';
import { get_title_canvas } from './titles.js';
import { gr_string, gr_get_string_size } from './font.js';
import { TITLE_FONT, SUBTITLE_FONT, CURRENT_FONT } from './gamefont.js';

const ROW_SPACING = 11;
const SCROLL_SPEED = 15.67; // pixels per second (F1_0 / time_delay where time_delay=4180)

// Fade values for vertical brightness (from CREDITS.C line 180)
// Bell curve: dim at top/bottom edges, full brightness in center
const fade_values = new Uint8Array( [
	1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 10, 10,
	11, 11, 12, 12, 12, 13, 13, 14, 14, 15, 15, 15, 16, 16, 17, 17, 17, 18, 18, 19, 19, 19, 20, 20,
	20, 21, 21, 22, 22, 22, 23, 23, 23, 24, 24, 24, 24, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27,
	28, 28, 28, 28, 28, 29, 29, 29, 29, 29, 29, 30, 30, 30, 30, 30, 30, 30, 30, 30, 31, 31, 31, 31,
	31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30,
	30, 30, 30, 30, 29, 29, 29, 29, 29, 29, 28, 28, 28, 28, 28, 27, 27, 27, 27, 26, 26, 26, 26, 25,
	25, 25, 24, 24, 24, 24, 23, 23, 23, 22, 22, 22, 21, 21, 20, 20, 20, 19, 19, 19, 18, 18, 17, 17,
	17, 16, 16, 15, 15, 15, 14, 14, 13, 13, 12, 12, 12, 11, 11, 10, 10, 9, 9, 8, 8, 8, 7, 7, 6, 6, 5,
	5, 4, 4, 3, 3, 2, 2, 1
] );

// Text decryption (same cipher as bitmaps.txb/briefing.txb)
// Ported from: encode_rotate_left + XOR in CREDITS.C lines 257-263
function decode_text( data ) {

	const decoded = new Uint8Array( data.length );

	for ( let i = 0; i < data.length; i ++ ) {

		let b = data[ i ];

		if ( b === 0x0A ) {

			// Newlines pass through unchanged
			decoded[ i ] = b;
			continue;

		}

		// Rotate left
		const bit7a = ( b & 0x80 ) !== 0 ? 1 : 0;
		b = ( ( b << 1 ) | bit7a ) & 0xFF;

		// XOR with 0xD3
		b = b ^ 0xD3;

		// Rotate left again
		const bit7b = ( b & 0x80 ) !== 0 ? 1 : 0;
		b = ( ( b << 1 ) | bit7b ) & 0xFF;

		decoded[ i ] = b;

	}

	let text = '';
	for ( let i = 0; i < decoded.length; i ++ ) {

		text += String.fromCharCode( decoded[ i ] );

	}

	return text;

}

// Parse credit lines: determine font type and spacing for each line
// Ported from: CREDITS.C lines 287-316
// '$' prefix = header font (font1-1.fnt / TITLE_FONT)
// '*' prefix = title font (font2-3.fnt / SUBTITLE_FONT)
// '!' prefix = half-height line (uses names_font but with ROW_SPACING/2)
// default = names font (font2-2.fnt / CURRENT_FONT)
function parse_credit_lines( text ) {

	const rawLines = text.split( '\n' );
	const lines = [];
	let yPos = 0;

	for ( let i = 0; i < rawLines.length; i ++ ) {

		let line = rawLines[ i ].replace( /\r/g, '' );
		let fontType = 'names';
		let halfHeight = false;

		if ( line.length > 0 && line.charAt( 0 ) === '$' ) {

			fontType = 'header';
			line = line.substring( 1 );

		} else if ( line.length > 0 && line.charAt( 0 ) === '*' ) {

			fontType = 'title';
			line = line.substring( 1 );

		} else if ( line.length > 0 && line.charAt( 0 ) === '!' ) {

			halfHeight = true;
			line = line.substring( 1 );

		}

		lines.push( {
			text: line,
			fontType: fontType,
			halfHeight: halfHeight,
			baseY: yPos
		} );

		yPos += halfHeight ? Math.floor( ROW_SPACING / 2 ) : ROW_SPACING;

	}

	return { lines: lines, totalHeight: yPos };

}

// Show scrolling credits screen
// Ported from: credits_show() in CREDITS.C lines 196-367
export async function credits_show( hogFile, gamePalette ) {

	// Load credits text
	let cfile = hogFile.findFile( 'credits.tex' );
	let isBinary = false;

	if ( cfile === null ) {

		cfile = hogFile.findFile( 'credits.txb' );
		isBinary = true;

	}

	if ( cfile === null ) {

		console.warn( 'CREDITS: credits.tex/txb not found' );
		return;

	}

	const rawData = cfile.readBytes( cfile.length() );
	let creditsText;

	if ( isBinary === true ) {

		creditsText = decode_text( rawData );

	} else {

		creditsText = '';
		for ( let i = 0; i < rawData.length; i ++ ) {

			creditsText += String.fromCharCode( rawData[ i ] );

		}

	}

	// Parse credit lines
	const parsed = parse_credit_lines( creditsText );
	const creditLines = parsed.lines;
	const totalContentHeight = parsed.totalHeight;

	console.log( 'CREDITS: Parsed ' + creditLines.length + ' lines, total height ' + totalContentHeight + 'px' );

	// Load stars.pcx background
	const { canvas: titleCanvas, ctx: titleCtx, inner: titleInner } = get_title_canvas();
	const pcxData = pcx_read( hogFile, 'stars.pcx' );

	if ( pcxData !== null ) {

		const pcxCanvas = pcx_to_canvas( pcxData );

		if ( pcxCanvas !== null ) {

			titleCanvas.width = pcxCanvas.width;
			titleCanvas.height = pcxCanvas.height;
			titleCtx.drawImage( pcxCanvas, 0, 0 );

		}

	}

	const bgImageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );
	titleCanvas.style.display = 'block';

	// Get fonts (matching CREDITS.C lines 226-228)
	// header_font = font1-1.fnt (TITLE_FONT)
	// title_font = font2-3.fnt (SUBTITLE_FONT)
	// names_font = font2-2.fnt (CURRENT_FONT)
	const headerFont = TITLE_FONT();
	const titleFont = SUBTITLE_FONT();
	const namesFont = CURRENT_FONT();

	if ( headerFont === null || titleFont === null || namesFont === null ) {

		console.warn( 'CREDITS: Fonts not loaded' );
		return;

	}

	// Pre-allocate working ImageData (Golden Rule #5: no allocations in render loop)
	const canvasW = titleCanvas.width;
	const canvasH = titleCanvas.height;
	const workImageData = titleCtx.createImageData( canvasW, canvasH );
	const workPixels = workImageData.data;
	const bgPixels = bgImageData.data;

	// Animation state
	let scrollOffset = 0;
	let done = false;
	let lastTime = performance.now();

	// Input handlers
	const onKeyDown = ( e ) => {

		done = true;
		e.preventDefault();

	};

	const onClick = () => {

		done = true;

	};

	document.addEventListener( 'keydown', onKeyDown );
	titleInner.addEventListener( 'click', onClick );

	// Main animation loop
	await new Promise( ( resolve ) => {

		function frame( now ) {

			if ( done === true ) {

				document.removeEventListener( 'keydown', onKeyDown );
				titleInner.removeEventListener( 'click', onClick );
				resolve();
				return;

			}

			const dt = ( now - lastTime ) / 1000;
			lastTime = now;

			// Clamp dt to prevent huge jumps (e.g. tab switching)
			const clampedDt = dt > 0.1 ? 0.1 : dt;
			scrollOffset += SCROLL_SPEED * clampedDt;

			// Check if all lines have scrolled off the top
			if ( scrollOffset > totalContentHeight + 200 ) {

				done = true;
				document.removeEventListener( 'keydown', onKeyDown );
				titleInner.removeEventListener( 'click', onClick );
				resolve();
				return;

			}

			// Copy background pixels
			workPixels.set( bgPixels );

			// Render visible credit lines
			for ( let i = 0; i < creditLines.length; i ++ ) {

				const line = creditLines[ i ];
				const y = Math.floor( line.baseY - scrollOffset + 200 );

				// Skip lines off-screen (with margin for tall fonts)
				if ( y < - 30 || y >= 200 ) continue;

				// Skip empty lines
				if ( line.text.length === 0 ) continue;

				// Select font
				let font;
				if ( line.fontType === 'header' ) {

					font = headerFont;

				} else if ( line.fontType === 'title' ) {

					font = titleFont;

				} else {

					font = namesFont;

				}

				// Handle tab-separated two-column layout
				// Ported from: CREDITS.C lines 300-308
				const tabIdx = line.text.indexOf( '\t' );

				if ( tabIdx !== - 1 ) {

					const leftText = line.text.substring( 0, tabIdx );
					const rightText = line.text.substring( tabIdx + 1 );

					// Left column centered in 0-160, right column centered in 160-320
					const leftSize = gr_get_string_size( font, leftText );
					const rightSize = gr_get_string_size( font, rightText );
					const leftX = Math.floor( ( 160 - leftSize.width ) / 2 );
					const rightX = 160 + Math.floor( ( 160 - rightSize.width ) / 2 );

					gr_string( workImageData, font, leftX, y, leftText, gamePalette );
					gr_string( workImageData, font, rightX, y, rightText, gamePalette );

				} else {

					// Centered text
					gr_string( workImageData, font, 0x8000, y, line.text, gamePalette );

				}

			}

			// Apply vertical fade (dim at edges, bright in center)
			// Ported from: gr_bitblt_fade_table usage in CREDITS.C line 298
			for ( let row = 0; row < canvasH && row < 200; row ++ ) {

				const fade = fade_values[ row ];

				for ( let col = 0; col < canvasW; col ++ ) {

					const idx = ( row * canvasW + col ) * 4;
					workPixels[ idx ] = ( workPixels[ idx ] * fade ) >> 5;
					workPixels[ idx + 1 ] = ( workPixels[ idx + 1 ] * fade ) >> 5;
					workPixels[ idx + 2 ] = ( workPixels[ idx + 2 ] * fade ) >> 5;

				}

			}

			titleCtx.putImageData( workImageData, 0, 0 );
			requestAnimationFrame( frame );

		}

		requestAnimationFrame( frame );

	} );

}
