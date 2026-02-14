// Ported from: descent-master/MAIN/FIREBALL.C
// Explosion and impact visual effects using vclip animated sprites
// Debris system for exploding polygon models

import * as THREE from 'three';
import { Vclips } from './bm.js';
import { Robot_info, N_robot_types } from './bm.js';
import { Polygon_models, buildSubmodelMesh } from './polyobj.js';
import { find_point_seg } from './gameseg.js';
import { OBJ_ROBOT } from './object.js';
import { Segments, Vertices, Side_to_verts, Walls } from './mglobal.js';
import { WallAnims, find_connect_side, wall_set_tmap_num } from './wall.js';
import { digi_play_sample_3d, SOUND_EXPLODING_WALL } from './digi.js';

// Vclip constants (from VCLIP.H)
export const VCLIP_SMALL_EXPLOSION = 2;
export const VCLIP_PLAYER_HIT = 1;
export const VCLIP_MORPHING_ROBOT = 10;
export const VCLIP_VOLATILE_WALL_HIT = 5;
export const VCLIP_POWERUP_DISAPPEARANCE = 62;

// Explosion scale factor (from FIREBALL.C: #define EXPLOSION_SCALE fl2f(2.5))
const EXPLOSION_SCALE = 2.5;

// What vclip does this object explode with?
// Ported from: get_explosion_vclip() in FIREBALL.C lines 901-916
// stage 0 = hit spark (exp1), stage 1 = death explosion (exp2)
export function get_explosion_vclip( obj_type, obj_id, stage ) {

	if ( obj_type === OBJ_ROBOT ) {

		if ( obj_id >= 0 && obj_id < N_robot_types ) {

			if ( stage === 0 && Robot_info[ obj_id ].exp1_vclip_num > - 1 ) {

				return Robot_info[ obj_id ].exp1_vclip_num;

			} else if ( stage === 1 && Robot_info[ obj_id ].exp2_vclip_num > - 1 ) {

				return Robot_info[ obj_id ].exp2_vclip_num;

			}

		}

	}

	return VCLIP_SMALL_EXPLOSION;	// default

}

// Debris lifetime in seconds (from FIREBALL.C: #define DEBRIS_LIFE (f1_0 * 2))
const DEBRIS_LIFE = 2.0;

// Pool
const MAX_EXPLOSIONS = 30;
const explosions = [];

// Debris pool
const MAX_DEBRIS = 30;
const debrisList = [];

// External refs
let _scene = null;
let _buildTexture = null;	// callback( bitmapIndex ) => THREE.Texture
let _pigFile = null;
let _palette = null;

// Texture cache keyed by PIG bitmap index
const _textureCache = new Map();

// Reusable vectors for debris updates (Golden Rule #5)
const _debrisEuler = new THREE.Euler();

class ExplosionObj {

	constructor() {

		this.active = false;
		this.lifeleft = 0;
		this.playTime = 0;
		this.vclipNum = 0;
		this.numFrames = 0;
		this.baseSize = 0;
		this.sprite = null;
		this.lastFrame = - 1;	// track frame to avoid unnecessary texture swaps

	}

}

// Debris object — represents a piece of a destroyed polygon model
// Ported from: object_create_debris() in FIREBALL.C
class DebrisObj {

	constructor() {

		this.active = false;
		this.mesh = null;
		this.vel_x = 0;
		this.vel_y = 0;
		this.vel_z = 0;
		this.rotvel_x = 0;
		this.rotvel_y = 0;
		this.rotvel_z = 0;
		this.lifeleft = 0;
		// Position in Descent coordinates
		this.pos_x = 0;
		this.pos_y = 0;
		this.pos_z = 0;
		this.segnum = - 1;	// Current segment (for wall collision)

	}

}

// Get or create texture for a vclip frame
function getVclipTexture( vclipNum, frameIndex ) {

	const vc = Vclips[ vclipNum ];
	if ( vc === undefined || frameIndex >= vc.frames.length ) return null;

	const bmIdx = vc.frames[ frameIndex ];
	if ( _textureCache.has( bmIdx ) ) return _textureCache.get( bmIdx );

	if ( _buildTexture === null ) return null;

	const tex = _buildTexture( bmIdx );
	if ( tex !== null ) {

		_textureCache.set( bmIdx, tex );

	}

	return tex;

}

