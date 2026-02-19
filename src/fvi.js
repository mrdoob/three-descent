// Ported from: descent-master/MAIN/FVI.C
// Find Vector Intersection — the core raycasting engine for collision detection

import { IS_CHILD } from './segment.js';
import {
	Vertices, Segments, Num_segments
} from './mglobal.js';
import {
	get_seg_masks, create_abs_vertex_lists, find_point_seg,
	get_num_faces
} from './gameseg.js';
import { wall_is_doorway, WID_FLY_FLAG, WID_TRANSPARENT_WALL } from './wall.js';
import {
	Objects,
	OBJ_NONE, OBJ_WALL, OBJ_FIREBALL, OBJ_ROBOT, OBJ_HOSTAGE, OBJ_PLAYER,
	OBJ_WEAPON, OBJ_CAMERA, OBJ_POWERUP, OBJ_DEBRIS, OBJ_CNTRLCEN,
	OBJ_FLARE, OBJ_CLUTTER, OBJ_GHOST, OBJ_LIGHT, OBJ_COOP,
	OF_SHOULD_BE_DEAD
} from './object.js';
import { Robot_info } from './robot.js';
// Proximity bomb weapon ID (duplicated here to avoid circular import with laser.js)
const PROXIMITY_ID = 16;

// Hit type constants (from FVI.H)
export const HIT_NONE = 0;
export const HIT_WALL = 1;
export const HIT_OBJECT = 2;
export const HIT_BAD_P0 = 3;

// FVI query flags (from FVI.H)
export const FQ_CHECK_OBJS = 1;
export const FQ_TRANSWALL = 2;
export const FQ_TRANSPOINT = 4;
export const FQ_GET_SEGLIST = 8;

export const MAX_FVI_SEGS = 100;

// Internal intersection type constants
const IT_NONE = 0;
const IT_FACE = 1;
const IT_EDGE = 2;
const IT_POINT = 3;

// Projection table: given largest normal component, which axes to use for 2D projection
// [biggest][0] = i axis, [biggest][1] = j axis
// When normal component is negative, i and j are swapped
const ij_table = [
	[ 2, 1 ],	// X biggest
	[ 0, 2 ],	// Y biggest
	[ 1, 0 ]	// Z biggest
];

// Plane distance tolerance (from GAMESEG.C)
const PLANE_DIST_TOLERANCE = 250 / 65536.0;

// ---- CollisionResult matrix ----
// Ported from: COLLIDE.C collide_init() lines 1978-2035
// CollisionResult[a][b] = what happens to a when it collides with b
// 0 = RESULT_NOTHING, 1 = RESULT_CHECK
const MAX_OBJECT_TYPES = 15;
const RESULT_NOTHING = 0;
const RESULT_CHECK = 1;
const CollisionResult = [];

for ( let i = 0; i < MAX_OBJECT_TYPES; i ++ ) {

	CollisionResult[ i ] = new Uint8Array( MAX_OBJECT_TYPES );

}

function _enable_collision( t1, t2 ) {

	CollisionResult[ t1 ][ t2 ] = RESULT_CHECK;
	CollisionResult[ t2 ][ t1 ] = RESULT_CHECK;

}

// Initialize collision matrix (called once at module load)
_enable_collision( OBJ_WALL, OBJ_ROBOT );
_enable_collision( OBJ_WALL, OBJ_WEAPON );
_enable_collision( OBJ_WALL, OBJ_PLAYER );
_enable_collision( OBJ_ROBOT, OBJ_ROBOT );
_enable_collision( OBJ_PLAYER, OBJ_PLAYER );
_enable_collision( OBJ_WEAPON, OBJ_WEAPON );
_enable_collision( OBJ_ROBOT, OBJ_PLAYER );
_enable_collision( OBJ_ROBOT, OBJ_WEAPON );
_enable_collision( OBJ_HOSTAGE, OBJ_PLAYER );
_enable_collision( OBJ_HOSTAGE, OBJ_WEAPON );
_enable_collision( OBJ_PLAYER, OBJ_WEAPON );
_enable_collision( OBJ_PLAYER, OBJ_POWERUP );
_enable_collision( OBJ_WEAPON, OBJ_DEBRIS );
_enable_collision( OBJ_POWERUP, OBJ_WALL );
_enable_collision( OBJ_WEAPON, OBJ_CNTRLCEN );
_enable_collision( OBJ_WEAPON, OBJ_CLUTTER );
_enable_collision( OBJ_PLAYER, OBJ_CNTRLCEN );
_enable_collision( OBJ_ROBOT, OBJ_CNTRLCEN );
_enable_collision( OBJ_PLAYER, OBJ_CLUTTER );

// ---- laser_are_related ----
// Ported from: LASER.C lines 143-175
// Returns true if two objects are related (parent-child weapon relationship)
// and should NOT collide with each other
let _gameTime = 0;

export function fvi_set_game_time( t ) {

	_gameTime = t;

}

