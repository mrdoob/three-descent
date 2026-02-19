// Ported from: descent-master/MAIN/TITLES.C
// Logo sequence, briefing screens with typewriter text

import * as THREE from 'three';
import { pcx_read, pcx_to_canvas } from './pcx.js';
import { songs_play_song, SONG_BRIEFING } from './songs.js';
import { GAME_FONT } from './gamefont.js';
import { gr_get_string_size, gr_string } from './font.js';
import { Robot_info, N_robot_types } from './bm.js';
import { Polygon_models, buildModelMesh, buildAnimatedModelMesh, polyobj_rebuild_glow_refs } from './polyobj.js';

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
const CHAR_WIDTH_FALLBACK = 6;

// Typewriter delay: 28ms per character (KEY_DELAY_DEFAULT in TITLES.C)
const KEY_DELAY_DEFAULT = 28;

// Briefing render space is fixed 320x200
const BRIEFING_RENDER_W = 320;
const BRIEFING_RENDER_H = 200;

// Robot/bitmap viewport for briefing special visuals (TITLES.C init_spinning_robot/init_briefing_bitmap)
const BRIEFING_VIS_X = 138;
const BRIEFING_VIS_Y = 55;
const BRIEFING_VIS_W = 166;
const BRIEFING_VIS_H = 138;

// Game palette proxy for briefing font colors (indexes used by gr_string).
const BRIEFING_PALETTE = new Uint8Array( 256 * 3 );
const BRIEFING_FG_INDEX = [ 250, 251 ];
const BRIEFING_BG_INDEX = [ 252, 253 ];
const BRIEFING_SKIP_DIM_FG_INDEX = 244;
const BRIEFING_SKIP_DIM_BG_INDEX = 245;
const BRIEFING_SKIP_BRIGHT_FG_INDEX = 246;
const BRIEFING_SKIP_BRIGHT_BG_INDEX = 247;

function set_palette_rgb63( palette, index, r63, g63, b63 ) {

	// Original palette values are 0..63; convert to 0..252 like the main palette tables.
	palette[ index * 3 + 0 ] = r63 * 4;
	palette[ index * 3 + 1 ] = g63 * 4;
	palette[ index * 3 + 2 ] = b63 * 4;

}

// Ported from TITLES.C briefing color init (lines 1013-1019)
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_FG_INDEX[ 0 ], 0, 54, 0 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_BG_INDEX[ 0 ], 0, 19, 0 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_FG_INDEX[ 1 ], 42, 38, 32 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_BG_INDEX[ 1 ], 14, 14, 14 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_SKIP_DIM_FG_INDEX, 40, 40, 40 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_SKIP_DIM_BG_INDEX, 8, 8, 8 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_SKIP_BRIGHT_FG_INDEX, 63, 63, 63 );
set_palette_rgb63( BRIEFING_PALETTE, BRIEFING_SKIP_BRIGHT_BG_INDEX, 16, 16, 16 );

// Cached briefing text (decrypted once)
let _briefingText = null;
let _endingText = null;

// Cached per-character advances from GAME_FONT (show_char_delay/gr_get_string_size parity)
let _briefingFont = null;
const _briefingCharAdvance = new Int16Array( 256 );
for ( let i = 0; i < _briefingCharAdvance.length; i ++ ) _briefingCharAdvance[ i ] = - 1;

function get_briefing_font() {

	if ( _briefingFont === null ) {

		_briefingFont = GAME_FONT();

	}

	return _briefingFont;

}

function get_briefing_char_width( ch ) {

	const code = ch.charCodeAt( 0 );

	if ( code >= 0 && code < _briefingCharAdvance.length ) {

		if ( _briefingCharAdvance[ code ] >= 0 ) {

			return _briefingCharAdvance[ code ];

		}

	}

	const font = get_briefing_font();
	let width = CHAR_WIDTH_FALLBACK;

	if ( font !== null ) {

		const size = gr_get_string_size( font, ch );
		width = size.width;

		if ( width <= 0 ) {

			width = font.ft_w;

		}

	}

	if ( code >= 0 && code < _briefingCharAdvance.length ) {

		_briefingCharAdvance[ code ] = width;

	}

	return width;

}