// Initialize explosion pool
// buildTexture: callback( bitmapIndex ) => THREE.Texture
export function fireball_init( scene, buildTexture, pigFile, palette ) {

	_scene = scene;
	_buildTexture = buildTexture;
	_pigFile = pigFile;
	_palette = palette;

	for ( let i = 0; i < MAX_EXPLOSIONS; i ++ ) {

		const e = new ExplosionObj();

		// Each explosion gets its own SpriteMaterial (per-instance texture)
		e.sprite = new THREE.Sprite( new THREE.SpriteMaterial( {
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			depthTest: true
		} ) );
		e.sprite.visible = false;

		explosions.push( e );

	}

	// Pre-create debris pool slots
	for ( let i = 0; i < MAX_DEBRIS; i ++ ) {

		debrisList.push( new DebrisObj() );

	}

}

// Create a visual explosion at a position (Descent coordinates)
// vclip_num defaults to VCLIP_SMALL_EXPLOSION if not specified
export function object_create_explosion( pos_x, pos_y, pos_z, size, vclip_num ) {

	if ( _scene === null ) return;
	if ( vclip_num === undefined ) vclip_num = VCLIP_SMALL_EXPLOSION;

	const vc = Vclips[ vclip_num ];
	if ( vc === undefined || vc.num_frames === 0 || vc.frames.length === 0 ) return;

	for ( let i = 0; i < MAX_EXPLOSIONS; i ++ ) {

		const e = explosions[ i ];
		if ( e.active === true ) continue;

		e.active = true;
		e.vclipNum = vclip_num;
		e.numFrames = vc.num_frames;
		e.playTime = vc.play_time > 0 ? vc.play_time : 0.5;
		e.lifeleft = e.playTime;
		e.baseSize = size;
		e.lastFrame = - 1;

		// Set first frame texture
		const tex = getVclipTexture( vclip_num, 0 );
		if ( tex !== null ) {

			e.sprite.material.map = tex;
			e.sprite.material.needsUpdate = true;

		}

		// Position in Three.js coordinates (negate Z)
		e.sprite.visible = true;
		e.sprite.position.set( pos_x, pos_y, - pos_z );

		const s = size * EXPLOSION_SCALE;
		e.sprite.scale.set( s, s, 1 );

		_scene.add( e.sprite );

		return;

	}

}

// Create a single debris piece from a submodel of a destroyed object
// Ported from: object_create_debris() in FIREBALL.C
function object_create_debris( model_num, subobj_num, pos_x, pos_y, pos_z ) {

	if ( _scene === null || _pigFile === null || _palette === null ) return;

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return;

	// Build (or get cached) mesh for this submodel
	const sourceMesh = buildSubmodelMesh( model, subobj_num, _pigFile, _palette );
	if ( sourceMesh === null ) return;

	// Find an inactive debris slot
	let d = null;
	for ( let i = 0; i < MAX_DEBRIS; i ++ ) {

		if ( debrisList[ i ].active !== true ) {

			d = debrisList[ i ];
			break;

		}

	}

	if ( d === null ) return;	// No free slots

	// Clean up any previous mesh in this slot
	if ( d.mesh !== null ) {

		_scene.remove( d.mesh );
		d.mesh = null;

	}

	// Clone the submodel mesh (shares geometry/material, cheap)
	d.mesh = sourceMesh.clone();
	d.active = true;
	d.lifeleft = DEBRIS_LIFE;

	// Position at parent's location (Descent coordinates)
	d.pos_x = pos_x;
	d.pos_y = pos_y;
	d.pos_z = pos_z;
	d.segnum = find_point_seg( pos_x, pos_y, pos_z, - 1 );

	// Random velocity: normalized random direction * (10 + random * 30)
	// Ported from FIREBALL.C: vm_vec_normalize + vm_vec_scale(i2f(10) + d_rand()*6)
	let vx = ( Math.random() - 0.5 );
	let vy = ( Math.random() - 0.5 );
	let vz = ( Math.random() - 0.5 );
	const vmag = Math.sqrt( vx * vx + vy * vy + vz * vz );
	if ( vmag > 0.001 ) {

		vx /= vmag;
		vy /= vmag;
		vz /= vmag;

	}

	const speed = 10.0 + Math.random() * 30.0;
	d.vel_x = vx * speed;
	d.vel_y = vy * speed;
	d.vel_z = vz * speed;

	// Fixed rotation velocities (from FIREBALL.C)
	// 10*0x2000/3 = ~0.4167 rev/s, 10*0x4000/3 = ~0.8333, 10*0x7000/3 = ~1.4583
	d.rotvel_x = 2.62;	// ~150 deg/s
	d.rotvel_y = 5.24;	// ~300 deg/s
	d.rotvel_z = 9.16;	// ~525 deg/s

	// Position mesh in Three.js coordinates
	d.mesh.position.set( pos_x, pos_y, - pos_z );
	_scene.add( d.mesh );

}

