// Ported from: descent-master/MAIN/MORPH.C and MORPH.H
// Morphing effects - robots materializing from matcen generators

import * as THREE from 'three';
import { Polygon_models } from './polyobj.js';

// Pre-allocated matrix for morph completion orientation reset (Golden Rule #5)
const _morphMatrix = new THREE.Matrix4();

// AIM_CHASE_OBJECT constant (from ai.js)
const AIM_CHASE_OBJECT = 3;

// MORPH.C: #define MORPH_RATE (f1_0*3)
const MORPH_RATE = 3.0;

// MORPH.C: vms_vector morph_rotvel = {0x4000,0x2000,0x1000}
// 0x4000/0x10000 = 0.25 rev/s = PI/2 rad/s (same conversion for other axes)
const MORPH_ROTVEL_X = 1.5708;
const MORPH_ROTVEL_Y = 0.7854;
const MORPH_ROTVEL_Z = 0.3927;

function compute_start_scale( x, y, z, boxSize ) {

	let k = Number.POSITIVE_INFINITY;

	if ( x !== 0 && boxSize.x < Math.abs( x ) * 0.5 ) {

		const t = boxSize.x / Math.abs( x );
		if ( t < k ) k = t;

	}

	if ( y !== 0 && boxSize.y < Math.abs( y ) * 0.5 ) {

		const t = boxSize.y / Math.abs( y );
		if ( t < k ) k = t;

	}

	if ( z !== 0 && boxSize.z < Math.abs( z ) * 0.5 ) {

		const t = boxSize.z / Math.abs( z );
		if ( t < k ) k = t;

	}

	return Number.isFinite( k ) ? k : 0;

}

function get_robot_model( robot ) {

	if ( robot === undefined || robot === null ) return null;
	const obj = robot.obj;
	if ( obj === undefined || obj === null || obj.rtype === null ) return null;
	const modelNum = obj.rtype.model_num;
	if ( modelNum === undefined || modelNum < 0 || modelNum >= Polygon_models.length ) return null;
	return Polygon_models[ modelNum ] || null;

}

function create_entry_for_mesh( mesh ) {

	if ( mesh === undefined || mesh === null || mesh.isMesh !== true ) return null;
	if ( mesh.geometry === undefined || mesh.geometry === null ) return null;
	if ( mesh.geometry.isBufferGeometry !== true ) return null;

	const oldPos = mesh.geometry.getAttribute( 'position' );
	if ( oldPos === undefined || oldPos.itemSize !== 3 ) return null;

	// Clone per robot, since the source mesh shares geometry across clones.
	mesh.geometry = mesh.geometry.clone();
	const pos = mesh.geometry.getAttribute( 'position' );
	if ( pos === undefined || pos.itemSize !== 3 ) return null;

	const targets = new Float32Array( pos.array.length );
	targets.set( pos.array );

	return {
		positionAttr: pos,
		targets: targets,
		deltas: new Float32Array( targets.length ),
		times: new Float32Array( targets.length / 3 )
	};

}

function collect_entries_for_submodel_group( group, outEntries ) {

	if ( group === undefined || group === null ) return;

	for ( let i = 0; i < group.children.length; i ++ ) {

		const child = group.children[ i ];
		const entry = create_entry_for_mesh( child );
		if ( entry !== null ) outEntries.push( entry );

	}

}

function collect_entries_for_mesh_tree( root, outEntries ) {

	if ( root === undefined || root === null ) return;

	root.traverse( ( child ) => {

		const entry = create_entry_for_mesh( child );
		if ( entry !== null ) outEntries.push( entry );

	} );

}

