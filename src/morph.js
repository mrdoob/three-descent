// Ported from: descent-master/MAIN/MORPH.C and MORPH.H
// Morphing effects - robots materializing from matcen generators

import * as THREE from 'three';

// Pre-allocated matrix for morph completion orientation reset (Golden Rule #5)
const _morphMatrix = new THREE.Matrix4();

// AIM_CHASE_OBJECT constant (from ai.js)
const AIM_CHASE_OBJECT = 3;

// Process morph animations for all robots
// Ported from: do_morph_frame() in MORPH.C
export function do_morph_frame( liveRobots, dt ) {

	for ( let i = 0; i < liveRobots.length; i ++ ) {

		const robot = liveRobots[ i ];
		if ( robot.alive !== true || robot.morphing !== true ) continue;

		robot.morph_timer += dt;
		const t = robot.morph_timer / robot.morph_duration;

		if ( t >= 1.0 ) {

			// Morph complete — restore normal scale and enable AI
			robot.mesh.scale.set( 1, 1, 1 );
			robot.morphing = false;
			robot.aiLocal.mode = AIM_CHASE_OBJECT;

			// Restore orientation from obj vectors (morph spin uses Euler rotation)
			const obj = robot.obj;
			const mm = _morphMatrix;
			mm.set(
				obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
				obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
				- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
				0, 0, 0, 1
			);
			robot.mesh.quaternion.setFromRotationMatrix( mm );
			robot.mesh.rotation.set( 0, 0, 0 );
			continue;

		}

		// Scale animation: smooth ease-out from 0 to 1
		const scale = t * t * ( 3.0 - 2.0 * t );	// smoothstep
		robot.mesh.scale.set( scale, scale, scale );

		// Spin rotation during morph (from MORPH.C: morph_rotvel = {0x4000, 0x2000, 0x1000})
		// 0x4000/F1_0 = 0.25 rev/frame → ~2.5 rad/s at 30fps
		robot.mesh.rotation.x += 2.5 * dt;
		robot.mesh.rotation.y += 1.25 * dt;
		robot.mesh.rotation.z += 0.625 * dt;

	}

}
