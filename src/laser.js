// Ported from: descent-master/MAIN/LASER.C
// Laser/weapon creation, movement, and collision

import * as THREE from 'three';
import { GameTime, Segments } from './mglobal.js';
import { find_point_seg } from './gameseg.js';
import { find_vector_intersection, HIT_NONE, HIT_WALL } from './fvi.js';
import { Weapon_info, Vclips, N_weapon_types,
	WEAPON_RENDER_NONE, WEAPON_RENDER_LASER, WEAPON_RENDER_BLOB, WEAPON_RENDER_POLYMODEL, WEAPON_RENDER_VCLIP,
	LASER_ID, CONCUSSION_ID, VULCAN_ID, SPREADFIRE_ID, PLASMA_ID, FUSION_ID,
	Primary_weapon_to_weapon_info, Secondary_weapon_to_weapon_info } from './bm.js';
import { Polygon_models, buildModelMesh } from './polyobj.js';
import { phys_apply_force_to_player, phys_apply_rot } from './physics.js';

// Parent type constants
export const PARENT_PLAYER = 0;
export const PARENT_ROBOT = 1;

// Difficulty level (0=trainee, 4=insane)
let Difficulty_level = 1;

// Constants
const MAX_WEAPONS = 50;
const PLAYER_HIT_RADIUS = 3.0;

// Homing missile constants (from LASER.C / LASER.H)
const HOMING_MISSILE_STRAIGHT_TIME = 0.125;	// 1/8 second straight flight before tracking
const MIN_TRACKABLE_DOT = 0.75;				// Cone angle for target acquisition
const MAX_TRACKABLE_DIST = 250.0;			// Max tracking distance
const NUM_SMART_CHILDREN = 6;				// Children per smart bomb
const MAX_SMART_DISTANCE = 150.0;			// Smart bomb target search radius

// Weapon_info indices for special weapons
const WEAPON_SMART_INDEX = 17;				// Smart missile
const PLAYER_SMART_HOMING_ID = 19;		// Player smart homing child
const ROBOT_SMART_HOMING_ID = 29;		// Robot smart homing child
const WEAPON_MEGA_INDEX = 18;				// Mega missile
export const PROXIMITY_ID = 16;				// Proximity bomb (weapon_info index)
export const FLARE_ID = 9;					// Flare (weapon_info index)

// Proximity bomb constants
const PROXIMITY_ARM_TIME = 2.0;				// seconds before proximity bomb arms
const PROXIMITY_DETECT_RADIUS = 12.0;		// detection radius for proximity trigger

// Player weapon state
export let Primary_weapon = 0;		// 0=laser, 1=vulcan, 2=spreadfire, 3=plasma, 4=fusion
export let Secondary_weapon = 0;	// 0=concussion, 1=homing, 2=proximity, 3=smart, 4=mega
let Next_laser_fire_time = 0;
let Next_missile_fire_time = 0;
let Last_laser_fire_time = 0;		// Tracks last successful fire (for stale-time reset)
let _gameTime = 0;

// Ported from: WEAPON.H #define REARM_TIME (F1_0)
const REARM_TIME = 1.0;	// 1 second delay after switching weapons

// Spreadfire toggle: alternates between horizontal (0) and vertical (1) spread
// Ported from: LASER.C Spreadfire_toggle
let Spreadfire_toggle = 0;

// Weapon selection result codes
export const WEAPON_SELECT_CHANGED = 0;
export const WEAPON_SELECT_ALREADY = 1;
export const WEAPON_SELECT_UNAVAILABLE = - 1;

// Player weapon flags getter (set via laser_set_externals)
let _getPlayerPrimaryFlags = null;
let _getPlayerSecondaryAmmo = null;

// Ported from: select_weapon() in WEAPON.C lines 306-357
// Returns: WEAPON_SELECT_CHANGED, WEAPON_SELECT_ALREADY, or WEAPON_SELECT_UNAVAILABLE
export function set_primary_weapon( w, waitForRearm ) {

	if ( Primary_weapon === w ) return WEAPON_SELECT_ALREADY;

	// Check if player has this weapon
	if ( _getPlayerPrimaryFlags !== null ) {

		const flags = _getPlayerPrimaryFlags();
		if ( ( flags & ( 1 << w ) ) === 0 ) return WEAPON_SELECT_UNAVAILABLE;

	}

	if ( waitForRearm === true ) {

		Next_laser_fire_time = GameTime + REARM_TIME;

	}

	Primary_weapon = w;
	return WEAPON_SELECT_CHANGED;

}

// Ported from: select_weapon() in WEAPON.C lines 306-357
// Returns: WEAPON_SELECT_CHANGED, WEAPON_SELECT_ALREADY, or WEAPON_SELECT_UNAVAILABLE
export function set_secondary_weapon( w, waitForRearm ) {

	if ( Secondary_weapon === w ) return WEAPON_SELECT_ALREADY;

	// Check if player has ammo for this weapon
	if ( _getPlayerSecondaryAmmo !== null ) {

		const ammo = _getPlayerSecondaryAmmo( w );
		if ( ammo <= 0 ) return WEAPON_SELECT_UNAVAILABLE;

	}

	if ( waitForRearm === true ) {

		Next_missile_fire_time = GameTime + REARM_TIME;

	}

	Secondary_weapon = w;
	return WEAPON_SELECT_CHANGED;

}

// Weapon pool
const weapons = [];
let Weapon_next_signature = 0;


// PIG file and palette references (set via laser_set_externals)
let _pigFile = null;
let _palette = null;

// Texture cache: PIG bitmap index → THREE.DataTexture
const _weaponTextureCache = new Map();

// External references (set via laser_set_externals)
let _scene = null;
let _robots = null;
let _onRobotHit = null;
let _onPlayerHit = null;
let _onWallHit = null;
let _getPlayerPos = null;
let _getPlayerEnergy = null;
let _setPlayerEnergy = null;
let _getVulcanAmmo = null;
let _setVulcanAmmo = null;
let _getSecondaryAmmo = null;
let _setSecondaryAmmo = null;
let _onBadassExplosion = null;
let _onAutoSelectPrimary = null;
let _onAutoSelectSecondary = null;
let _onPlayerFiredLaser = null;	// ( weaponIndex, dir_x, dir_y, dir_z ) => void — notify AI of danger laser
let _getPlayerLaserLevel = null;
let _isPlayerCloaked = null;

// Pre-allocated working vectors (Golden Rule #5)
const _dirVec = new THREE.Vector3();
const _orientMatrix = new THREE.Matrix4();

// Pre-allocated result for ray-sphere intersection
const _sphereIntResult = { dist: 0, hit_x: 0, hit_y: 0, hit_z: 0 };

// Ray-sphere intersection test
// Ported from: check_vector_to_sphere_1() in FVI.C lines 664-724
// Tests line segment p0→p1 against sphere at sphere_pos with radius sphere_rad.
// Returns distance to intersection (>0 if hit), 0 if no hit.
// Hit point stored in _sphereIntResult.
function check_vector_to_sphere( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, sp_x, sp_y, sp_z, sphere_rad ) {

	// d = p1 - p0 (ray direction, unnormalized)
	const d_x = p1_x - p0_x;
	const d_y = p1_y - p0_y;
	const d_z = p1_z - p0_z;

	// w = sphere_pos - p0 (vector from ray origin to sphere center)
	const w_x = sp_x - p0_x;
	const w_y = sp_y - p0_y;
	const w_z = sp_z - p0_z;

	const mag_d = Math.sqrt( d_x * d_x + d_y * d_y + d_z * d_z );

	if ( mag_d < 0.0001 ) {

		// Zero-length segment: check if p0 is inside sphere
		const int_dist = Math.sqrt( w_x * w_x + w_y * w_y + w_z * w_z );
		_sphereIntResult.hit_x = p0_x;
		_sphereIntResult.hit_y = p0_y;
		_sphereIntResult.hit_z = p0_z;
		_sphereIntResult.dist = int_dist;
		return ( int_dist < sphere_rad ) ? int_dist : 0;

	}

	// Normalized ray direction
	const dn_x = d_x / mag_d;
	const dn_y = d_y / mag_d;
	const dn_z = d_z / mag_d;

	// Project w onto ray direction
	const w_dist = dn_x * w_x + dn_y * w_y + dn_z * w_z;

	if ( w_dist < 0 ) return 0;	// Moving away from sphere
	if ( w_dist > mag_d + sphere_rad ) return 0;	// Cannot reach sphere

	// Closest point on ray to sphere center
	const cp_x = p0_x + dn_x * w_dist;
	const cp_y = p0_y + dn_y * w_dist;
	const cp_z = p0_z + dn_z * w_dist;

	// Distance from closest point to sphere center
	const dx = cp_x - sp_x;
	const dy = cp_y - sp_y;
	const dz = cp_z - sp_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	if ( dist < sphere_rad ) {

		const dist2 = dist * dist;
		const rad2 = sphere_rad * sphere_rad;
		const shorten = Math.sqrt( rad2 - dist2 );

		const int_dist = w_dist - shorten;

		if ( int_dist > mag_d || int_dist < 0 ) {

			// Inside sphere — don't move
			_sphereIntResult.hit_x = p0_x;
			_sphereIntResult.hit_y = p0_y;
			_sphereIntResult.hit_z = p0_z;
			_sphereIntResult.dist = 1;
			return 1;

		}

		// Intersection point
		_sphereIntResult.hit_x = p0_x + dn_x * int_dist;
		_sphereIntResult.hit_y = p0_y + dn_y * int_dist;
		_sphereIntResult.hit_z = p0_z + dn_z * int_dist;
		_sphereIntResult.dist = int_dist;
		return int_dist;

	}

	return 0;

}

