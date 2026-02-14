// Ported from: descent-master/MAIN/POWERUP.C
// Powerup placement, animation, pickup detection, sprite texture building

import * as THREE from 'three';
import { Vclips, Powerup_info, N_powerup_types } from './bm.js';
import { OBJ_POWERUP, OBJ_HOSTAGE } from './object.js';
import { object_create_explosion, VCLIP_POWERUP_DISAPPEARANCE } from './fireball.js';
import { digi_play_sample_3d } from './digi.js';

// Lifetime for robot-dropped powerups (seconds)
// Ported from: POWERUP.C do_powerup_frame() — lifeleft countdown
const DROPPED_POWERUP_LIFELEFT = 20.0;

// Tracked powerups for player pickup
const livePowerups = [];

// Map of powerup ID → vclip_num (built dynamically from placed objects)
const powerupVclipMap = {};
// Map of powerup ID → size
const powerupSizeMap = {};

// Cache for vclip sprite textures (keyed by PIG bitmap index)
const spriteTextureCache = new Map();

// External references
let _pigFile = null;
let _palette = null;
let _scene = null;
let _collide_player_and_powerup = null;

export function powerup_set_externals( ext ) {

	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;
	if ( ext.scene !== undefined ) _scene = ext.scene;
	if ( ext.collide_player_and_powerup !== undefined ) _collide_player_and_powerup = ext.collide_player_and_powerup;

}

export function powerup_get_live() { return livePowerups; }
export function powerup_get_vclip_map() { return powerupVclipMap; }
export function powerup_get_size_map() { return powerupSizeMap; }

// Build a billboard sprite texture from a PIG bitmap
export function buildSpriteTexture( bitmapIndex ) {

	if ( spriteTextureCache.has( bitmapIndex ) ) {

		return spriteTextureCache.get( bitmapIndex );

	}

	if ( _pigFile === null || _palette === null ) return null;

	const pixels = _pigFile.getBitmapPixels( bitmapIndex );
	if ( pixels === null ) return null;

	const bm = _pigFile.bitmaps[ bitmapIndex ];
	const w = bm.width;
	const h = bm.height;
	const rgba = new Uint8Array( w * h * 4 );

	for ( let i = 0; i < w * h; i ++ ) {

		const palIdx = pixels[ i ];

		if ( palIdx === 255 ) {

			rgba[ i * 4 + 0 ] = 0;
			rgba[ i * 4 + 1 ] = 0;
			rgba[ i * 4 + 2 ] = 0;
			rgba[ i * 4 + 3 ] = 0;

		} else {

			rgba[ i * 4 + 0 ] = _palette[ palIdx * 3 + 0 ];
			rgba[ i * 4 + 1 ] = _palette[ palIdx * 3 + 1 ];
			rgba[ i * 4 + 2 ] = _palette[ palIdx * 3 + 2 ];
			rgba[ i * 4 + 3 ] = 255;

		}

	}

	const texture = new THREE.DataTexture( rgba, w, h );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestFilter;
	texture.needsUpdate = true;

	spriteTextureCache.set( bitmapIndex, texture );
	return texture;

}

// Build a sprite material for a vclip (uses first frame)
export function buildVclipSprite( vclipNum, size ) {

	const vc = Vclips[ vclipNum ];
	if ( vc === undefined || vc.frames.length === 0 ) {

		console.warn( 'buildVclipSprite: vclip ' + vclipNum + ' — no frames (undefined=' +
			( vc === undefined ) + ', length=' + ( vc !== undefined ? vc.frames.length : 'N/A' ) + ')' );
		return null;

	}

	// Use first frame bitmap
	const bitmapIndex = vc.frames[ 0 ];
	const texture = buildSpriteTexture( bitmapIndex );
	if ( texture === null ) {

		console.warn( 'buildVclipSprite: vclip ' + vclipNum + ' — texture build failed for bitmap ' + bitmapIndex );
		return null;

	}

	const material = new THREE.SpriteMaterial( {
		map: texture,
		transparent: true,
		depthTest: true,
		depthWrite: false
	} );

	const sprite = new THREE.Sprite( material );
	sprite.scale.set( size * 2, size * 2, 1 );

	return sprite;

}

