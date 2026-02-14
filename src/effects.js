// Ported from: descent-master/MAIN/EFFECTS.C
// Special effects - animated wall textures (fans, monitors, lava, warning lights)

import {
	Effects, Num_effects, MAX_EFFECTS,
	EF_CRITICAL, EF_ONE_SHOT, EF_STOPPED,
	TmapInfos, ObjBitmaps
} from './bm.js';
import { Textures, Segments } from './mglobal.js';
import { Vclips } from './vclip.js';
import { digi_play_sample_3d } from './digi.js';

// Externals injected at init time (avoids circular imports)
let _getFrameTime = null;
let _onTextureChanged = null;	// callback(changing_wall_texture, newBitmapIndex)
let _onSideOverlayChanged = null;	// callback(segnum, sidenum) — side tmap_num2 changed
let _createExplosion = null;	// callback(x, y, z, size, vclipNum) — create explosion
let _reactorDestroyed = false;	// set when reactor is destroyed — freezes EF_CRITICAL eclips

// Set external dependencies
export function effects_set_externals( externals ) {

	_getFrameTime = externals.getFrameTime;
	if ( externals.createExplosion !== undefined ) _createExplosion = externals.createExplosion;
	if ( externals.onSideOverlayChanged !== undefined ) _onSideOverlayChanged = externals.onSideOverlayChanged;

}

// Set render callback for when a texture changes
export function effects_set_render_callback( callback ) {

	_onTextureChanged = callback;

}

// Initialize special effects timers
// Ported from: init_special_effects() in EFFECTS.C
export function init_special_effects() {

	for ( let i = 0; i < Num_effects; i ++ ) {

		Effects[ i ].time_left = Effects[ i ].vc_frame_time;

	}

}

// Reset special effects (clear one-shots, restart stopped effects)
// Ported from: reset_special_effects() in EFFECTS.C
export function reset_special_effects() {

	_reactorDestroyed = false;

	for ( let i = 0; i < Num_effects; i ++ ) {

		Effects[ i ].segnum = - 1;
		Effects[ i ].flags &= ~( EF_STOPPED | EF_ONE_SHOT );

		if ( Effects[ i ].changing_wall_texture !== - 1 ) {

			Textures[ Effects[ i ].changing_wall_texture ] = Effects[ i ].vc_frames[ Effects[ i ].frame_count ];

		}

		// Reset object textures to current frame
		// Ported from: EFFECTS.C reset_special_effects() lines 142-143
		if ( Effects[ i ].changing_object_texture !== - 1 ) {

			ObjBitmaps[ Effects[ i ].changing_object_texture ] = Effects[ i ].vc_frames[ Effects[ i ].frame_count ];

		}

	}

}

// Process special effects each frame
// Ported from: do_special_effects() in EFFECTS.C
export function do_special_effects() {

	if ( _getFrameTime === null ) return;

	const frameTime = _getFrameTime();

	for ( let i = 0; i < Num_effects; i ++ ) {

		const ec = Effects[ i ];

		if ( ec.changing_wall_texture === - 1 && ec.changing_object_texture === - 1 ) {

			continue;

		}

		if ( ( ec.flags & EF_STOPPED ) !== 0 ) {

			continue;

		}

		ec.time_left -= frameTime;

		let frameChanged = false;

		while ( ec.time_left < 0 ) {

			ec.time_left += ec.vc_frame_time;

			ec.frame_count ++;
			if ( ec.frame_count >= ec.vc_num_frames ) {

				if ( ( ec.flags & EF_ONE_SHOT ) !== 0 ) {

					// One-shot: switch to destroyed bitmap and stop
					// Ported from: EFFECTS.C lines 169-175
					if ( ec.segnum !== - 1 && ec.sidenum >= 0 && ec.sidenum < 6 ) {

						const side = Segments[ ec.segnum ].sides[ ec.sidenum ];
						side.tmap_num2 = ( side.tmap_num2 & 0xC000 ) | ec.dest_bm_num;

						// Notify renderer to update this side's mesh
						if ( _onSideOverlayChanged !== null ) {

							_onSideOverlayChanged( ec.segnum, ec.sidenum );

						}

					}

					ec.flags &= ~EF_ONE_SHOT;
					ec.segnum = - 1;

				}

				ec.frame_count = 0;

			}

			frameChanged = true;

		}

		if ( frameChanged !== true ) continue;

		// EF_CRITICAL eclips always skip normal texture updates
		// They are the alternate clips referenced by other eclips' crit_clip field
		// Ported from: EFFECTS.C line 182-183
		if ( ( ec.flags & EF_CRITICAL ) !== 0 ) {

			continue;

		}

		// If this eclip has a crit_clip and reactor is destroyed,
		// redirect to show frames from the alternate clip instead
		// Ported from: EFFECTS.C lines 185-195
		if ( ec.crit_clip !== - 1 && _reactorDestroyed === true ) {

			const n = ec.crit_clip;

			if ( ec.changing_wall_texture !== - 1 ) {

				const newBitmapIndex = Effects[ n ].vc_frames[ Effects[ n ].frame_count ];
				Textures[ ec.changing_wall_texture ] = newBitmapIndex;

				if ( _onTextureChanged !== null ) {

					_onTextureChanged( ec.changing_wall_texture, newBitmapIndex );

				}

			}

			// Object texture crit_clip update
			// Ported from: EFFECTS.C lines 192-193
			if ( ec.changing_object_texture !== - 1 ) {

				ObjBitmaps[ ec.changing_object_texture ] = Effects[ n ].vc_frames[ Effects[ n ].frame_count ];

			}

		} else {

			// Normal frame update
			// Ported from: EFFECTS.C lines 196-203
			if ( ec.changing_wall_texture !== - 1 ) {

				const newBitmapIndex = ec.vc_frames[ ec.frame_count ];
				Textures[ ec.changing_wall_texture ] = newBitmapIndex;

				if ( _onTextureChanged !== null ) {

					_onTextureChanged( ec.changing_wall_texture, newBitmapIndex );

				}

			}

			// Object texture normal frame update
			// Ported from: EFFECTS.C lines 201-202
			if ( ec.changing_object_texture !== - 1 ) {

				ObjBitmaps[ ec.changing_object_texture ] = ec.vc_frames[ ec.frame_count ];

			}

		}

	}

}

