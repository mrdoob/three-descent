// Ported from: descent-master/MAIN/SEGMENT.H
// Core data structures for segment-based level geometry

export const SIDE_IS_QUAD = 1;		// render side as quadrilateral
export const SIDE_IS_TRI_02 = 2;	// render side as two triangles, triangulated along edge from 0 to 2
export const SIDE_IS_TRI_13 = 3;	// render side as two triangles, triangulated along edge from 1 to 3

export const MAX_VERTICES_PER_SEGMENT = 8;
export const MAX_SIDES_PER_SEGMENT = 6;
export const MAX_VERTICES_PER_POLY = 4;

export const WLEFT = 0;
export const WTOP = 1;
export const WRIGHT = 2;
export const WBOTTOM = 3;
export const WBACK = 4;
export const WFRONT = 5;

export const MAX_SEGMENTS = 900;
export const MAX_SEGMENT_VERTICES = 3600;	// 4 * MAX_SEGMENTS
export const MAX_VERTICES = MAX_SEGMENT_VERTICES;

export const MAX_TEXTURES = 800;

export const DEFAULT_LIGHTING = 0;

// Returns true if segnum references a child segment
export function IS_CHILD( segnum ) {

	return segnum > - 1;

}

// Structure for storing u,v,light values
export class UVL {

	constructor() {

		this.u = 0;	// float (converted from fix)
		this.v = 0;
		this.l = 0;

	}

}

// Side of a segment
export class Side {

	constructor() {

		this.type = 0;			// SIDE_IS_QUAD, SIDE_IS_TRI_02, SIDE_IS_TRI_13
		this.pad = 0;
		this.wall_num = - 1;
		this.tmap_num = 0;
		this.tmap_num2 = 0;
		this.uvls = [ new UVL(), new UVL(), new UVL(), new UVL() ];
		// normals[2] - we compute these during validation
		this.normals = [
			{ x: 0, y: 0, z: 0 },
			{ x: 0, y: 0, z: 0 }
		];

	}

}

// Segment - the fundamental level building block
export class Segment {

	constructor() {

		this.sides = [];
		for ( let i = 0; i < MAX_SIDES_PER_SEGMENT; i ++ ) {

			this.sides.push( new Side() );

		}

		this.children = new Int16Array( MAX_SIDES_PER_SEGMENT );
		this.children.fill( - 1 );

		this.verts = new Int16Array( MAX_VERTICES_PER_SEGMENT );

		this.objects = - 1;		// pointer to objects in this segment
		this.special = 0;		// special property (damaging, trigger, etc.)
		this.matcen_num = - 1;	// which center segment is associated with
		this.value = 0;
		this.static_light = 0;	// average static light in segment (float, converted from fix)

	}

}