// Cached weapon model meshes (weapon_type → THREE.Group template)
const _weaponModelCache = new Map();

function get_random_laser_offset() {

	// Ported from: LASER.C line 1127
	// Laser_offset = ((F1_0*2)*(rand()%10))/10 -> 0.0,0.2,...,1.8
	return 2.0 * ( Math.floor( Math.random() * 10 ) / 10.0 );

}

// Build a DataTexture from a PIG bitmap index (cached)
// Ported from draw_object_blob() which calls g3_draw_bitmap()
function getWeaponTexture( bitmapIndex ) {

	if ( _weaponTextureCache.has( bitmapIndex ) ) {

		return _weaponTextureCache.get( bitmapIndex );

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

			// Transparent pixel
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

	_weaponTextureCache.set( bitmapIndex, texture );
	return texture;

}

// Build a weapon model mesh from POF data, with additive blending for glow
// Ported from: draw_polygon_object() for weapon rendering in OBJECT.C
function buildWeaponModelMesh( weapon_type ) {

	if ( _weaponModelCache.has( weapon_type ) ) {

		return _weaponModelCache.get( weapon_type ).clone();

	}

	if ( weapon_type >= N_weapon_types ) return null;

	const wi = Weapon_info[ weapon_type ];
	if ( wi.render_type !== WEAPON_RENDER_POLYMODEL ) return null;

	const model = Polygon_models[ wi.model_num ];
	if ( model === null || model === undefined ) return null;

	const group = buildModelMesh( model, _pigFile, _palette );
	if ( group === null ) return null;

	// Outer model: render opaque with original POF model colors
	// Ported from original Descent which rendered weapon polymodels as opaque flat-shaded polys.
	// The colors come from RGB 5-5-5 flat polys and textures in the POF model data.
	// We just ensure double-sided rendering — no additive blending needed for the outer model.
	group.traverse( ( child ) => {

		if ( child.isMesh === true ) {

			child.material = child.material.clone();
			child.material.side = THREE.DoubleSide;

		}

	} );

	// Inner model: additive blending for glowing core effect
	if ( wi.model_num_inner > 0 ) {

		const innerModel = Polygon_models[ wi.model_num_inner ];
		if ( innerModel !== null && innerModel !== undefined ) {

			const innerGroup = buildModelMesh( innerModel, _pigFile, _palette );
			if ( innerGroup !== null ) {

				innerGroup.traverse( ( child ) => {

					if ( child.isMesh === true ) {

						child.material = child.material.clone();
						child.material.blending = THREE.AdditiveBlending;
						child.material.transparent = true;
						child.material.depthWrite = false;
						child.material.side = THREE.DoubleSide;

					}

				} );

				group.add( innerGroup );

			}

		}

	}

	_weaponModelCache.set( weapon_type, group );
	return group.clone();

}

// Orient a weapon model mesh to face along a velocity vector
// Ported from: object orientation setup in PHYSICS.C
function orientWeaponModel( mesh, vel_x, vel_y, vel_z ) {

	const speed = Math.sqrt( vel_x * vel_x + vel_y * vel_y + vel_z * vel_z );
	if ( speed < 0.001 ) return;

	// Forward vector (Descent coords)
	const fwd_x = vel_x / speed;
	const fwd_y = vel_y / speed;
	const fwd_z = vel_z / speed;

	// Build right vector via cross product with world up (0,1,0)
	// right = up × forward
	let rx = - fwd_z;		// 1 * fwd_z - 0 * fwd_y → but cross(up, fwd) = (0*fz - 1*fz, ...) → no
	let ry = 0;
	let rz = fwd_x;		// cross(0,1,0 × fx,fy,fz) = (1*fz - 0*fy, 0*fx - 0*fz, 0*fy - 1*fx)
	// Actually: cross(Y, F) = (Yy*Fz - Yz*Fy, Yz*Fx - Yx*Fz, Yx*Fy - Yy*Fx)
	// = (1*fz - 0*fy, 0*fx - 0*fz, 0*fy - 1*fx) = (fz, 0, -fx)
	rx = fwd_z;
	ry = 0;
	rz = - fwd_x;

	let rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );

	if ( rmag < 0.001 ) {

		// Forward is parallel to up — use X as alternate up
		rx = 0;
		ry = - fwd_z;
		rz = fwd_y;
		rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );

	}

	if ( rmag > 0.001 ) {

		rx /= rmag;
		ry /= rmag;
		rz /= rmag;

	}

	// Up = forward × right
	const ux = fwd_y * rz - fwd_z * ry;
	const uy = fwd_z * rx - fwd_x * rz;
	const uz = fwd_x * ry - fwd_y * rx;

	// Build orientation matrix (Descent → Three.js coordinate conversion)
	// Columns: rvec, uvec, -fvec (negate fvec Z for Descent→Three.js)
	_orientMatrix.set(
		rx, ux, - fwd_x, 0,
		ry, uy, - fwd_y, 0,
		- rz, - uz, fwd_z, 0,
		0, 0, 0, 1
	);

	mesh.quaternion.setFromRotationMatrix( _orientMatrix );

}

// Fallback colors for weapons without bitmaps (keyed by weapon_type)
function getFallbackColor( weapon_type, parent_type ) {

	if ( parent_type === PARENT_ROBOT ) return 0x00ff44;
	if ( weapon_type === 12 || weapon_type === 20 ) return 0xffff00;	// spreadfire
	if ( weapon_type === 13 ) return 0x0088ff;	// plasma
	if ( weapon_type === 14 ) return 0xff00ff;	// fusion
	if ( weapon_type === 8 ) return 0xff8800;	// concussion
	if ( weapon_type === 15 || weapon_type === PLAYER_SMART_HOMING_ID || weapon_type === ROBOT_SMART_HOMING_ID ) return 0xff6600;	// homing
	if ( weapon_type === WEAPON_SMART_INDEX || weapon_type === WEAPON_MEGA_INDEX ) return 0xff00ff;	// smart/mega
	if ( weapon_type === FLARE_ID ) return 0xffffaa;	// flare (bright yellow-white)
	return 0xff4400;	// laser

}

class WeaponObj {

	constructor() {

		this.active = false;
		this.parent_type = PARENT_PLAYER;
		this.weapon_type = 0;	// weapon_info index

		// Position in Descent coordinates
		this.pos_x = 0;
		this.pos_y = 0;
		this.pos_z = 0;

		// Velocity in Descent coordinates
		this.vel_x = 0;
		this.vel_y = 0;
		this.vel_z = 0;

		this.segnum = 0;
		this.lifeleft = 0;
		this.damage = 5.0;
		this.signature = 0;

		// Thrust vector (Descent coordinates) — for thrust-based weapons
		this.thrust_x = 0;
		this.thrust_y = 0;
		this.thrust_z = 0;
		this.mass = 1.0;
		this.drag = 0;
		this.max_speed = 0;		// speed cap for thrust weapons

		// Homing tracking
		this.track_goal = - 1;		// target index in _robots (-1 = none)
		this.creation_time = 0;		// GameTime when created
		this.track_revalidate = 0;	// frames until next target re-validation (every 4 frames)

		// Persistent weapon tracking (fusion passes through targets)
		// Ported from: LASER.C obj->ctype.laser_info.last_hitobj
		this.last_hitobj = - 1;

		// Proximity bomb state (stuck to wall after first wall hit)
		// Ported from: LASER.C / PHYSICS.C proximity bomb handling
		this.stuck = false;
		this.stuck_wallnum = - 1;	// wall_num this weapon is stuck to (for kill_stuck_objects)

		// Bounce grace period for smart homing children
		// Ported from: LASER.C lines 278-281 — PF_BOUNCE set at creation,
		// cleared at HOMING_MISSILE_STRAIGHT_TIME (0.125s)
		this.bounce_grace = false;

		// Three.js mesh reference (sprite for blob/laser/vclip weapons)
		this.mesh = null;

		// Three.js model mesh (Group for polymodel weapons)
		this.modelMesh = null;

	}

}

