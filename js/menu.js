// Ported from: descent-master/MAIN/MENU.C, MAIN/NEWMENU.C
// Canvas-based main menu with bitmap font rendering

import { pcx_read, pcx_to_canvas } from './pcx.js';
import { get_title_canvas } from './titles.js';
import { gr_get_string_size, gr_string } from './font.js';
import { NORMAL_FONT, CURRENT_FONT, SUBTITLE_FONT, TITLE_FONT, GAME_FONT } from './gamefont.js';
import { credits_show } from './credits.js';
import { scores_view } from './scores.js';

// Difficulty level names (from GAME.H NDL=5)
const DIFFICULTY_NAMES = [ 'TRAINEE', 'ROOKIE', 'HOTSHOT', 'ACE', 'INSANE' ];

// Shareware menu items (from MENU.C DoMenu)
const MENU_ITEMS = [
	{ label: 'NEW GAME', id: 'new_game' },
	{ label: 'LOAD GAME', id: 'load_game' },
	{ label: 'VIEW SCORES', id: 'scores' },
	{ label: 'ORDERING INFO', id: 'ordering' },
	{ label: 'CREDITS', id: 'credits' },
	{ label: 'QUIT', id: 'quit' },
];

// Cached background ImageData for the menu.pcx
let _bgImageData = null;

function sleep( ms ) {

	return new Promise( resolve => setTimeout( resolve, ms ) );

}