let _briefingPigFile = null;
let _briefingPalette = null;

function clear_image_data( imageData ) {

	imageData.data.fill( 0 );

}

function draw_briefing_char( textCtx, imageData, ch, x, y, colorIndex ) {

	const font = get_briefing_font();
	if ( font === null ) return;

	let color = colorIndex;
	if ( color < 0 || color >= BRIEFING_FG_INDEX.length ) color = 0;

	// Draw shadow then foreground, matching show_char_delay() in TITLES.C.
	gr_string( imageData, font, x, y, ch, BRIEFING_PALETTE, BRIEFING_BG_INDEX[ color ] );
	gr_string( imageData, font, x + 1, y, ch, BRIEFING_PALETTE, BRIEFING_FG_INDEX[ color ] );
	textCtx.putImageData( imageData, 0, 0 );

}

function create_briefing_label_canvas( text, fgIndex, bgIndex ) {

	const font = get_briefing_font();
	if ( font === null ) return null;

	const size = gr_get_string_size( font, text );
	const width = Math.max( size.width + 1, 1 );
	const height = Math.max( font.ft_h + 1, 1 );

	const canvas = document.createElement( 'canvas' );
	canvas.width = width;
	canvas.height = height;
	canvas.style.imageRendering = 'pixelated';
	canvas.style.pointerEvents = 'none';

	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
	if ( ctx === null ) return null;

	const imageData = ctx.createImageData( width, height );
	clear_image_data( imageData );
	gr_string( imageData, font, 0, 0, text, BRIEFING_PALETTE, bgIndex );
	gr_string( imageData, font, 1, 0, text, BRIEFING_PALETTE, fgIndex );
	ctx.putImageData( imageData, 0, 0 );

	return canvas;

}

function create_briefing_visual_state( parentElement ) {

	const container = document.createElement( 'div' );
	container.style.position = 'absolute';
	container.style.left = ( BRIEFING_VIS_X / BRIEFING_RENDER_W * 100 ).toFixed( 2 ) + '%';
	container.style.top = ( BRIEFING_VIS_Y / BRIEFING_RENDER_H * 100 ).toFixed( 2 ) + '%';
	container.style.width = ( BRIEFING_VIS_W / BRIEFING_RENDER_W * 100 ).toFixed( 2 ) + '%';
	container.style.height = ( BRIEFING_VIS_H / BRIEFING_RENDER_H * 100 ).toFixed( 2 ) + '%';
	container.style.pointerEvents = 'none';
	parentElement.appendChild( container );

	const glCanvas = document.createElement( 'canvas' );
	glCanvas.width = BRIEFING_VIS_W;
	glCanvas.height = BRIEFING_VIS_H;
	glCanvas.style.width = '100%';
	glCanvas.style.height = '100%';
	glCanvas.style.imageRendering = 'pixelated';
	glCanvas.style.display = 'none';
	container.appendChild( glCanvas );

	const renderer = new THREE.WebGLRenderer( {
		canvas: glCanvas,
		alpha: true,
		antialias: false,
		powerPreference: 'low-power'
	} );
	renderer.setSize( BRIEFING_VIS_W, BRIEFING_VIS_H, false );
	renderer.setPixelRatio( 1 );
	renderer.setClearColor( 0x000000, 0 );

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera( 38, BRIEFING_VIS_W / BRIEFING_VIS_H, 0.1, 1000 );
	camera.position.set( 0, 0, 35 );
	camera.lookAt( 0, 0, 0 );

	const ambient = new THREE.AmbientLight( 0xffffff, 0.9 );
	scene.add( ambient );

	const key = new THREE.DirectionalLight( 0xffffff, 0.5 );
	key.position.set( 0.6, 1.0, 0.7 );
	scene.add( key );

	return {
		container: container,
		renderer: renderer,
		scene: scene,
		camera: camera,
		robotMesh: null,
		robotYaw: 0,
		active: true,
		rafId: 0,
		lastTimeMs: 0,
		box: new THREE.Box3(),
		center: new THREE.Vector3(),
		size: new THREE.Vector3()
	};

}

