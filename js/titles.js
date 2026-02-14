// Ported from: descent-master/MAIN/TITLES.C
// Logo sequence, briefing screens with typewriter text

import { pcx_read, pcx_to_canvas } from './pcx.js';
import { songs_play_song, SONG_BRIEFING } from './songs.js';

// Briefing screen table — mirrors Briefing_screens[] in TITLES.C lines 309-370
// { bs_name, level_num, message_num, text_ulx, text_uly, text_width, text_height }
const SHAREWARE_ENDING_LEVEL_NUM = 0x7F;

const Briefing_screens = [
	{ bs_name: 'brief01.pcx', level_num: 0, message_num: 1, text_ulx: 13, text_uly: 140, text_width: 290, text_height: 59 },
	{ bs_name: 'brief02.pcx', level_num: 0, message_num: 2, text_ulx: 27, text_uly: 34, text_width: 257, text_height: 177 },
	{ bs_name: 'brief03.pcx', level_num: 0, message_num: 3, text_ulx: 20, text_uly: 22, text_width: 257, text_height: 177 },
	{ bs_name: 'brief02.pcx', level_num: 0, message_num: 4, text_ulx: 27, text_uly: 34, text_width: 257, text_height: 177 },

	{ bs_name: 'moon01.pcx', level_num: 1, message_num: 5, text_ulx: 10, text_uly: 10, text_width: 300, text_height: 170 },
	{ bs_name: 'moon01.pcx', level_num: 2, message_num: 6, text_ulx: 10, text_uly: 10, text_width: 300, text_height: 170 },
	{ bs_name: 'moon01.pcx', level_num: 3, message_num: 7, text_ulx: 10, text_uly: 10, text_width: 300, text_height: 170 },

	{ bs_name: 'venus01.pcx', level_num: 4, message_num: 8, text_ulx: 15, text_uly: 15, text_width: 300, text_height: 200 },
	{ bs_name: 'venus01.pcx', level_num: 5, message_num: 9, text_ulx: 15, text_uly: 15, text_width: 300, text_height: 200 },

	{ bs_name: 'brief03.pcx', level_num: 6, message_num: 10, text_ulx: 20, text_uly: 22, text_width: 257, text_height: 177 },
	{ bs_name: 'merc01.pcx', level_num: 6, message_num: 11, text_ulx: 10, text_uly: 15, text_width: 300, text_height: 200 },
	{ bs_name: 'merc01.pcx', level_num: 7, message_num: 12, text_ulx: 10, text_uly: 15, text_width: 300, text_height: 200 },

	{ bs_name: 'end01.pcx', level_num: SHAREWARE_ENDING_LEVEL_NUM, message_num: 1, text_ulx: 23, text_uly: 40, text_width: 320, text_height: 200 },
];

// Briefing text colors (ported from TITLES.C lines 1013-1018)
// Color 0: green foreground with dark green shadow
// Color 1: tan/brown foreground with gray shadow
const BRIEFING_COLORS = [
	{ fg: '#00e000', bg: '#004c00' },
	{ fg: '#d49a80', bg: '#383838' },
];

// Font size — original uses 8px tall GAME_FONT at 320x200
// Scale factor applied when rendering to screen-sized canvas
const CHAR_HEIGHT = 8;
const CHAR_WIDTH = 6; // approximate monospace width at 320x200

// Typewriter delay: 28ms per character (KEY_DELAY_DEFAULT in TITLES.C)
const KEY_DELAY_DEFAULT = 28;

// Cached briefing text (decrypted once)
let _briefingText = null;
let _endingText = null;

