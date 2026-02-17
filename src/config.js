// Game settings (persisted to localStorage)

const SETTINGS_KEY = 'descent_settings';

// Defaults
let _invertMouseY = false;
let _textureFiltering = 'nearest'; // 'nearest' or 'linear'

// Callbacks when texture filtering changes (so render.js/polyobj.js can update)
const _onTextureFilteringChangedCallbacks = [];

// Load settings from localStorage
function loadSettings() {

	try {

		const json = localStorage.getItem( SETTINGS_KEY );

		if ( json !== null ) {

			const data = JSON.parse( json );

			if ( data.invertMouseY === true || data.invertMouseY === false ) {

				_invertMouseY = data.invertMouseY;

			}

			if ( data.textureFiltering === 'nearest' || data.textureFiltering === 'linear' ) {

				_textureFiltering = data.textureFiltering;

			}

		}

	} catch ( e ) {

		// Ignore parse errors, use defaults

	}

}

function saveSettings() {

	try {

		localStorage.setItem( SETTINGS_KEY, JSON.stringify( {
			invertMouseY: _invertMouseY,
			textureFiltering: _textureFiltering,
		} ) );

	} catch ( e ) {

		// Ignore storage errors

	}

}

// Initialize on module load
loadSettings();

// --- Public API ---

export function config_get_invert_mouse_y() {

	return _invertMouseY;

}

export function config_set_invert_mouse_y( value ) {

	_invertMouseY = value;
	saveSettings();

}

export function config_get_texture_filtering() {

	return _textureFiltering;

}

export function config_set_texture_filtering( value ) {

	_textureFiltering = value;
	saveSettings();

	for ( let i = 0; i < _onTextureFilteringChangedCallbacks.length; i ++ ) {

		_onTextureFilteringChangedCallbacks[ i ]( value );

	}

}

export function config_on_texture_filtering_changed( cb ) {

	_onTextureFilteringChangedCallbacks.push( cb );

}