function laser_are_related( o1, o2 ) {

	if ( o1 < 0 || o2 < 0 ) return false;

	const obj1 = Objects[ o1 ];
	const obj2 = Objects[ o2 ];
	if ( obj1 === undefined || obj2 === undefined ) return false;

	// See if o2 is the parent of o1
	if ( obj1.type === OBJ_WEAPON && obj1.ctype !== null ) {

		if ( obj1.ctype.parent_num === o2 &&
			obj1.ctype.parent_signature === obj2.signature ) {

			// Proximity bomb exception: related only if < 2.0 seconds old
			if ( obj1.id === PROXIMITY_ID ) {

				if ( obj1.ctype.creation_time !== undefined &&
					obj1.ctype.creation_time + 2.0 < _gameTime ) {

					return false;

				}

			}

			return true;

		}

	}

	// See if o1 is the parent of o2
	if ( obj2.type === OBJ_WEAPON && obj2.ctype !== null ) {

		if ( obj2.ctype.parent_num === o1 &&
			obj2.ctype.parent_signature === obj1.signature ) {

			return true;

		}

	}

	// Both must be weapons for sibling check
	if ( obj1.type !== OBJ_WEAPON || obj2.type !== OBJ_WEAPON ) return false;

	// Check if siblings (same parent)
	if ( obj1.ctype !== null && obj2.ctype !== null &&
		obj1.ctype.parent_signature === obj2.ctype.parent_signature ) {

		// Proximity bombs can blow each other up
		if ( obj1.id === PROXIMITY_ID || obj2.id === PROXIMITY_ID ) return false;

		return true;

	}

	return false;

}

// ---- check_vector_to_sphere_1 ----
// Ported from: FVI.C lines 664-724
// Returns 0 if no intersection, or distance to intersection point
// Sets _obj_int_result with intersection point
const _obj_int_result = { x: 0, y: 0, z: 0 };

function check_vector_to_sphere_1( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
	sphere_x, sphere_y, sphere_z, sphere_rad ) {

	// Direction vector
	const d_x = p1_x - p0_x;
	const d_y = p1_y - p0_y;
	const d_z = p1_z - p0_z;

	const mag_d = Math.sqrt( d_x * d_x + d_y * d_y + d_z * d_z );

	if ( mag_d < 0.0001 ) {

		// Zero-length: check if inside sphere
		const wx = sphere_x - p0_x;
		const wy = sphere_y - p0_y;
		const wz = sphere_z - p0_z;
		const wdist = Math.sqrt( wx * wx + wy * wy + wz * wz );

		if ( wdist < sphere_rad ) {

			_obj_int_result.x = p0_x;
			_obj_int_result.y = p0_y;
			_obj_int_result.z = p0_z;
			return 1;

		}

		return 0;

	}

	// Normalized direction
	const dn_x = d_x / mag_d;
	const dn_y = d_y / mag_d;
	const dn_z = d_z / mag_d;

	// Vector from p0 to sphere center
	const w_x = sphere_x - p0_x;
	const w_y = sphere_y - p0_y;
	const w_z = sphere_z - p0_z;

	// Project onto ray
	const w_dist = dn_x * w_x + dn_y * w_y + dn_z * w_z;

	if ( w_dist < 0 ) return 0;					// Behind start
	if ( w_dist > mag_d + sphere_rad ) return 0;	// Past end

	// Closest point on ray to sphere center
	const cp_x = p0_x + dn_x * w_dist;
	const cp_y = p0_y + dn_y * w_dist;
	const cp_z = p0_z + dn_z * w_dist;

	const dx = cp_x - sphere_x;
	const dy = cp_y - sphere_y;
	const dz = cp_z - sphere_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	if ( dist < sphere_rad ) {

		const shorten = Math.sqrt( sphere_rad * sphere_rad - dist * dist );
		const int_dist = w_dist - shorten;

		if ( int_dist < 0 || int_dist > mag_d ) {

			// Inside sphere — return start point
			_obj_int_result.x = p0_x;
			_obj_int_result.y = p0_y;
			_obj_int_result.z = p0_z;
			return 1;

		}

		_obj_int_result.x = p0_x + dn_x * int_dist;
		_obj_int_result.y = p0_y + dn_y * int_dist;
		_obj_int_result.z = p0_z + dn_z * int_dist;
		return int_dist;

	}

	return 0;

}

// ---- check_vector_to_object ----
// Ported from: FVI.C lines 835-850
// Wrapper that adjusts sizes for special cases
function check_vector_to_object( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
	rad, obj, otherobj ) {

	let size = obj.size;

	// Attack-type robots (claw guys) get 3/4 radius
	if ( obj.type === OBJ_ROBOT && Robot_info[ obj.id ] !== undefined &&
		Robot_info[ obj.id ].attack_type !== 0 ) {

		size = ( size * 3 ) / 4;

	}

	return check_vector_to_sphere_1(
		p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
		obj.pos_x, obj.pos_y, obj.pos_z,
		size + rad
	);

}

// FVI query state: ignore_obj_list (set before calling find_vector_intersection)
let _fvi_ignore_obj_list = null;

export function fvi_set_ignore_obj_list( list ) {

	_fvi_ignore_obj_list = list;

}

// Pre-allocated module-level state (Golden Rule #5: no allocations in render loop)
const MAX_SEGS_VISITED = 100;
const _segs_visited = new Int16Array( MAX_SEGS_VISITED );
let _n_segs_visited = 0;

// Global FVI state passed between fvi_sub and find_vector_intersection
let _fvi_hit_object = - 1;
let _fvi_hit_seg = - 1;
let _fvi_hit_side = - 1;
let _fvi_hit_side_seg = - 1;
let _fvi_hit_seg2 = - 1;
let _wall_norm_x = 0;
let _wall_norm_y = 0;
let _wall_norm_z = 0;
let _fvi_nest_count = 0;

// Pre-allocated hit result (returned by find_vector_intersection)
const _hit_data = {
	hit_type: HIT_NONE,
	hit_pnt_x: 0, hit_pnt_y: 0, hit_pnt_z: 0,
	hit_seg: - 1,
	hit_side: - 1,
	hit_side_seg: - 1,
	hit_object: - 1,
	hit_wallnorm_x: 0, hit_wallnorm_y: 0, hit_wallnorm_z: 0,
	n_segs: 0,
	seglist: new Int16Array( MAX_FVI_SEGS )
};

