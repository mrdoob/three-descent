// Ported from: descent-master/MAIN/PHYSICS.C
// Player physics simulation: linear and rotational sub-stepping with drag

import { find_point_seg } from './gameseg.js';
import { find_vector_intersection, HIT_NONE, HIT_WALL, HIT_BAD_P0 } from './fvi.js';
import { wall_hit_process as fvi_wall_hit_process } from './wall.js';
import { check_trigger as fvi_check_trigger } from './switch.js';
import { GameTime } from './mglobal.js';

// --- Player ship physics constants (ported from bitmaps.bin $PLAYER_SHIP) ---
export const PLAYER_MASS = 4.0;
export const PLAYER_DRAG = 0.033;
export const PLAYER_MAX_THRUST = 7.8;
export const PLAYER_MAX_ROTTHRUST = 0.14;
export const PLAYER_WIGGLE = 0.5;
export const PHYSICS_FT = 1.0 / 64.0;	// Sub-step time (F1_0/64)
export const PLAYER_RADIUS = 2.5;	// Collision radius in Descent units

// Wall-hit damage constants (from COLLIDE.C lines 650-652)
const DAMAGE_SCALE = 128.0;
const DAMAGE_THRESHOLD = 1.0 / 3.0;	// F1_0/3
const WALL_LOUDNESS_SCALE = 20.0;

// Callback for wall-hit damage — injected by gameseq.js
let _onPlayerWallHit = null;

export function physics_set_wall_hit_callback( fn ) {

	_onPlayerWallHit = fn;

}

// Turn banking constants (converted from fixed-point to float)
// Ported from: PHYSICS.C lines 269-272
// TURNROLL_SCALE = (0x4ec4/2) in fixang, converts to ~0.154 in our float system
// ROLL_RATE = 0x2000 fixang/sec = 0.785 rad/s (~45°/sec max interpolation rate)
const TURNROLL_SCALE = 0.154;
const ROLL_RATE = 0.785;

// Auto-level constants (from PHYSICS.C do_physics_align_object)
// DAMP_ANG = 0x400 fixang = 0x400/65536 radians ≈ 0.0156 radians (~0.9°)
const DAMP_ANG = 0.0156;

// Player velocity in Descent coordinates (persistent across frames)
const playerVelocity = { x: 0, y: 0, z: 0 };
// Player rotational velocity (pitch, heading, bank) in radians/sec
const playerRotVel = { x: 0, y: 0, z: 0 };
// Turn banking angle (visual bank during yaw rotation)
let turnroll = 0;

export function getPlayerVelocity() { return playerVelocity; }
export function getTurnroll() { return turnroll; }

// Compute turn banking angle from yaw rotational velocity
// Ported from: set_object_turnroll() in PHYSICS.C lines 404-426
// Smoothly interpolates current turnroll toward desired bank at ROLL_RATE
export function set_object_turnroll( dt ) {

	const desired_bank = playerRotVel.y * TURNROLL_SCALE;

	if ( turnroll !== desired_bank ) {

		let max_roll = ROLL_RATE * dt;
		const delta_ang = desired_bank - turnroll;

		if ( Math.abs( delta_ang ) < max_roll ) {

			max_roll = delta_ang;

		} else if ( delta_ang < 0 ) {

			max_roll = - max_roll;

		}

		turnroll += max_roll;

	}

}

// Auto-level the player ship: gradually rotate toward "upright" orientation
// Ported from: do_physics_align_object() in PHYSICS.C lines 312-402
// The original finds the segment side whose normal is most aligned with the player's
// up vector, then gradually banks the ship toward that normal. For our Three.js port,
// we use world-up (0,1,0) as the desired up vector (equivalent to floor_levelling mode
// in the original) and compute roll correction in Descent coordinates.
//
// camera = THREE.PerspectiveCamera (has .quaternion for orientation)
// dt = frame delta time in seconds
//
// Pre-allocated working vectors (Golden Rule #5)
const _alignForward = { x: 0, y: 0, z: 0 };
const _alignUp = { x: 0, y: 0, z: 0 };

