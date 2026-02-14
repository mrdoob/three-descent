// Ported from: descent-master/MAIN/HUD.C
// HUD message display system

// --- HUD messages ---

const MAX_HUD_MESSAGES = 4;
const HUD_MESSAGE_TIME = 3.0;
const _messages = [];

const COCKPIT_W = 320;

export function hud_show_message( msg ) {

	if ( _messages.length > 0 && _messages[ 0 ].text === msg ) {

		_messages[ 0 ].timer = HUD_MESSAGE_TIME;
		return;

	}

	_messages.unshift( { text: msg, timer: HUD_MESSAGE_TIME } );

	if ( _messages.length > MAX_HUD_MESSAGES ) {

		_messages.length = MAX_HUD_MESSAGES;

	}

}

// Update message timers (call every frame, regardless of dirty state)
export function hud_update_timers( dt ) {

	for ( let i = _messages.length - 1; i >= 0; i -- ) {

		_messages[ i ].timer -= dt;

		if ( _messages[ i ].timer <= 0 ) {

			_messages.splice( i, 1 );

		}

	}

}

// Check if any HUD messages are active
export function hud_has_messages() {

	return _messages.length > 0;

}

export function hud_draw_messages( ctx ) {

	if ( _messages.length === 0 ) return;

	ctx.font = '7px monospace';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';

	for ( let i = 0; i < _messages.length; i ++ ) {

		const msg = _messages[ i ];
		const alpha = msg.timer < 0.5 ? msg.timer / 0.5 : 1.0;

		ctx.globalAlpha = alpha;
		ctx.fillStyle = '#00ff00';
		ctx.fillText( msg.text, COCKPIT_W / 2, 14 + i * 9 );

	}

	ctx.globalAlpha = 1.0;

}
