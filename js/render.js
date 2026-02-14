// Ported from: descent-master/MAIN/RENDER.C
// Rendering pipeline - converts segment geometry to Three.js BufferGeometry

import * as THREE from 'three';

import {
	SIDE_IS_QUAD, SIDE_IS_TRI_02, SIDE_IS_TRI_13,
	MAX_SIDES_PER_SEGMENT, IS_CHILD
} from './segment.js';
import {
	Vertices, Segments, Num_segments, Textures,
	NumTextures, Side_to_verts
} from './mglobal.js';
import { BM_FLAG_TRANSPARENT, BM_FLAG_SUPER_TRANSPARENT, BM_FLAG_RLE } from './piggy.js';
import { decode_tmap_num2, texmerge_get_cached_bitmap } from './texmerge.js';
import { Effects, Num_effects } from './bm.js';
import { wall_is_doorway, WID_RENDPAST_FLAG } from './wall.js';

// Convert Descent coordinate system to Three.js
// Descent: X=right, Y=up, Z=forward (into screen)
// Three.js: X=right, Y=up, Z=out of screen (toward viewer)
// Solution: negate Z
function descentToThree( x, y, z ) {

	return { x: x, y: y, z: - z };

}

// Build a Three.js texture from palette-indexed pixel data
function buildTexture( pixels, width, height, palette, transparent ) {

	const rgba = new Uint8Array( width * height * 4 );

	for ( let i = 0; i < width * height; i ++ ) {

		const palIdx = pixels[ i ];

		if ( transparent === true && palIdx === 255 ) {

			// Fully transparent pixel
			rgba[ i * 4 + 0 ] = 0;
			rgba[ i * 4 + 1 ] = 0;
			rgba[ i * 4 + 2 ] = 0;
			rgba[ i * 4 + 3 ] = 0;

		} else {

			rgba[ i * 4 + 0 ] = palette[ palIdx * 3 + 0 ];
			rgba[ i * 4 + 1 ] = palette[ palIdx * 3 + 1 ];
			rgba[ i * 4 + 2 ] = palette[ palIdx * 3 + 2 ];
			rgba[ i * 4 + 3 ] = 255;

		}

	}

	const texture = new THREE.DataTexture( rgba, width, height );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestMipmapLinearFilter;
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;

	return texture;

}

// Cache for Three.js textures (keyed by bitmap index)
const textureCache = new Map();

// Cache for merged textures (keyed by "base_overlay_rotation")
const mergedTextureCache = new Map();

// Get or create a Three.js texture for a bitmap index
function getTexture( bitmapIndex, pigFile, palette ) {

	if ( textureCache.has( bitmapIndex ) ) {

		return textureCache.get( bitmapIndex );

	}

	const pixels = pigFile.getBitmapPixels( bitmapIndex );
	if ( pixels === null ) return null;

	const bm = pigFile.bitmaps[ bitmapIndex ];
	const isTransparent = ( bm.flags & BM_FLAG_TRANSPARENT ) !== 0;

	const texture = buildTexture( pixels, bm.width, bm.height, palette, isTransparent );
	textureCache.set( bitmapIndex, texture );

	return texture;

}