export function do_physics_align_object( camera, dt ) {

	if ( camera === null ) return;

	// Extract camera forward vector in Descent coordinates (negate Z)
	// camera forward in Three.js is (0,0,-1) rotated by quaternion
	const q = camera.quaternion;
	// Optimized quaternion rotation of (0,0,-1):
	// Three.js forward (0,0,-1) → Descent forward (negate z) = (0,0,1) in Descent
	// Actually: get Three.js forward then convert
	const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

	// Rotate (0,0,-1) by quaternion: result = q * (0,0,-1) * q^-1
	// Derived from standard quaternion rotation matrix: R*v where v=(0,0,-1) = -column3(R)
	const fx_three = - 2.0 * ( qx * qz + qw * qy );
	const fy_three = 2.0 * ( qw * qx - qy * qz );
	const fz_three = - ( 1.0 - 2.0 * ( qx * qx + qy * qy ) );

	// Convert to Descent coords (negate Z)
	_alignForward.x = fx_three;
	_alignForward.y = fy_three;
	_alignForward.z = - fz_three;

	// Rotate (0,1,0) by quaternion: column2 of standard quaternion rotation matrix
	const ux_three = 2.0 * ( qx * qy - qw * qz );
	const uy_three = 1.0 - 2.0 * ( qx * qx + qz * qz );
	const uz_three = 2.0 * ( qy * qz + qw * qx );

	// Convert to Descent coords (negate Z)
	_alignUp.x = ux_three;
	_alignUp.y = uy_three;
	_alignUp.z = - uz_three;

	// Desired up vector: world Y-up (0, 1, 0)
	const desired_x = 0;
	const desired_y = 1;
	const desired_z = 0;

	// Check that desired up is not nearly parallel to forward
	// (dot product of desired_up and forward should be < 0.5)
	// Ported from: PHYSICS.C line 375 — labs(vm_vec_dot(&desired_upvec,&obj->orient.fvec)) < f1_0/2
	const fwdDotDesired = Math.abs(
		_alignForward.x * desired_x + _alignForward.y * desired_y + _alignForward.z * desired_z
	);

	if ( fwdDotDesired >= 0.5 ) return;	// Ship pointing nearly straight up/down — can't auto-level

	// Project desired up onto the plane perpendicular to forward
	// projected = desired - (desired . forward) * forward
	const dot_df = desired_x * _alignForward.x + desired_y * _alignForward.y + desired_z * _alignForward.z;
	let proj_x = desired_x - dot_df * _alignForward.x;
	let proj_y = desired_y - dot_df * _alignForward.y;
	let proj_z = desired_z - dot_df * _alignForward.z;

	// Normalize projected desired up
	const proj_mag = Math.sqrt( proj_x * proj_x + proj_y * proj_y + proj_z * proj_z );
	if ( proj_mag < 0.001 ) return;
	proj_x /= proj_mag;
	proj_y /= proj_mag;
	proj_z /= proj_mag;

	// Also project current up onto the plane perpendicular to forward
	const dot_uf = _alignUp.x * _alignForward.x + _alignUp.y * _alignForward.y + _alignUp.z * _alignForward.z;
	let cur_x = _alignUp.x - dot_uf * _alignForward.x;
	let cur_y = _alignUp.y - dot_uf * _alignForward.y;
	let cur_z = _alignUp.z - dot_uf * _alignForward.z;

	const cur_mag = Math.sqrt( cur_x * cur_x + cur_y * cur_y + cur_z * cur_z );
	if ( cur_mag < 0.001 ) return;
	cur_x /= cur_mag;
	cur_y /= cur_mag;
	cur_z /= cur_mag;

	// Compute angle between projected current up and projected desired up
	// Using cross product magnitude for signed angle around forward axis
	let dot_cp = cur_x * proj_x + cur_y * proj_y + cur_z * proj_z;
	if ( dot_cp > 1.0 ) dot_cp = 1.0;
	if ( dot_cp < - 1.0 ) dot_cp = - 1.0;

	// Cross product cur × proj, dotted with forward gives signed angle direction
	const cross_x = cur_y * proj_z - cur_z * proj_y;
	const cross_y = cur_z * proj_x - cur_x * proj_z;
	const cross_z = cur_x * proj_y - cur_y * proj_x;
	const cross_dot_fwd = cross_x * _alignForward.x + cross_y * _alignForward.y + cross_z * _alignForward.z;

	const delta_ang = Math.atan2( cross_dot_fwd, dot_cp );

	// Include turnroll in the delta (ported from PHYSICS.C line 383)
	const total_delta = delta_ang + turnroll;

	// Only correct if above damping threshold
	// Ported from: PHYSICS.C line 385 — if (abs(delta_ang) > DAMP_ANG)
	if ( Math.abs( total_delta ) <= DAMP_ANG ) return;

	// Limit rotation rate to ROLL_RATE * dt
	// Ported from: PHYSICS.C lines 388-391
	let roll_ang = ROLL_RATE * dt;

	if ( Math.abs( total_delta ) < roll_ang ) {

		roll_ang = total_delta;

	} else if ( total_delta < 0 ) {

		roll_ang = - roll_ang;

	}

	// Apply bank correction around forward axis (Three.js Z axis in camera space)
	// In Three.js camera space, Z-rotation is bank/roll
	// The sign is inverted because Three.js Z points toward viewer (opposite to Descent forward)
	camera.rotateZ( roll_ang );

}