// Get weapon properties with fallback defaults
function getWeaponSpeed( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].speed[ Difficulty_level ];

	}

	return 80.0;

}

function getWeaponDamage( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].strength[ Difficulty_level ];

	}

	return 5.0;

}

function getWeaponLifetime( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].lifetime;

	}

	return 12.0;

}

function getWeaponFireWait( weapon_type ) {

	if ( weapon_type < N_weapon_types ) {

		return Weapon_info[ weapon_type ].fire_wait;

	}

	return 0.25;

}

// Set external references
export function laser_set_externals( ext ) {

	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;
	if ( ext.scene !== undefined ) _scene = ext.scene;
	if ( ext.robots !== undefined ) _robots = ext.robots;
	if ( ext.onRobotHit !== undefined ) _onRobotHit = ext.onRobotHit;
	if ( ext.onPlayerHit !== undefined ) _onPlayerHit = ext.onPlayerHit;
	if ( ext.onWallHit !== undefined ) _onWallHit = ext.onWallHit;
	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.getPlayerEnergy !== undefined ) _getPlayerEnergy = ext.getPlayerEnergy;
	if ( ext.setPlayerEnergy !== undefined ) _setPlayerEnergy = ext.setPlayerEnergy;
	if ( ext.getVulcanAmmo !== undefined ) _getVulcanAmmo = ext.getVulcanAmmo;
	if ( ext.setVulcanAmmo !== undefined ) _setVulcanAmmo = ext.setVulcanAmmo;
	if ( ext.getSecondaryAmmo !== undefined ) _getSecondaryAmmo = ext.getSecondaryAmmo;
	if ( ext.setSecondaryAmmo !== undefined ) _setSecondaryAmmo = ext.setSecondaryAmmo;
	if ( ext.onBadassExplosion !== undefined ) _onBadassExplosion = ext.onBadassExplosion;
	if ( ext.onAutoSelectPrimary !== undefined ) _onAutoSelectPrimary = ext.onAutoSelectPrimary;
	if ( ext.onAutoSelectSecondary !== undefined ) _onAutoSelectSecondary = ext.onAutoSelectSecondary;
	if ( ext.onPlayerFiredLaser !== undefined ) _onPlayerFiredLaser = ext.onPlayerFiredLaser;
	if ( ext.getPlayerPrimaryFlags !== undefined ) _getPlayerPrimaryFlags = ext.getPlayerPrimaryFlags;
	if ( ext.getPlayerSecondaryAmmo !== undefined ) _getPlayerSecondaryAmmo = ext.getPlayerSecondaryAmmo;
	if ( ext.getPlayerLaserLevel !== undefined ) _getPlayerLaserLevel = ext.getPlayerLaserLevel;
	if ( ext.isPlayerCloaked !== undefined ) _isPlayerCloaked = ext.isPlayerCloaked;

}

// Get weapon object by pool index for danger_laser checking
// Returns null if index invalid or weapon inactive
// Ported from: Objects[danger_laser_num] access in AI.C line 1619
export function laser_get_weapon( idx ) {

	if ( idx < 0 || idx >= MAX_WEAPONS ) return null;
	const w = weapons[ idx ];
	if ( w.active !== true ) return null;
	return w;

}

// Initialize weapon pool with pre-built sprites
export function laser_init() {

	Weapon_next_signature = 0;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = new WeaponObj();

		// Each weapon gets its own SpriteMaterial (needed for per-weapon texture/opacity)
		const material = new THREE.SpriteMaterial( {
			transparent: true,
			blending: THREE.AdditiveBlending,
			depthWrite: false
		} );

		w.mesh = new THREE.Sprite( material );
		w.mesh.visible = false;

		weapons.push( w );

	}

}

// Configure weapon visual for a weapon type
// Ported from: draw_object_blob() and draw_weapon_vclip() in OBJECT.C / VCLIP.C
function configureWeaponVisual( w, weapon_type, parent_type ) {

	// Check if this is a polymodel weapon (lasers, missiles)
	if ( weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];

		if ( wi.render_type === WEAPON_RENDER_POLYMODEL && _pigFile !== null ) {

			// Build 3D model mesh
			const modelMesh = buildWeaponModelMesh( weapon_type );
			if ( modelMesh !== null ) {

				w.modelMesh = modelMesh;
				w.mesh.visible = false;	// hide sprite
				return;

			}

		}

	}

	// Fall through to sprite rendering for blob/laser/vclip/fallback
	configureWeaponSprite( w, weapon_type, parent_type );

}

// Configure sprite material and scale for a weapon type
// Ported from: draw_object_blob() and draw_weapon_vclip() in OBJECT.C / VCLIP.C
function configureWeaponSprite( w, weapon_type, parent_type ) {

	const mat = w.mesh.material;
	let texture = null;
	let blobSize = 2.0; // default diameter in world units

	if ( weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];

		if ( ( wi.render_type === WEAPON_RENDER_BLOB || wi.render_type === WEAPON_RENDER_LASER ) && wi.bitmap !== - 1 ) {

			// Blob/laser weapon: use single bitmap
			texture = getWeaponTexture( wi.bitmap );

		} else if ( wi.render_type === WEAPON_RENDER_VCLIP && wi.weapon_vclip >= 0 ) {

			// VClip weapon: use first frame of animation
			const vc = Vclips[ wi.weapon_vclip ];
			if ( vc !== undefined && vc.num_frames > 0 ) {

				texture = getWeaponTexture( vc.frames[ 0 ] );

			}

		}

		// Use blob_size from Weapon_info (already float from fixed-point conversion)
		if ( wi.blob_size > 0 ) {

			blobSize = wi.blob_size * 2.0; // blob_size is radius, sprite needs diameter

		}

	}

	if ( texture !== null ) {

		mat.map = texture;
		mat.color.set( 0xffffff );

		// Aspect-ratio correction from draw_object_blob():
		// if wider than tall, scale height down; if taller than wide, scale width down
		const bm_w = texture.image.width;
		const bm_h = texture.image.height;

		if ( bm_w > bm_h ) {

			w.mesh.scale.set( blobSize, blobSize * ( bm_h / bm_w ), 1 );

		} else {

			w.mesh.scale.set( blobSize * ( bm_w / bm_h ), blobSize, 1 );

		}

	} else {

		// Fallback: colored sprite without texture
		mat.map = null;
		mat.color.set( getFallbackColor( weapon_type, parent_type ) );
		w.mesh.scale.set( blobSize, blobSize, 1 );

	}

	mat.needsUpdate = true;

}

// Get light color for a weapon type
// Find best homing target for a weapon
// Ported from: find_homing_object() in LASER.C lines 540-599
// Returns: robot index (>=0), TRACK_PLAYER (-2) for player target, or -1 for no target
const TRACK_PLAYER = - 2;