// Get or create a merged texture (base + overlay)
function getMergedTexture( baseBmIndex, overlayBmIndex, rotation, pigFile, palette ) {

	const key = baseBmIndex + '_' + overlayBmIndex + '_' + rotation;

	if ( mergedTextureCache.has( key ) ) {

		return mergedTextureCache.get( key );

	}

	const basePixels = pigFile.getBitmapPixels( baseBmIndex );
	const overlayPixels = pigFile.getBitmapPixels( overlayBmIndex );

	if ( basePixels === null ) return null;

	const baseBm = pigFile.bitmaps[ baseBmIndex ];
	const overlayBm = pigFile.bitmaps[ overlayBmIndex ];

	let mergedPixels;
	let isSuperTransparent = false;
	if ( overlayPixels !== null ) {

		const overlayFlags = ( overlayBm !== undefined ) ? overlayBm.flags : 0;
		isSuperTransparent = ( overlayFlags & BM_FLAG_SUPER_TRANSPARENT ) !== 0;
		mergedPixels = texmerge_get_cached_bitmap(
			basePixels, overlayPixels, rotation,
			baseBm.width, baseBm.height, overlayFlags
		);

	} else {

		mergedPixels = basePixels;

	}

	const isTransparent = ( baseBm.flags & BM_FLAG_TRANSPARENT ) !== 0 || isSuperTransparent;
	const texture = buildTexture( mergedPixels, baseBm.width, baseBm.height, palette, isTransparent );

	mergedTextureCache.set( key, texture );
	return texture;

}

// Material cache (keyed by texture)
const materialCache = new Map();

function getMaterial( texture, transparent ) {

	if ( materialCache.has( texture ) ) {

		return materialCache.get( texture );

	}

	const material = new THREE.MeshBasicMaterial( {
		map: texture,
		alphaTest: transparent ? 0.5 : 0,
		vertexColors: true
	} );

	materialCache.set( texture, material );
	return material;

}

// --- Portal visibility system ---
// Ported from: dxx-rebirth-master/similar/main/render.cpp build_segment_list()
const MAX_RENDER_SEGS = 500;
const _visibleSegments = new Set();
const _bfsQueue = new Array( MAX_RENDER_SEGS );
let _bfsQueueLength = 0;

// Map: segnum → array of { batchedMesh, instanceId } for per-side visibility control
const segmentBatchedInstances = new Map();

// All BatchedMesh objects (for bulk visibility reset + disposal)
const allBatchedMeshes = [];

// Pre-allocated identity matrix for BatchedMesh instances (vertices already in world space)
const _identityMatrix = new THREE.Matrix4();

// Registry of individual door/wall meshes, keyed by segnum * 6 + sidenum
const doorMeshes = new Map();

// Mine group reference for adding overlay meshes at runtime
let _mineGroup = null;

// Individual meshes created for destroyed monitor sides (overlaid on batched geometry)
const destroyedSideMeshes = new Map();

// Registry of DataTextures used for eclip-animated tmap indices
// Maps tmap_num → DataTexture (so we can update pixels in-place when eclip advances)
const eclipTextures = new Map();

// Maps eclip tmap_num → array of {dataTexture, baseBmIndex, rotation}
// For eclip textures used as overlays (tmap_num2) in merged textures
const eclipOverlayTextures = new Map();

// Stored references for texture rebuilding during door animation
let _pigFile = null;
let _palette = null;

// Get texture and transparency for a side based on its current tmap_num/tmap_num2
function getSideTexture( side, pigFile, palette ) {

	const tmap_num = side.tmap_num;
	let bitmapIndex = 0;

	if ( tmap_num >= 0 && tmap_num < NumTextures ) {

		bitmapIndex = Textures[ tmap_num ];

	}

	let texture = null;
	let isTransparent = false;

	if ( side.tmap_num2 !== 0 ) {

		// Overlay texture present
		const decoded = decode_tmap_num2( side.tmap_num2 );
		const overlayTmap = decoded.index;
		let overlayBmIndex = 0;

		if ( overlayTmap >= 0 && overlayTmap < NumTextures ) {

			overlayBmIndex = Textures[ overlayTmap ];

		}

		if ( overlayBmIndex > 0 ) {

			texture = getMergedTexture( bitmapIndex, overlayBmIndex, decoded.rotation, pigFile, palette );
			pigFile.pageIn( overlayBmIndex );
			const overlayBm = pigFile.bitmaps[ overlayBmIndex ];
			if ( overlayBm !== undefined && ( ( overlayBm.flags & BM_FLAG_TRANSPARENT ) !== 0 || ( overlayBm.flags & BM_FLAG_SUPER_TRANSPARENT ) !== 0 ) ) {

				isTransparent = true;

			}

		} else {

			texture = getTexture( bitmapIndex, pigFile, palette );

		}

	} else {

		texture = getTexture( bitmapIndex, pigFile, palette );

	}

	if ( bitmapIndex >= 0 && bitmapIndex < pigFile.bitmaps.length ) {

		const bm = pigFile.bitmaps[ bitmapIndex ];
		if ( ( bm.flags & BM_FLAG_TRANSPARENT ) !== 0 ) {

			isTransparent = true;

		}

	}

	return { texture, isTransparent };

}