function destroy_briefing_visual_state( state ) {

	if ( state === null ) return;

	state.active = false;
	if ( state.rafId !== 0 ) cancelAnimationFrame( state.rafId );

	if ( state.robotMesh !== null ) {

		state.scene.remove( state.robotMesh );
		state.robotMesh = null;

	}

	state.renderer.dispose();

	if ( state.container.parentElement !== null ) {

		state.container.parentElement.removeChild( state.container );

	}

}

function build_briefing_robot_mesh( robotNum ) {

	let modelNum = - 1;

	if ( robotNum >= 0 && robotNum < N_robot_types ) {

		const ri = Robot_info[ robotNum ];
		if ( ri !== undefined && ri.model_num >= 0 ) {

			modelNum = ri.model_num;

		}

	}

	// Fallback: allow direct model index command values.
	if ( modelNum < 0 && robotNum >= 0 && robotNum < Polygon_models.length ) {

		if ( Polygon_models[ robotNum ] !== null && Polygon_models[ robotNum ] !== undefined ) {

			modelNum = robotNum;

		}

	}

	if ( modelNum < 0 || modelNum >= Polygon_models.length ) return null;
	if ( _briefingPigFile === null || _briefingPalette === null ) return null;

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return null;

	let mesh = null;

	if ( model.anim_angs !== null ) {

		if ( model.animatedMesh === null ) {

			model.animatedMesh = buildAnimatedModelMesh( model, _briefingPigFile, _briefingPalette );

		}

		if ( model.animatedMesh !== null ) {

			mesh = model.animatedMesh.clone( true );

		}

	}

	if ( mesh === null ) {

		if ( model.mesh === null ) {

			model.mesh = buildModelMesh( model, _briefingPigFile, _briefingPalette );

		}

		if ( model.mesh === null ) return null;

		mesh = model.mesh.clone();

	}

	polyobj_rebuild_glow_refs( mesh );
	return mesh;

}

function set_briefing_robot( state, robotNum ) {

	if ( state === null ) return;

	if ( state.robotMesh !== null ) {

		state.scene.remove( state.robotMesh );
		state.robotMesh = null;

	}

	if ( robotNum < 0 ) {

		state.renderer.domElement.style.display = 'none';
		state.renderer.clear();
		return;

	}

	const mesh = build_briefing_robot_mesh( robotNum );
	if ( mesh === null ) {

		state.renderer.domElement.style.display = 'none';
		state.renderer.clear();
		return;

	}

	state.renderer.domElement.style.display = 'block';
	state.robotYaw = 0;

	// Center model and fit camera to bounds.
	state.box.setFromObject( mesh );
	state.box.getCenter( state.center );
	mesh.position.sub( state.center );

	state.box.setFromObject( mesh );
	state.box.getSize( state.size );
	const radius = Math.max( state.size.length() * 0.5, 1.0 );
	const dist = radius * 2.4;

	state.camera.position.set( 0, 0, dist );
	state.camera.near = Math.max( dist * 0.05, 0.1 );
	state.camera.far = dist * 12;
	state.camera.updateProjectionMatrix();
	state.camera.lookAt( 0, 0, 0 );

	state.robotMesh = mesh;
	state.scene.add( mesh );
	state.renderer.render( state.scene, state.camera );

}

function start_briefing_visual_loop( state ) {

	if ( state === null ) return;

	state.lastTimeMs = performance.now();

	function tick( nowMs ) {

		if ( state.active !== true ) return;

		const dt = Math.max( 0, ( nowMs - state.lastTimeMs ) / 1000.0 );
		state.lastTimeMs = nowMs;

		if ( state.robotMesh !== null ) {

			state.robotYaw += dt * 1.5;
			state.robotMesh.rotation.y = state.robotYaw;
			state.renderer.render( state.scene, state.camera );

		}

		state.rafId = requestAnimationFrame( tick );

	}

	state.rafId = requestAnimationFrame( tick );

}

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