function find_submodel_min_max( model, submodelNum ) {

	if ( model === null || model.model_data === null ) return null;

	const data = model.model_data;
	const ptr0 = ( submodelNum === 0 ) ? 0 : model.submodel_ptrs[ submodelNum ];
	if ( ptr0 < 0 || ptr0 + 4 > data.length ) return null;

	const dv = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const opcode = dv.getUint16( ptr0, true );
	if ( opcode !== 1 && opcode !== 7 ) return null;

	const nverts = dv.getUint16( ptr0 + 2, true );
	if ( nverts <= 0 ) return null;

	let ptr = ptr0 + 4;
	if ( opcode === 7 ) ptr += 4;
	if ( ptr + nverts * 12 > data.length ) return null;

	let minX = dv.getInt32( ptr + 0, true ) / 65536.0;
	let minY = dv.getInt32( ptr + 4, true ) / 65536.0;
	let minZ = dv.getInt32( ptr + 8, true ) / 65536.0;
	let maxX = minX;
	let maxY = minY;
	let maxZ = minZ;

	for ( let i = 1; i < nverts; i ++ ) {

		const v = ptr + i * 12;
		const x = dv.getInt32( v + 0, true ) / 65536.0;
		const y = dv.getInt32( v + 4, true ) / 65536.0;
		const z = dv.getInt32( v + 8, true ) / 65536.0;

		if ( x < minX ) minX = x;
		if ( y < minY ) minY = y;
		if ( z < minZ ) minZ = z;
		if ( x > maxX ) maxX = x;
		if ( y > maxY ) maxY = y;
		if ( z > maxZ ) maxZ = z;

	}

	return {
		min: { x: minX, y: minY, z: minZ },
		max: { x: maxX, y: maxY, z: maxZ }
	};

}

function compute_root_box_size( model, rootEntries ) {

	const bounds = find_submodel_min_max( model, 0 );
	if ( bounds !== null ) {

		return {
			x: Math.max( - bounds.min.x, bounds.max.x ) * 0.5,
			y: Math.max( - bounds.min.y, bounds.max.y ) * 0.5,
			z: Math.max( - bounds.min.z, bounds.max.z ) * 0.5
		};

	}

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;

	for ( let i = 0; i < rootEntries.length; i ++ ) {

		const t = rootEntries[ i ].targets;
		for ( let k = 0; k < t.length; k += 3 ) {

			const x = t[ k + 0 ];
			const y = t[ k + 1 ];
			const z = t[ k + 2 ];

			if ( x < minX ) minX = x;
			if ( y < minY ) minY = y;
			if ( z < minZ ) minZ = z;
			if ( x > maxX ) maxX = x;
			if ( y > maxY ) maxY = y;
			if ( z > maxZ ) maxZ = z;

		}

	}

	if ( Number.isFinite( minX ) !== true ) {

		return { x: 0, y: 0, z: 0 };

	}

	return {
		x: Math.max( - minX, maxX ) * 0.5,
		y: Math.max( - minY, maxY ) * 0.5,
		z: Math.max( - minZ, maxZ ) * 0.5
	};

}

function init_submodel_points( state, submodelNum, boxSize ) {

	const entries = state.submodelEntries[ submodelNum ];
	if ( entries === undefined ) {

		state.nMorphingPoints[ submodelNum ] = 0;
		return;

	}

	const useBox = ( boxSize !== null );
	let morphingCount = 0;

	for ( let i = 0; i < entries.length; i ++ ) {

		const entry = entries[ i ];
		const pos = entry.positionAttr.array;
		const targets = entry.targets;
		const deltas = entry.deltas;
		const times = entry.times;

		for ( let v = 0; v < times.length; v ++ ) {

			const k = v * 3;
			const tx = targets[ k + 0 ];
			const ty = targets[ k + 1 ];
			const tz = targets[ k + 2 ];

			const s = useBox ? compute_start_scale( tx, ty, tz, boxSize ) : 0;

			const sx = tx * s;
			const sy = ty * s;
			const sz = tz * s;

			pos[ k + 0 ] = sx;
			pos[ k + 1 ] = sy;
			pos[ k + 2 ] = sz;

			const dx = tx - sx;
			const dy = ty - sy;
			const dz = tz - sz;
			const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

			if ( dist > 0.000001 ) {

				const invDist = 1.0 / dist;
				deltas[ k + 0 ] = dx * invDist * MORPH_RATE;
				deltas[ k + 1 ] = dy * invDist * MORPH_RATE;
				deltas[ k + 2 ] = dz * invDist * MORPH_RATE;
				times[ v ] = dist / MORPH_RATE;
				morphingCount ++;

			} else {

				deltas[ k + 0 ] = 0;
				deltas[ k + 1 ] = 0;
				deltas[ k + 2 ] = 0;
				times[ v ] = 0;

			}

		}

		entry.positionAttr.needsUpdate = true;

	}

	state.nMorphingPoints[ submodelNum ] = morphingCount;

}