// Build a single side mesh (for door/wall sides that need individual update)
function buildSideMesh( segnum, sidenum, pigFile, palette ) {

	const seg = Segments[ segnum ];
	const side = seg.sides[ sidenum ];

	const result = getSideTexture( side, pigFile, palette );
	if ( result.texture === null ) return null;

	const sv = Side_to_verts[ sidenum ];
	const positions = [];
	const uvs = [];
	const colors = [];

	const verts = [];
	for ( let i = 0; i < 4; i ++ ) {

		const vi = seg.verts[ sv[ i ] ];
		verts.push( descentToThree(
			Vertices[ vi * 3 + 0 ],
			Vertices[ vi * 3 + 1 ],
			Vertices[ vi * 3 + 2 ]
		) );

	}

	const sideUvs = [];
	const lights = [];
	for ( let i = 0; i < 4; i ++ ) {

		sideUvs.push( { u: side.uvls[ i ].u, v: side.uvls[ i ].v } );
		lights.push( Math.min( side.uvls[ i ].l, 1.0 ) );

	}

	const addTriangle = ( i0, i1, i2 ) => {

		positions.push(
			verts[ i0 ].x, verts[ i0 ].y, verts[ i0 ].z,
			verts[ i1 ].x, verts[ i1 ].y, verts[ i1 ].z,
			verts[ i2 ].x, verts[ i2 ].y, verts[ i2 ].z
		);

		uvs.push(
			sideUvs[ i0 ].u, sideUvs[ i0 ].v,
			sideUvs[ i1 ].u, sideUvs[ i1 ].v,
			sideUvs[ i2 ].u, sideUvs[ i2 ].v
		);

		const l0 = lights[ i0 ];
		const l1 = lights[ i1 ];
		const l2 = lights[ i2 ];
		colors.push(
			l0, l0, l0,
			l1, l1, l1,
			l2, l2, l2
		);

	};

	switch ( side.type ) {

		case SIDE_IS_TRI_02:
			addTriangle( 0, 2, 1 );
			addTriangle( 2, 0, 3 );
			break;

		case SIDE_IS_TRI_13:
			addTriangle( 3, 1, 0 );
			addTriangle( 1, 3, 2 );
			break;

		case SIDE_IS_QUAD:
		default:
			addTriangle( 0, 2, 1 );
			addTriangle( 0, 3, 2 );
			break;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );

	const material = getMaterial( result.texture, result.isTransparent );

	return new THREE.Mesh( geometry, material );

}