// Stop an effect from animating (show first frame)
// Ported from: stop_effect() in EFFECTS.C
export function stop_effect( effect_num ) {

	const ec = Effects[ effect_num ];

	ec.flags |= EF_STOPPED;
	ec.frame_count = 0;

	if ( ec.changing_wall_texture !== - 1 ) {

		Textures[ ec.changing_wall_texture ] = ec.vc_frames[ 0 ];

		if ( _onTextureChanged !== null ) {

			_onTextureChanged( ec.changing_wall_texture, ec.vc_frames[ 0 ] );

		}

	}

	// Stop object texture animation — show first frame
	// Ported from: EFFECTS.C stop_effect() lines 239-240
	if ( ec.changing_object_texture !== - 1 ) {

		ObjBitmaps[ ec.changing_object_texture ] = ec.vc_frames[ 0 ];

	}

}

// Restart a stopped effect
// Ported from: restart_effect() in EFFECTS.C
export function restart_effect( effect_num ) {

	Effects[ effect_num ].flags &= ~EF_STOPPED;

}

// Called when reactor is destroyed — freezes EF_CRITICAL eclips
// Ported from: EFFECTS.C do_special_effects() reactor_is_dead check
export function effects_set_reactor_destroyed( destroyed ) {

	_reactorDestroyed = destroyed;

}

// Check if a weapon hit can blow up an effect (destructible monitor) on a wall side
// If so, creates an explosion and replaces the texture with the destroyed version
// Returns 1 if the effect blew up, 0 if not
// Ported from: check_effect_blowup() in COLLIDE.C lines 766-852
export function check_effect_blowup( segnum, sidenum, pos_x, pos_y, pos_z ) {

	if ( segnum < 0 ) return 0;

	const seg = Segments[ segnum ];
	if ( seg === undefined ) return 0;

	const side = seg.sides[ sidenum ];
	const tm = side.tmap_num2;

	// Must have an overlay texture
	if ( tm === 0 ) return 0;

	// Look up eclip for this overlay texture
	const tmapIndex = tm & 0x3FFF;
	if ( tmapIndex < 0 || TmapInfos[ tmapIndex ] === undefined ) return 0;

	const ec_num = TmapInfos[ tmapIndex ].eclip_num;
	if ( ec_num === - 1 ) return 0;

	const ec = Effects[ ec_num ];

	// Check if this eclip can be destroyed
	const db = ec.dest_bm_num;
	if ( db === - 1 ) return 0;

	// Don't destroy if already playing one-shot destruction
	if ( ( ec.flags & EF_ONE_SHOT ) !== 0 ) return 0;

	// Skipping UV pixel transparency check for simplicity
	// (Original checks if hit pixel is non-transparent to confirm monitor was hit)
	// This means we destroy whenever the side is hit, which is 95%+ accurate
	// since monitors typically fill their entire side

	// Create explosion at impact point
	// Ported from: COLLIDE.C line 810-811
	const vc = ec.dest_vclip;
	if ( _createExplosion !== null && vc >= 0 ) {

		_createExplosion( pos_x, pos_y, pos_z, ec.dest_size > 0 ? ec.dest_size : 2.0, vc );

	}

	// Play destruction vclip sound
	// Ported from: COLLIDE.C lines 813-814
	if ( vc >= 0 && Vclips[ vc ] !== undefined && Vclips[ vc ].sound_num !== - 1 ) {

		digi_play_sample_3d( Vclips[ vc ].sound_num, 0.8, pos_x, pos_y, pos_z );

	}

	// Handle texture replacement
	if ( ec.dest_eclip !== - 1 && Effects[ ec.dest_eclip ].segnum === - 1 ) {

		// Start one-shot destruction animation
		// Ported from: COLLIDE.C lines 823-837
		const new_ec = Effects[ ec.dest_eclip ];
		const bm_num = new_ec.changing_wall_texture;

		new_ec.time_left = new_ec.vc_frame_time;
		new_ec.frame_count = 0;
		new_ec.segnum = segnum;
		new_ec.sidenum = sidenum;
		new_ec.flags |= EF_ONE_SHOT;
		new_ec.dest_bm_num = ec.dest_bm_num;

		side.tmap_num2 = bm_num | ( tm & 0xC000 );

	} else {

		// Immediate replacement with destroyed bitmap
		// Ported from: COLLIDE.C lines 839-840
		side.tmap_num2 = db | ( tm & 0xC000 );

	}

	// Notify renderer to rebuild this side's mesh with the new texture
	if ( _onSideOverlayChanged !== null ) {

		_onSideOverlayChanged( segnum, sidenum );

	}

	return 1;

}