function find_homing_object( w ) {

	// Robot-fired weapons track the player (not other robots)
	// Ported from: LASER.C lines 560-563 — "Not in network mode. If not fired by player, then track player."
	// In C: if (parent_num != player) { if (!cloaked) best_objnum = ConsoleObject - Objects; }
	if ( w.parent_type !== PARENT_PLAYER ) {

		// Don't track cloaked player
		if ( _isPlayerCloaked !== null && _isPlayerCloaked() === true ) return - 1;

		// Verify player is within tracking cone and distance
		if ( _getPlayerPos === null ) return - 1;
		const pp = _getPlayerPos();

		const speed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
		if ( speed < 0.001 ) return - 1;

		const fwd_x = w.vel_x / speed;
		const fwd_y = w.vel_y / speed;
		const fwd_z = w.vel_z / speed;

		const dx = pp.x - w.pos_x;
		const dy = pp.y - w.pos_y;
		const dz = pp.z - w.pos_z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist > MAX_TRACKABLE_DIST || dist < 0.001 ) return - 1;

		const nx = dx / dist;
		const ny = dy / dist;
		const nz = dz / dist;
		const dot = fwd_x * nx + fwd_y * ny + fwd_z * nz;

		if ( dot > MIN_TRACKABLE_DOT ) return TRACK_PLAYER;
		return - 1;

	}

	// Player-fired weapons track robots
	if ( _robots === null ) return - 1;

	// Get weapon forward direction from velocity
	const speed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
	if ( speed < 0.001 ) return - 1;

	const fwd_x = w.vel_x / speed;
	const fwd_y = w.vel_y / speed;
	const fwd_z = w.vel_z / speed;

	let bestDot = MIN_TRACKABLE_DOT;
	let bestIndex = - 1;

	for ( let r = 0; r < _robots.length; r ++ ) {

		const robot = _robots[ r ];
		if ( robot.alive !== true ) continue;

		// Vector from weapon to robot
		const dx = robot.obj.pos_x - w.pos_x;
		const dy = robot.obj.pos_y - w.pos_y;
		const dz = robot.obj.pos_z - w.pos_z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist > MAX_TRACKABLE_DIST ) continue;
		if ( dist < 0.001 ) continue;

		// Normalized direction to target
		const nx = dx / dist;
		const ny = dy / dist;
		const nz = dz / dist;

		// Dot product with weapon forward direction
		const dot = fwd_x * nx + fwd_y * ny + fwd_z * nz;

		if ( dot > bestDot ) {

			// LOS check: don't track through walls
			// Ported from: find_homing_object_complete() in LASER.C — object_to_object_visibility()
			const losResult = find_vector_intersection(
				w.pos_x, w.pos_y, w.pos_z,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
				w.segnum, 0.0,
				- 1, 0
			);

			if ( losResult.hit_type === HIT_WALL ) continue;

			bestDot = dot;
			bestIndex = r;

		}

	}

	return bestIndex;

}

// Create smart bomb children when a smart missile explodes
// Ported from: create_smart_children() in LASER.C
function create_smart_children( w ) {

	if ( _robots === null ) return;

	// Find visible targets within MAX_SMART_DISTANCE
	// Robot blobs can't track robots (LASER.C line 1301-1304)
	const targets = [];

	if ( w.parent_type !== PARENT_ROBOT ) {

		// Player-fired smart: target robots
		for ( let r = 0; r < _robots.length; r ++ ) {

			const robot = _robots[ r ];
			if ( robot.alive !== true ) continue;

			const dx = robot.obj.pos_x - w.pos_x;
			const dy = robot.obj.pos_y - w.pos_y;
			const dz = robot.obj.pos_z - w.pos_z;
			const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

			if ( dist < MAX_SMART_DISTANCE ) {

				targets.push( { index: r, dist: dist } );

			}

		}

	}

	// Create NUM_SMART_CHILDREN homing children
	for ( let i = 0; i < NUM_SMART_CHILDREN; i ++ ) {

		let dir_x, dir_y, dir_z;

		if ( targets.length > 0 ) {

			// Pick random target
			const t = targets[ Math.floor( Math.random() * targets.length ) ];
			const robot = _robots[ t.index ];

			dir_x = robot.obj.pos_x - w.pos_x;
			dir_y = robot.obj.pos_y - w.pos_y;
			dir_z = robot.obj.pos_z - w.pos_z;
			const dist = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );

			if ( dist > 0.001 ) {

				dir_x /= dist;
				dir_y /= dist;
				dir_z /= dist;

			}

			// Add 25% random noise (from original: vm_vec_scale_add2(&vec, &rand, F1_0/4))
			dir_x += ( Math.random() - 0.5 ) * 0.5;
			dir_y += ( Math.random() - 0.5 ) * 0.5;
			dir_z += ( Math.random() - 0.5 ) * 0.5;

			const mag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
			if ( mag > 0.001 ) {

				dir_x /= mag;
				dir_y /= mag;
				dir_z /= mag;

			}

		} else {

			// No targets: random direction
			dir_x = Math.random() - 0.5;
			dir_y = Math.random() - 0.5;
			dir_z = Math.random() - 0.5;
			const mag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
			if ( mag > 0.001 ) {

				dir_x /= mag;
				dir_y /= mag;
				dir_z /= mag;

			}

		}

		const homingType = ( w.parent_type === PARENT_ROBOT ) ? ROBOT_SMART_HOMING_ID : PLAYER_SMART_HOMING_ID;

		const childIdx = Laser_create_new(
			dir_x, dir_y, dir_z,
			w.pos_x, w.pos_y, w.pos_z,
			w.segnum, w.parent_type, homingType
		);

		// Set initial tracking target
		if ( childIdx !== - 1 && targets.length > 0 ) {

			weapons[ childIdx ].track_goal = targets[ Math.floor( Math.random() * targets.length ) ].index;

		}

	}

}

// Handle special weapon effects on impact (smart children, area damage)
function handleWeaponExplosion( w ) {

	// Smart missile: spawn 6 homing children
	if ( w.weapon_type === WEAPON_SMART_INDEX ) {

		create_smart_children( w );

	}

	// Badass (area) damage for weapons with damage_radius
	if ( w.weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ w.weapon_type ];
		if ( wi.damage_radius > 0 && _onBadassExplosion !== null ) {

			_onBadassExplosion( w.pos_x, w.pos_y, w.pos_z, w.damage, wi.damage_radius );

		}

	}

}

// Create a new weapon bolt
// weapon_type: index into Weapon_info[] array
// damage_multiplier: optional multiplier for damage (fusion charge)
export function Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, parent_type, weapon_type, damage_multiplier, laser_offset_override ) {

	if ( _scene === null ) return - 1;

	if ( parent_type === undefined ) parent_type = PARENT_PLAYER;
	if ( weapon_type === undefined ) weapon_type = 0;
	if ( damage_multiplier === undefined ) damage_multiplier = 1.0;

	let speed = getWeaponSpeed( weapon_type );
	const damage = getWeaponDamage( weapon_type ) * damage_multiplier;
	const lifetime = getWeaponLifetime( weapon_type );

	// Get thrust/drag/mass from Weapon_info
	// Ported from: Laser_create_new() in LASER.C lines 382-400
	let weapon_thrust = 0;
	let weapon_drag = 0;
	let weapon_mass = 1.0;

	if ( weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];
		weapon_thrust = wi.thrust;
		weapon_drag = wi.drag;
		weapon_mass = wi.mass > 0 ? wi.mass : 1.0;

	}

	// Thrust-based weapons start at half speed (they accelerate up to max)
	// Ported from: LASER.C line 388-389
	const max_speed = speed;
	if ( weapon_thrust > 0 ) {

		speed = speed / 2;

		// Smart homing children start at 1/4 speed (not 1/2)
		// Ported from: LASER.C create_smart_children() speed adjustment
		if ( weapon_type === PLAYER_SMART_HOMING_ID || weapon_type === ROBOT_SMART_HOMING_ID ) {

			speed = max_speed / 4;

		}

	}

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active === true ) continue;

		w.active = true;
		w.parent_type = parent_type;
		w.weapon_type = weapon_type;
		w.pos_x = pos_x;
		w.pos_y = pos_y;
		w.pos_z = pos_z;
		w.vel_x = dir_x * speed;
		w.vel_y = dir_y * speed;
		w.vel_z = dir_z * speed;
		w.segnum = segnum;
		w.lifeleft = lifetime;
		w.damage = damage;
		w.signature = Weapon_next_signature ++;
		w.creation_time = _gameTime;
		w.track_goal = - 1;
		w.last_hitobj = - 1;
		w.stuck = false;
		w.stuck_wallnum = - 1;

		// Smart homing children get bounce grace to avoid instant wall collision
		// Ported from: LASER.C lines 278-281 — PF_BOUNCE set on smart homing children
		w.bounce_grace = ( weapon_type === PLAYER_SMART_HOMING_ID || weapon_type === ROBOT_SMART_HOMING_ID );

		// Set thrust properties
		// Ported from: LASER.C lines 397-400
		// thrust = velocity * (weapon_thrust / weapon_speed)
		w.drag = weapon_drag;
		w.mass = weapon_mass;
		w.max_speed = max_speed;

		if ( weapon_thrust > 0 && speed > 0.001 ) {

			const thrustScale = weapon_thrust / speed;
			w.thrust_x = w.vel_x * thrustScale;
			w.thrust_y = w.vel_y * thrustScale;
			w.thrust_z = w.vel_z * thrustScale;

		} else {

			w.thrust_x = 0;
			w.thrust_y = 0;
			w.thrust_z = 0;

		}

		// Set initial homing target for homing weapons
		if ( weapon_type < N_weapon_types && Weapon_info[ weapon_type ].homing_flag !== 0 ) {

			w.track_goal = find_homing_object( w );

		}

		// Configure visual (sprite or 3D model) based on weapon type
		configureWeaponVisual( w, weapon_type, parent_type );

		// Move bolt forward so its tail (not center) is at the gun barrel.
		// Ported from LASER.C lines 348-371: "fire the laser from the gun tip
		// so that the back end of the laser bolt is at the gun tip."
		// offset = Laser_offset (random jitter) + laser_length / 2
		if ( w.modelMesh !== null ) {

			// Ported from LASER.C lines 286 and 360:
			// laser_length = Polygon_models[model_num].rad * 2, then add laser_length/2.
			let laserHalfLength = 0;
			if ( weapon_type < N_weapon_types ) {

				const wi = Weapon_info[ weapon_type ];
				if ( wi !== undefined && wi.model_num >= 0 && wi.model_num < Polygon_models.length ) {

					const model = Polygon_models[ wi.model_num ];
					if ( model !== null && model !== undefined && model.rad > 0 ) {

						laserHalfLength = model.rad;

					}

				}

			}

			let laserOffset = laser_offset_override;
			if ( laserOffset === undefined ) {

				laserOffset = get_random_laser_offset();

			}

			const totalOffset = laserHalfLength + laserOffset;

			// Push position forward along fire direction (Descent coords)
			pos_x += dir_x * totalOffset;
			pos_y += dir_y * totalOffset;
			pos_z += dir_z * totalOffset;

			// Verify the new position is still in a valid segment
			const newSeg = find_point_seg( pos_x, pos_y, pos_z, segnum );
			if ( newSeg !== - 1 ) {

				w.pos_x = pos_x;
				w.pos_y = pos_y;
				w.pos_z = pos_z;
				w.segnum = newSeg;

			}

			// Polymodel weapon: position and orient the 3D model
			w.modelMesh.position.set( w.pos_x, w.pos_y, - w.pos_z );
			orientWeaponModel( w.modelMesh, w.vel_x, w.vel_y, w.vel_z );
			w.modelMesh.visible = true;
			_scene.add( w.modelMesh );

		} else {

			// Sprite weapon
			w.mesh.visible = true;
			w.mesh.position.set( pos_x, pos_y, - pos_z );
			_scene.add( w.mesh );

		}

		return i;

	}

	return - 1;

}