// Build all the mine geometry as a single Three.js Group
// Uses BatchedMesh per texture for per-side visibility control (portal culling)
export function buildMineGeometry( pigFile, palette ) {

	const group = new THREE.Group();

	// Store references for later door texture updates
	_pigFile = pigFile;
	_palette = palette;
	_mineGroup = group;

	// Clear caches
	textureCache.clear();
	mergedTextureCache.clear();
	materialCache.clear();
	doorMeshes.clear();
	eclipTextures.clear();
	eclipOverlayTextures.clear();
	segmentBatchedInstances.clear();

	// Dispose previous BatchedMesh objects
	for ( let i = 0; i < allBatchedMeshes.length; i ++ ) {

		allBatchedMeshes[ i ].dispose();

	}

	allBatchedMeshes.length = 0;

	// Clean up destroyed side meshes from previous level
	for ( const [ key, mesh ] of destroyedSideMeshes ) {

		mesh.geometry.dispose();
		mesh.material.dispose();

	}

	destroyedSideMeshes.clear();

	// Build set of eclip-animated tmap indices for registration
	const eclipTmapSet = new Set();
	for ( let i = 0; i < Num_effects; i ++ ) {

		if ( Effects[ i ].changing_wall_texture !== - 1 ) {

			eclipTmapSet.add( Effects[ i ].changing_wall_texture );

		}

	}

	// Phase 1: Collect side data per texture for BatchedMesh construction
	// Key: texture uuid, Value: { sides: [{segnum, sidenum, positions, uvs, colors}], texture, transparent }
	const textureSides = new Map();

	for ( let segnum = 0; segnum < Num_segments; segnum ++ ) {

		const seg = Segments[ segnum ];

		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			const side = seg.sides[ sidenum ];

			// Only render sides that are walls (no child) or have a wall/door
			if ( IS_CHILD( seg.children[ sidenum ] ) && side.wall_num === - 1 ) continue;

			// Door/wall sides get individual meshes for dynamic texture updates
			if ( side.wall_num !== - 1 ) {

				const mesh = buildSideMesh( segnum, sidenum, pigFile, palette );
				if ( mesh !== null ) {

					const key = segnum * 6 + sidenum;
					doorMeshes.set( key, mesh );
					group.add( mesh );

				}

				continue;

			}

			// Regular sides collected per texture for BatchedMesh
			const result = getSideTexture( side, pigFile, palette );
			if ( result.texture === null ) continue;

			const texKey = result.texture.uuid;

			if ( textureSides.has( texKey ) === false ) {

				textureSides.set( texKey, {
					sides: [],
					texture: result.texture,
					transparent: result.isTransparent
				} );

			}

			// Build vertex/UV/color data for this side
			const sv = Side_to_verts[ sidenum ];
			const verts = [];
			for ( let i = 0; i < 4; i ++ ) {

				const vi = seg.verts[ sv[ i ] ];
				verts.push( descentToThree(
					Vertices[ vi * 3 + 0 ],
					Vertices[ vi * 3 + 1 ],
					Vertices[ vi * 3 + 2 ]
				) );

			}

			const sideUvs = [];
			const lights = [];
			for ( let i = 0; i < 4; i ++ ) {

				sideUvs.push( { u: side.uvls[ i ].u, v: side.uvls[ i ].v } );
				lights.push( Math.min( side.uvls[ i ].l, 1.0 ) );

			}

			const positions = [];
			const uvArr = [];
			const colors = [];

			const addTriangle = ( i0, i1, i2 ) => {

				positions.push(
					verts[ i0 ].x, verts[ i0 ].y, verts[ i0 ].z,
					verts[ i1 ].x, verts[ i1 ].y, verts[ i1 ].z,
					verts[ i2 ].x, verts[ i2 ].y, verts[ i2 ].z
				);

				uvArr.push(
					sideUvs[ i0 ].u, sideUvs[ i0 ].v,
					sideUvs[ i1 ].u, sideUvs[ i1 ].v,
					sideUvs[ i2 ].u, sideUvs[ i2 ].v
				);

				const l0 = lights[ i0 ];
				const l1 = lights[ i1 ];
				const l2 = lights[ i2 ];
				colors.push(
					l0, l0, l0,
					l1, l1, l1,
					l2, l2, l2
				);

			};

			switch ( side.type ) {

				case SIDE_IS_TRI_02:
					addTriangle( 0, 2, 1 );
					addTriangle( 2, 0, 3 );
					break;

				case SIDE_IS_TRI_13:
					addTriangle( 3, 1, 0 );
					addTriangle( 1, 3, 2 );
					break;

				case SIDE_IS_QUAD:
				default:
					addTriangle( 0, 2, 1 );
					addTriangle( 0, 3, 2 );
					break;

			}

			textureSides.get( texKey ).sides.push( {
				segnum: segnum,
				positions: positions,
				uvs: uvArr,
				colors: colors
			} );

		}

	}

	// Phase 2: Build one BatchedMesh per unique texture
	let totalTriangles = 0;
	let totalBatchedSides = 0;

	for ( const [ texKey, data ] of textureSides ) {

		const numSides = data.sides.length;
		if ( numSides === 0 ) continue;

		const maxVertices = numSides * 6; // 2 triangles × 3 vertices per side

		const material = getMaterial( data.texture, data.transparent );

		const batchedMesh = new THREE.BatchedMesh( numSides, maxVertices, 0, material );

		for ( let i = 0; i < numSides; i ++ ) {

			const sideData = data.sides[ i ];

			const tempGeo = new THREE.BufferGeometry();
			tempGeo.setAttribute( 'position', new THREE.Float32BufferAttribute( sideData.positions, 3 ) );
			tempGeo.setAttribute( 'uv', new THREE.Float32BufferAttribute( sideData.uvs, 2 ) );
			tempGeo.setAttribute( 'color', new THREE.Float32BufferAttribute( sideData.colors, 3 ) );

			const geoId = batchedMesh.addGeometry( tempGeo );
			const instId = batchedMesh.addInstance( geoId );
			batchedMesh.setMatrixAt( instId, _identityMatrix );

			// Start invisible — updateMineVisibility will show visible ones
			batchedMesh.setVisibleAt( instId, false );

			tempGeo.dispose();

			// Register for per-segment visibility lookup
			const segnum = sideData.segnum;

			if ( segmentBatchedInstances.has( segnum ) === false ) {

				segmentBatchedInstances.set( segnum, [] );

			}

			segmentBatchedInstances.get( segnum ).push( {
				batchedMesh: batchedMesh,
				instanceId: instId
			} );

			totalBatchedSides ++;

		}

		group.add( batchedMesh );
		allBatchedMeshes.push( batchedMesh );
		totalTriangles += numSides * 2;

	}

	// Phase 3: Register eclip textures for in-place animation
	for ( const tmapNum of eclipTmapSet ) {

		const bitmapIndex = Textures[ tmapNum ];
		const tex = textureCache.get( bitmapIndex );
		if ( tex !== undefined ) {

			registerEclipTexture( tmapNum, tex );

		}

	}

	// Register eclip overlay textures for animation
	const registeredOverlayKeys = new Set();

	for ( let segnum = 0; segnum < Num_segments; segnum ++ ) {

		const seg = Segments[ segnum ];

		for ( let sidenum = 0; sidenum < MAX_SIDES_PER_SEGMENT; sidenum ++ ) {

			const side = seg.sides[ sidenum ];
			if ( side.tmap_num2 === 0 ) continue;

			const decoded = decode_tmap_num2( side.tmap_num2 );
			if ( eclipTmapSet.has( decoded.index ) === false ) continue;

			const baseBmIndex = ( side.tmap_num >= 0 && side.tmap_num < NumTextures )
				? Textures[ side.tmap_num ] : 0;
			const overlayBmIndex = Textures[ decoded.index ];
			const rotation = decoded.rotation;
			const cacheKey = baseBmIndex + '_' + overlayBmIndex + '_' + rotation;

			if ( registeredOverlayKeys.has( cacheKey ) ) continue;

			const mergedTex = mergedTextureCache.get( cacheKey );
			if ( mergedTex === undefined ) continue;

			registeredOverlayKeys.add( cacheKey );

			if ( eclipOverlayTextures.has( decoded.index ) === false ) {

				eclipOverlayTextures.set( decoded.index, [] );

			}

			eclipOverlayTextures.get( decoded.index ).push( {
				dataTexture: mergedTex,
				baseBmIndex: baseBmIndex,
				rotation: rotation
			} );

		}

	}

	let totalOverlays = 0;
	for ( const [ key, arr ] of eclipOverlayTextures ) {

		totalOverlays += arr.length;

	}

	console.log( 'RENDER: Built ' + allBatchedMeshes.length + ' BatchedMeshes (' + totalBatchedSides + ' sides) + ' + doorMeshes.size + ' door meshes, ' + totalTriangles + ' triangles, ' + eclipTextures.size + ' eclip base textures, ' + totalOverlays + ' eclip overlay textures' );

	return group;

}