// Blow up a polygon model — create debris for each submodel
// Ported from: explode_model() in FIREBALL.C
export function explode_model( model_num, pos_x, pos_y, pos_z ) {

	if ( model_num < 0 || model_num >= Polygon_models.length ) return;

	const model = Polygon_models[ model_num ];
	if ( model === null || model === undefined ) return;

	if ( model.n_models > 1 ) {

		// Create debris for each submodel (skip 0 = center body)
		for ( let i = 1; i < model.n_models; i ++ ) {

			object_create_debris( model_num, i, pos_x, pos_y, pos_z );

		}

	}

	// Also create debris for submodel 0 (the center) since we remove the whole mesh
	object_create_debris( model_num, 0, pos_x, pos_y, pos_z );

}

// Clean up all active debris (called on level change)
export function debris_cleanup() {

	// Clean up active explosions and their lights
	for ( let i = 0; i < explosions.length; i ++ ) {

		const e = explosions[ i ];
		if ( e.active === true ) {

			e.active = false;
			e.sprite.visible = false;
			if ( _scene !== null ) _scene.remove( e.sprite );

		}

	}

	// Clean up active debris
	for ( let i = 0; i < debrisList.length; i ++ ) {

		const d = debrisList[ i ];
		if ( d.active === true ) {

			d.active = false;
			if ( d.mesh !== null ) {

				if ( _scene !== null ) _scene.remove( d.mesh );
				d.mesh = null;

			}

		}

	}

	// Reset any active exploding walls
	init_exploding_walls();

}

// Update all active explosions and debris
export function fireball_process( dt ) {

	// --- Process explosions ---
	for ( let i = 0; i < MAX_EXPLOSIONS; i ++ ) {

		const e = explosions[ i ];
		if ( e.active !== true ) continue;

		e.lifeleft -= dt;
		if ( e.lifeleft <= 0 ) {

			e.active = false;
			e.sprite.visible = false;
			_scene.remove( e.sprite );

			continue;

		}

		// Calculate current animation frame from lifeleft
		// From VCLIP.C: bitmapnum = (nf - fixdiv((nf-1)*timeleft, play_time)) - 1
		const nf = e.numFrames;
		let frameNum = Math.floor( nf - ( ( nf - 1 ) * e.lifeleft / e.playTime ) ) - 1;
		if ( frameNum < 0 ) frameNum = 0;
		if ( frameNum >= nf ) frameNum = nf - 1;

		// Update texture only when frame changes
		if ( frameNum !== e.lastFrame ) {

			e.lastFrame = frameNum;
			const tex = getVclipTexture( e.vclipNum, frameNum );
			if ( tex !== null ) {

				e.sprite.material.map = tex;
				e.sprite.material.needsUpdate = true;

			}

		}

	}

	// --- Process debris ---
	// Ported from: do_debris_frame() in FIREBALL.C
	for ( let i = 0; i < debrisList.length; i ++ ) {

		const d = debrisList[ i ];
		if ( d.active !== true ) continue;

		d.lifeleft -= dt;

		if ( d.lifeleft <= 0 ) {

			// Debris expires — create small explosion at its position
			object_create_explosion( d.pos_x, d.pos_y, d.pos_z, 1.5, VCLIP_SMALL_EXPLOSION );

			d.active = false;
			if ( d.mesh !== null ) {

				_scene.remove( d.mesh );
				d.mesh = null;

			}

			continue;

		}

		// Update position: pos += vel * dt (no drag, per original)
		const new_x = d.pos_x + d.vel_x * dt;
		const new_y = d.pos_y + d.vel_y * dt;
		const new_z = d.pos_z + d.vel_z * dt;

		// Wall collision check: if debris left its segment, it hit a wall
		// Ported from: collide_debris_and_wall() in COLLIDE.C — explode on impact
		const newSeg = find_point_seg( new_x, new_y, new_z, d.segnum );

		if ( newSeg === - 1 ) {

			// Hit a wall — explode and deactivate
			object_create_explosion( d.pos_x, d.pos_y, d.pos_z, 1.5, VCLIP_SMALL_EXPLOSION );

			d.active = false;
			if ( d.mesh !== null ) {

				_scene.remove( d.mesh );
				d.mesh = null;

			}

			continue;

		}

		d.pos_x = new_x;
		d.pos_y = new_y;
		d.pos_z = new_z;
		d.segnum = newSeg;

		// Update mesh position (Three.js coordinates: negate Z)
		d.mesh.position.set( d.pos_x, d.pos_y, - d.pos_z );

		// Apply rotation (accumulate euler angles)
		d.mesh.rotation.x += d.rotvel_x * dt;
		d.mesh.rotation.y += d.rotvel_y * dt;
		d.mesh.rotation.z += d.rotvel_z * dt;

	}

	// --- Process exploding walls ---
	do_exploding_wall_frame( dt );

}