// Pre-allocated temp vectors for internal computation
const _temp_seglist = new Int16Array( MAX_FVI_SEGS );

// ---- Helper: get vertex component by index (0=x, 1=y, 2=z) ----
function vert_xyz( vertnum, comp ) {

	return Vertices[ vertnum * 3 + comp ];

}

// ---- find_plane_line_intersection ----
// Ported from FVI.C lines 261-313
// Finds where a line from p0 to p1 intersects a plane (offset by rad)
// Returns true and sets new_pnt if intersection found, false if parallel
// Pre-allocated result point
const _plane_int_result = { x: 0, y: 0, z: 0 };

function find_plane_line_intersection( plane_x, plane_y, plane_z, norm_x, norm_y, norm_z, p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, rad ) {

	// d = p1 - p0
	const dx = p1_x - p0_x;
	const dy = p1_y - p0_y;
	const dz = p1_z - p0_z;

	// w = p0 - plane_pnt
	const wx = p0_x - plane_x;
	const wy = p0_y - plane_y;
	const wz = p0_z - plane_z;

	let num = norm_x * wx + norm_y * wy + norm_z * wz;
	const den = - ( norm_x * dx + norm_y * dy + norm_z * dz );

	num -= rad; // Move intersection plane out by radius

	// Check for various degenerate cases
	if ( den === 0 ) return false; // Parallel to plane

	if ( den > 0 ) {

		if ( num > den ) return false; // Fraction > 1

	} else if ( den < 0 && num < den ) {

		return false; // Fraction > 1

	}

	// Compute intersection parameter k = num/den
	const k = num / den;

	if ( k > 1.0 ) return false; // Safety check

	// Compute intersection point: p0 + d * k
	_plane_int_result.x = p0_x + dx * k;
	_plane_int_result.y = p0_y + dy * k;
	_plane_int_result.z = p0_z + dz * k;

	return true;

}

// ---- check_point_to_face ----
// Ported from FVI.C lines 335-396
// 2D point-in-polygon test by projecting onto dominant normal plane
// Returns edgemask: 0 = inside polygon, nonzero = which edge(s) it's behind
function check_point_to_face( checkp_x, checkp_y, checkp_z, seg, sidenum, facenum, nv, vertex_list ) {

	const sidep = seg.sides[ sidenum ];
	const norm = sidep.normals[ facenum ];

	// Find dominant axis of normal (largest absolute component)
	const ax = Math.abs( norm.x );
	const ay = Math.abs( norm.y );
	const az = Math.abs( norm.z );

	let biggest;

	if ( ax > ay ) {

		biggest = ( ax > az ) ? 0 : 2;

	} else {

		biggest = ( ay > az ) ? 1 : 2;

	}

	// Choose projection axes based on normal sign
	let ii, jj;
	const norm_comp = ( biggest === 0 ) ? norm.x : ( biggest === 1 ) ? norm.y : norm.z;

	if ( norm_comp > 0 ) {

		ii = ij_table[ biggest ][ 0 ];
		jj = ij_table[ biggest ][ 1 ];

	} else {

		ii = ij_table[ biggest ][ 1 ];
		jj = ij_table[ biggest ][ 0 ];

	}

	// Project check point (avoid array allocation — index directly)
	const check_i = ( ii === 0 ) ? checkp_x : ( ii === 1 ) ? checkp_y : checkp_z;
	const check_j = ( jj === 0 ) ? checkp_x : ( jj === 1 ) ? checkp_y : checkp_z;

	// Test each edge
	let edgemask = 0;

	for ( let edge = 0; edge < nv; edge ++ ) {

		const v0idx = vertex_list[ facenum * 3 + edge ];
		const v1idx = vertex_list[ facenum * 3 + ( ( edge + 1 ) % nv ) ];

		const v0_i = vert_xyz( v0idx, ii );
		const v0_j = vert_xyz( v0idx, jj );
		const v1_i = vert_xyz( v1idx, ii );
		const v1_j = vert_xyz( v1idx, jj );

		const edge_i = v1_i - v0_i;
		const edge_j = v1_j - v0_j;
		const chk_i = check_i - v0_i;
		const chk_j = check_j - v0_j;

		// Cross product: if negative, point is outside this edge
		const d = chk_i * edge_j - chk_j * edge_i;

		if ( d < 0 ) {

			edgemask |= ( 1 << edge );

		}

	}

	return edgemask;

}