// Show the main menu and return { action, difficulty }
// Draws menu.pcx background and renders text with bitmap fonts
export async function do_main_menu( hogFile, defaultDifficulty, gamePalette ) {

	const { canvas: titleCanvas, ctx: titleCtx, inner: titleInner } = get_title_canvas();

	// Load menu background
	const pcxData = pcx_read( hogFile, 'menu.pcx' );

	if ( pcxData !== null ) {

		const pcxCanvas = pcx_to_canvas( pcxData );

		if ( pcxCanvas !== null ) {

			titleCanvas.width = pcxCanvas.width;
			titleCanvas.height = pcxCanvas.height;
			titleCtx.drawImage( pcxCanvas, 0, 0 );

		}

	}

	// Save background as ImageData snapshot
	_bgImageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );

	// Ensure canvas is visible
	titleCanvas.style.display = 'block';

	return new Promise( ( resolve ) => {

		let selectedIndex = 0;
		let state = 'main'; // 'main' or 'difficulty'
		let itemYPositions = []; // { y, h } for each menu item (in 320x200 space)
		let busy = false; // Prevent multiple sub-screen activations

		function renderMainMenu() {

			state = 'main';
			itemYPositions = [];

			// Restore background
			titleCtx.putImageData( _bgImageData, 0, 0 );
			const imageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );

			const normalFont = NORMAL_FONT();
			const currentFont = CURRENT_FONT();

			if ( normalFont === null || currentFont === null ) {

				// Fallback: fonts not loaded, just put background
				titleCtx.putImageData( imageData, 0, 0 );
				return;

			}

			// Measure all items to compute vertical centering
			const itemHeight = normalFont.ft_h + 2; // 1px spacing above and below
			const totalHeight = MENU_ITEMS.length * itemHeight;
			let startY = Math.floor( ( 200 - totalHeight ) / 2 );

			// Render each menu item
			for ( let i = 0; i < MENU_ITEMS.length; i ++ ) {

				const label = MENU_ITEMS[ i ].label;
				const isSelected = ( i === selectedIndex );
				const font = isSelected ? currentFont : normalFont;

				const y = startY + i * itemHeight;
				itemYPositions.push( { y: y, h: itemHeight } );

				// Render centered text (x = 0x8000)
				gr_string( imageData, font, 0x8000, y, label, gamePalette );

			}

			// Render controls info at bottom using small font
			const smallFont = GAME_FONT();
			const controlsY = startY + MENU_ITEMS.length * itemHeight + 10;

			if ( smallFont !== null ) {

				const line1 = 'WASD:MOVE  MOUSE:LOOK  Q/E:ROLL';
				const line2 = 'LEFT CLICK:FIRE  RIGHT CLICK:MISSILE  TAB:MAP';
				gr_string( imageData, smallFont, 0x8000, controlsY, line1, gamePalette );
				gr_string( imageData, smallFont, 0x8000, controlsY + smallFont.ft_h + 1, line2, gamePalette );

			}

			titleCtx.putImageData( imageData, 0, 0 );

		}

		function renderDifficultyMenu() {

			state = 'difficulty';
			itemYPositions = [];

			// Restore background
			titleCtx.putImageData( _bgImageData, 0, 0 );
			const imageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );

			const normalFont = NORMAL_FONT();
			const currentFont = CURRENT_FONT();
			const subtitleFont = SUBTITLE_FONT();

			if ( normalFont === null || currentFont === null ) {

				titleCtx.putImageData( imageData, 0, 0 );
				return;

			}

			// Title "SELECT DIFFICULTY"
			const titleFont = subtitleFont !== null ? subtitleFont : normalFont;
			const titleText = 'SELECT DIFFICULTY';

			const itemHeight = normalFont.ft_h + 2;
			const totalHeight = titleFont.ft_h + 6 + DIFFICULTY_NAMES.length * itemHeight;
			let startY = Math.floor( ( 200 - totalHeight ) / 2 );

			// Draw title
			gr_string( imageData, titleFont, 0x8000, startY, titleText, gamePalette );

			const itemsStartY = startY + titleFont.ft_h + 6;

			// Draw difficulty items
			for ( let i = 0; i < DIFFICULTY_NAMES.length; i ++ ) {

				const label = DIFFICULTY_NAMES[ i ];
				const isSelected = ( i === selectedIndex );
				const font = isSelected ? currentFont : normalFont;

				const y = itemsStartY + i * itemHeight;
				itemYPositions.push( { y: y, h: itemHeight } );

				gr_string( imageData, font, 0x8000, y, label, gamePalette );

			}

			titleCtx.putImageData( imageData, 0, 0 );

		}

		// Show ordering info: display order01.pcx and wait for input
		// Ported from: show_order_form() in INFERNO.C lines 1756-1787
		async function showOrderForm() {

			const orderPcx = pcx_read( hogFile, 'order01.pcx' );

			if ( orderPcx === null ) return;

			const orderCanvas = pcx_to_canvas( orderPcx );

			if ( orderCanvas === null ) return;

			titleCanvas.width = orderCanvas.width;
			titleCanvas.height = orderCanvas.height;
			titleCtx.drawImage( orderCanvas, 0, 0 );

			// Wait for any key or click
			await new Promise( ( waitResolve ) => {

				let resolved = false;

				const finish = () => {

					if ( resolved === true ) return;
					resolved = true;
					document.removeEventListener( 'keydown', onKeyLocal );
					titleInner.removeEventListener( 'click', onClickLocal );
					waitResolve();

				};

				const onKeyLocal = ( e ) => {

					e.preventDefault();
					finish();

				};

				const onClickLocal = () => {

					finish();

				};

				document.addEventListener( 'keydown', onKeyLocal );
				titleInner.addEventListener( 'click', onClickLocal );

			} );

		}

		// Show "no saved games" message briefly
		async function showLoadGameMessage() {

			// Restore background
			titleCtx.putImageData( _bgImageData, 0, 0 );
			const imageData = titleCtx.getImageData( 0, 0, titleCanvas.width, titleCanvas.height );

			const subtitleFont = SUBTITLE_FONT();
			const smallFont = GAME_FONT();

			if ( subtitleFont !== null ) {

				gr_string( imageData, subtitleFont, 0x8000, 80, 'LOAD GAME', gamePalette );

			}

			if ( smallFont !== null ) {

				gr_string( imageData, smallFont, 0x8000, 100, 'NO SAVED GAMES', gamePalette );

			}

			titleCtx.putImageData( imageData, 0, 0 );

			// Wait for key/click or 2 second timeout
			await new Promise( ( waitResolve ) => {

				let resolved = false;
				let timer = null;

				const finish = () => {

					if ( resolved === true ) return;
					resolved = true;
					if ( timer !== null ) clearTimeout( timer );
					document.removeEventListener( 'keydown', onKeyLocal );
					titleInner.removeEventListener( 'click', onClickLocal );
					waitResolve();

				};

				const onKeyLocal = ( e ) => {

					e.preventDefault();
					finish();

				};

				const onClickLocal = () => {

					finish();

				};

				document.addEventListener( 'keydown', onKeyLocal );
				titleInner.addEventListener( 'click', onClickLocal );
				timer = setTimeout( finish, 2000 );

			} );

		}

		async function handleMenuSelect( index ) {

			if ( busy === true ) return;

			const id = MENU_ITEMS[ index ].id;

			if ( id === 'new_game' ) {

				selectedIndex = defaultDifficulty || 1;
				renderDifficultyMenu();
				return;

			}

			if ( id === 'quit' ) {

				// No quit action in browser — just stay on menu
				return;

			}

			busy = true;

			// Remove menu event listeners while showing sub-screen
			document.removeEventListener( 'keydown', onKeyDown );
			titleInner.removeEventListener( 'click', onMouseClick );
			titleInner.removeEventListener( 'mousemove', onMouseMove );

			if ( id === 'credits' ) {

				await credits_show( hogFile, gamePalette );

			} else if ( id === 'scores' ) {

				await scores_view( hogFile, gamePalette );

			} else if ( id === 'ordering' ) {

				await showOrderForm();

			} else if ( id === 'load_game' ) {

				await showLoadGameMessage();

			}

			// Small delay to prevent the exit key/click from triggering a menu item
			await sleep( 150 );

			// Restore canvas to menu background dimensions
			titleCanvas.width = _bgImageData.width;
			titleCanvas.height = _bgImageData.height;

			// Re-add listeners
			document.addEventListener( 'keydown', onKeyDown );
			titleInner.addEventListener( 'click', onMouseClick );
			titleInner.addEventListener( 'mousemove', onMouseMove );

			// Re-render menu
			renderMainMenu();

			busy = false;

		}

		function handleDifficultySelect( difficulty ) {

			if ( busy === true ) return;
			busy = true;
			cleanup();
			resolve( { action: 'new_game', difficulty: difficulty } );

		}

		function cleanup() {

			document.removeEventListener( 'keydown', onKeyDown );
			titleInner.removeEventListener( 'click', onMouseClick );
			titleInner.removeEventListener( 'mousemove', onMouseMove );

		}

		// Convert viewport mouse coordinates to 320x200 canvas space
		function viewportTo320x200( clientX, clientY ) {

			const rect = titleInner.getBoundingClientRect();
			const x = ( clientX - rect.left ) / rect.width * 320;
			const y = ( clientY - rect.top ) / rect.height * 200;
			return { x: Math.floor( x ), y: Math.floor( y ) };

		}

		// Find which menu item is at the given 320x200 y coordinate
		function findItemAtY( y200 ) {

			for ( let i = 0; i < itemYPositions.length; i ++ ) {

				const item = itemYPositions[ i ];

				if ( y200 >= item.y && y200 < item.y + item.h ) {

					return i;

				}

			}

			return - 1;

		}

		const onMouseMove = ( e ) => {

			if ( busy === true ) return;

			const pos = viewportTo320x200( e.clientX, e.clientY );
			const idx = findItemAtY( pos.y );

			if ( idx !== - 1 && idx !== selectedIndex ) {

				selectedIndex = idx;

				if ( state === 'main' ) {

					renderMainMenu();

				} else {

					renderDifficultyMenu();

				}

			}

		};

		const onMouseClick = ( e ) => {

			if ( busy === true ) return;

			const pos = viewportTo320x200( e.clientX, e.clientY );
			const idx = findItemAtY( pos.y );

			if ( idx !== - 1 ) {

				selectedIndex = idx;

				if ( state === 'main' ) {

					handleMenuSelect( idx );

				} else if ( state === 'difficulty' ) {

					handleDifficultySelect( idx );

				}

			}

		};

		const onKeyDown = ( e ) => {

			if ( busy === true ) return;

			if ( e.key === 'ArrowUp' ) {

				e.preventDefault();
				selectedIndex --;

				const maxItems = ( state === 'main' ) ? MENU_ITEMS.length : DIFFICULTY_NAMES.length;

				if ( selectedIndex < 0 ) selectedIndex = maxItems - 1;

				if ( state === 'main' ) {

					renderMainMenu();

				} else {

					renderDifficultyMenu();

				}

			} else if ( e.key === 'ArrowDown' ) {

				e.preventDefault();
				selectedIndex ++;

				const maxItems = ( state === 'main' ) ? MENU_ITEMS.length : DIFFICULTY_NAMES.length;

				if ( selectedIndex >= maxItems ) selectedIndex = 0;

				if ( state === 'main' ) {

					renderMainMenu();

				} else {

					renderDifficultyMenu();

				}

			} else if ( e.key === 'Enter' ) {

				e.preventDefault();

				if ( state === 'main' ) {

					handleMenuSelect( selectedIndex );

				} else if ( state === 'difficulty' ) {

					handleDifficultySelect( selectedIndex );

				}

			} else if ( e.key === 'Escape' ) {

				e.preventDefault();

				if ( state === 'difficulty' ) {

					selectedIndex = 0;
					renderMainMenu();

				}

			}

		};

		document.addEventListener( 'keydown', onKeyDown );
		titleInner.addEventListener( 'click', onMouseClick );
		titleInner.addEventListener( 'mousemove', onMouseMove );

		// Start with main menu
		renderMainMenu();

	} );

}