// ---- Text decryption ----
// Same cipher as bitmaps.bin: rotate-left + XOR 0xD3 + rotate-left
// But newlines (0x0A) are NOT encrypted
function decode_briefing_text( data ) {

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

// Load and decrypt briefing text from HOG
function load_briefing_text( hogFile ) {

	if ( _briefingText !== null ) return _briefingText;

	// Try .tex first, fall back to .txb
	let cfile = hogFile.findFile( 'briefing.tex' );
	let isBinary = false;

	if ( cfile === null ) {

		cfile = hogFile.findFile( 'briefing.txb' );
		isBinary = true;

	}

	if ( cfile === null ) {

		console.warn( 'TITLES: briefing.tex/txb not found in HOG' );
		return '';

	}

	const rawData = cfile.readBytes( cfile.length() );

	if ( isBinary === true ) {

		_briefingText = decode_briefing_text( rawData );

	} else {

		let text = '';
		for ( let i = 0; i < rawData.length; i ++ ) {

			text += String.fromCharCode( rawData[ i ] );

		}

		_briefingText = text;

	}

	return _briefingText;

}

// Load and decrypt ending text from HOG
function load_ending_text( hogFile ) {

	if ( _endingText !== null ) return _endingText;

	let cfile = hogFile.findFile( 'ending.tex' );
	let isBinary = false;

	if ( cfile === null ) {

		cfile = hogFile.findFile( 'ending.txb' );
		isBinary = true;

	}

	if ( cfile === null ) {

		console.warn( 'TITLES: ending.tex/txb not found in HOG' );
		return '';

	}

	const rawData = cfile.readBytes( cfile.length() );

	if ( isBinary === true ) {

		_endingText = decode_briefing_text( rawData );

	} else {

		let text = '';
		for ( let i = 0; i < rawData.length; i ++ ) {

			text += String.fromCharCode( rawData[ i ] );

		}

		_endingText = text;

	}

	return _endingText;

}

// Find message text for a given message_num in the briefing text
// Messages are delimited by $S <num> commands
function get_briefing_message( text, messageNum ) {

	let pos = 0;
	let curScreen = 0;

	while ( pos < text.length && curScreen !== messageNum ) {

		const ch = text.charAt( pos );
		pos ++;

		if ( ch === '$' ) {

			const cmd = text.charAt( pos );
			pos ++;

			if ( cmd === 'S' ) {

				// Read number
				curScreen = get_message_num( text, pos );
				// Skip past the number and to end of line
				while ( pos < text.length && text.charAt( pos ) !== '\n' ) {

					pos ++;

				}

				if ( pos < text.length ) pos ++; // skip newline

			}

		}

	}

	return pos < text.length ? text.substring( pos ) : '';

}

// Parse a number from text at given position
function get_message_num( text, pos ) {

	let num = 0;

	// Skip spaces
	while ( pos < text.length && text.charAt( pos ) === ' ' ) {

		pos ++;

	}

	while ( pos < text.length ) {

		const ch = text.charAt( pos );
		if ( ch >= '0' && ch <= '9' ) {

			num = num * 10 + ( ch.charCodeAt( 0 ) - 48 );
			pos ++;

		} else {

			break;

		}

	}

	return num;

}

// ---- Title Screen Display ----

// Shared full-screen canvas for all title/briefing screens
let _titleCanvas = null;
let _titleCtx = null;
let _titleWrapper = null; // outer container (fills viewport, black bg)
let _titleInner = null; // inner container (maintains 8:5 aspect ratio)
let _titleOverlay = null; // DOM overlay for text (child of _titleInner)

function ensureTitleCanvas() {

	if ( _titleCanvas !== null ) return;

	// Wrapper div that fills the viewport with black background
	_titleWrapper = document.createElement( 'div' );
	_titleWrapper.id = 'title-wrapper';
	_titleWrapper.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:200;background:#000;display:flex;align-items:center;justify-content:center;';
	document.body.appendChild( _titleWrapper );

	// Inner container that maintains 320:200 (8:5) aspect ratio
	_titleInner = document.createElement( 'div' );
	_titleInner.id = 'title-inner';
	_titleInner.style.cssText = 'position:relative;image-rendering:pixelated;';
	_titleWrapper.appendChild( _titleInner );

	_titleCanvas = document.createElement( 'canvas' );
	_titleCanvas.id = 'title-canvas';
	_titleCanvas.style.cssText = 'display:block;width:100%;height:100%;image-rendering:pixelated;';
	_titleCtx = _titleCanvas.getContext( '2d', { willReadFrequently: true } );
	_titleInner.appendChild( _titleCanvas );

	// Size the inner container to fill viewport while maintaining 8:5 aspect ratio
	_resizeTitleContainer();
	window.addEventListener( 'resize', _resizeTitleContainer );

}

function _resizeTitleContainer() {

	if ( _titleInner === null ) return;

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const aspect = 320 / 200; // 1.6

	let w, h;
	if ( vw / vh > aspect ) {

		// Viewport is wider than 8:5 — fit to height
		h = vh;
		w = Math.floor( vh * aspect );

	} else {

		// Viewport is taller than 8:5 — fit to width
		w = vw;
		h = Math.floor( vw / aspect );

	}

	_titleInner.style.width = w + 'px';
	_titleInner.style.height = h + 'px';
	// Set font-size on inner so children can use em units
	// Original 8px font at 200px height → scale proportionally
	_titleInner.style.fontSize = ( h * 8 / 200 ) + 'px';

}

function removeTitleCanvas() {

	window.removeEventListener( 'resize', _resizeTitleContainer );

	if ( _titleWrapper !== null && _titleWrapper.parentElement !== null ) {

		_titleWrapper.parentElement.removeChild( _titleWrapper );

	}

	_titleCanvas = null;
	_titleCtx = null;
	_titleWrapper = null;
	_titleInner = null;
	_titleOverlay = null;

}

function ensureTextOverlay() {

	if ( _titleOverlay !== null ) return _titleOverlay;

	_titleOverlay = document.createElement( 'div' );
	_titleOverlay.id = 'title-text-overlay';
	// Positioned absolutely within _titleInner, covering full 320x200 area
	_titleOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;pointer-events:none;overflow:hidden;';
	_titleInner.appendChild( _titleOverlay );

	return _titleOverlay;

}

// Draw a PCX image onto the title canvas, scaling 320x200 to viewport
function drawPcxToCanvas( pcxCanvas ) {

	if ( pcxCanvas === null || _titleCtx === null ) return;

	_titleCanvas.width = pcxCanvas.width;
	_titleCanvas.height = pcxCanvas.height;
	_titleCtx.drawImage( pcxCanvas, 0, 0 );

}

// ---- Logo Sequence ----
// Ported from INFERNO.C lines 1584-1586:
//   show_title_screen( "iplogo1.pcx", 1 );
//   show_title_screen( "logo.pcx", 1 );
// Then descent.pcx is shown as the title background

export async function show_title_sequence( hogFile ) {

	ensureTitleCanvas();

	// Fade CSS transition support
	_titleInner.style.transition = 'opacity 0.5s ease';
	_titleInner.style.opacity = '0';

	// Show Interplay logo
	await show_single_title_screen( hogFile, 'iplogo1.pcx', 3000 );

	// Show Parallax logo
	await show_single_title_screen( hogFile, 'logo.pcx', 3000 );

	// Show Descent title
	await show_single_title_screen( hogFile, 'descent.pcx', 3000 );

	// Restore opacity for subsequent screens (menu, briefings)
	_titleInner.style.transition = 'none';
	_titleInner.style.opacity = '1';

}

// Show a single title screen: fade in, hold, fade out
// Returns immediately if user presses key/clicks
async function show_single_title_screen( hogFile, filename, holdMs ) {

	const pcxData = pcx_read( hogFile, filename );
	if ( pcxData === null ) return;

	const canvas = pcx_to_canvas( pcxData );
	if ( canvas === null ) return;

	drawPcxToCanvas( canvas );

	// Fade in
	_titleInner.style.opacity = '0';

	// Force reflow so transition triggers
	void _titleInner.offsetWidth;
	_titleInner.style.opacity = '1';

	await wait_for_input_or_timeout( 500 + holdMs );

	// Fade out
	_titleInner.style.opacity = '0';
	await sleep( 500 );

}

// ---- Briefing Screens ----

// Show briefing screens for a given level
// level_num: 1-based level number, or 0 for intro
// For shareware ending: pass SHAREWARE_ENDING_LEVEL_NUM
export async function do_briefing_screens( hogFile, levelNum ) {

	const text = load_briefing_text( hogFile );
	if ( text.length === 0 ) return;

	songs_play_song( SONG_BRIEFING, true );

	ensureTitleCanvas();
	_titleInner.style.transition = 'opacity 0.3s ease';

	// Small delay to let any pending click events from the menu flush
	await sleep( 150 );

	let abortAll = false;

	// Show intro screens (level_num == 0) when starting level 1
	if ( levelNum === 1 ) {

		for ( let i = 0; i < Briefing_screens.length; i ++ ) {

			if ( Briefing_screens[ i ].level_num !== 0 ) break;

			const aborted = await show_briefing_screen( hogFile, i, text );
			if ( aborted === true ) {

				abortAll = true;
				break;

			}

		}

	}

	// Show screens for this specific level (skip if intro was aborted)
	if ( abortAll !== true ) {

		for ( let i = 0; i < Briefing_screens.length; i ++ ) {

			if ( Briefing_screens[ i ].level_num === levelNum ) {

				const aborted = await show_briefing_screen( hogFile, i, text );
				if ( aborted === true ) break;

			}

		}

	}

	// Clean up text overlay
	if ( _titleOverlay !== null && _titleOverlay.parentElement !== null ) {

		_titleOverlay.parentElement.removeChild( _titleOverlay );
		_titleOverlay = null;

	}

}

// Show shareware ending screens
export async function do_shareware_end_game( hogFile ) {

	// Load ending text
	const text = load_ending_text( hogFile );

	songs_play_song( SONG_BRIEFING, true );

	ensureTitleCanvas();
	_titleInner.style.transition = 'opacity 0.3s ease';

	// Show screens with SHAREWARE_ENDING_LEVEL_NUM
	for ( let i = 0; i < Briefing_screens.length; i ++ ) {

		if ( Briefing_screens[ i ].level_num === SHAREWARE_ENDING_LEVEL_NUM ) {

			// For ending, use ending text instead of briefing text
			const aborted = await show_briefing_screen( hogFile, i, text );
			if ( aborted === true ) break;

		}

	}

	if ( _titleOverlay !== null && _titleOverlay.parentElement !== null ) {

		_titleOverlay.parentElement.removeChild( _titleOverlay );
		_titleOverlay = null;

	}

}

// Show a single briefing screen: PCX background + typewriter text
// Returns true if user pressed ESC (abort)
async function show_briefing_screen( hogFile, screenIndex, briefingText ) {

	const bsp = Briefing_screens[ screenIndex ];

	// Load PCX background
	const pcxData = pcx_read( hogFile, bsp.bs_name );
	if ( pcxData === null ) return false;

	const canvas = pcx_to_canvas( pcxData );
	if ( canvas === null ) return false;

	// Show background with fade in
	_titleInner.style.opacity = '0';
	drawPcxToCanvas( canvas );
	void _titleInner.offsetWidth;
	_titleInner.style.opacity = '1';

	await sleep( 300 );

	// Get message text for this screen
	const messageText = get_briefing_message( briefingText, bsp.message_num );

	// Display text with typewriter effect
	const aborted = await display_briefing_text( bsp, messageText );

	// Fade out
	_titleInner.style.opacity = '0';
	await sleep( 300 );

	return aborted;

}

// Display briefing text with typewriter effect
// Processes $ commands, handles paging
// Returns true if ESC pressed
async function display_briefing_text( bsp, message ) {

	const overlay = ensureTextOverlay();
	overlay.innerHTML = '';
	overlay.style.pointerEvents = 'auto';

	// Text container fills the overlay (which is already sized to match the 320x200 area)
	const textContainer = document.createElement( 'div' );
	textContainer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
	overlay.appendChild( textContainer );

	let currentColor = 0;
	let tabStop = 0;
	let textX = bsp.text_ulx;
	let textY = bsp.text_uly;
	let prevCh = 10; // start as if previous was newline
	let pos = 0;
	let aborted = false;
	let delayMs = KEY_DELAY_DEFAULT;
	let skipAnimation = false;
	let endedWithStop = false; // Track if $S command already handled the final wait

	// Pre-create a text element for efficient rendering
	// We'll use a monospace pre element that we append characters to
	const textEl = document.createElement( 'pre' );
	textEl.style.cssText = 'position:absolute;margin:0;padding:0;font-family:"Courier New",monospace;' +
		'white-space:pre-wrap;word-break:break-all;line-height:1.15;pointer-events:none;' +
		'text-shadow:none;';

	// Position the text using % coordinates relative to the 320x200 space
	// The overlay and text container are children of _titleInner, which is aspect-correct
	const leftPct = ( bsp.text_ulx / 320 * 100 ).toFixed( 2 );
	const topPct = ( bsp.text_uly / 200 * 100 ).toFixed( 2 );
	const widthPct = ( bsp.text_width / 320 * 100 ).toFixed( 2 );
	// Original uses 8px tall font at 200px height = 4% of container height
	textEl.style.left = leftPct + '%';
	textEl.style.top = topPct + '%';
	textEl.style.width = widthPct + '%';
	textEl.style.fontSize = '1em';
	textEl.style.color = BRIEFING_COLORS[ 0 ].fg;
	textContainer.appendChild( textEl );

	// Build an array of styled spans for the text
	let currentSpan = createColorSpan( currentColor );
	textEl.appendChild( currentSpan );

	// Handle ESC or click to skip/advance
	let keyPressed = null;

	const onKeyDown = ( e ) => {

		if ( e.key === 'Escape' ) {

			keyPressed = 'escape';
			e.preventDefault();

		} else if ( e.key === ' ' || e.key === 'Enter' ) {

			keyPressed = 'advance';
			e.preventDefault();

		}

	};

	const onClick = () => {

		keyPressed = 'advance';

	};

	document.addEventListener( 'keydown', onKeyDown );
	overlay.addEventListener( 'click', onClick );

	try {

		while ( pos < message.length ) {

			// Check for user input
			if ( keyPressed === 'escape' ) {

				aborted = true;
				break;

			}

			if ( keyPressed === 'advance' ) {

				// Speed up: show rest of page instantly
				skipAnimation = true;
				keyPressed = null;

			}

			const ch = message.charAt( pos );
			pos ++;

			if ( ch === '$' ) {

				// Process command
				const cmd = message.charAt( pos );
				pos ++;

				if ( cmd === 'C' ) {

					// Change color
					let numStr = '';
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						numStr += message.charAt( pos );
						pos ++;

					}

					if ( pos < message.length ) pos ++; // skip newline

					currentColor = parseInt( numStr.trim(), 10 ) - 1;
					if ( currentColor < 0 ) currentColor = 0;
					if ( currentColor >= BRIEFING_COLORS.length ) currentColor = BRIEFING_COLORS.length - 1;
					currentSpan = createColorSpan( currentColor );
					textEl.appendChild( currentSpan );
					prevCh = 10;

				} else if ( cmd === 'F' ) {

					// Toggle flashing cursor — skip to end of line
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						pos ++;

					}

					if ( pos < message.length ) pos ++;
					prevCh = 10;

				} else if ( cmd === 'T' ) {

					// Tab stop
					let numStr = '';
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						numStr += message.charAt( pos );
						pos ++;

					}

					if ( pos < message.length ) pos ++;
					tabStop = parseInt( numStr.trim(), 10 ) || 0;
					prevCh = 10;

				} else if ( cmd === 'R' || cmd === 'N' || cmd === 'O' || cmd === 'B' ) {

					// Robot display / animated bitmap / static bitmap — skip to end of line
					// (We don't render these in the JS port)
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						pos ++;

					}

					if ( pos < message.length ) pos ++;
					prevCh = 10;

				} else if ( cmd === 'S' ) {

					// End of message — wait for key
					skipAnimation = false;
					keyPressed = null;
					endedWithStop = true;

					const waitResult = await wait_for_key_or_click( overlay );
					if ( waitResult === 'escape' ) aborted = true;
					break;

				} else if ( cmd === 'P' ) {

					// New page — wait for key, then clear text
					// Skip to end of line
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						pos ++;

					}

					if ( pos < message.length ) pos ++;

					skipAnimation = false;
					keyPressed = null;

					const pageResult = await wait_for_key_or_click( overlay );

					if ( pageResult === 'escape' ) {

						aborted = true;
						break;

					}

					keyPressed = null;

					// Reload background and clear text
					textEl.innerHTML = '';
					currentSpan = createColorSpan( currentColor );
					textEl.appendChild( currentSpan );
					textX = bsp.text_ulx;
					textY = bsp.text_uly;
					prevCh = 10;

				}

			} else if ( ch === '\t' ) {

				// Tab — insert spaces
				const spacesNeeded = tabStop > 0 ? Math.max( 1, Math.floor( tabStop / CHAR_WIDTH ) ) : 4;
				currentSpan.textContent += ' '.repeat( spacesNeeded );

			} else if ( ch === ';' && prevCh === 10 ) {

				// Comment line — skip to end of line
				while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

					pos ++;

				}

				if ( pos < message.length ) pos ++;
				prevCh = 10;

			} else if ( ch === '\\' ) {

				// Line continuation — swallow next newline
				prevCh = ch.charCodeAt( 0 );

			} else if ( ch === '\n' ) {

				if ( prevCh !== 92 ) { // 92 = backslash

					currentSpan.textContent += '\n';
					textX = bsp.text_ulx;
					textY += CHAR_HEIGHT;
					prevCh = 10;

				} else {

					prevCh = 10;

				}

			} else {

				// Regular character — typewriter delay
				prevCh = ch.charCodeAt( 0 );
				currentSpan.textContent += ch;
				textX += CHAR_WIDTH;

				if ( skipAnimation !== true && delayMs > 0 ) {

					await sleep( delayMs );

					// Check for skip during delay
					if ( keyPressed === 'advance' ) {

						skipAnimation = true;
						keyPressed = null;

					}

					if ( keyPressed === 'escape' ) {

						aborted = true;
						break;

					}

				}

			}

		}

		// If not aborted and message ended without $S, wait for key
		if ( aborted !== true && endedWithStop !== true && keyPressed !== 'escape' ) {

			skipAnimation = false;
			keyPressed = null;
			const endResult = await wait_for_key_or_click( overlay );

			if ( endResult === 'escape' ) {

				aborted = true;

			}

		}

	} finally {

		document.removeEventListener( 'keydown', onKeyDown );
		overlay.removeEventListener( 'click', onClick );
		overlay.innerHTML = '';

	}

	return aborted;

}