// ---- check_sphere_to_face ----
// Ported from FVI.C lines 400-466
// Checks if a sphere of given radius intersects a polygon face
// Returns IT_FACE, IT_EDGE, IT_POINT, or IT_NONE
function check_sphere_to_face( pnt_x, pnt_y, pnt_z, seg, sidenum, facenum, nv, rad, vertex_list ) {

	// First check if point projects inside the face
	const edgemask = check_point_to_face( pnt_x, pnt_y, pnt_z, seg, sidenum, facenum, nv, vertex_list );

	if ( edgemask === 0 ) return IT_FACE;

	// Point is outside face — check distance to nearest edge
	// Find first edge we're behind
	let edgenum = 0;
	let mask = edgemask;

	while ( ( mask & 1 ) === 0 ) {

		mask >>= 1;
		edgenum ++;

	}

	const v0idx = vertex_list[ facenum * 3 + edgenum ];
	const v1idx = vertex_list[ facenum * 3 + ( ( edgenum + 1 ) % nv ) ];

	const v0_x = vert_xyz( v0idx, 0 );
	const v0_y = vert_xyz( v0idx, 1 );
	const v0_z = vert_xyz( v0idx, 2 );
	const v1_x = vert_xyz( v1idx, 0 );
	const v1_y = vert_xyz( v1idx, 1 );
	const v1_z = vert_xyz( v1idx, 2 );

	// Edge vector and its length
	let edge_x = v1_x - v0_x;
	let edge_y = v1_y - v0_y;
	let edge_z = v1_z - v0_z;
	const edgelen = Math.sqrt( edge_x * edge_x + edge_y * edge_y + edge_z * edge_z );

	if ( edgelen < 0.000001 ) return IT_NONE;

	edge_x /= edgelen;
	edge_y /= edgelen;
	edge_z /= edgelen;

	// Check vector from v0 to check point
	const chk_x = pnt_x - v0_x;
	const chk_y = pnt_y - v0_y;
	const chk_z = pnt_z - v0_z;

	// Project onto edge
	const d = edge_x * chk_x + edge_y * chk_y + edge_z * chk_z;

	if ( d + rad < 0 ) return IT_NONE;		// Too far behind start
	if ( d - rad > edgelen ) return IT_NONE;	// Too far past end

	// Find closest point on edge
	let closest_x, closest_y, closest_z;
	let itype = IT_POINT;

	if ( d < 0 ) {

		closest_x = v0_x;
		closest_y = v0_y;
		closest_z = v0_z;

	} else if ( d > edgelen ) {

		closest_x = v1_x;
		closest_y = v1_y;
		closest_z = v1_z;

	} else {

		itype = IT_EDGE;
		closest_x = v0_x + edge_x * d;
		closest_y = v0_y + edge_y * d;
		closest_z = v0_z + edge_z * d;

	}

	// Distance from check point to closest point
	const ddx = pnt_x - closest_x;
	const ddy = pnt_y - closest_y;
	const ddz = pnt_z - closest_z;
	const dist = Math.sqrt( ddx * ddx + ddy * ddy + ddz * ddz );

	if ( dist <= rad ) {

		return ( itype === IT_POINT ) ? IT_NONE : itype;

	}

	return IT_NONE;

}

// ---- check_line_to_face ----
// Ported from FVI.C lines 472-515
// Returns intersection type if line p0→p1 intersects face, fills in newp
function check_line_to_face( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, seg, segnum, sidenum, facenum, nv, rad ) {

	const sidep = seg.sides[ sidenum ];
	const norm = sidep.normals[ facenum ];
	const vertex_list = create_abs_vertex_lists( segnum, sidenum );

	// Use lowest vertex index as reference point (matching original C)
	const num_faces = get_num_faces( sidep );
	let vertnum;

	if ( num_faces === 2 ) {

		vertnum = Math.min( vertex_list[ 0 ], vertex_list[ 2 ] );

	} else {

		vertnum = vertex_list[ 0 ];

		for ( let i = 1; i < 4; i ++ ) {

			if ( vertex_list[ i ] < vertnum ) vertnum = vertex_list[ i ];

		}

	}

	const plane_x = vert_xyz( vertnum, 0 );
	const plane_y = vert_xyz( vertnum, 1 );
	const plane_z = vert_xyz( vertnum, 2 );

	const pli = find_plane_line_intersection(
		plane_x, plane_y, plane_z,
		norm.x, norm.y, norm.z,
		p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
		rad
	);

	if ( pli !== true ) return IT_NONE;

	// _plane_int_result now holds the intersection point
	// If rad != 0, project the point down onto the polygon plane for the 2D check
	let check_x = _plane_int_result.x;
	let check_y = _plane_int_result.y;
	let check_z = _plane_int_result.z;

	if ( rad !== 0 ) {

		check_x -= norm.x * rad;
		check_y -= norm.y * rad;
		check_z -= norm.z * rad;

	}

	return check_sphere_to_face( check_x, check_y, check_z, seg, sidenum, facenum, nv, rad, vertex_list );

}