// Place a powerup object in the scene (called from placeObjects)
// Returns true if sprite was created, false if failed
export function powerup_place( obj, scene ) {

	const sprite = buildVclipSprite( obj.rtype.vclip_num, obj.size );
	if ( sprite === null ) {

		console.warn( 'POWERUP: Failed to place powerup id=' + obj.id + ' vclip=' + obj.rtype.vclip_num +
			' (no frames in PIG for this vclip)' );
		return false;

	}

	sprite.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
	scene.add( sprite );

	const vc = Vclips[ obj.rtype.vclip_num ];
	const frameTime = ( vc !== undefined && vc.num_frames > 1 ) ? vc.play_time / vc.num_frames : 0;
	livePowerups.push( {
		obj: obj, sprite: sprite, alive: true,
		vclipNum: obj.rtype.vclip_num, frameNum: 0, frameTime: frameTime, frameTimer: frameTime
	} );

	// Record vclip_num and size for this powerup type (for robot drops)
	if ( powerupVclipMap[ obj.id ] === undefined ) {

		powerupVclipMap[ obj.id ] = obj.rtype.vclip_num;
		powerupSizeMap[ obj.id ] = obj.size;

	}

	return true;

}

// Place a hostage object in the scene (called from placeObjects)
// Returns 1 to increment hostagesInLevel counter
export function powerup_place_hostage( obj, scene ) {

	const sprite = buildVclipSprite( obj.rtype.vclip_num, obj.size );
	if ( sprite === null ) return 0;

	sprite.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );
	scene.add( sprite );

	const vc = Vclips[ obj.rtype.vclip_num ];
	const frameTime = ( vc !== undefined && vc.num_frames > 1 ) ? vc.play_time / vc.num_frames : 0;
	livePowerups.push( {
		obj: obj, sprite: sprite, alive: true, isHostage: true,
		vclipNum: obj.rtype.vclip_num, frameNum: 0, frameTime: frameTime, frameTimer: frameTime
	} );

	return 1;

}

// Spawn a dropped powerup from a destroyed robot
// Ported from: object_create_egg() in COLLIDE.C
export function spawnDroppedPowerup( powerupId, pos_x, pos_y, pos_z, segnum ) {

	if ( _scene === null ) return;

	// Find vclip_num for this powerup type
	// Prefer Powerup_info[] (parsed from bitmaps.bin), fall back to dynamic map
	let vclipNum;
	let size;

	if ( powerupId >= 0 && powerupId < N_powerup_types && Powerup_info[ powerupId ].vclip_num !== - 1 ) {

		vclipNum = Powerup_info[ powerupId ].vclip_num;
		size = Powerup_info[ powerupId ].size;

	} else {

		vclipNum = powerupVclipMap[ powerupId ];
		size = powerupSizeMap[ powerupId ] || 3.0;

	}

	if ( vclipNum === undefined ) {

		// No vclip known for this powerup type — give directly to player
		console.log( 'DROP: No vclip for powerup id=' + powerupId + ', auto-collecting' );

		if ( _collide_player_and_powerup !== null ) {

			_collide_player_and_powerup( {
				alive: true,
				obj: { id: powerupId, size: size },
				sprite: null,
				isHostage: false,
				autoPicked: true
			} );

		}

		return;

	}

	// Create sprite
	const sprite = buildVclipSprite( vclipNum, size );
	if ( sprite === null ) return;

	sprite.position.set( pos_x, pos_y, - pos_z );
	_scene.add( sprite );

	// Create a powerup object for pickup tracking
	const obj = {
		type: OBJ_POWERUP,
		id: powerupId,
		pos_x: pos_x,
		pos_y: pos_y,
		pos_z: pos_z,
		segnum: segnum,
		size: size
	};

	const vc = Vclips[ vclipNum ];
	const frameTime = ( vc !== undefined && vc.num_frames > 1 ) ? vc.play_time / vc.num_frames : 0;
	livePowerups.push( {
		obj: obj, sprite: sprite, alive: true,
		vclipNum: vclipNum, frameNum: 0, frameTime: frameTime, frameTimer: frameTime,
		dropped: true, lifeleft: DROPPED_POWERUP_LIFELEFT
	} );
	console.log( 'DROP: Spawned powerup id=' + powerupId + ' at seg ' + segnum );

}