// Reset player physics state (velocity + rotational velocity)
// Called on respawn, restart, and level transitions
export function physics_reset() {

	playerVelocity.x = 0;
	playerVelocity.y = 0;
	playerVelocity.z = 0;
	playerRotVel.x = 0;
	playerRotVel.y = 0;
	playerRotVel.z = 0;
	turnroll = 0;

}

// Apply an instantaneous force to an object, changing its velocity
// Ported from: phys_apply_force() in PHYSICS.C lines 1163-1173
// obj must have mtype.mass and aiLocal.vel_x/vel_y/vel_z (for robots)
// or playerVelocity (for player)
export function phys_apply_force( obj, force_x, force_y, force_z ) {

	// For player object — modify playerVelocity directly
	if ( obj === null ) {

		// Null = player object (special case, since player doesn't use Objects[])
		if ( PLAYER_MASS > 0 ) {

			const invMass = 1.0 / PLAYER_MASS;
			playerVelocity.x += force_x * invMass;
			playerVelocity.y += force_y * invMass;
			playerVelocity.z += force_z * invMass;

		}

		return;

	}

	// For objects with physics info (robots, etc.)
	// Robot mass comes from mtype.mass (if available) or a default
	const mass = ( obj.mtype != null && obj.mtype.mass > 0 ) ? obj.mtype.mass : 4.0;
	const invMass = 1.0 / mass;

	// Robots store velocity in aiLocal, not mtype.phys_info
	if ( obj.aiLocal !== undefined && obj.aiLocal !== null ) {

		obj.aiLocal.vel_x += force_x * invMass;
		obj.aiLocal.vel_y += force_y * invMass;
		obj.aiLocal.vel_z += force_z * invMass;

	} else if ( obj.mtype !== null ) {

		obj.mtype.velocity_x += force_x * invMass;
		obj.mtype.velocity_y += force_y * invMass;
		obj.mtype.velocity_z += force_z * invMass;

	}

}

// Apply force to player specifically (convenience wrapper)
export function phys_apply_force_to_player( force_x, force_y, force_z ) {

	phys_apply_force( null, force_x, force_y, force_z );

}

// Apply rotational force to player (makes camera spin on impacts)
// Ported from: phys_apply_rot() in PHYSICS.C lines 1239-1267
// Force direction causes rotation proportional to force magnitude / mass
export function phys_apply_rot( force_x, force_y, force_z ) {

	if ( PLAYER_MASS <= 0 ) return;

	const invMass = 1.0 / PLAYER_MASS;
	playerRotVel.x += force_x * invMass;
	playerRotVel.y += force_y * invMass;
	playerRotVel.z += force_z * invMass;

}