// ---- special_check_line_to_face ----
// Ported from FVI.C lines 568-656
// Used when BOTH endpoints are behind the face (startmask & bit is set)
// Checks edge-to-edge intersection instead
function special_check_line_to_face( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, seg, segnum, sidenum, facenum, nv, rad ) {

	const sidep = seg.sides[ sidenum ];
	const vertex_list = create_abs_vertex_lists( segnum, sidenum );

	// Figure out which edge to check against
	const edgemask = check_point_to_face( p0_x, p0_y, p0_z, seg, sidenum, facenum, nv, vertex_list );

	if ( edgemask === 0 ) {

		// p0 projects inside face — use regular check
		return check_line_to_face( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, seg, segnum, sidenum, facenum, nv, rad );

	}

	// Find first edge we're behind
	let edgenum = 0;
	let mask = edgemask;

	while ( ( mask & 1 ) === 0 ) {

		mask >>= 1;
		edgenum ++;

	}

	const v0idx = vertex_list[ facenum * 3 + edgenum ];
	const v1idx = vertex_list[ facenum * 3 + ( ( edgenum + 1 ) % nv ) ];

	const ev0_x = vert_xyz( v0idx, 0 );
	const ev0_y = vert_xyz( v0idx, 1 );
	const ev0_z = vert_xyz( v0idx, 2 );
	const ev1_x = vert_xyz( v1idx, 0 );
	const ev1_y = vert_xyz( v1idx, 1 );
	const ev1_z = vert_xyz( v1idx, 2 );

	// Edge vector
	let edge_x = ev1_x - ev0_x;
	let edge_y = ev1_y - ev0_y;
	let edge_z = ev1_z - ev0_z;

	// Move vector
	let move_x = p1_x - p0_x;
	let move_y = p1_y - p0_y;
	let move_z = p1_z - p0_z;

	const edge_len = Math.sqrt( edge_x * edge_x + edge_y * edge_y + edge_z * edge_z );
	const move_len = Math.sqrt( move_x * move_x + move_y * move_y + move_z * move_z );

	if ( edge_len < 0.000001 || move_len < 0.000001 ) return IT_NONE;

	edge_x /= edge_len;
	edge_y /= edge_len;
	edge_z /= edge_len;
	move_x /= move_len;
	move_y /= move_len;
	move_z /= move_len;

	// Find closest approach of two lines using determinant method
	// Ported from check_line_to_line in FVI.C
	const cross_x = edge_y * move_z - edge_z * move_y;
	const cross_y = edge_z * move_x - edge_x * move_z;
	const cross_z = edge_x * move_y - edge_y * move_x;
	const cross_mag2 = cross_x * cross_x + cross_y * cross_y + cross_z * cross_z;

	if ( cross_mag2 < 0.0000001 ) return IT_NONE; // Lines are parallel

	// Vector from edge start to move start
	const r_x = p0_x - ev0_x;
	const r_y = p0_y - ev0_y;
	const r_z = p0_z - ev0_z;

	// Compute t parameters using Cramer's rule on the 3x3 determinant
	// edge_t = det(r, move, cross) / cross_mag2
	// move_t = det(r, edge, cross) / cross_mag2
	const move_t = (
		r_x * ( edge_y * cross_z - edge_z * cross_y ) -
		r_y * ( edge_x * cross_z - edge_z * cross_x ) +
		r_z * ( edge_x * cross_y - edge_y * cross_x )
	) / cross_mag2;

	const edge_t = (
		r_x * ( move_y * cross_z - move_z * cross_y ) -
		r_y * ( move_x * cross_z - move_z * cross_x ) +
		r_z * ( move_x * cross_y - move_y * cross_x )
	) / cross_mag2;

	// Validate ranges
	if ( move_t < 0 || move_t > move_len + rad ) return IT_NONE;

	const move_t2 = Math.min( move_t, move_len );
	const edge_t2 = Math.max( 0, Math.min( edge_t, edge_len ) );

	// Compute closest points
	const cp_edge_x = ev0_x + edge_x * edge_t2;
	const cp_edge_y = ev0_y + edge_y * edge_t2;
	const cp_edge_z = ev0_z + edge_z * edge_t2;
	const cp_move_x = p0_x + move_x * move_t2;
	const cp_move_y = p0_y + move_y * move_t2;
	const cp_move_z = p0_z + move_z * move_t2;

	const ddx = cp_edge_x - cp_move_x;
	const ddy = cp_edge_y - cp_move_y;
	const ddz = cp_edge_z - cp_move_z;
	const closest_dist = Math.sqrt( ddx * ddx + ddy * ddy + ddz * ddz );

	// Note massive tolerance here (from original: rad*15/20)
	if ( closest_dist < ( rad * 15 ) / 20 ) {

		// Hit! Compute intersection point
		const int_t = move_t - rad;
		_plane_int_result.x = p0_x + move_x * int_t;
		_plane_int_result.y = p0_y + move_y * int_t;
		_plane_int_result.z = p0_z + move_z * int_t;

		return IT_EDGE;

	}

	return IT_NONE;

}

// ---- fvi_sub ----
// Ported from FVI.C lines 1002-1310
// The recursive core of FVI: for each segment, check all 6 sides
// Open passage → recurse. Wall → record hit with normal.
// Writes result into _fvi_sub_result (pre-allocated, Golden Rule #5)
const _fvi_sub_result = { type: HIT_NONE, pnt_x: 0, pnt_y: 0, pnt_z: 0, seg: - 1 };

// Pre-allocated sub_result for recursive calls (one per nesting level, max depth ~20)
const MAX_FVI_DEPTH = 20;
const _sub_results = [];

for ( let i = 0; i < MAX_FVI_DEPTH; i ++ ) {

	_sub_results.push( { hit_x: 0, hit_y: 0, hit_z: 0, hit_seg: - 1 } );

}