// Animate powerup/hostage vclips and check player pickup
// Called each frame from onFrameCallback
export function powerup_do_frame( dt, playerPos ) {

	// Animate powerup/hostage vclips
	for ( let i = 0; i < livePowerups.length; i ++ ) {

		const pw = livePowerups[ i ];
		if ( pw.alive !== true || pw.sprite === null ) continue;
		if ( pw.frameTime <= 0 ) continue;	// No animation

		const vc = Vclips[ pw.vclipNum ];
		if ( vc === undefined || vc.num_frames <= 1 ) continue;

		pw.frameTimer -= dt;

		while ( pw.frameTimer < 0 ) {

			pw.frameTimer += pw.frameTime;
			pw.frameNum ++;
			if ( pw.frameNum >= vc.num_frames ) pw.frameNum = 0;

		}

		// Update sprite texture to current frame
		const bitmapIndex = vc.frames[ pw.frameNum ];
		const newTexture = buildSpriteTexture( bitmapIndex );
		if ( newTexture !== null && pw.sprite.material.map !== newTexture ) {

			pw.sprite.material.map = newTexture;
			pw.sprite.material.needsUpdate = true;

		}

	}

	// Check lifeleft on dropped powerups — remove when expired
	// Ported from: do_powerup_frame() in POWERUP.C lines 210-215
	for ( let i = livePowerups.length - 1; i >= 0; i -- ) {

		const pw = livePowerups[ i ];
		if ( pw.alive !== true ) continue;
		if ( pw.dropped !== true ) continue;	// Only dropped powerups expire

		pw.lifeleft -= dt;

		if ( pw.lifeleft <= 0 ) {

			// Spawn disappearance explosion at powerup position
			object_create_explosion( pw.obj.pos_x, pw.obj.pos_y, pw.obj.pos_z, 3.5, VCLIP_POWERUP_DISAPPEARANCE );

			// Play disappearance sound (ported from POWERUP.C line 213-214)
			const dispVc = Vclips[ VCLIP_POWERUP_DISAPPEARANCE ];
			if ( dispVc !== undefined && dispVc.sound_num >= 0 ) {

				digi_play_sample_3d( dispVc.sound_num, 1.0, pw.obj.pos_x, pw.obj.pos_y, pw.obj.pos_z );

			}

			// Remove sprite from scene
			if ( pw.sprite !== null && _scene !== null ) {

				_scene.remove( pw.sprite );

			}

			pw.alive = false;

		}

	}

	// Check powerup collection (player walks into powerup)
	if ( _collide_player_and_powerup !== null && playerPos !== null ) {

		for ( let i = 0; i < livePowerups.length; i ++ ) {

			const pw = livePowerups[ i ];
			if ( pw.alive !== true ) continue;

			const dx = playerPos.x - pw.obj.pos_x;
			const dy = playerPos.y - pw.obj.pos_y;
			const dz = playerPos.z - pw.obj.pos_z;
			const distSq = dx * dx + dy * dy + dz * dz;
			const pickupRadius = pw.obj.size + 2.5; // Player radius

			if ( distSq < pickupRadius * pickupRadius ) {

				_collide_player_and_powerup( pw );

			}

		}

	}

}

// Clean up powerups for level transition
export function powerup_cleanup( scene ) {

	for ( let i = 0; i < livePowerups.length; i ++ ) {

		if ( livePowerups[ i ].sprite !== null ) {

			scene.remove( livePowerups[ i ].sprite );

		}

	}

	livePowerups.length = 0;

}