// Create a colored span element for briefing text
function createColorSpan( colorIndex ) {

	const span = document.createElement( 'span' );
	const color = BRIEFING_COLORS[ colorIndex ] || BRIEFING_COLORS[ 0 ];
	span.style.color = color.fg;
	span.style.textShadow = '1px 1px 0 ' + color.bg;
	return span;

}

// Wait for keypress or click
// Returns 'escape' if ESC pressed, 'advance' otherwise
async function wait_for_key_or_click( element ) {

	const result = await new Promise( ( resolve ) => {

		let resolved = false;

		const cleanup = ( value ) => {

			if ( resolved === true ) return;
			resolved = true;
			document.removeEventListener( 'keydown', onKey );
			element.removeEventListener( 'click', onClickLocal );
			resolve( value );

		};

		const onKey = ( e ) => {

			if ( e.key === 'Escape' ) {

				e.preventDefault();
				cleanup( 'escape' );

			} else if ( e.key === ' ' || e.key === 'Enter' ) {

				e.preventDefault();
				cleanup( 'advance' );

			}

		};

		const onClickLocal = () => {

			cleanup( 'advance' );

		};

		document.addEventListener( 'keydown', onKey );
		element.addEventListener( 'click', onClickLocal );

	} );

	// Small debounce to prevent the same keypress from being caught by next screen
	await sleep( 100 );

	return result;

}

