// Ported from: descent-master/MAIN/AUTOMAP.C
// Automap wireframe display

import * as THREE from 'three';

import { Segments, Vertices, Num_segments, Side_to_verts, Walls, Automap_visited } from './mglobal.js';
import { IS_CHILD } from './segment.js';

// Wall type constants
const WALL_DOOR = 2;

// Key flags
const KEY_BLUE = 2;
const KEY_RED = 4;
const KEY_GOLD = 8;

// Build automap wireframe geometry from current level segments
// Returns a THREE.LineSegments mesh ready to add to scene
export function buildAutomapGeometry() {

	const positions = [];
	const colors = [];

	for ( let s = 0; s < Num_segments; s ++ ) {

		// Only show segments the player has visited
		// Ported from: AUTOMAP.C line 739 — Automap_visited[segnum] check
		if ( Automap_visited[ s ] !== 1 ) continue;

		const seg = Segments[ s ];

		for ( let side = 0; side < 6; side ++ ) {

			const sv = Side_to_verts[ side ];
			const hasChild = IS_CHILD( seg.children[ side ] );
			const wallNum = seg.sides[ side ].wall_num;

			// Determine edge color
			let r = 0.15, g = 0.4, b = 0.15;	// Default: green walls

			if ( hasChild === true && wallNum === - 1 ) {

				// Open passage — draw faint
				r = 0.1; g = 0.1; b = 0.1;

			} else if ( wallNum !== - 1 ) {

				const wall = Walls[ wallNum ];

				if ( wall !== undefined && wall.type === WALL_DOOR ) {

					// Door
					r = 0.2; g = 0.8; b = 0.2;

					// Key-colored doors
					if ( ( wall.keys & KEY_BLUE ) !== 0 ) { r = 0.2; g = 0.2; b = 1.0; }
					else if ( ( wall.keys & KEY_RED ) !== 0 ) { r = 1.0; g = 0.2; b = 0.2; }
					else if ( ( wall.keys & KEY_GOLD ) !== 0 ) { r = 1.0; g = 1.0; b = 0.2; }

				}

			}

			// Special segment types (1=fuel, 2=repair, 3=controlcen, 4=robotmaker)
			if ( seg.special === 1 ) { r = 0.6; g = 0.4; b = 0.1; }	// Fuel center
			if ( seg.special === 3 ) { r = 0.8; g = 0.1; b = 0.1; }	// Reactor (SEGMENT_IS_CONTROLCEN=3)
			if ( seg.special === 4 ) { r = 0.7; g = 0.1; b = 0.7; }	// Robot maker

			// Add 4 edges for this side
			for ( let e = 0; e < 4; e ++ ) {

				const v0i = seg.verts[ sv[ e ] ];
				const v1i = seg.verts[ sv[ ( e + 1 ) % 4 ] ];

				positions.push(
					Vertices[ v0i * 3 ], Vertices[ v0i * 3 + 1 ], - Vertices[ v0i * 3 + 2 ],
					Vertices[ v1i * 3 ], Vertices[ v1i * 3 + 1 ], - Vertices[ v1i * 3 + 2 ]
				);

				colors.push( r, g, b, r, g, b );

			}

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );

	const material = new THREE.LineBasicMaterial( {
		vertexColors: true,
		transparent: true,
		opacity: 0.8
	} );

	return new THREE.LineSegments( geometry, material );

}