function fvi_sub( p0_x, p0_y, p0_z, startseg, p1_x, p1_y, p1_z, rad, thisobjnum, flags, seglist, n_segs_ptr, entry_seg ) {

	const seg = Segments[ startseg ];
	let hit_type = HIT_NONE;
	let hit_seg = - 1;
	let hit_none_seg = - 1;
	let closest_d = Infinity;
	let closest_hit_x = p1_x;
	let closest_hit_y = p1_y;
	let closest_hit_z = p1_z;

	const cur_nest = _fvi_nest_count;
	_fvi_nest_count ++;

	if ( _fvi_nest_count >= MAX_FVI_DEPTH ) {

		_fvi_sub_result.type = HIT_NONE;
		_fvi_sub_result.pnt_x = p1_x;
		_fvi_sub_result.pnt_y = p1_y;
		_fvi_sub_result.pnt_z = p1_z;
		_fvi_sub_result.seg = startseg;
		return;

	}

	// ---- Object collision check ----
	// Ported from: FVI.C lines 1056-1092
	if ( ( flags & FQ_CHECK_OBJS ) !== 0 ) {

		let objnum = seg.objects;

		while ( objnum !== - 1 ) {

			const obj = Objects[ objnum ];

			if ( obj === undefined ) break;

			const nextObj = obj.next;

			// Skip dead objects
			if ( ( obj.flags & OF_SHOULD_BE_DEAD ) !== 0 ) { objnum = nextObj; continue; }

			// Skip self
			if ( thisobjnum === objnum ) { objnum = nextObj; continue; }

			// Player movement queries pass thisobjnum = -1; ignore the player object
			// so enabling FQ_CHECK_OBJS doesn't immediately block all movement.
			if ( thisobjnum === - 1 && obj.type === OBJ_PLAYER ) { objnum = nextObj; continue; }

			// Skip ignored objects
			if ( _fvi_ignore_obj_list !== null ) {

				let ignored = false;

				for ( let ig = 0; ig < _fvi_ignore_obj_list.length; ig ++ ) {

					if ( _fvi_ignore_obj_list[ ig ] === objnum ) { ignored = true; break; }

				}

				if ( ignored === true ) { objnum = nextObj; continue; }

			}

			// Skip related weapons (parent-child)
			if ( laser_are_related( objnum, thisobjnum ) === true ) { objnum = nextObj; continue; }

			// Collision matrix check
			if ( thisobjnum > - 1 ) {

				const thisobj = Objects[ thisobjnum ];

				if ( thisobj !== undefined &&
					thisobj.type < MAX_OBJECT_TYPES && obj.type < MAX_OBJECT_TYPES ) {

					if ( CollisionResult[ thisobj.type ][ obj.type ] === RESULT_NOTHING &&
						CollisionResult[ obj.type ][ thisobj.type ] === RESULT_NOTHING ) {

						objnum = nextObj; continue;

					}

					// Robot-robot: skip unless both are attack types
					if ( thisobj.type === OBJ_ROBOT && obj.type === OBJ_ROBOT ) {

						const ri_this = Robot_info[ thisobj.id ];
						const ri_obj = Robot_info[ obj.id ];

						if ( ri_this === undefined || ri_obj === undefined ||
							( ri_this.attack_type === 0 || ri_obj.attack_type === 0 ) ) {

							objnum = nextObj; continue;

						}

					}

				}

			}

			// Radius fudge for attack-type robots
			let fudged_rad = rad;

			if ( thisobjnum > - 1 ) {

				const thisobj = Objects[ thisobjnum ];

				if ( thisobj !== undefined && thisobj.type === OBJ_ROBOT &&
					Robot_info[ thisobj.id ] !== undefined &&
					Robot_info[ thisobj.id ].attack_type !== 0 ) {

					fudged_rad = ( rad * 3 ) / 4;

				}

			}

			// Check sphere intersection
			const d = check_vector_to_object(
				p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
				fudged_rad, obj,
				( thisobjnum > - 1 ) ? Objects[ thisobjnum ] : null
			);

			if ( d > 0 && d < closest_d ) {

				_fvi_hit_object = objnum;
				closest_d = d;
				closest_hit_x = _obj_int_result.x;
				closest_hit_y = _obj_int_result.y;
				closest_hit_z = _obj_int_result.z;
				hit_type = HIT_OBJECT;

			}

			objnum = nextObj;

		}

	}

	// Get facemask at start and end points
	const startmask = get_seg_masks( p0_x, p0_y, p0_z, startseg, rad ).facemask;

	const endmasks = get_seg_masks( p1_x, p1_y, p1_z, startseg, rad );
	const endmask = endmasks.facemask;
	const centermask = endmasks.centermask;

	if ( centermask === 0 ) hit_none_seg = startseg;

	if ( endmask !== 0 ) {

		// On the back of at least one face
		let bit = 1;

		for ( let side = 0; side < 6 && endmask >= bit; side ++ ) {

			const num_faces = get_num_faces( seg.sides[ side ] );
			const nfaces = ( num_faces === 0 ) ? 1 : num_faces;

			for ( let face = 0; face < 2; face ++, bit <<= 1 ) {

				if ( ( endmask & bit ) === 0 ) continue;

				// Don't go back through entry side
				if ( seg.children[ side ] === entry_seg ) continue;

				let face_hit_type;
				const nv = ( nfaces === 1 ) ? 4 : 3;

				if ( ( startmask & bit ) !== 0 ) {

					// Start was also through — use special edge check
					face_hit_type = special_check_line_to_face(
						p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
						seg, startseg, side, face, nv, rad
					);

				} else {

					face_hit_type = check_line_to_face(
						p0_x, p0_y, p0_z, p1_x, p1_y, p1_z,
						seg, startseg, side, face, nv, rad
					);

				}

				if ( face_hit_type !== IT_NONE ) {

					// Check if we can pass through this wall/door
					// Ported from: FVI.C lines 1149-1159
					const wid_flag = wall_is_doorway( startseg, side );
					const newsegnum = seg.children[ side ];

					if ( ( ( wid_flag & WID_FLY_FLAG ) !== 0 ||
						( wid_flag === WID_TRANSPARENT_WALL && ( flags & FQ_TRANSWALL ) !== 0 ) ) &&
						IS_CHILD( newsegnum ) === true ) {

						// Can fly through — recurse into child segment

						// Check if we've already visited this segment
						let already_visited = false;

						for ( let i = 0; i < _n_segs_visited; i ++ ) {

							if ( newsegnum === _segs_visited[ i ] ) {

								already_visited = true;
								break;

							}

						}

						if ( already_visited !== true ) {

							_segs_visited[ _n_segs_visited ++ ] = newsegnum;

							if ( _n_segs_visited >= MAX_SEGS_VISITED ) break; // Give up

							// Save wall_norm globals (recursive call may trash them)
							const save_norm_x = _wall_norm_x;
							const save_norm_y = _wall_norm_y;
							const save_norm_z = _wall_norm_z;
							const save_hit_object = _fvi_hit_object;

							const sub_result = _sub_results[ cur_nest ];

							fvi_sub(
								p0_x, p0_y, p0_z,
								newsegnum,
								p1_x, p1_y, p1_z,
								rad, thisobjnum, flags,
								_temp_seglist, 0, startseg
							);

							const sub_hit_type = _fvi_sub_result.type;
							sub_result.hit_x = _fvi_sub_result.pnt_x;
							sub_result.hit_y = _fvi_sub_result.pnt_y;
							sub_result.hit_z = _fvi_sub_result.pnt_z;
							sub_result.hit_seg = _fvi_sub_result.seg;

							if ( sub_hit_type !== HIT_NONE ) {

								const ddx = sub_result.hit_x - p0_x;
								const ddy = sub_result.hit_y - p0_y;
								const ddz = sub_result.hit_z - p0_z;
								const d = Math.sqrt( ddx * ddx + ddy * ddy + ddz * ddz );

								if ( d < closest_d ) {

									closest_d = d;
									closest_hit_x = sub_result.hit_x;
									closest_hit_y = sub_result.hit_y;
									closest_hit_z = sub_result.hit_z;
									hit_type = sub_hit_type;

									if ( sub_result.hit_seg !== - 1 ) hit_seg = sub_result.hit_seg;

								} else {

									// Restore globals
									_wall_norm_x = save_norm_x;
									_wall_norm_y = save_norm_y;
									_wall_norm_z = save_norm_z;
									_fvi_hit_object = save_hit_object;

								}

							} else {

								// Restore globals
								_wall_norm_x = save_norm_x;
								_wall_norm_y = save_norm_y;
								_wall_norm_z = save_norm_z;

								if ( sub_result.hit_seg !== - 1 ) hit_none_seg = sub_result.hit_seg;

							}

						}

					} else {

						// It's a wall (either blocked by door/wall, or no child segment) — record hit
						const int_x = _plane_int_result.x;
						const int_y = _plane_int_result.y;
						const int_z = _plane_int_result.z;

						const ddx = int_x - p0_x;
						const ddy = int_y - p0_y;
						const ddz = int_z - p0_z;
						const d = Math.sqrt( ddx * ddx + ddy * ddy + ddz * ddz );

						if ( d < closest_d ) {

							closest_d = d;
							closest_hit_x = int_x;
							closest_hit_y = int_y;
							closest_hit_z = int_z;
							hit_type = HIT_WALL;

							// Record wall normal
							const norm = seg.sides[ side ].normals[ face ];
							_wall_norm_x = norm.x;
							_wall_norm_y = norm.y;
							_wall_norm_z = norm.z;

							// Try to find hit_seg
							const hm = get_seg_masks( int_x, int_y, int_z, startseg, 0 );

							if ( hm.centermask === 0 ) {

								hit_seg = startseg;

							} else {

								_fvi_hit_seg2 = startseg;

							}

							_fvi_hit_seg = hit_seg;
							_fvi_hit_side = side;
							_fvi_hit_side_seg = startseg;

						}

					}

				}

			}

		}

	}

	// Write results to pre-allocated output
	if ( hit_type === HIT_NONE ) {

		_fvi_sub_result.type = HIT_NONE;
		_fvi_sub_result.pnt_x = p1_x;
		_fvi_sub_result.pnt_y = p1_y;
		_fvi_sub_result.pnt_z = p1_z;
		_fvi_sub_result.seg = hit_none_seg;

	} else {

		_fvi_sub_result.type = hit_type;
		_fvi_sub_result.pnt_x = closest_hit_x;
		_fvi_sub_result.pnt_y = closest_hit_y;
		_fvi_sub_result.pnt_z = closest_hit_z;
		_fvi_sub_result.seg = ( hit_seg === - 1 ) ? ( ( _fvi_hit_seg2 !== - 1 ) ? _fvi_hit_seg2 : hit_none_seg ) : hit_seg;

	}

}