// Fire player primary weapon
// Returns true if weapon was fired
export function Laser_player_fire( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, gameTime, damage_multiplier, laser_offset_override ) {

	_gameTime = gameTime;

	// Reset fire timer if stale (e.g., after automap or long pause)
	// Ported from: LASER.C Laser_player_fire_spread_delay() stale-time check
	if ( Last_laser_fire_time + 0.1 < gameTime ) {

		Next_laser_fire_time = gameTime;

	}

	// Check fire rate
	if ( gameTime < Next_laser_fire_time ) return false;

	// Laser level 0-3 maps directly to weapon_info indices 0-3
	// Ported from: LASER.C Laser_player_fire() — laser_level IS the weapon_type
	let weapon_info_index = Primary_weapon_to_weapon_info[ Primary_weapon ];
	if ( Primary_weapon === 0 && _getPlayerLaserLevel !== null ) {

		weapon_info_index = _getPlayerLaserLevel();

	}

	const fire_wait = getWeaponFireWait( weapon_info_index );

	// Vulcan uses ammo instead of energy
	if ( Primary_weapon === 1 ) {

		if ( _getVulcanAmmo !== null ) {

			const ammo = _getVulcanAmmo();
			if ( ammo <= 0 ) {

				// Auto-select a different weapon
				if ( _onAutoSelectPrimary !== null ) _onAutoSelectPrimary();
				return false;

			}

			_setVulcanAmmo( ammo - 1 );

		}

	} else {

		// All other primary weapons use energy
		if ( _getPlayerEnergy !== null && _setPlayerEnergy !== null ) {

			const energy = _getPlayerEnergy();
			let energyCost = 0;

			if ( weapon_info_index < N_weapon_types ) {

				energyCost = Weapon_info[ weapon_info_index ].energy_usage;

			}

			// Default cost if not specified
			if ( energyCost <= 0 ) energyCost = 1.0;

			// Lower difficulty = cheaper energy cost
			// Ported from: do_laser_firing_player() in LASER.C line 1058
			// Trainee(0): 50%, Hotshot(1): 75%, Ace+(2+): 100%
			if ( Difficulty_level < 2 ) {

				energyCost = energyCost * ( Difficulty_level + 2 ) / 4;

			}

			if ( energy < energyCost ) {

				// Auto-select a different weapon
				if ( _onAutoSelectPrimary !== null ) _onAutoSelectPrimary();
				return false;

			}

			_setPlayerEnergy( energy - energyCost );

		}

	}

	Next_laser_fire_time = gameTime + fire_wait;
	Last_laser_fire_time = gameTime;

	// Spreadfire: 3 bolts in a spread pattern with alternating horizontal/vertical
	// Ported from: LASER.C Laser_player_fire_spread() using Spreadfire_toggle
	if ( Primary_weapon === 2 ) {

		// Center bolt
		const centerIdx = Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, 1.0, laser_offset_override );

		// Notify AI of danger laser for robot evasion
		// Ported from: Player_fired_laser_this_frame in LASER.C line 822
		if ( centerIdx !== - 1 && _onPlayerFiredLaser !== null ) {

			_onPlayerFiredLaser( centerIdx, dir_x, dir_y, dir_z );

		}

		// Compute right and up vectors for spread
		// Ported from: LASER.C Laser_player_fire_spread() — F1_0/16 = 0.0625
		const spread = 0.0625;
		let sx, sy, sz;

		if ( Spreadfire_toggle === 0 ) {

			// Horizontal spread: use right vector
			// Cross dir with world up (0,1,0) to get right
			// cross(dir, up) = (dy*0 - dz*1, dz*0 - dx*0, dx*1 - dy*0) = (-dz, 0, dx)
			// Actually cross(up, dir) = (1*dz - 0*dy, 0*dx - 0*dz, 0*dy - 1*dx) = (dz, 0, -dx)
			sx = dir_z;
			sy = 0;
			sz = - dir_x;

			if ( Math.abs( dir_y ) > 0.9 ) {

				// Dir is near vertical, use X as alternate
				sx = 0;
				sy = - dir_z;
				sz = dir_y;

			}

		} else {

			// Vertical spread: use up vector
			// up = cross(dir, right), where right = cross(up_world, dir)
			let rx = dir_z, ry = 0, rz = - dir_x;

			if ( Math.abs( dir_y ) > 0.9 ) {

				rx = 0; ry = - dir_z; rz = dir_y;

			}

			const rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );
			if ( rmag > 0.001 ) { rx /= rmag; ry /= rmag; rz /= rmag; }

			// up = forward × right
			sx = dir_y * rz - dir_z * ry;
			sy = dir_z * rx - dir_x * rz;
			sz = dir_x * ry - dir_y * rx;

		}

		const smag = Math.sqrt( sx * sx + sy * sy + sz * sz );
		if ( smag > 0.001 ) {

			sx /= smag; sy /= smag; sz /= smag;

		}

		Spreadfire_toggle = 1 - Spreadfire_toggle;

		// Right/up spread bolt
		Laser_create_new(
			dir_x + sx * spread, dir_y + sy * spread, dir_z + sz * spread,
			pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, 1.0, laser_offset_override
		);

		// Left/down spread bolt
		Laser_create_new(
			dir_x - sx * spread, dir_y - sy * spread, dir_z - sz * spread,
			pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, 1.0, laser_offset_override
		);

		return true;

	}

	// Vulcan cannon: add random spread to direction
	// Ported from: LASER.C lines 1146-1150 — rand()/8 - 32767/16 spread per axis
	if ( Primary_weapon === 1 ) {

		const spread = 0.03;	// ~1.7 degrees angular spread
		dir_x += ( Math.random() - 0.5 ) * spread;
		dir_y += ( Math.random() - 0.5 ) * spread;
		dir_z += ( Math.random() - 0.5 ) * spread;

		// Re-normalize
		const dmag = Math.sqrt( dir_x * dir_x + dir_y * dir_y + dir_z * dir_z );
		if ( dmag > 0.001 ) { dir_x /= dmag; dir_y /= dmag; dir_z /= dmag; }

	}

	// Normal single bolt
	const boltIdx = Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index, damage_multiplier, laser_offset_override );

	// Notify AI of danger laser for robot evasion
	// Ported from: Player_fired_laser_this_frame in LASER.C line 822
	if ( boltIdx !== - 1 && _onPlayerFiredLaser !== null ) {

		_onPlayerFiredLaser( boltIdx, dir_x, dir_y, dir_z );

	}

	return true;

}