// --- BFS portal visibility ---
// Ported from: dxx-rebirth-master/similar/main/render.cpp build_segment_list()
// Traverses connected segments from player position, stopping at solid walls,
// closed doors, and portals outside the camera frustum

// Pre-allocated objects for frustum culling (Golden Rule #5)
const _frustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _portalBox = new THREE.Box3();
const _portalPoint = new THREE.Vector3();

function buildVisibleSegments( startSegnum, camera ) {

	_visibleSegments.clear();

	if ( startSegnum < 0 || startSegnum >= Num_segments ) return;

	// Build frustum from camera matrices
	_projScreenMatrix.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
	_frustum.setFromProjectionMatrix( _projScreenMatrix );

	_visibleSegments.add( startSegnum );
	_bfsQueue[ 0 ] = startSegnum;
	_bfsQueueLength = 1;
	let head = 0;

	while ( head < _bfsQueueLength && _visibleSegments.size < MAX_RENDER_SEGS ) {

		const segnum = _bfsQueue[ head ++ ];
		const seg = Segments[ segnum ];

		for ( let side = 0; side < 6; side ++ ) {

			const child = seg.children[ side ];
			if ( child < 0 ) continue;
			if ( _visibleSegments.has( child ) ) continue;

			// Check if we can see through this side
			const wid = wall_is_doorway( segnum, side );
			if ( ( wid & WID_RENDPAST_FLAG ) === 0 ) continue;

			// Check if portal opening is in the camera frustum
			const sv = Side_to_verts[ side ];
			_portalBox.makeEmpty();

			for ( let i = 0; i < 4; i ++ ) {

				const vi = seg.verts[ sv[ i ] ];
				_portalPoint.set(
					Vertices[ vi * 3 + 0 ],
					Vertices[ vi * 3 + 1 ],
					- Vertices[ vi * 3 + 2 ] // negate Z for Three.js
				);
				_portalBox.expandByPoint( _portalPoint );

			}

			if ( _frustum.intersectsBox( _portalBox ) ) {

				_visibleSegments.add( child );
				_bfsQueue[ _bfsQueueLength ++ ] = child;

			}

		}

	}

}