// ============================================================
// Exploding wall system
// Ported from: explode_wall() and do_exploding_wall_frame() in FIREBALL.C lines 1136-1283
// Progressive fireball cascade on walls with WCF_EXPLODES flag
// ============================================================

const MAX_EXPLODING_WALLS = 10;
const EXPL_WALL_TIME = 1.0;			// 1 second total explosion time (f1_0 in original)
const EXPL_WALL_TOTAL_FIREBALLS = 32;	// total fireballs spawned over explosion duration
const EXPL_WALL_FIREBALL_SIZE = 4.5;	// 0x48000 / 65536 = ~4.5 (smallest fireball size)

// Exploding wall slots — pre-allocated (Golden Rule #5)
const expl_wall_list = [];

for ( let i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

	expl_wall_list.push( { segnum: - 1, sidenum: 0, time: 0 } );

}

// Badass explosion callback for wall fireballs that do area damage
// (pos_x, pos_y, pos_z, maxDamage, maxDistance) => void
let _onBadassWallExplosion = null;

export function fireball_set_badass_wall_callback( fn ) {

	_onBadassWallExplosion = fn;

}

// Initialize exploding walls (called at level start)
// Ported from: init_exploding_walls() in FIREBALL.C lines 1149-1155
export function init_exploding_walls() {

	for ( let i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

		expl_wall_list[ i ].segnum = - 1;

	}

}