// Get the weapon_info index for the player's current laser level
// Used by game.js for dual/quad fire and fire sound lookup
export function get_player_laser_weapon_info_index() {

	if ( Primary_weapon === 0 && _getPlayerLaserLevel !== null ) {

		return _getPlayerLaserLevel();

	}

	return Primary_weapon_to_weapon_info[ Primary_weapon ];

}

// Fire player secondary weapon (missiles)
export function Laser_player_fire_secondary( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, gameTime ) {

	_gameTime = gameTime;

	if ( gameTime < Next_missile_fire_time ) return false;

	// Check secondary ammo
	if ( _getSecondaryAmmo !== null && _setSecondaryAmmo !== null ) {

		const ammo = _getSecondaryAmmo( Secondary_weapon );
		if ( ammo <= 0 ) {

			// Auto-select a different secondary weapon
			if ( _onAutoSelectSecondary !== null ) _onAutoSelectSecondary();
			return false;

		}

		_setSecondaryAmmo( Secondary_weapon, ammo - 1 );

	}

	const weapon_info_index = Secondary_weapon_to_weapon_info[ Secondary_weapon ];
	const fire_wait = getWeaponFireWait( weapon_info_index );

	Next_missile_fire_time = gameTime + fire_wait;

	const missileIdx = Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, weapon_info_index );

	// Mega missile recoil: push player backward with random tumble
	// Ported from: do_laser_firing_player() in LASER.C lines 1421-1438
	// Linear: -forward * 128 (fvec << 7), Rotation: -forward * 8 + random(-0.25,+0.25)
	if ( Secondary_weapon === 4 ) {

		phys_apply_force_to_player( - dir_x * 128.0, - dir_y * 128.0, - dir_z * 128.0 );
		phys_apply_rot(
			- dir_x * 8.0 + ( Math.random() - 0.5 ) * 0.5,
			- dir_y * 8.0 + ( Math.random() - 0.5 ) * 0.5,
			- dir_z * 8.0 + ( Math.random() - 0.5 ) * 0.5
		);

	}

	// Notify AI of danger laser for robot evasion
	if ( missileIdx !== - 1 && _onPlayerFiredLaser !== null ) {

		_onPlayerFiredLaser( missileIdx, dir_x, dir_y, dir_z );

	}

	return true;

}

// Fire a flare (F key)
// Ported from: Flare_create() in LASER.C lines 857-887
export function Flare_create( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum ) {

	if ( _getPlayerEnergy === null || _setPlayerEnergy === null ) return false;

	const wi = Weapon_info[ FLARE_ID ];
	const energyCost = ( wi !== undefined && wi.energy_usage > 0 ) ? wi.energy_usage : 1.0;

	const energy = _getPlayerEnergy();
	if ( energy <= 0 ) return false;

	_setPlayerEnergy( Math.max( 0, energy - energyCost ) );

	Laser_create_new( dir_x, dir_y, dir_z, pos_x, pos_y, pos_z, segnum, PARENT_PLAYER, FLARE_ID );
	return true;

}

// Remove a weapon from the scene
function kill_weapon( w ) {

	w.active = false;
	w.mesh.visible = false;

	if ( _scene !== null ) {

		if ( w.modelMesh !== null ) {

			w.modelMesh.visible = false;
			_scene.remove( w.modelMesh );
			w.modelMesh = null;

		} else {

			_scene.remove( w.mesh );

		}

	}

}