// Update mine visibility based on portal culling from player's current segment
// Called each frame before renderer.render()
export function updateMineVisibility( playerSegnum, camera ) {

	if ( camera === null || camera === undefined ) return;

	buildVisibleSegments( playerSegnum, camera );

	// Hide all batched instances
	for ( let i = 0; i < allBatchedMeshes.length; i ++ ) {

		const bm = allBatchedMeshes[ i ];
		const count = bm.instanceCount;
		for ( let j = 0; j < count; j ++ ) {

			bm.setVisibleAt( j, false );

		}

	}

	// Show instances in visible segments
	for ( const segnum of _visibleSegments ) {

		const instances = segmentBatchedInstances.get( segnum );
		if ( instances !== undefined ) {

			for ( let i = 0; i < instances.length; i ++ ) {

				const entry = instances[ i ];
				entry.batchedMesh.setVisibleAt( entry.instanceId, true );

			}

		}

	}

	// Update door mesh visibility
	for ( const [ key, mesh ] of doorMeshes ) {

		const segnum = ( key / 6 ) | 0;
		mesh.visible = _visibleSegments.has( segnum );

	}

	// Update destroyed side overlay visibility
	for ( const [ key, mesh ] of destroyedSideMeshes ) {

		const segnum = ( key / 6 ) | 0;
		mesh.visible = _visibleSegments.has( segnum );

	}

}