// Rotational physics sub-stepping
// Ported from: do_physics_sim_rot() in PHYSICS.C
// rotThrust = { x, y, z } rotational thrust input
// dt = frame time
export function do_physics_sim_rot( rotThrust_x, rotThrust_y, rotThrust_z, dt ) {

	const rotDrag = PLAYER_DRAG * 2.5;

	const rotAccel_x = rotThrust_x / PLAYER_MASS;
	const rotAccel_y = rotThrust_y / PLAYER_MASS;
	const rotAccel_z = rotThrust_z / PLAYER_MASS;

	let count = Math.floor( dt / PHYSICS_FT );
	const r = dt - count * PHYSICS_FT;
	const k = r / PHYSICS_FT;

	// Full sub-steps
	while ( count > 0 ) {

		playerRotVel.x += rotAccel_x;
		playerRotVel.y += rotAccel_y;
		playerRotVel.z += rotAccel_z;

		const scale = 1.0 - rotDrag;
		playerRotVel.x *= scale;
		playerRotVel.y *= scale;
		playerRotVel.z *= scale;

		count --;

	}

	// Remaining fraction
	playerRotVel.x += rotAccel_x * k;
	playerRotVel.y += rotAccel_y * k;
	playerRotVel.z += rotAccel_z * k;

	const kScale = 1.0 - k * rotDrag;
	playerRotVel.x *= kScale;
	playerRotVel.y *= kScale;
	playerRotVel.z *= kScale;

	return playerRotVel;

}

// Linear physics sub-stepping
// Ported from: do_physics_sim() in PHYSICS.C
// thrust = { x, y, z } linear thrust from controls
// up_dx/dy/dz = camera up vector in Descent coords (for wiggle)
// dt = frame time
// Returns frame displacement { x, y, z }
//
// Pre-allocated result object (Golden Rule #5)
const _frameResult = { x: 0, y: 0, z: 0 };

export function do_physics_sim( thrust_x, thrust_y, thrust_z, up_dx, up_dy, up_dz, dt ) {

	// Ship wiggle: sinusoidal vertical bobbing (ported from read_flying_controls PF_WIGGLE)
	const swiggle = Math.sin( GameTime * 2.0 * Math.PI );
	playerVelocity.x += up_dx * swiggle * PLAYER_WIGGLE;
	playerVelocity.y += up_dy * swiggle * PLAYER_WIGGLE;
	playerVelocity.z += up_dz * swiggle * PLAYER_WIGGLE;

	// Apply drag + thrust to velocity
	const accel_x = thrust_x / PLAYER_MASS;
	const accel_y = thrust_y / PLAYER_MASS;
	const accel_z = thrust_z / PLAYER_MASS;

	let count = Math.floor( dt / PHYSICS_FT );
	const r = dt - count * PHYSICS_FT;
	const k = r / PHYSICS_FT;

	// Full sub-steps
	while ( count > 0 ) {

		playerVelocity.x += accel_x;
		playerVelocity.y += accel_y;
		playerVelocity.z += accel_z;

		const scale = 1.0 - PLAYER_DRAG;
		playerVelocity.x *= scale;
		playerVelocity.y *= scale;
		playerVelocity.z *= scale;

		count --;

	}

	// Remaining fraction
	playerVelocity.x += accel_x * k;
	playerVelocity.y += accel_y * k;
	playerVelocity.z += accel_z * k;

	const kScale = 1.0 - k * PLAYER_DRAG;
	playerVelocity.x *= kScale;
	playerVelocity.y *= kScale;
	playerVelocity.z *= kScale;

	// Compute frame movement
	_frameResult.x = playerVelocity.x * dt;
	_frameResult.y = playerVelocity.y * dt;
	_frameResult.z = playerVelocity.z * dt;

	return _frameResult;

}

// Apply movement with FVI-based collision detection and wall sliding
// Ported from: PHYSICS.C do_physics_sim() — iterative wall-sliding loop
// p0 = start position (Descent coords), frame = movement delta
// playerSegnum = current segment
// Returns { x, y, z, segnum } — new position and segment
//
// Pre-allocated result object (Golden Rule #5)
const _moveResult = { x: 0, y: 0, z: 0, segnum: 0 };

