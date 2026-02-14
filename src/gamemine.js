// Ported from: descent-master/MAIN/GAMEMINE.C
// Functions for loading mines (levels) in the game

import {
	MAX_SIDES_PER_SEGMENT, MAX_VERTICES_PER_SEGMENT,
	IS_CHILD, SIDE_IS_QUAD
} from './segment.js';
import {
	Vertices, Segments, Num_segments, Num_vertices,
	set_Num_vertices, set_Num_segments,
	set_Highest_vertex_index, set_Highest_segment_index,
	Side_to_verts
} from './mglobal.js';
import { validate_segment_all } from './gameseg.js';

const COMPILED_MINE_VERSION = 0;

// Load compiled mine data (old shareware format)
// Mirrors load_mine_data_compiled() in GAMEMINE.C
// Differences from "new" format:
// - Num_vertices and Num_segments are int (4 bytes) not ushort (2 bytes)
// - All 6 children are always written (no bitmask)
// - Special data (special, matcen_num, value) always written
// - Wall bytes always written for all 6 sides (no bitmask)
// - tmap_num2 always written (no bit 15 flag on tmap_num)
export function load_mine_data_compiled_old( fp ) {

	// Read version byte
	const version = fp.readUByte();
	if ( version !== COMPILED_MINE_VERSION ) {

		console.error( 'MINE: Invalid compiled mine version: ' + version + ' (expected ' + COMPILED_MINE_VERSION + ')' );
		return - 1;

	}

	// Read vertex and segment counts (int in old format, not ushort)
	const numVertices = fp.readInt();
	const numSegments = fp.readInt();

	set_Num_vertices( numVertices );
	set_Num_segments( numSegments );

	console.log( 'MINE (old format): ' + numVertices + ' vertices, ' + numSegments + ' segments' );

	// Read vertices: each is 3 fix values (12 bytes) -> convert to float
	for ( let i = 0; i < numVertices; i ++ ) {

		Vertices[ i * 3 + 0 ] = fp.readFix();	// x
		Vertices[ i * 3 + 1 ] = fp.readFix();	// y
		Vertices[ i * 3 + 2 ] = fp.readFix();	// z

	}

	// Read segments
	for ( let segnum = 0; segnum < numSegments; segnum ++ ) {

		const seg = Segments[ segnum ];

		// All 6 children always written (short each)
		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			seg.children[ sidenum ] = fp.readShort();

		}

		// Read vertex indices (8 shorts)
		for ( let i = 0; i < MAX_VERTICES_PER_SEGMENT; i ++ ) {

			seg.verts[ i ] = fp.readShort();

		}

		seg.objects = - 1;

		// Special data always written
		seg.special = fp.readUByte();
		seg.matcen_num = fp.readUByte();
		seg.value = fp.readShort();

		// Read static_light (ushort shifted left by 4 to make fix)
		const temp_ushort = fp.readUShort();
		seg.static_light = ( temp_ushort << 4 ) / 65536.0;

		// Wall bytes always written for all 6 sides
		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			seg.sides[ sidenum ].pad = 0;
			const byte_wallnum = fp.readUByte();
			if ( byte_wallnum === 255 ) {

				seg.sides[ sidenum ].wall_num = - 1;

			} else {

				seg.sides[ sidenum ].wall_num = byte_wallnum;

			}

		}

		// Read side texture and UV data
		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			const side = seg.sides[ sidenum ];

			if ( ( seg.children[ sidenum ] === - 1 ) || ( side.wall_num !== - 1 ) ) {

				// tmap_num is always a plain short (no bit 15 flag)
				side.tmap_num = fp.readShort();

				// tmap_num2 is always written
				side.tmap_num2 = fp.readShort();

				// Read UVL data for 4 vertices
				for ( let i = 0; i < 4; i ++ ) {

					const u_short = fp.readShort();
					side.uvls[ i ].u = ( u_short << 5 ) / 65536.0;

					const v_short = fp.readShort();
					side.uvls[ i ].v = ( v_short << 5 ) / 65536.0;

					const l_ushort = fp.readUShort();
					side.uvls[ i ].l = ( l_ushort << 1 ) / 65536.0;

				}

			} else {

				side.tmap_num = 0;
				side.tmap_num2 = 0;
				for ( let i = 0; i < 4; i ++ ) {

					side.uvls[ i ].u = 0;
					side.uvls[ i ].v = 0;
					side.uvls[ i ].l = 0;

				}

			}

		}

	}

	set_Highest_vertex_index( numVertices - 1 );
	set_Highest_segment_index( numSegments - 1 );

	// Fill in side types and normals
	validate_segment_all();

	console.log( 'MINE: Loaded successfully (old format)' );

	return 0;

}