// Update a door mesh's texture when wall_set_tmap_num changes the side
// Called from wall.js via render callback
export function updateDoorMesh( segnum, sidenum ) {

	if ( _pigFile === null || _palette === null ) return;

	const key = segnum * 6 + sidenum;
	const mesh = doorMeshes.get( key );
	if ( mesh === undefined ) return;

	const seg = Segments[ segnum ];
	const side = seg.sides[ sidenum ];

	const result = getSideTexture( side, _pigFile, _palette );
	if ( result.texture === null ) return;

	// Reuse existing material — just swap texture properties (avoids shader recompilation)
	mesh.material.map = result.texture;
	mesh.material.alphaTest = result.isTransparent ? 0.5 : 0;
	mesh.material.needsUpdate = true;

}

// Toggle visibility of a wall side mesh (for illusion walls)
export function setWallMeshVisible( segnum, sidenum, visible ) {

	const key = segnum * 6 + sidenum;
	const mesh = doorMeshes.get( key );
	if ( mesh !== undefined ) {

		mesh.visible = visible;

	}

}

// Rebuild a side's overlay mesh after its tmap_num2 has changed
// Creates an individual mesh on top of the batched geometry to show the new texture
// Ported from: check_effect_blowup() / one-shot eclip completion in EFFECTS.C
export function rebuildSideOverlay( segnum, sidenum ) {

	if ( _pigFile === null || _palette === null || _mineGroup === null ) return;

	const key = segnum * 6 + sidenum;

	// If this side has a door mesh, just update it
	const doorMesh = doorMeshes.get( key );
	if ( doorMesh !== undefined ) {

		updateDoorMesh( segnum, sidenum );
		return;

	}

	// If we already created an overlay mesh for this side, update its texture
	const existing = destroyedSideMeshes.get( key );
	if ( existing !== undefined ) {

		const seg = Segments[ segnum ];
		const side = seg.sides[ sidenum ];
		const result = getSideTexture( side, _pigFile, _palette );
		if ( result.texture !== null ) {

			existing.material.map = result.texture;
			existing.material.alphaTest = result.isTransparent ? 0.5 : 0;
			existing.material.needsUpdate = true;

		}

		return;

	}

	// Create a new individual mesh for this side (overlays the batched geometry)
	const mesh = buildSideMesh( segnum, sidenum, _pigFile, _palette );
	if ( mesh === null ) return;

	destroyedSideMeshes.set( key, mesh );
	_mineGroup.add( mesh );

}

// Register a DataTexture as eclip-animated for a given tmap_num
// Called during buildMineGeometry when we detect an eclip texture
export function registerEclipTexture( tmapNum, dataTexture ) {

	if ( eclipTextures.has( tmapNum ) === false ) {

		eclipTextures.set( tmapNum, dataTexture );

	}

}