// Wait for input or timeout (for title screens)
function wait_for_input_or_timeout( ms ) {

	return new Promise( ( resolve ) => {

		let resolved = false;
		let timer = null;

		const cleanup = () => {

			if ( resolved === true ) return;
			resolved = true;
			if ( timer !== null ) clearTimeout( timer );
			document.removeEventListener( 'keydown', onKey );
			document.removeEventListener( 'click', onClickLocal );
			resolve();

		};

		const onKey = ( e ) => {

			cleanup();

		};

		const onClickLocal = () => {

			cleanup();

		};

		document.addEventListener( 'keydown', onKey );
		document.addEventListener( 'click', onClickLocal );

		timer = setTimeout( cleanup, ms );

	} );

}

function sleep( ms ) {

	return new Promise( resolve => setTimeout( resolve, ms ) );

}

// Hide the title canvas (called when transitioning to gameplay)
export function hide_title_canvas() {

	if ( _titleWrapper !== null ) {

		_titleWrapper.style.display = 'none';

	}

}

// Show the title canvas (called when returning to menus)
export function show_title_canvas() {

	ensureTitleCanvas();
	_titleWrapper.style.display = 'flex';
	_titleInner.style.opacity = '1';

}

// Expose for menu.js to draw PCX backgrounds and position overlays
export function get_title_canvas() {

	ensureTitleCanvas();
	return { canvas: _titleCanvas, ctx: _titleCtx, inner: _titleInner };

}
