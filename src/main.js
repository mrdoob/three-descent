// Ported from: descent-master/MAIN/INFERNO.C
// Main entry point — loads game data files, initializes subsystems, starts game

import { HogFile } from './hogfile.js';
import { PigFile, loadPalette } from './piggy.js';
import { bm_read_all, bm_build_shareware_texture_table, Sounds } from './bm.js';
import { loadSharewareModels } from './polyobj.js';
import { digi_init, digi_set_sounds_table, digi_resume,
	digi_get_audio_context, digi_get_master_gain } from './digi.js';
import { songs_init, songs_set_audio_context, songs_play_song, songs_play_level_song, songs_resume, SONG_TITLE } from './songs.js';
import { show_title_sequence, do_briefing_screens, hide_title_canvas } from './titles.js';
import { do_main_menu } from './menu.js';
import { gamefont_init } from './gamefont.js';
import { gameseq_set_externals, gameseq_get_difficulty, gameseq_set_difficulty,
	gameseq_get_secondary_ammo, gameseq_set_sound_initialized,
	loadLevel } from './gameseq.js';

const status = document.getElementById( 'status' );

let hogFile = null;
let pigFile = null;
let palette = null;

function setStatus( msg ) {

	status.textContent = msg;
	console.log( msg );

}

// ---- Load game data files via fetch ----

async function loadGameData() {

	setStatus( 'Loading DESCENT.HOG...' );

	const hogResponse = await fetch( 'descent.hog' );
	if ( hogResponse.ok !== true ) {

		setStatus( 'Error: Could not fetch descent.hog' );
		return;

	}

	const hogBuffer = await hogResponse.arrayBuffer();
	hogFile = new HogFile();
	if ( hogFile.init( hogBuffer ) !== true ) {

		setStatus( 'Error: Invalid HOG file' );
		return;

	}

	setStatus( 'Loading DESCENT.PIG...' );

	const pigResponse = await fetch( 'descent.pig' );
	if ( pigResponse.ok !== true ) {

		setStatus( 'Error: Could not fetch descent.pig' );
		return;

	}

	const pigBuffer = await pigResponse.arrayBuffer();
	pigFile = new PigFile();
	if ( pigFile.init( pigBuffer ) !== true ) {

		setStatus( 'Error: Invalid PIG file' );
		return;

	}

	startGame();

}

async function startGame() {

	setStatus( 'Reading game data...' );

	// Load palette from HOG
	palette = loadPalette( hogFile );
	if ( palette === null ) {

		setStatus( 'Error: Could not load palette' );
		return;

	}

	// Read texture mapping data
	setStatus( 'Reading texture data...' );

	if ( pigFile.isShareware === true ) {

		// Shareware: no HAM data in PIG, build texture table from bitmaps.bin in HOG
		bm_build_shareware_texture_table( hogFile, pigFile );

	} else {

		// Registered: HAM data embedded in PIG file
		if ( pigFile.hamData !== null ) {

			bm_read_all( pigFile.hamData );

		} else {

			console.warn( 'No HAM data found in PIG file' );

		}

	}

	// Page in all bitmaps
	setStatus( 'Loading textures...' );
	pigFile.pageInAll();

	// Load polygon models from HOG (shareware .pof files)
	if ( pigFile.isShareware === true ) {

		setStatus( 'Loading models...' );
		loadSharewareModels( hogFile );

	}

	// Initialize sound and music (needed before title sequence for music)
	digi_init( pigFile );
	digi_set_sounds_table( Sounds );
	songs_init( hogFile );

	// Share AudioContext from digi.js with songs.js (avoids multiple contexts)
	const sharedAudioCtx = digi_get_audio_context();
	if ( sharedAudioCtx !== null ) {

		songs_set_audio_context( sharedAudioCtx, digi_get_master_gain() );

	}

	// Resume audio on first user interaction (browser policy)
	document.addEventListener( 'click', function () {

		digi_resume();
		songs_resume();

	}, { once: true } );

	// Load bitmap fonts from HOG
	gamefont_init( hogFile, palette );

	setStatus( '' );

	// Wire up gameseq with loaded data
	gameseq_set_externals( {
		hogFile: hogFile,
		pigFile: pigFile,
		palette: palette,
		setStatus: setStatus
	} );
	gameseq_set_sound_initialized( true );

	// --- Title sequence: logos → menu → briefing → gameplay ---

	// Show logo sequence (Interplay → Parallax → Descent title)
	await show_title_sequence( hogFile );

	// Play title music
	digi_resume();
	songs_resume();
	songs_play_song( SONG_TITLE, true );

	// Show main menu (NEW GAME → difficulty selection)
	const menuResult = await do_main_menu( hogFile, gameseq_get_difficulty(), palette );
	gameseq_set_difficulty( menuResult.difficulty );

	// Starting concussion missiles depend on difficulty
	gameseq_get_secondary_ammo()[ 0 ] = 2 + 4 - gameseq_get_difficulty();

	// Show intro briefing screens (level 0 + level 1)
	await do_briefing_screens( hogFile, 1, pigFile, palette );

	// Hide title canvas and start gameplay
	hide_title_canvas();

	// Load the first level
	setStatus( 'Loading level 1...' );
	songs_play_level_song( 1 );

	if ( pigFile.isShareware === true ) {

		loadLevel( 'level01.sdl' );

	} else {

		loadLevel( 'level01.rdl' );

	}

}

// Quick-start for testing: skip title/menu/briefing, jump into gameplay
// Usage from console or MCP: window.quickStart() or window.quickStart(3) for level 3
window.quickStart = async function ( levelNum, difficulty ) {

	if ( hogFile === null || pigFile === null ) {

		console.warn( 'quickStart: game data not loaded yet' );
		return;

	}

	if ( levelNum === undefined ) levelNum = 1;
	if ( difficulty === undefined ) difficulty = 1; // Rookie

	gameseq_set_difficulty( difficulty );
	gameseq_get_secondary_ammo()[ 0 ] = 2 + 4 - difficulty;

	hide_title_canvas();
	digi_resume();
	songs_resume();
	songs_play_level_song( levelNum );

	const fileName = pigFile.isShareware === true
		? 'level0' + levelNum + '.sdl'
		: 'level0' + levelNum + '.rdl';

	loadLevel( fileName );

};

// Start loading immediately
loadGameData();