let _skipBriefing = false;
let _skipBriefingBtn = null;

function addSkipBriefingButton() {

	_skipBriefing = false;

	if ( _skipBriefingBtn !== null ) return;

	const btn = document.createElement( 'button' );
	btn.style.cssText = 'position:absolute;bottom:20px;right:20px;z-index:202;' +
		'background:transparent;border:none;outline:none;padding:8px 16px;cursor:pointer;';

	const dimLabel = create_briefing_label_canvas( 'Skip', BRIEFING_SKIP_DIM_FG_INDEX, BRIEFING_SKIP_DIM_BG_INDEX );
	const brightLabel = create_briefing_label_canvas( 'Skip', BRIEFING_SKIP_BRIGHT_FG_INDEX, BRIEFING_SKIP_BRIGHT_BG_INDEX );

	if ( dimLabel !== null && brightLabel !== null ) {

		const scale = 2;
		const width = dimLabel.width * scale;
		const height = dimLabel.height * scale;

		btn.style.width = width + 'px';
		btn.style.height = height + 'px';
		btn.style.padding = '0';

		dimLabel.style.width = width + 'px';
		dimLabel.style.height = height + 'px';
		brightLabel.style.width = width + 'px';
		brightLabel.style.height = height + 'px';
		brightLabel.style.display = 'none';

		btn.appendChild( dimLabel );
		btn.appendChild( brightLabel );

		btn.addEventListener( 'mouseenter', () => {

			dimLabel.style.display = 'none';
			brightLabel.style.display = 'block';

		} );
		btn.addEventListener( 'mouseleave', () => {

			dimLabel.style.display = 'block';
			brightLabel.style.display = 'none';

		} );

	} else {

		btn.textContent = 'Skip';
		btn.style.color = 'rgba(255,255,255,0.6)';
		btn.style.fontFamily = '"Courier New", monospace';
		btn.style.fontSize = '14px';

		btn.addEventListener( 'mouseenter', () => {

			btn.style.color = 'rgba(255,255,255,0.95)';

		} );
		btn.addEventListener( 'mouseleave', () => {

			btn.style.color = 'rgba(255,255,255,0.6)';

		} );

	}
	btn.addEventListener( 'click', ( e ) => {

		e.stopPropagation();
		_skipBriefing = true;

	} );

	_skipBriefingBtn = btn;
	_titleWrapper.appendChild( btn );

}

function removeSkipBriefingButton() {

	if ( _skipBriefingBtn !== null && _skipBriefingBtn.parentElement !== null ) {

		_skipBriefingBtn.parentElement.removeChild( _skipBriefingBtn );

	}

	_skipBriefingBtn = null;
	_skipBriefing = false;

}

// Show briefing screens for a given level
// level_num: 1-based level number, or 0 for intro
// For shareware ending: pass SHAREWARE_ENDING_LEVEL_NUM
export async function do_briefing_screens( hogFile, levelNum, pigFile, palette ) {

	if ( pigFile !== undefined ) _briefingPigFile = pigFile;
	if ( palette !== undefined ) _briefingPalette = palette;

	const text = load_briefing_text( hogFile );
	if ( text.length === 0 ) return;

	songs_play_song( SONG_BRIEFING, true );

	ensureTitleCanvas();
	_titleInner.style.transition = 'opacity 0.3s ease';

	// Small delay to let any pending click events from the menu flush
	await sleep( 150 );

	addSkipBriefingButton();

	let abortAll = false;

	// Show intro screens (level_num == 0) when starting level 1
	if ( levelNum === 1 ) {

		for ( let i = 0; i < Briefing_screens.length; i ++ ) {

			if ( Briefing_screens[ i ].level_num !== 0 ) break;
			if ( _skipBriefing === true ) { abortAll = true; break; }

			const aborted = await show_briefing_screen( hogFile, i, text );
			if ( aborted === true || _skipBriefing === true ) {

				abortAll = true;
				break;

			}

		}

	}

	// Show screens for this specific level (skip if intro was aborted)
	if ( abortAll !== true && _skipBriefing !== true ) {

		for ( let i = 0; i < Briefing_screens.length; i ++ ) {

			if ( _skipBriefing === true ) break;

			if ( Briefing_screens[ i ].level_num === levelNum ) {

				const aborted = await show_briefing_screen( hogFile, i, text );
				if ( aborted === true || _skipBriefing === true ) break;

			}

		}

	}

	removeSkipBriefingButton();

	// Clean up text overlay
	if ( _titleOverlay !== null && _titleOverlay.parentElement !== null ) {

		_titleOverlay.parentElement.removeChild( _titleOverlay );
		_titleOverlay = null;

	}

}