export function do_physics_move( p0_x, p0_y, p0_z, frame_x, frame_y, frame_z, playerSegnum, dt ) {

	if ( frame_x === 0 && frame_y === 0 && frame_z === 0 ) {

		_moveResult.x = p0_x;
		_moveResult.y = p0_y;
		_moveResult.z = p0_z;
		_moveResult.segnum = playerSegnum;
		return _moveResult;

	}

	let p1_x = p0_x + frame_x;
	let p1_y = p0_y + frame_y;
	let p1_z = p0_z + frame_z;

	let curSeg = playerSegnum;
	const MAX_FVI_ITERS = 4;

	for ( let iter = 0; iter < MAX_FVI_ITERS; iter ++ ) {

		const hit = find_vector_intersection(
			p0_x, p0_y, p0_z,
			p1_x, p1_y, p1_z,
			curSeg, PLAYER_RADIUS,
			- 1, 0
		);

		if ( hit.hit_type === HIT_NONE ) {

			// Moved unobstructed
			p0_x = hit.hit_pnt_x;
			p0_y = hit.hit_pnt_y;
			p0_z = hit.hit_pnt_z;

			if ( hit.hit_seg !== - 1 ) curSeg = hit.hit_seg;
			break;

		} else if ( hit.hit_type === HIT_WALL ) {

			// Move to hit point
			p0_x = hit.hit_pnt_x;
			p0_y = hit.hit_pnt_y;
			p0_z = hit.hit_pnt_z;

			if ( hit.hit_seg !== - 1 ) curSeg = hit.hit_seg;

			// Process wall hit (triggers, doors)
			if ( hit.hit_side_seg !== - 1 && hit.hit_side !== - 1 ) {

				fvi_wall_hit_process( hit.hit_side_seg, hit.hit_side );
				fvi_check_trigger( hit.hit_side_seg, hit.hit_side );

			}

			// Wall sliding: remove velocity component along wall normal
			const nx = hit.hit_wallnorm_x;
			const ny = hit.hit_wallnorm_y;
			const nz = hit.hit_wallnorm_z;
			const wall_part = playerVelocity.x * nx + playerVelocity.y * ny + playerVelocity.z * nz;

			// Player wall-hit damage
			// Ported from: collide_player_and_wall() in COLLIDE.C lines 654-693
			if ( _onPlayerWallHit !== null && wall_part < 0 ) {

				const hitspeed = - wall_part;	// magnitude of velocity into wall
				const damage = hitspeed / DAMAGE_SCALE;

				if ( damage >= DAMAGE_THRESHOLD ) {

					const volume = Math.min( ( hitspeed - DAMAGE_SCALE * DAMAGE_THRESHOLD ) / WALL_LOUDNESS_SCALE, 1.0 );
					_onPlayerWallHit( damage, volume, hit.hit_pnt_x, hit.hit_pnt_y, hit.hit_pnt_z,
						hit.hit_side_seg, hit.hit_side );

				}

			}

			if ( wall_part < 0 ) {

				// Slide along wall: remove velocity component along wall normal
				// Ported from: PHYSICS.C line 940-946
				// PF_BOUNCE multiplies wall_part by 2 for elastic bounce
				// Player does NOT have PF_BOUNCE — pure slide (factor = 1.0)
				const bounce_factor = 1.0;
				playerVelocity.x -= nx * wall_part * bounce_factor;
				playerVelocity.y -= ny * wall_part * bounce_factor;
				playerVelocity.z -= nz * wall_part * bounce_factor;

			}

			// Compute remaining movement with slid velocity
			const remaining_dt = dt * ( 1.0 - ( iter + 1 ) / MAX_FVI_ITERS );

			if ( remaining_dt > 0.0001 ) {

				p1_x = p0_x + playerVelocity.x * remaining_dt;
				p1_y = p0_y + playerVelocity.y * remaining_dt;
				p1_z = p0_z + playerVelocity.z * remaining_dt;
				continue; // Try again with remaining movement

			}

			break;

		} else if ( hit.hit_type === HIT_BAD_P0 ) {

			// Start point not in segment — try to recover
			const newSeg = find_point_seg( p0_x, p0_y, p0_z, curSeg );

			if ( newSeg !== - 1 ) {

				curSeg = newSeg;
				continue; // Retry with corrected segment

			}

			break;

		} else {

			break;

		}

	}

	_moveResult.x = p0_x;
	_moveResult.y = p0_y;
	_moveResult.z = p0_z;
	_moveResult.segnum = curSeg;
	return _moveResult;

}
