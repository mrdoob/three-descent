// Ported from: descent-master/MAIN/GAMEFONT.C
// Loads and provides access to the 5 game fonts

import { gr_init_font } from './font.js';

// Font indices (from GAMEFONT.H)
const GFONT_BIG_1 = 0;
const GFONT_MEDIUM_1 = 1;
const GFONT_MEDIUM_2 = 2;
const GFONT_MEDIUM_3 = 3;
const GFONT_SMALL = 4;

const MAX_FONTS = 5;

// Font filenames (from GAMEFONT.C lines 64-69)
const Gamefont_filenames = [
	'font1-1.fnt',		// Font 0: Big (titles)
	'font2-1.fnt',		// Font 1: Medium 1 (menus, help, scores)
	'font2-2.fnt',		// Font 2: Medium 2 (highlighted menu items)
	'font2-3.fnt',		// Font 3: Medium 3 (subtitles)
	'font3-1.fnt',		// Font 4: Small (HUD/game messages)
];

const Gamefonts = new Array( MAX_FONTS );
let Gamefont_installed = false;

// Load all 5 game fonts from HOG
// Ported from: gamefont_init() in GAMEFONT.C lines 75-86
export function gamefont_init( hogFile, gamePalette ) {

	if ( Gamefont_installed === true ) return;

	Gamefont_installed = true;

	for ( let i = 0; i < MAX_FONTS; i ++ ) {

		const cfile = hogFile.findFile( Gamefont_filenames[ i ] );

		if ( cfile === null ) {

			console.warn( 'GAMEFONT: Could not find ' + Gamefont_filenames[ i ] );
			Gamefonts[ i ] = null;
			continue;

		}

		Gamefonts[ i ] = gr_init_font( cfile, gamePalette );

		if ( Gamefonts[ i ] !== null ) {

			const f = Gamefonts[ i ];
			console.log( 'GAMEFONT: Loaded ' + Gamefont_filenames[ i ] +
				' (' + f.ft_w + 'x' + f.ft_h +
				', chars ' + f.ft_minchar + '-' + f.ft_maxchar +
				', flags=0x' + f.ft_flags.toString( 16 ) + ')' );

		}

	}

	console.log( 'GAMEFONT: Loaded ' + MAX_FONTS + ' fonts' );

}

// Font getters (from GAMEFONT.H lines 65-68)

export function GAME_FONT() {

	return Gamefonts[ GFONT_SMALL ];

}

export function TITLE_FONT() {

	return Gamefonts[ GFONT_BIG_1 ];

}

export function NORMAL_FONT() {

	return Gamefonts[ GFONT_MEDIUM_1 ];

}

export function CURRENT_FONT() {

	return Gamefonts[ GFONT_MEDIUM_2 ];

}

export function SUBTITLE_FONT() {

	return Gamefonts[ GFONT_MEDIUM_3 ];

}

export function MENU_FONT() {

	return Gamefonts[ GFONT_MEDIUM_1 ];

}