// Update an eclip-animated texture in-place with new bitmap data
// Called from effects.js when an eclip advances to a new frame
export function updateEclipTexture( tmapNum, newBitmapIndex ) {

	if ( _pigFile === null || _palette === null ) return;

	// Update base texture (eclip used as tmap_num)
	const dataTexture = eclipTextures.get( tmapNum );
	if ( dataTexture !== undefined ) {

		const pixels = _pigFile.getBitmapPixels( newBitmapIndex );
		if ( pixels !== null ) {

			const bm = _pigFile.bitmaps[ newBitmapIndex ];
			if ( bm !== undefined ) {

				const rgba = dataTexture.image.data;
				const w = dataTexture.image.width;
				const h = dataTexture.image.height;

				if ( bm.width === w && bm.height === h ) {

					const isTransparent = ( bm.flags & BM_FLAG_TRANSPARENT ) !== 0;

					for ( let i = 0; i < w * h; i ++ ) {

						const palIdx = pixels[ i ];

						if ( isTransparent === true && palIdx === 255 ) {

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

					dataTexture.needsUpdate = true;

				}

			}

		}

	}

	// Update overlay textures (eclip used as tmap_num2 in merged textures)
	// Merge base + overlay directly into RGBA to avoid temp array allocation (Golden Rule #5)
	const overlayEntries = eclipOverlayTextures.get( tmapNum );
	if ( overlayEntries !== undefined ) {

		const overlayPixels = _pigFile.getBitmapPixels( newBitmapIndex );
		if ( overlayPixels === null ) return;

		for ( let i = 0; i < overlayEntries.length; i ++ ) {

			const entry = overlayEntries[ i ];
			const basePixels = _pigFile.getBitmapPixels( entry.baseBmIndex );
			if ( basePixels === null ) continue;

			const baseBm = _pigFile.bitmaps[ entry.baseBmIndex ];
			if ( baseBm === undefined ) continue;

			const rgba = entry.dataTexture.image.data;
			const w = entry.dataTexture.image.width;
			const h = entry.dataTexture.image.height;

			if ( baseBm.width !== w || baseBm.height !== h ) continue;

			const rot = entry.rotation;

			for ( let y = 0; y < h; y ++ ) {

				for ( let x = 0; x < w; x ++ ) {

					// Compute overlay source position based on rotation
					let sx, sy;

					switch ( rot ) {

						case 0: sx = x; sy = y; break;
						case 1: sx = y; sy = ( w - 1 ) - x; break;
						case 2: sx = ( w - 1 ) - x; sy = ( h - 1 ) - y; break;
						case 3: sx = ( h - 1 ) - y; sy = x; break;
						default: sx = x; sy = y;

					}

					const srcIdx = sy * w + sx;
					let palIdx;

					if ( srcIdx >= 0 && srcIdx < overlayPixels.length &&
						overlayPixels[ srcIdx ] !== 255 ) {

						palIdx = overlayPixels[ srcIdx ];

					} else {

						palIdx = basePixels[ y * w + x ];

					}

					const dstIdx = ( y * w + x ) * 4;
					rgba[ dstIdx + 0 ] = _palette[ palIdx * 3 + 0 ];
					rgba[ dstIdx + 1 ] = _palette[ palIdx * 3 + 1 ];
					rgba[ dstIdx + 2 ] = _palette[ palIdx * 3 + 2 ];
					rgba[ dstIdx + 3 ] = 255;

				}

			}

			entry.dataTexture.needsUpdate = true;

		}

	}

}

// Clear all caches (call when loading a new level)
export function clearRenderCaches() {

	for ( const [ key, tex ] of textureCache ) {

		tex.dispose();

	}

	for ( const [ key, tex ] of mergedTextureCache ) {

		tex.dispose();

	}

	for ( const [ key, mat ] of materialCache ) {

		mat.dispose();

	}

	textureCache.clear();
	mergedTextureCache.clear();
	materialCache.clear();

	// Clear door meshes
	for ( const [ key, mesh ] of doorMeshes ) {

		if ( mesh.geometry !== null ) mesh.geometry.dispose();
		if ( mesh.material !== null ) mesh.material.dispose();

	}

	doorMeshes.clear();
	eclipTextures.clear();
	eclipOverlayTextures.clear();

	// Dispose BatchedMesh objects
	for ( let i = 0; i < allBatchedMeshes.length; i ++ ) {

		allBatchedMeshes[ i ].dispose();

	}

	allBatchedMeshes.length = 0;
	segmentBatchedInstances.clear();
	_visibleSegments.clear();

	// Clear destroyed side overlay meshes
	for ( const [ key, mesh ] of destroyedSideMeshes ) {

		if ( mesh.geometry !== null ) mesh.geometry.dispose();
		if ( mesh.material !== null ) mesh.material.dispose();

	}

	destroyedSideMeshes.clear();
	_mineGroup = null;

}
