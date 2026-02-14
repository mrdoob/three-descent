// Ported from: descent-master/MAIN/MGLOBAL.C
// Global variables for main directory

import {
	MAX_SEGMENTS, MAX_VERTICES, MAX_SIDES_PER_SEGMENT, MAX_TEXTURES,
	Segment, WRIGHT, WBOTTOM, WLEFT, WTOP, WFRONT, WBACK
} from './segment.js';

// Global array of vertices, common to one mine
// Each vertex has {x, y, z} as floats (converted from fixed-point vms_vector)
export const Vertices = new Float32Array( MAX_VERTICES * 3 );

// This is the global mine
export const Segments = [];
for ( let i = 0; i < MAX_SEGMENTS; i ++ ) {

	Segments.push( new Segment() );

}

// Number of vertices and segments in current mine
export let Num_vertices = 0;
export let Num_segments = 0;

export let Highest_vertex_index = 0;
export let Highest_segment_index = 0;

export function set_Num_vertices( n ) { Num_vertices = n; }
export function set_Num_segments( n ) { Num_segments = n; }
export function set_Highest_vertex_index( n ) { Highest_vertex_index = n; }
export function set_Highest_segment_index( n ) { Highest_segment_index = n; }

// Translate table to get opposite side of a face on a segment
export const Side_opposite = [ WRIGHT, WBOTTOM, WLEFT, WTOP, WFRONT, WBACK ];

// Side_to_verts[side][vertex] - which segment vertices form each side
// Ported directly from MGLOBAL.C
export const Side_to_verts = [
	[ 7, 6, 2, 3 ],	// left   (WLEFT)
	[ 0, 4, 7, 3 ],	// top    (WTOP)
	[ 0, 1, 5, 4 ],	// right  (WRIGHT)
	[ 2, 6, 5, 1 ],	// bottom (WBOTTOM)
	[ 4, 5, 6, 7 ],	// back   (WBACK)
	[ 3, 2, 1, 0 ],	// front  (WFRONT)
];

// Texture map stuff
export let NumTextures = 0;
export function set_NumTextures( n ) { NumTextures = n; }

// Textures[i] = bitmap_index (ushort) — maps tmap_num to bitmap index
export const Textures = new Uint16Array( MAX_TEXTURES );

// Walls array - populated by gamesave when loading level data
import { Wall, MAX_WALLS } from './wall.js';

export const Walls = [];
for ( let i = 0; i < MAX_WALLS; i ++ ) {

	Walls.push( new Wall() );

}

export let Num_walls = 0;
export function set_Num_walls( n ) { Num_walls = n; }

// Object pool — re-exported from object.js for easy access
import { Objects, MAX_OBJECTS } from './object.js';
export { Objects, MAX_OBJECTS };

// Automap visited segments — only show segments the player has entered
// Ported from: RENDER.C line 981 (Automap_visited[segnum] = 1)
export const Automap_visited = new Uint8Array( MAX_SEGMENTS );

export let FrameTime = 0;
export let GameTime = 0;
export let FrameCount = 0;

export function set_FrameTime( t ) { FrameTime = t; }
export function set_GameTime( t ) { GameTime = t; }
export function set_FrameCount( c ) { FrameCount = c; }