// Update all active weapons: move, check collisions, expire
// Ported from: Laser_do_weapon_sequence() in LASER.C
export function laser_do_weapon_sequence( dt ) {

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;

		// Lifetime check
		w.lifeleft -= dt;
		if ( w.lifeleft <= 0 ) {

			// Proximity bombs explode when they expire (flares just disappear)
			if ( w.stuck === true && w.weapon_type === PROXIMITY_ID ) {

				handleWeaponExplosion( w );
				if ( _onWallHit !== null ) {

					_onWallHit( w.pos_x, w.pos_y, w.pos_z, w.segnum, - 1, w.damage, w.weapon_type );

				}

			}

			kill_weapon( w );
			continue;

		}

		// --- Proximity bomb detection when stuck to wall ---
		// Ported from: LASER.C / COLLIDE.C proximity bomb behavior
		// After arming (2s), detonate when any robot comes within detect radius
		// Before arming, only direct collision detonates
		// (Flares stuck to walls are passive — no proximity detection)
		if ( w.stuck === true && w.weapon_type === PROXIMITY_ID ) {

			const age = _gameTime - w.creation_time;

			if ( age >= PROXIMITY_ARM_TIME ) {

				// Check robots
				let triggered = false;

				if ( _robots !== null ) {

					for ( let r = 0; r < _robots.length; r ++ ) {

						const robot = _robots[ r ];
						if ( robot.alive !== true ) continue;

						const dx = robot.obj.pos_x - w.pos_x;
						const dy = robot.obj.pos_y - w.pos_y;
						const dz = robot.obj.pos_z - w.pos_z;
						const distSq = dx * dx + dy * dy + dz * dz;

						if ( distSq < PROXIMITY_DETECT_RADIUS * PROXIMITY_DETECT_RADIUS ) {

							triggered = true;
							break;

						}

					}

				}

				// Check player (proximity can hurt the player after arming)
				// Ported from: laser_are_related() — proximity >= 2s old are NOT related to parent
				if ( triggered !== true && _getPlayerPos !== null ) {

					const pp = _getPlayerPos();
					const dx = pp.x - w.pos_x;
					const dy = pp.y - w.pos_y;
					const dz = pp.z - w.pos_z;
					const distSq = dx * dx + dy * dy + dz * dz;

					if ( distSq < PROXIMITY_DETECT_RADIUS * PROXIMITY_DETECT_RADIUS ) {

						triggered = true;

					}

				}

				if ( triggered === true ) {

					handleWeaponExplosion( w );
					if ( _onWallHit !== null ) {

						_onWallHit( w.pos_x, w.pos_y, w.pos_z, w.segnum, - 1, w.damage, w.weapon_type );

					}

					kill_weapon( w );
					continue;

				}

			}

			// Stuck bombs don't move — skip the rest of the movement/collision logic
			continue;

		}

		// --- Homing tracking (update velocity before movement) ---
		if ( w.weapon_type < N_weapon_types ) {

			const wi = Weapon_info[ w.weapon_type ];
			if ( wi.homing_flag !== 0 ) {

				// Only track after straight flight period
				if ( _gameTime - w.creation_time > HOMING_MISSILE_STRAIGHT_TIME ) {

					// Smart homing children: clear bounce grace when tracking starts
					// Ported from: LASER.C lines 950-953
					if ( w.bounce_grace === true ) {

						w.bounce_grace = false;

					}

					// Validate current target
					// track_goal: -1 = no target, TRACK_PLAYER (-2) = player, >=0 = robot index
					if ( w.track_goal >= 0 ) {

						if ( _robots === null || w.track_goal >= _robots.length || _robots[ w.track_goal ].alive !== true ) {

							w.track_goal = - 1;

						}

					}

					// Re-validate / search for new target every 4 frames
					// Ported from: LASER.C line 943 — (d_tick_count & 3) gate
					if ( w.track_goal === - 1 || w.track_revalidate <= 0 ) {

						w.track_goal = find_homing_object( w );
						w.track_revalidate = 4;

					}

					w.track_revalidate --;

					// Resolve target position
					// track_goal: TRACK_PLAYER (-2) = player, >=0 = robot index
					let hasTarget = false;
					let tgt_x = 0, tgt_y = 0, tgt_z = 0;

					if ( w.track_goal === TRACK_PLAYER && _getPlayerPos !== null ) {

						const pp = _getPlayerPos();
						tgt_x = pp.x;
						tgt_y = pp.y;
						tgt_z = pp.z;
						hasTarget = true;

					} else if ( w.track_goal >= 0 && _robots !== null && w.track_goal < _robots.length ) {

						const target = _robots[ w.track_goal ];
						if ( target.alive === true ) {

							tgt_x = target.obj.pos_x;
							tgt_y = target.obj.pos_y;
							tgt_z = target.obj.pos_z;
							hasTarget = true;

						} else {

							w.track_goal = - 1;

						}

					}

					// Blend velocity toward target
					if ( hasTarget === true ) {

						const speed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
						if ( speed > 0.001 ) {

							// Current direction (normalized)
							const cur_x = w.vel_x / speed;
							const cur_y = w.vel_y / speed;
							const cur_z = w.vel_z / speed;

							// Direction to target
							let tx = tgt_x - w.pos_x;
							let ty = tgt_y - w.pos_y;
							let tz = tgt_z - w.pos_z;
							const tdist = Math.sqrt( tx * tx + ty * ty + tz * tz );

							if ( tdist > 0.001 ) {

								tx /= tdist;
								ty /= tdist;
								tz /= tdist;

								// Blend: newDir = normalize(currentDir + targetDir)
								// Ported from LASER.C: vm_vec_add2(&temp_vec, &vector_to_object)
								let nx = cur_x + tx;
								let ny = cur_y + ty;
								let nz = cur_z + tz;

								// Non-polymodel weapons (smart children) add target dir twice
								// for harder tracking. Ported from LASER.C line 968-969.
								if ( wi.render_type !== WEAPON_RENDER_POLYMODEL ) {

									nx += tx;
									ny += ty;
									nz += tz;

								}

								const nmag = Math.sqrt( nx * nx + ny * ny + nz * nz );

								if ( nmag > 0.001 ) {

									nx /= nmag;
									ny /= nmag;
									nz /= nmag;

									// Subtract off life proportional to amount turned.
									// Ported from LASER.C lines 989-1003
									const newDot = cur_x * nx + cur_y * ny + cur_z * nz;
									let absdot = Math.abs( 1.0 - newDot );

									if ( absdot > 0.125 ) {

										if ( absdot > 0.25 ) absdot = 0.25;
										const lifelost = absdot * 16 * dt;
										w.lifeleft -= lifelost;

									}

									w.vel_x = nx * speed;
									w.vel_y = ny * speed;
									w.vel_z = nz * speed;

									// Update thrust direction to match new velocity
									if ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) {

										const thrustMag = Math.sqrt( w.thrust_x * w.thrust_x + w.thrust_y * w.thrust_y + w.thrust_z * w.thrust_z );
										w.thrust_x = nx * thrustMag;
										w.thrust_y = ny * thrustMag;
										w.thrust_z = nz * thrustMag;

									}

								}

							}

						}

					}

				}

			}

		}

		// --- Apply thrust and drag to velocity ---
		// Ported from: do_physics_sim() in PHYSICS.C lines 641-680
		if ( w.drag > 0 ) {

			if ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) {

				// Thrust-based: acceleration = thrust / mass, then apply drag
				const invMass = 1.0 / w.mass;
				w.vel_x += w.thrust_x * invMass * dt;
				w.vel_y += w.thrust_y * invMass * dt;
				w.vel_z += w.thrust_z * invMass * dt;

			}

			// Apply drag: velocity *= (1.0 - drag) per frame
			const dragFactor = Math.pow( 1.0 - w.drag, dt );
			w.vel_x *= dragFactor;
			w.vel_y *= dragFactor;
			w.vel_z *= dragFactor;

		}

		// Homing speed acceleration: if below max_speed, accelerate toward it
		// Ported from: LASER.C lines 974-977
		if ( w.weapon_type < N_weapon_types && Weapon_info[ w.weapon_type ].homing_flag !== 0 && w.max_speed > 0 ) {

			const curSpeed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
			if ( curSpeed > 0.001 && curSpeed + 1.0 < w.max_speed ) {

				const newSpeed = curSpeed + w.max_speed * dt / 2;
				const accelScale = newSpeed / curSpeed;
				w.vel_x *= accelScale;
				w.vel_y *= accelScale;
				w.vel_z *= accelScale;

			}

		}

		// Clamp speed for thrust-based weapons
		// Ported from: LASER.C lines 1014-1025
		if ( w.max_speed > 0 && ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) ) {

			const curSpeed = Math.sqrt( w.vel_x * w.vel_x + w.vel_y * w.vel_y + w.vel_z * w.vel_z );
			if ( curSpeed > w.max_speed ) {

				const scale = w.max_speed / curSpeed;
				w.vel_x *= scale;
				w.vel_y *= scale;
				w.vel_z *= scale;

			}

		}

		// --- Compute new position using FVI ray cast ---
		// Ported from: Laser_do_weapon_sequence() in LASER.C — ray-sphere collision
		const new_x = w.pos_x + w.vel_x * dt;
		const new_y = w.pos_y + w.vel_y * dt;
		const new_z = w.pos_z + w.vel_z * dt;

		// FVI ray cast from old position to new position (radius 0 for projectiles)
		const fvi_result = find_vector_intersection(
			w.pos_x, w.pos_y, w.pos_z,
			new_x, new_y, new_z,
			w.segnum, 0.0,
			- 1, 0
		);

		// Compute wall hit distance (used to compare against object hits)
		let wallHitDist = Infinity;

		if ( fvi_result.hit_type === HIT_WALL ) {

			const wdx = fvi_result.hit_pnt_x - w.pos_x;
			const wdy = fvi_result.hit_pnt_y - w.pos_y;
			const wdz = fvi_result.hit_pnt_z - w.pos_z;
			wallHitDist = Math.sqrt( wdx * wdx + wdy * wdy + wdz * wdz );

		}

		// Fallback: if FVI returned HIT_NONE but find_point_seg fails, treat as wall hit at endpoint
		let newSeg = w.segnum;
		if ( fvi_result.hit_type !== HIT_WALL ) {

			newSeg = ( fvi_result.hit_seg !== - 1 ) ? fvi_result.hit_seg : find_point_seg( new_x, new_y, new_z, w.segnum );

			if ( newSeg === - 1 ) {

				// Outside mine — treat as wall hit at current position
				wallHitDist = 0;
				newSeg = w.segnum;

			}

		} else {

			// Wall hit — use FVI result segment
			if ( fvi_result.hit_seg !== - 1 ) newSeg = fvi_result.hit_seg;

		}

		// --- Ray-sphere object collision ---
		// Ported from: check_vector_to_sphere_1() in FVI.C
		// Test the full p0→p1 ray segment against each potential target sphere.
		// Track closest object hit and compare against wall hit distance.
		let closestObjDist = Infinity;
		let closestObjIndex = - 1;	// robot index or -2 for player
		let closestHit_x = 0, closestHit_y = 0, closestHit_z = 0;

		// Player weapons check against robots
		if ( w.parent_type === PARENT_PLAYER && _robots !== null ) {

			for ( let r = 0; r < _robots.length; r ++ ) {

				const robot = _robots[ r ];
				if ( robot.alive !== true ) continue;
				if ( robot.morphing === true ) continue;

				// Skip persistent weapon re-hitting same target
				if ( w.last_hitobj === r ) continue;

				const hitRadius = robot.obj.size + 0.5;
				const hitDist = check_vector_to_sphere(
					w.pos_x, w.pos_y, w.pos_z,
					new_x, new_y, new_z,
					robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
					hitRadius
				);

				if ( hitDist > 0 && hitDist < closestObjDist ) {

					closestObjDist = hitDist;
					closestObjIndex = r;
					closestHit_x = _sphereIntResult.hit_x;
					closestHit_y = _sphereIntResult.hit_y;
					closestHit_z = _sphereIntResult.hit_z;

				}

			}

		}

		// Robot weapons check against player
		// Skip persistent weapon re-hitting player (last_hitobj == -2)
		// Ported from: LASER.C last_hitobj tracking for persistent weapons
		if ( w.parent_type === PARENT_ROBOT && _getPlayerPos !== null && w.last_hitobj !== - 2 ) {

			const pp = _getPlayerPos();
			const hitDist = check_vector_to_sphere(
				w.pos_x, w.pos_y, w.pos_z,
				new_x, new_y, new_z,
				pp.x, pp.y, pp.z,
				PLAYER_HIT_RADIUS
			);

			if ( hitDist > 0 && hitDist < closestObjDist ) {

				closestObjDist = hitDist;
				closestObjIndex = - 2;	// special: player hit
				closestHit_x = _sphereIntResult.hit_x;
				closestHit_y = _sphereIntResult.hit_y;
				closestHit_z = _sphereIntResult.hit_z;

			}

		}

		// Determine what was hit first: wall or object
		let hitSomething = false;

		if ( closestObjDist < wallHitDist && closestObjIndex !== - 1 ) {

			// Object hit is closer than wall

			// Check if weapon is persistent (e.g., fusion cannon)
			// Ported from: LASER.C — persistent weapons pass through targets
			const isPersistent = ( w.weapon_type < N_weapon_types && Weapon_info[ w.weapon_type ].persistent !== 0 );

			if ( closestObjIndex === - 2 ) {

				// Hit player — track for persistent weapons
				// Ported from: LASER.C last_hitobj = player object num
				w.last_hitobj = - 2;

				if ( _onPlayerHit !== null ) {

					_onPlayerHit( w.damage, closestHit_x, closestHit_y, closestHit_z );

				}

				if ( isPersistent !== true ) {

					handleWeaponExplosion( w );
					kill_weapon( w );
					hitSomething = true;

				}

			} else {

				// Hit robot
				w.last_hitobj = closestObjIndex;

				handleWeaponExplosion( w );

				if ( _onRobotHit !== null ) {

					_onRobotHit( closestObjIndex, w.damage, w.weapon_type, w.vel_x, w.vel_y, w.vel_z );

				}

				if ( isPersistent !== true ) {

					kill_weapon( w );
					hitSomething = true;

				}

			}

		} else if ( wallHitDist < Infinity ) {

			// Wall hit (or outside mine)
			if ( fvi_result.hit_type === HIT_WALL ) {

				w.pos_x = fvi_result.hit_pnt_x;
				w.pos_y = fvi_result.hit_pnt_y;
				w.pos_z = fvi_result.hit_pnt_z;
				if ( fvi_result.hit_seg !== - 1 ) w.segnum = fvi_result.hit_seg;

			}

			// Proximity bombs and flares stick to walls instead of exploding
			// Ported from: PHYSICS.C line 754 — PF_STICK flag handling
			if ( w.weapon_type === PROXIMITY_ID || w.weapon_type === FLARE_ID ) {

				w.stuck = true;

				// Store wall_num for kill_stuck_objects()
				// Ported from: add_stuck_object() in WALL.C line 989-996
				if ( fvi_result.hit_side_seg >= 0 && fvi_result.hit_side >= 0 ) {

					const hitSeg = Segments[ fvi_result.hit_side_seg ];
					if ( hitSeg !== undefined ) {

						w.stuck_wallnum = hitSeg.sides[ fvi_result.hit_side ].wall_num;

					}

				}
				w.vel_x = 0;
				w.vel_y = 0;
				w.vel_z = 0;
				w.thrust_x = 0;
				w.thrust_y = 0;
				w.thrust_z = 0;

				// Update mesh position to wall contact point
				if ( w.modelMesh !== null ) {

					w.modelMesh.position.set( w.pos_x, w.pos_y, - w.pos_z );

				} else {

					w.mesh.position.set( w.pos_x, w.pos_y, - w.pos_z );

				}

				hitSomething = true;

			} else {

				// Check if weapon has bounce flag — reflect off walls instead of exploding
				// Ported from: PHYSICS.C lines 940-946 — PF_BOUNCE velocity reflection
				// Also: smart homing children get temporary bounce grace (LASER.C lines 278-281)
				const wiBounce = ( w.bounce_grace === true ) ? 1
					: ( w.weapon_type < N_weapon_types ) ? Weapon_info[ w.weapon_type ].bounce : 0;

				if ( wiBounce !== 0 && fvi_result.hit_type === HIT_WALL ) {

					// Reflect velocity: v -= 2 * (v . n) * n
					const nx = fvi_result.hit_wallnorm_x;
					const ny = fvi_result.hit_wallnorm_y;
					const nz = fvi_result.hit_wallnorm_z;
					const dot = w.vel_x * nx + w.vel_y * ny + w.vel_z * nz;

					if ( dot < 0 ) {

						w.vel_x -= 2.0 * dot * nx;
						w.vel_y -= 2.0 * dot * ny;
						w.vel_z -= 2.0 * dot * nz;

					}

					// Also reflect thrust direction
					if ( w.thrust_x !== 0 || w.thrust_y !== 0 || w.thrust_z !== 0 ) {

						const tdot = w.thrust_x * nx + w.thrust_y * ny + w.thrust_z * nz;
						if ( tdot < 0 ) {

							w.thrust_x -= 2.0 * tdot * nx;
							w.thrust_y -= 2.0 * tdot * ny;
							w.thrust_z -= 2.0 * tdot * nz;

						}

					}

					hitSomething = true;

				} else {

					handleWeaponExplosion( w );

					if ( _onWallHit !== null ) {

						// Use hit_side_seg/hit_side from FVI for precise blastable wall detection
						const wallSeg = ( fvi_result.hit_side_seg !== - 1 ) ? fvi_result.hit_side_seg : w.segnum;
						_onWallHit( w.pos_x, w.pos_y, w.pos_z, wallSeg, fvi_result.hit_side, w.damage, w.weapon_type );

					}

					kill_weapon( w );
					hitSomething = true;

				}

			}

		}

		if ( hitSomething === true ) continue;

		// Update position
		w.pos_x = new_x;
		w.pos_y = new_y;
		w.pos_z = new_z;
		w.segnum = newSeg;

		// Update mesh and light position
		if ( w.modelMesh !== null ) {

			w.modelMesh.position.set( new_x, new_y, - new_z );
			orientWeaponModel( w.modelMesh, w.vel_x, w.vel_y, w.vel_z );

		} else {

			w.mesh.position.set( new_x, new_y, - new_z );

		}

		// Animate vclip weapons (swap sprite texture per frame)
		// Ported from: draw_weapon_vclip() in VCLIP.C
		if ( w.weapon_type < N_weapon_types ) {

			const wi = Weapon_info[ w.weapon_type ];
			if ( wi.render_type === WEAPON_RENDER_VCLIP && wi.weapon_vclip >= 0 ) {

				const vc = Vclips[ wi.weapon_vclip ];
				if ( vc !== undefined && vc.num_frames > 1 && vc.play_time > 0 ) {

					// modtime = lifeleft % play_time (loop animation)
					let modtime = w.lifeleft;
					while ( modtime > vc.play_time ) modtime -= vc.play_time;

					// Calculate frame index
					let frame = Math.floor( ( vc.num_frames * ( vc.play_time - modtime ) ) / vc.play_time );
					if ( frame >= vc.num_frames ) frame = vc.num_frames - 1;
					if ( frame < 0 ) frame = 0;

					const tex = getWeaponTexture( vc.frames[ frame ] );
					if ( tex !== null ) {

						w.mesh.material.map = tex;
						w.mesh.material.needsUpdate = true;

					}

				}

			}

		}

	}

}