// ---- find_vector_intersection ----
// Ported from FVI.C lines 881-999
// Public API: Finds where a moving sphere hits a wall
// Parameters:
//   p0_x/y/z - start position (Descent coordinates)
//   p1_x/y/z - end position
//   startseg - segment containing p0
//   rad - collision radius
//   thisobjnum - object index to ignore (-1 for none)
//   flags - FQ_* flag bitmask
// Returns pre-allocated _hit_data object
export function find_vector_intersection( p0_x, p0_y, p0_z, p1_x, p1_y, p1_z, startseg, rad, thisobjnum, flags ) {

	if ( startseg < 0 || startseg >= Num_segments ) {

		_hit_data.hit_type = HIT_BAD_P0;
		_hit_data.hit_pnt_x = p0_x;
		_hit_data.hit_pnt_y = p0_y;
		_hit_data.hit_pnt_z = p0_z;
		_hit_data.hit_seg = startseg;
		_hit_data.hit_side = - 1;
		_hit_data.hit_side_seg = - 1;
		_hit_data.hit_object = - 1;
		_hit_data.n_segs = 0;
		return _hit_data;

	}

	// Reset globals
	_fvi_hit_seg = - 1;
	_fvi_hit_side = - 1;
	_fvi_hit_object = - 1;
	_fvi_hit_seg2 = - 1;
	_fvi_hit_side_seg = - 1;
	_wall_norm_x = 0;
	_wall_norm_y = 0;
	_wall_norm_z = 0;

	// Check that start point is actually in the start segment
	const startCheck = get_seg_masks( p0_x, p0_y, p0_z, startseg, 0 );

	if ( startCheck.centermask !== 0 ) {

		_hit_data.hit_type = HIT_BAD_P0;
		_hit_data.hit_pnt_x = p0_x;
		_hit_data.hit_pnt_y = p0_y;
		_hit_data.hit_pnt_z = p0_z;
		_hit_data.hit_seg = startseg;
		_hit_data.hit_side = 0;
		_hit_data.hit_side_seg = - 1;
		_hit_data.hit_object = - 1;
		_hit_data.n_segs = 0;
		return _hit_data;

	}

	// Initialize visited list
	_segs_visited[ 0 ] = startseg;
	_n_segs_visited = 1;
	_fvi_nest_count = 0;

	// Run the recursive FVI
	_hit_data.n_segs = 0;

	fvi_sub(
		p0_x, p0_y, p0_z, startseg,
		p1_x, p1_y, p1_z,
		rad, thisobjnum, flags,
		_hit_data.seglist, _hit_data.n_segs,
		- 2 // entry_seg = -2 means no entry
	);

	let hit_type = _fvi_sub_result.type;
	let hit_pnt_x = _fvi_sub_result.pnt_x;
	let hit_pnt_y = _fvi_sub_result.pnt_y;
	let hit_pnt_z = _fvi_sub_result.pnt_z;
	let hit_seg = _fvi_sub_result.seg;

	// Verify hit_seg
	if ( hit_seg !== - 1 ) {

		const hm = get_seg_masks( hit_pnt_x, hit_pnt_y, hit_pnt_z, hit_seg, 0 );

		if ( hm.centermask !== 0 ) {

			hit_seg = find_point_seg( hit_pnt_x, hit_pnt_y, hit_pnt_z, startseg );

		}

	} else {

		hit_seg = find_point_seg( hit_pnt_x, hit_pnt_y, hit_pnt_z, startseg );

	}

	// Fallback: if hit_seg still -1, try with zero radius
	if ( hit_seg === - 1 ) {

		_segs_visited[ 0 ] = startseg;
		_n_segs_visited = 1;
		_fvi_nest_count = 0;

		fvi_sub(
			p0_x, p0_y, p0_z, startseg,
			p1_x, p1_y, p1_z,
			0, thisobjnum, flags,
			_hit_data.seglist, _hit_data.n_segs,
			- 2
		);

		if ( _fvi_sub_result.seg !== - 1 ) {

			hit_seg = _fvi_sub_result.seg;
			hit_pnt_x = _fvi_sub_result.pnt_x;
			hit_pnt_y = _fvi_sub_result.pnt_y;
			hit_pnt_z = _fvi_sub_result.pnt_z;

		}

	}

	// Fill in result
	_hit_data.hit_type = hit_type;
	_hit_data.hit_pnt_x = hit_pnt_x;
	_hit_data.hit_pnt_y = hit_pnt_y;
	_hit_data.hit_pnt_z = hit_pnt_z;
	_hit_data.hit_seg = hit_seg;
	_hit_data.hit_side = _fvi_hit_side;
	_hit_data.hit_side_seg = _fvi_hit_side_seg;
	_hit_data.hit_object = _fvi_hit_object;
	_hit_data.hit_wallnorm_x = _wall_norm_x;
	_hit_data.hit_wallnorm_y = _wall_norm_y;
	_hit_data.hit_wallnorm_z = _wall_norm_z;

	return _hit_data;

}