function update_submodel_points( state, submodelNum, dt ) {

	let remaining = state.nMorphingPoints[ submodelNum ];
	if ( remaining <= 0 ) return;

	const entries = state.submodelEntries[ submodelNum ];
	if ( entries === undefined ) return;

	for ( let i = 0; i < entries.length; i ++ ) {

		const entry = entries[ i ];
		const pos = entry.positionAttr.array;
		const targets = entry.targets;
		const deltas = entry.deltas;
		const times = entry.times;

		let dirty = false;

		for ( let v = 0; v < times.length; v ++ ) {

			let t = times[ v ];
			if ( t <= 0 ) continue;

			t -= dt;
			const k = v * 3;

			if ( t <= 0 ) {

				times[ v ] = 0;
				pos[ k + 0 ] = targets[ k + 0 ];
				pos[ k + 1 ] = targets[ k + 1 ];
				pos[ k + 2 ] = targets[ k + 2 ];
				remaining --;

			} else {

				times[ v ] = t;
				pos[ k + 0 ] += deltas[ k + 0 ] * dt;
				pos[ k + 1 ] += deltas[ k + 1 ] * dt;
				pos[ k + 2 ] += deltas[ k + 2 ] * dt;

			}

			dirty = true;

		}

		if ( dirty ) entry.positionAttr.needsUpdate = true;

	}

	state.nMorphingPoints[ submodelNum ] = remaining;

}

function activate_child_submodels( robot, state, parentSubmodel ) {

	for ( let i = 1; i < state.submodelActive.length; i ++ ) {

		if ( state.submodelActive[ i ] !== 0 ) continue;
		if ( state.submodelParents[ i ] !== parentSubmodel ) continue;

		init_submodel_points( state, i, null );
		state.submodelActive[ i ] = 1;
		state.nSubmodelsActive ++;

		if ( robot.submodelGroups !== undefined && robot.submodelGroups !== null ) {

			const g = robot.submodelGroups[ i ];
			if ( g !== undefined && g !== null ) g.visible = true;

		}

	}

}

function finish_robot_morph( robot ) {

	if ( robot.morphState !== undefined && robot.morphState !== null ) {

		const state = robot.morphState;

		for ( let i = 0; i < state.submodelEntries.length; i ++ ) {

			const entries = state.submodelEntries[ i ];
			if ( entries === undefined ) continue;

			for ( let j = 0; j < entries.length; j ++ ) {

				const e = entries[ j ];
				e.positionAttr.array.set( e.targets );
				e.positionAttr.needsUpdate = true;

			}

		}

	}

	if ( robot.submodelGroups !== undefined && robot.submodelGroups !== null ) {

		for ( let i = 0; i < robot.submodelGroups.length; i ++ ) {

			const g = robot.submodelGroups[ i ];
			if ( g !== undefined && g !== null ) g.visible = true;

		}

	}

	if ( robot.mesh !== null ) {

		robot.mesh.scale.set( 1, 1, 1 );

	}

	robot.morphState = null;
	robot.morphing = false;

	if ( robot.aiLocal !== undefined && robot.aiLocal !== null ) {

		robot.aiLocal.mode = AIM_CHASE_OBJECT;

	}

	if ( robot.mesh !== null ) {

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

	}

}