// Get distance of nearest homing weapon targeting the player
// Ported from: LASER.C lines 958-963 (homing_object_dist update in laser_do_weapon_sequence)
// Returns distance in Descent units, or -1 if no homing weapon is tracking the player
export function laser_get_homing_object_dist() {

	if ( _getPlayerPos === null ) return - 1;

	const pp = _getPlayerPos();
	let minDist = - 1;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.parent_type !== PARENT_ROBOT ) continue;

		// Check if this is a homing weapon
		if ( w.weapon_type >= N_weapon_types ) continue;
		if ( Weapon_info[ w.weapon_type ].homing_flag === 0 ) continue;

		// Compute distance to player
		const dx = w.pos_x - pp.x;
		const dy = w.pos_y - pp.y;
		const dz = w.pos_z - pp.z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( minDist < 0 || dist < minDist ) {

			minDist = dist;

		}

	}

	return minDist;

}

// Get active weapons array for dynamic lighting
// Used by lighting.js to compute light from active weapon bolts
export function laser_get_active_weapons() {

	return weapons;

}

// Return pre-allocated array of stuck flare positions for dynamic lighting
// Ported from: set_dynamic_light() flare handling in LIGHTING.C lines 313-314
// Used by lighting.js to add flickering PointLights for stuck flares
const _stuckFlareData = [];
let _stuckFlareCount = 0;

for ( let i = 0; i < 8; i ++ ) {

	_stuckFlareData.push( { pos_x: 0, pos_y: 0, pos_z: 0, idx: 0, lifeleft: 0 } );

}

export function laser_get_stuck_flares() {

	_stuckFlareCount = 0;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		if ( _stuckFlareCount >= 8 ) break;

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.stuck !== true ) continue;
		if ( w.weapon_type !== FLARE_ID ) continue;

		const f = _stuckFlareData[ _stuckFlareCount ];
		f.pos_x = w.pos_x;
		f.pos_y = w.pos_y;
		f.pos_z = w.pos_z;
		f.idx = i;
		f.lifeleft = w.lifeleft;
		_stuckFlareCount ++;

	}

	return { data: _stuckFlareData, count: _stuckFlareCount };

}

// Kill any weapons stuck to the given wall (called when doors open or walls blast)
// Ported from: kill_stuck_objects() in WALL.C lines 1028-1048
export function laser_kill_stuck_on_wall( wallnum ) {

	if ( wallnum === - 1 ) return;

	for ( let i = 0; i < MAX_WEAPONS; i ++ ) {

		const w = weapons[ i ];
		if ( w.active !== true ) continue;
		if ( w.stuck !== true ) continue;
		if ( w.stuck_wallnum !== wallnum ) continue;

		// Set short lifespan so weapon disappears quickly (0.25s like original)
		w.lifeleft = 0.25;
		w.stuck_wallnum = - 1;

	}

}
