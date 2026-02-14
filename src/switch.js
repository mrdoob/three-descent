// Ported from: descent-master/MAIN/SWITCH.C, SWITCH.H
// Triggers and switches

import { Segments, Walls, Num_walls } from './mglobal.js';
import { wall_open_door, wall_toggle, wall_illusion_off, wall_illusion_on, WALL_DOOR } from './wall.js';
import { trigger_matcen } from './fuelcen.js';
import { find_connect_side } from './gameseg.js';

// Trigger flags
export const TRIGGER_CONTROL_DOORS = 1;
export const TRIGGER_SHIELD_DAMAGE = 2;
export const TRIGGER_ENERGY_DRAIN = 4;
export const TRIGGER_EXIT = 8;
export const TRIGGER_ON = 16;
export const TRIGGER_ONE_SHOT = 32;
export const TRIGGER_MATCEN = 64;
export const TRIGGER_ILLUSION_OFF = 128;
export const TRIGGER_SECRET_EXIT = 256;
export const TRIGGER_ILLUSION_ON = 512;

export const MAX_TRIGGERS = 100;
export const MAX_WALLS_PER_LINK = 10;

export class Trigger {

	constructor() {

		this.type = 0;
		this.flags = 0;
		this.value = 0;		// fix -> float (damage amount, etc.)
		this.time = 0;			// fix -> float (recharge countdown)
		this.link_num = - 1;
		this.num_links = 0;
		this.seg = new Int16Array( MAX_WALLS_PER_LINK );
		this.side = new Int16Array( MAX_WALLS_PER_LINK );

	}

}

// Global triggers array
export const Triggers = [];
for ( let i = 0; i < MAX_TRIGGERS; i ++ ) {

	Triggers.push( new Trigger() );

}

export let Num_triggers = 0;

export function set_Num_triggers( n ) {

	Num_triggers = n;

}

// Late-bound externals to avoid circular imports
let _getFrameTime = null;
let _onLevelExit = null;
let _onPlayerShieldDamage = null;
let _onPlayerEnergyDrain = null;

export function switch_set_externals( externals ) {

	_getFrameTime = externals.getFrameTime;
	if ( externals.onLevelExit !== undefined ) _onLevelExit = externals.onLevelExit;
	if ( externals.onPlayerShieldDamage !== undefined ) _onPlayerShieldDamage = externals.onPlayerShieldDamage;
	if ( externals.onPlayerEnergyDrain !== undefined ) _onPlayerEnergyDrain = externals.onPlayerEnergyDrain;

}

// Execute a link — toggle all walls linked to this trigger
// Ported from: do_link() in SWITCH.C
function do_link( trigger_num ) {

	if ( trigger_num === - 1 ) return;

	const trig = Triggers[ trigger_num ];

	for ( let i = 0; i < trig.num_links; i ++ ) {

		wall_toggle( trig.seg[ i ], trig.side[ i ] );

	}

}

// Execute trigger effects
// Ported from: check_trigger_sub() in SWITCH.C
export function check_trigger_sub( trigger_num ) {

	const trig = Triggers[ trigger_num ];

	if ( ( trig.flags & TRIGGER_CONTROL_DOORS ) !== 0 ) {

		do_link( trigger_num );

	}

	if ( ( trig.flags & TRIGGER_SHIELD_DAMAGE ) !== 0 ) {

		// Ported from: check_trigger_sub() in SWITCH.C — TRIGGER_SHIELD_DAMAGE
		if ( _onPlayerShieldDamage !== null ) {

			_onPlayerShieldDamage( trig.value );

		}

	}

	if ( ( trig.flags & TRIGGER_ENERGY_DRAIN ) !== 0 ) {

		// Ported from: check_trigger_sub() in SWITCH.C — TRIGGER_ENERGY_DRAIN
		if ( _onPlayerEnergyDrain !== null ) {

			_onPlayerEnergyDrain( trig.value );

		}

	}

	if ( ( trig.flags & TRIGGER_EXIT ) !== 0 ) {

		console.log( 'TRIGGER: Level exit triggered!' );

		if ( _onLevelExit !== null ) {

			_onLevelExit( false );	// false = normal exit (not secret)

		}

	}

	if ( ( trig.flags & TRIGGER_SECRET_EXIT ) !== 0 ) {

		console.log( 'TRIGGER: Secret exit triggered!' );

		if ( _onLevelExit !== null ) {

			_onLevelExit( true );	// true = secret exit

		}

	}

	if ( ( trig.flags & TRIGGER_MATCEN ) !== 0 ) {

		// Activate matcens linked to this trigger
		// Ported from: do_matcen() in SWITCH.C lines 238-251
		for ( let i = 0; i < trig.num_links; i ++ ) {

			trigger_matcen( trig.seg[ i ] );

		}

	}

	if ( ( trig.flags & TRIGGER_ILLUSION_OFF ) !== 0 ) {

		// Ported from: do_il_off() in SWITCH.C
		for ( let i = 0; i < trig.num_links; i ++ ) {

			wall_illusion_off( trig.seg[ i ], trig.side[ i ] );

		}

	}

	if ( ( trig.flags & TRIGGER_ILLUSION_ON ) !== 0 ) {

		// Ported from: do_il_on() in SWITCH.C
		for ( let i = 0; i < trig.num_links; i ++ ) {

			wall_illusion_on( trig.seg[ i ], trig.side[ i ] );

		}

	}

}

// Check for a trigger on a wall side
// Called when the player contacts a wall
// Ported from: check_trigger() in SWITCH.C
export function check_trigger( segnum, sidenum ) {

	const seg = Segments[ segnum ];
	const wall_num = seg.sides[ sidenum ].wall_num;
	if ( wall_num === - 1 ) return;

	const trigger_num = Walls[ wall_num ].trigger;
	if ( trigger_num === - 1 ) return;

	const trig = Triggers[ trigger_num ];

	// Check if trigger is active
	if ( ( trig.flags & TRIGGER_ON ) === 0 && ( trig.flags & TRIGGER_ONE_SHOT ) !== 0 ) {

		// One-shot trigger already fired
		return;

	}

	check_trigger_sub( trigger_num );

	// Handle one-shot: disable trigger on both sides of the wall
	// Ported from: check_trigger() in SWITCH.C lines 375-388
	if ( ( trig.flags & TRIGGER_ONE_SHOT ) !== 0 ) {

		trig.flags &= ~TRIGGER_ON;

		// Find and disable the trigger on the back side of this wall
		const child_segnum = seg.children[ sidenum ];
		if ( child_segnum >= 0 ) {

			const cside = find_connect_side( segnum, child_segnum );
			if ( cside !== - 1 ) {

				const cseg = Segments[ child_segnum ];
				const cwall_num = cseg.sides[ cside ].wall_num;
				if ( cwall_num !== - 1 ) {

					const ctrigger_num = Walls[ cwall_num ].trigger;
					if ( ctrigger_num !== - 1 ) {

						Triggers[ ctrigger_num ].flags &= ~TRIGGER_ON;

					}

				}

			}

		}

	}

}

// Process trigger timers each frame
// Ported from: triggers_frame_process() in SWITCH.C
export function triggers_frame_process() {

	if ( _getFrameTime === null ) return;

	const frameTime = _getFrameTime();

	for ( let i = 0; i < Num_triggers; i ++ ) {

		if ( Triggers[ i ].time >= 0 ) {

			Triggers[ i ].time -= frameTime;

		}

	}

}