// ---- sphere_intersects_wall ----
// Ported from FVI.C lines 1467-1525
// Quick check if a sphere at given position intersects any wall
// Returns true if sphere overlaps a wall
const _siw_segs_visited = new Int16Array( MAX_SEGS_VISITED );
let _siw_n_segs_visited = 0;

export function sphere_intersects_wall( pnt_x, pnt_y, pnt_z, segnum, rad ) {

	_siw_n_segs_visited = 0;
	return _sphere_intersects_wall_recursive( pnt_x, pnt_y, pnt_z, segnum, rad );

}

function _sphere_intersects_wall_recursive( pnt_x, pnt_y, pnt_z, segnum, rad ) {

	if ( segnum < 0 || segnum >= Num_segments ) return true;
	if ( _siw_n_segs_visited >= MAX_SEGS_VISITED ) return false;

	_siw_segs_visited[ _siw_n_segs_visited ++ ] = segnum;

	const facemask = get_seg_masks( pnt_x, pnt_y, pnt_z, segnum, rad ).facemask;
	const seg = Segments[ segnum ];

	if ( facemask !== 0 ) {

		let bit = 1;

		for ( let side = 0; side < 6 && facemask >= bit; side ++ ) {

			const num_faces = get_num_faces( seg.sides[ side ] );
			const nfaces = ( num_faces === 0 ) ? 1 : num_faces;

			for ( let face = 0; face < 2; face ++, bit <<= 1 ) {

				if ( ( facemask & bit ) === 0 ) continue;

				const vertex_list = create_abs_vertex_lists( segnum, side );
				const nv = ( nfaces === 1 ) ? 4 : 3;

				const face_hit_type = check_sphere_to_face(
					pnt_x, pnt_y, pnt_z,
					seg, side, face, nv, rad, vertex_list
				);

				if ( face_hit_type !== IT_NONE ) {

					const child = seg.children[ side ];

					// Check if already visited
					let visited = false;

					for ( let i = 0; i < _siw_n_segs_visited; i ++ ) {

						if ( child === _siw_segs_visited[ i ] ) {

							visited = true;
							break;

						}

					}

					if ( visited !== true ) {

						if ( IS_CHILD( child ) !== true ) {

							return true; // Hit a solid wall

						} else {

							if ( _sphere_intersects_wall_recursive( pnt_x, pnt_y, pnt_z, child, rad ) === true ) {

								return true;

							}

						}

					}

				}

			}

		}

	}

	return false;

}