function build_morph_state( robot ) {

	const model = get_robot_model( robot );
	const hasSubmodelGroups = ( robot.submodelGroups !== undefined &&
		robot.submodelGroups !== null &&
		robot.submodelGroups.length > 0 );

	const submodelCount = hasSubmodelGroups ? (
		model !== null && model.n_models > 0 ? model.n_models : robot.submodelGroups.length
	) : 1;

	const state = {
		submodelEntries: new Array( submodelCount ),
		submodelActive: new Uint8Array( submodelCount ),
		nMorphingPoints: new Int32Array( submodelCount ),
		submodelParents: new Int16Array( submodelCount ),
		nSubmodelsActive: 0
	};

	state.submodelParents.fill( - 1 );

	for ( let i = 0; i < submodelCount; i ++ ) {

		state.submodelEntries[ i ] = [];

	}

	if ( hasSubmodelGroups ) {

		for ( let i = 0; i < submodelCount; i ++ ) {

			collect_entries_for_submodel_group( robot.submodelGroups[ i ], state.submodelEntries[ i ] );
			if ( i > 0 && robot.submodelGroups[ i ] !== undefined && robot.submodelGroups[ i ] !== null ) {

				robot.submodelGroups[ i ].visible = false;

			}

		}

		if ( model !== null ) {

			for ( let i = 1; i < submodelCount; i ++ ) {

				state.submodelParents[ i ] = model.submodel_parents[ i ];

			}

		}

	} else {

		collect_entries_for_mesh_tree( robot.mesh, state.submodelEntries[ 0 ] );

	}

	const rootBoxSize = compute_root_box_size( model, state.submodelEntries[ 0 ] );
	init_submodel_points( state, 0, rootBoxSize );
	state.submodelActive[ 0 ] = 1;
	state.nSubmodelsActive = 1;

	return state;

}

// Start MORPH.C-style morph animation for a newly created robot.
// Submodel 0 starts from a projected bounding-box shell; children begin from origin.
export function start_robot_morph( robot ) {

	if ( robot === undefined || robot === null ) return;
	if ( robot.mesh === undefined || robot.mesh === null ) return;

	robot.mesh.scale.set( 1, 1, 1 );
	robot.morphState = build_morph_state( robot );
	robot.morphing = true;
	robot.morph_timer = 0;

}

// Process morph animations for all robots
// Ported from: do_morph_frame() in MORPH.C
export function do_morph_frame( liveRobots, dt ) {

	for ( let i = 0; i < liveRobots.length; i ++ ) {

		const robot = liveRobots[ i ];
		if ( robot.alive !== true || robot.morphing !== true ) continue;
		if ( robot.mesh === null ) continue;

		robot.morph_timer += dt;

		const state = robot.morphState;
		if ( state === undefined || state === null ) {

			finish_robot_morph( robot );
			continue;

		}

		for ( let s = 0; s < state.submodelActive.length; s ++ ) {

			if ( state.submodelActive[ s ] !== 1 ) continue;

			update_submodel_points( state, s, dt );

			if ( state.nMorphingPoints[ s ] === 0 ) {

				state.submodelActive[ s ] = 2;
				state.nSubmodelsActive --;
				activate_child_submodels( robot, state, s );

			}

		}

		if ( state.nSubmodelsActive <= 0 ) {

			finish_robot_morph( robot );
			continue;

		}

		// Spin rotation during morph (MORPH.C sets object rotvel to morph_rotvel)
		robot.mesh.rotation.x += MORPH_ROTVEL_X * dt;
		robot.mesh.rotation.y += MORPH_ROTVEL_Y * dt;
		robot.mesh.rotation.z += MORPH_ROTVEL_Z * dt;

	}

}