// Start an exploding wall sequence
// Ported from: explode_wall() in FIREBALL.C lines 1158-1181
export function explode_wall( segnum, sidenum ) {

	// Find a free slot
	let i;
	for ( i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

		if ( expl_wall_list[ i ].segnum === - 1 ) break;

	}

	if ( i === MAX_EXPLODING_WALLS ) {

		console.warn( 'FIREBALL: No free slot for exploding wall!' );
		return;

	}

	expl_wall_list[ i ].segnum = segnum;
	expl_wall_list[ i ].sidenum = sidenum;
	expl_wall_list[ i ].time = 0;

	// Play one long sound for the whole door wall explosion
	// Ported from: FIREBALL.C line 1178-1179
	const seg = Segments[ segnum ];
	const sv = Side_to_verts[ sidenum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 4; v ++ ) {

		const vi = seg.verts[ sv[ v ] ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	cx /= 4;
	cy /= 4;
	cz /= 4;

	digi_play_sample_3d( SOUND_EXPLODING_WALL, 1.0, cx, cy, cz );

}

// Process all exploding walls per frame
// Ported from: do_exploding_wall_frame() in FIREBALL.C lines 1185-1283
function do_exploding_wall_frame( dt ) {

	for ( let i = 0; i < MAX_EXPLODING_WALLS; i ++ ) {

		const segnum = expl_wall_list[ i ].segnum;
		if ( segnum === - 1 ) continue;

		const sidenum = expl_wall_list[ i ].sidenum;

		const oldfrac = expl_wall_list[ i ].time / EXPL_WALL_TIME;

		expl_wall_list[ i ].time += dt;
		if ( expl_wall_list[ i ].time > EXPL_WALL_TIME ) {

			expl_wall_list[ i ].time = EXPL_WALL_TIME;

		}

		// At 75% of explosion time, set wall texture to final (destroyed) frame
		// Ported from: FIREBALL.C lines 1203-1216
		if ( expl_wall_list[ i ].time > ( EXPL_WALL_TIME * 3 ) / 4 ) {

			const seg = Segments[ segnum ];
			const wall_num = seg.sides[ sidenum ].wall_num;

			if ( wall_num !== - 1 ) {

				const a = Walls[ wall_num ].clip_num;

				if ( a >= 0 ) {

					const n = WallAnims[ a ].num_frames;
					const child_segnum = seg.children[ sidenum ];

					if ( child_segnum >= 0 ) {

						const cside = find_connect_side( segnum, child_segnum );

						if ( cside !== - 1 ) {

							wall_set_tmap_num( segnum, sidenum, child_segnum, cside, a, n - 1 );

						}

					}

				}

			}

		}

		const newfrac = expl_wall_list[ i ].time / EXPL_WALL_TIME;

		// Quadratic fireball count: count = TOTAL * frac^2
		// Ported from: FIREBALL.C lines 1220-1221
		const old_count = Math.floor( EXPL_WALL_TOTAL_FIREBALLS * oldfrac * oldfrac );
		const new_count = Math.floor( EXPL_WALL_TOTAL_FIREBALLS * newfrac * newfrac );

		// Create new fireballs for this frame
		// Ported from: FIREBALL.C lines 1229-1275
		for ( let e = old_count; e < new_count; e ++ ) {

			const seg = Segments[ segnum ];
			const sv = Side_to_verts[ sidenum ];

			// Get three vertices of the wall face
			const vi0 = seg.verts[ sv[ 0 ] ];
			const vi1 = seg.verts[ sv[ 1 ] ];
			const vi2 = seg.verts[ sv[ 2 ] ];

			const v0x = Vertices[ vi0 * 3 + 0 ];
			const v0y = Vertices[ vi0 * 3 + 1 ];
			const v0z = Vertices[ vi0 * 3 + 2 ];
			const v1x = Vertices[ vi1 * 3 + 0 ];
			const v1y = Vertices[ vi1 * 3 + 1 ];
			const v1z = Vertices[ vi1 * 3 + 2 ];
			const v2x = Vertices[ vi2 * 3 + 0 ];
			const v2y = Vertices[ vi2 * 3 + 1 ];
			const v2z = Vertices[ vi2 * 3 + 2 ];

			// Edge vectors from v1
			const e0x = v0x - v1x;
			const e0y = v0y - v1y;
			const e0z = v0z - v1z;
			const e1x = v2x - v1x;
			const e1y = v2y - v1y;
			const e1z = v2z - v1z;

			// Random position on face: pos = v1 + rand*e0 + rand*e1
			// Ported from: vm_vec_scale_add with rand()*2 (rand() returns 0..32767, *2 gives 0..65534, ~0..1.0 in fixed)
			const r0 = Math.random();
			const r1 = Math.random();

			let px = v1x + e0x * r0 + e1x * r1;
			let py = v1y + e0y * r0 + e1y * r1;
			let pz = v1z + e0z * r0 + e1z * r1;

			// Fireball size increases with progression
			const size = EXPL_WALL_FIREBALL_SIZE + ( 2 * EXPL_WALL_FIREBALL_SIZE * e / EXPL_WALL_TOTAL_FIREBALLS );

			// Offset from wall along face normal — starts far, gets closer
			// Ported from: FIREBALL.C lines 1258-1260
			let nx = e0y * e1z - e0z * e1y;
			let ny = e0z * e1x - e0x * e1z;
			let nz = e0x * e1y - e0y * e1x;
			const nmag = Math.sqrt( nx * nx + ny * ny + nz * nz );

			if ( nmag > 0.001 ) {

				nx /= nmag;
				ny /= nmag;
				nz /= nmag;
				const offset = size * ( EXPL_WALL_TOTAL_FIREBALLS - e ) / EXPL_WALL_TOTAL_FIREBALLS;
				px += nx * offset;
				py += ny * offset;
				pz += nz * offset;

			}

			if ( ( e & 3 ) !== 0 ) {

				// 3 of 4 are normal explosions (visual only)
				object_create_explosion( px, py, pz, size, VCLIP_SMALL_EXPLOSION );

			} else {

				// 1 of 4 are badass (do area damage)
				// Ported from: FIREBALL.C lines 1265-1272
				// damage=4, radius=20, force=50
				object_create_explosion( px, py, pz, size, VCLIP_SMALL_EXPLOSION );

				if ( _onBadassWallExplosion !== null ) {

					_onBadassWallExplosion( px, py, pz, 4.0, 20.0 );

				}

			}

		}

		// Check if explosion is complete
		if ( expl_wall_list[ i ].time >= EXPL_WALL_TIME ) {

			expl_wall_list[ i ].segnum = - 1;	// Free slot

		}

	}

}