// Show shareware ending screens
export async function do_shareware_end_game( hogFile, pigFile, palette ) {

	if ( pigFile !== undefined ) _briefingPigFile = pigFile;
	if ( palette !== undefined ) _briefingPalette = palette;

	// Load ending text
	const text = load_ending_text( hogFile );

	songs_play_song( SONG_BRIEFING, true );

	ensureTitleCanvas();
	_titleInner.style.transition = 'opacity 0.3s ease';

	addSkipBriefingButton();

	// Show screens with SHAREWARE_ENDING_LEVEL_NUM
	for ( let i = 0; i < Briefing_screens.length; i ++ ) {

		if ( _skipBriefing === true ) break;

		if ( Briefing_screens[ i ].level_num === SHAREWARE_ENDING_LEVEL_NUM ) {

			// For ending, use ending text instead of briefing text
			const aborted = await show_briefing_screen( hogFile, i, text );
			if ( aborted === true || _skipBriefing === true ) break;

		}

	}

	removeSkipBriefingButton();

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

	// Pixel-exact 320x200 text layer (matches GAME_FONT raster metrics).
	const textCanvas = document.createElement( 'canvas' );
	textCanvas.width = BRIEFING_RENDER_W;
	textCanvas.height = BRIEFING_RENDER_H;
	textCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;image-rendering:pixelated;pointer-events:none;';
	textContainer.appendChild( textCanvas );
	const textCtx = textCanvas.getContext( '2d', { willReadFrequently: true } );
	const textImageData = textCtx.createImageData( BRIEFING_RENDER_W, BRIEFING_RENDER_H );
	clear_image_data( textImageData );
	textCtx.putImageData( textImageData, 0, 0 );

	const visualState = create_briefing_visual_state( textContainer );
	start_briefing_visual_loop( visualState );

	let currentColor = 0;
	let tabStop = 0;
	let textX = bsp.text_ulx;
	let textY = bsp.text_uly;
	const textXMax = bsp.text_ulx + bsp.text_width;
	const textYMax = bsp.text_uly + bsp.text_height;
	let prevCh = 10; // start as if previous was newline
	let pos = 0;
	let aborted = false;
	let delayMs = KEY_DELAY_DEFAULT;
	let skipAnimation = false;
	let endedWithStop = false; // Track if $S command already handled the final wait
	const spaceWidth = get_briefing_char_width( ' ' );
	let newPage = false;
	let robotNum = - 1;

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

			// Check for user input or skip button
			if ( keyPressed === 'escape' || _skipBriefing === true ) {

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

					const parsedTabStop = parseInt( numStr.trim(), 10 );
					if ( Number.isNaN( parsedTabStop ) ) {

						tabStop = 0;

					} else {

						tabStop = parsedTabStop;

					}

					prevCh = 10;

				} else if ( cmd === 'R' ) {

					// Spinning robot model (TITLES.C init_spinning_robot + show_spinning_robot_frame)
					let numStr = '';
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						numStr += message.charAt( pos );
						pos ++;

					}

					if ( pos < message.length ) pos ++;

					const parsedRobotNum = parseInt( numStr.trim(), 10 );
					if ( Number.isNaN( parsedRobotNum ) ) {

						robotNum = - 1;

					} else {

						robotNum = parsedRobotNum;

					}

					set_briefing_robot( visualState, robotNum );
					prevCh = 10;

				} else if ( cmd === 'N' || cmd === 'O' || cmd === 'B' ) {

					// Animated/static bitmap commands; clear robot viewport for parity with Robot_canv reset.
					robotNum = - 1;
					set_briefing_robot( visualState, - 1 );

					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						pos ++;

					}

					if ( pos < message.length ) pos ++;
					prevCh = 10;

				} else if ( cmd === 'S' ) {

					// End of message — wait for key (skip if briefing skipped)
					endedWithStop = true;

					if ( _skipBriefing === true ) {

						aborted = true;
						break;

					}

					skipAnimation = false;
					keyPressed = null;

					const waitResult = await wait_for_key_or_click( overlay );
					if ( waitResult === 'escape' || _skipBriefing === true ) aborted = true;
					break;

				} else if ( cmd === 'P' ) {

					// New page marker, handled by the common page-break path below.
					while ( pos < message.length && message.charAt( pos ) !== '\n' ) {

						pos ++;

					}

					if ( pos < message.length ) pos ++;
					newPage = true;
					prevCh = 10;

				}

			} else if ( ch === '\t' ) {

				// Ported from: TITLES.C line 845-846
				if ( tabStop > 0 && textX - bsp.text_ulx < tabStop ) {

					const targetX = bsp.text_ulx + tabStop;

					while ( textX < targetX ) {

						textX += spaceWidth;

					}

				}

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

					textX = bsp.text_ulx;
					textY += CHAR_HEIGHT;
					prevCh = 10;

				} else {

					prevCh = ch.charCodeAt( 0 );

				}

			} else {

				// Regular character — typewriter delay
				prevCh = ch.charCodeAt( 0 );
				draw_briefing_char( textCtx, textImageData, ch, textX, textY, currentColor );
				textX += get_briefing_char_width( ch );

				if ( skipAnimation !== true && delayMs > 0 ) {

					await sleep( delayMs );

					// Check for skip during delay
					if ( keyPressed === 'advance' ) {

						skipAnimation = true;
						keyPressed = null;

					}

					if ( keyPressed === 'escape' || _skipBriefing === true ) {

						aborted = true;
						break;

					}

				}

			}

			if ( textX > textXMax ) {

				textX = bsp.text_ulx;
				textY += CHAR_HEIGHT;

			}

			if ( newPage === true || textY > textYMax ) {

				newPage = false;
				skipAnimation = false;
				keyPressed = null;

				const pageResult = await wait_for_key_or_click( overlay );

				if ( pageResult === 'escape' || _skipBriefing === true ) {

					aborted = true;
					break;

				}

				robotNum = - 1;
				set_briefing_robot( visualState, - 1 );
				clear_image_data( textImageData );
				textCtx.putImageData( textImageData, 0, 0 );
				textX = bsp.text_ulx;
				textY = bsp.text_uly;
				delayMs = KEY_DELAY_DEFAULT;

			}

		}

		// If not aborted and message ended without $S, wait for key
		if ( aborted !== true && endedWithStop !== true && keyPressed !== 'escape' && _skipBriefing !== true ) {

			skipAnimation = false;
			keyPressed = null;
			const endResult = await wait_for_key_or_click( overlay );

			if ( endResult === 'escape' || _skipBriefing === true ) {

				aborted = true;

			}

		}

	} finally {

		destroy_briefing_visual_state( visualState );
		document.removeEventListener( 'keydown', onKeyDown );
		overlay.removeEventListener( 'click', onClick );
		overlay.innerHTML = '';

	}

	return aborted;

}

// Wait for keypress or click
// Returns 'escape' if ESC pressed or skip button clicked, 'advance' otherwise
async function wait_for_key_or_click( element ) {

	const result = await new Promise( ( resolve ) => {

		let resolved = false;
		let pollTimer = null;

		const cleanup = ( value ) => {

			if ( resolved === true ) return;
			resolved = true;
			if ( pollTimer !== null ) clearInterval( pollTimer );
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

		// Poll for skip button (since its click uses stopPropagation)
		pollTimer = setInterval( () => {

			if ( _skipBriefing === true ) cleanup( 'escape' );

		}, 50 );

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