// Load compiled mine data (new compressed format)
// Mirrors load_mine_data_compiled_new() in GAMEMINE.C
export function load_mine_data_compiled_new( fp ) {

	// Read version byte
	const version = fp.readUByte();
	if ( version !== COMPILED_MINE_VERSION ) {

		console.error( 'MINE: Invalid compiled mine version: ' + version + ' (expected ' + COMPILED_MINE_VERSION + ')' );
		return - 1;

	}

	// Read vertex and segment counts (ushort in new format)
	const numVertices = fp.readUShort();
	const numSegments = fp.readUShort();

	set_Num_vertices( numVertices );
	set_Num_segments( numSegments );

	console.log( 'MINE: ' + numVertices + ' vertices, ' + numSegments + ' segments' );

	// Read vertices: each is 3 fix values (12 bytes) -> convert to float
	for ( let i = 0; i < numVertices; i ++ ) {

		Vertices[ i * 3 + 0 ] = fp.readFix();	// x
		Vertices[ i * 3 + 1 ] = fp.readFix();	// y
		Vertices[ i * 3 + 2 ] = fp.readFix();	// z

	}

	// Read segments
	for ( let segnum = 0; segnum < numSegments; segnum ++ ) {

		const seg = Segments[ segnum ];

		// Read children bitmask
		let bit_mask = fp.readUByte();

		// Read children (only if corresponding bit is set)
		for ( let bit = 0; bit < MAX_SIDES_PER_SEGMENT; bit ++ ) {

			if ( bit_mask & ( 1 << bit ) ) {

				seg.children[ bit ] = fp.readShort();

			} else {

				seg.children[ bit ] = - 1;

			}

		}

		// Read vertex indices (8 shorts)
		for ( let i = 0; i < MAX_VERTICES_PER_SEGMENT; i ++ ) {

			seg.verts[ i ] = fp.readShort();

		}

		seg.objects = - 1;

		// Bit 6 (1 << MAX_SIDES_PER_SEGMENT) indicates special data present
		if ( bit_mask & ( 1 << MAX_SIDES_PER_SEGMENT ) ) {

			seg.special = fp.readUByte();
			seg.matcen_num = fp.readUByte();
			seg.value = fp.readShort();

		} else {

			seg.special = 0;
			seg.matcen_num = - 1;
			seg.value = 0;

		}

		// Read static_light (ushort shifted left by 4 to make fix)
		// Convert fix to float: ((fix)temp_ushort << 4) / 65536.0
		const temp_ushort = fp.readUShort();
		seg.static_light = ( temp_ushort << 4 ) / 65536.0;

		// Read wall bitmask and wall numbers
		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			seg.sides[ sidenum ].pad = 0;

		}

		const wall_bit_mask = fp.readUByte();

		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			if ( wall_bit_mask & ( 1 << sidenum ) ) {

				const byte_wallnum = fp.readUByte();
				if ( byte_wallnum === 255 ) {

					seg.sides[ sidenum ].wall_num = - 1;

				} else {

					seg.sides[ sidenum ].wall_num = byte_wallnum;

				}

			} else {

				seg.sides[ sidenum ].wall_num = - 1;

			}

		}

		// Read side texture and UV data
		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			const side = seg.sides[ sidenum ];

			// Only read texture data if side has no child or has a wall
			if ( ( seg.children[ sidenum ] === - 1 ) || ( side.wall_num !== - 1 ) ) {

				// Read tmap_num (ushort) - bit 15 indicates tmap_num2 follows
				const temp_ushort2 = fp.readUShort();
				side.tmap_num = temp_ushort2 & 0x7fff;

				if ( ( temp_ushort2 & 0x8000 ) === 0 ) {

					side.tmap_num2 = 0;

				} else {

					side.tmap_num2 = fp.readShort();

				}

				// Read UVL data for 4 vertices
				// u,v: short << 5 to make fix, then convert to float
				// l: ushort << 1 to make fix, then convert to float
				for ( let i = 0; i < 4; i ++ ) {

					const u_short = fp.readShort();
					side.uvls[ i ].u = ( u_short << 5 ) / 65536.0;

					const v_short = fp.readShort();
					side.uvls[ i ].v = ( v_short << 5 ) / 65536.0;

					const l_ushort = fp.readUShort();
					side.uvls[ i ].l = ( l_ushort << 1 ) / 65536.0;

				}

			} else {

				side.tmap_num = 0;
				side.tmap_num2 = 0;
				for ( let i = 0; i < 4; i ++ ) {

					side.uvls[ i ].u = 0;
					side.uvls[ i ].v = 0;
					side.uvls[ i ].l = 0;

				}

			}

		}

	}

	set_Highest_vertex_index( numVertices - 1 );
	set_Highest_segment_index( numSegments - 1 );

	// Fill in side types and normals
	validate_segment_all();

	console.log( 'MINE: Loaded successfully' );

	return 0;

}
