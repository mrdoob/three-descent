// Ported from: descent-master/MAIN/POLYOBJ.C, POLYOBJ.H
// Polygon object (POF) model loading and rendering

import * as THREE from 'three';

// Constants
const MAX_SUBMODELS = 10;
const MAX_POLYGON_MODELS = 300;

// POF file signature
const POF_SIG = 0x4F505350;	// 'PSPO' as little-endian int32

// Chunk IDs (4-char codes as little-endian int32)
const ID_OHDR = 0x5244484F;	// 'OHDR'
const ID_SOBJ = 0x4A424F53;	// 'SOBJ'
const ID_GUNS = 0x534E5547;	// 'GUNS'
const ID_ANIM = 0x4D494E41;	// 'ANIM'
const ID_TXTR = 0x52545854;	// 'TXTR'
const ID_IDTA = 0x41544449;	// 'IDTA'

// Model bytecode opcodes
const OP_EOF = 0;
const OP_DEFPOINTS = 1;
const OP_FLATPOLY = 2;
const OP_TMAPPOLY = 3;
const OP_SORTNORM = 4;
const OP_RODBM = 5;
const OP_SUBCALL = 6;
const OP_DEFP_START = 7;
const OP_GLOW = 8;

// Palette for flat-shaded polygons (approximate Descent palette colors)
// We'll generate this from the actual palette when available
let flatColorPalette = null;

// Global model storage
export const Polygon_models = [];
export let N_polygon_models = 0;

export function set_N_polygon_models( n ) {

	N_polygon_models = n;

}

// Polymodel class - mirrors C struct polymodel
export class Polymodel {

	constructor() {

		this.n_models = 0;		// number of submodels
		this.model_data = null;		// Uint8Array bytecode
		this.model_data_size = 0;
		this.submodel_ptrs = new Int32Array( MAX_SUBMODELS );	// byte offsets into model_data
		this.submodel_offsets = [];	// {x,y,z} per submodel
		this.submodel_norms = [];
		this.submodel_pnts = [];
		this.submodel_rads = new Float64Array( MAX_SUBMODELS );
		this.submodel_parents = new Uint8Array( MAX_SUBMODELS );
		this.submodel_mins = [];
		this.submodel_maxs = [];
		this.mins = { x: 0, y: 0, z: 0 };
		this.maxs = { x: 0, y: 0, z: 0 };
		this.rad = 0;
		this.n_textures = 0;
		this.first_texture = 0;
		this.simpler_model = 0;

		for ( let i = 0; i < MAX_SUBMODELS; i ++ ) {

			this.submodel_offsets.push( { x: 0, y: 0, z: 0 } );
			this.submodel_norms.push( { x: 0, y: 0, z: 0 } );
			this.submodel_pnts.push( { x: 0, y: 0, z: 0 } );
			this.submodel_mins.push( { x: 0, y: 0, z: 0 } );
			this.submodel_maxs.push( { x: 0, y: 0, z: 0 } );

		}

		// Texture names from TXTR chunk (model-local indices map to these)
		this.textureNames = [];

		// Gun hardpoints from GUNS chunk (used by reactor/robots)
		this.n_guns = 0;
		this.gun_points = [];	// {x,y,z} per gun (model-space)
		this.gun_dirs = [];		// {x,y,z} per gun (model-space)
		this.gun_submodels = [];	// which submodel each gun is on

		// Animation data from ANIM chunk (null = no animation)
		// anim_angs[state][submodel] = {p, b, h} in radians
		this.anim_angs = null;

		// Three.js mesh (built on first use)
		this.mesh = null;

		// Animated mesh (hierarchical submodel groups, built on first use)
		this.animatedMesh = null;

	}

}

// Read a vms_vector (3 fix values = 12 bytes) from DataView
function readVec( dv, offset ) {

	return {
		x: dv.getInt32( offset, true ) / 65536.0,
		y: dv.getInt32( offset + 4, true ) / 65536.0,
		z: dv.getInt32( offset + 8, true ) / 65536.0
	};

}

// Read a uint16 from DataView
function readU16( dv, offset ) {

	return dv.getUint16( offset, true );

}

// Read an int16 from DataView
function readI16( dv, offset ) {

	return dv.getInt16( offset, true );

}

// Read a fix (int32) from DataView, convert to float
function readFix( dv, offset ) {

	return dv.getInt32( offset, true ) / 65536.0;

}

// Parse a POF file from a CFile reader
export function load_polygon_model( fp ) {

	const model = new Polymodel();

	const fileStart = fp.tell();
	const fileSize = fp.length();

	// Read signature
	const sig = fp.readInt();
	if ( ( sig & 0xFFFFFFFF ) !== ( POF_SIG & 0xFFFFFFFF ) ) {

		console.error( 'POF: Invalid signature 0x' + ( sig >>> 0 ).toString( 16 ) );
		return null;

	}

	// Read version
	const version = fp.readShort();

	// Read chunks
	while ( fp.tell() < fileSize ) {

		const chunkId = fp.readInt();
		const chunkLen = fp.readInt();
		const chunkStart = fp.tell();

		if ( ( chunkId & 0xFFFFFFFF ) === ( ID_OHDR & 0xFFFFFFFF ) ) {

			// Object header
			model.n_models = fp.readInt();
			model.rad = fp.readFix();
			const rmin = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
			const rmax = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
			model.mins = rmin;
			model.maxs = rmax;

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_SOBJ & 0xFFFFFFFF ) ) {

			// Subobject — subnum and parent are shorts (2 bytes), not ints
			const subnum = fp.readShort();
			if ( subnum >= 0 && subnum < MAX_SUBMODELS ) {

				model.submodel_parents[ subnum ] = fp.readShort();
				model.submodel_norms[ subnum ] = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
				model.submodel_pnts[ subnum ] = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
				model.submodel_offsets[ subnum ] = { x: fp.readFix(), y: fp.readFix(), z: fp.readFix() };
				model.submodel_rads[ subnum ] = fp.readFix();
				model.submodel_ptrs[ subnum ] = fp.readInt();

			}

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_TXTR & 0xFFFFFFFF ) ) {

			// Texture names (model-local bitmap indices map to these)
			const nTextures = fp.readShort();
			for ( let i = 0; i < nTextures; i ++ ) {

				// Read null-terminated string
				let name = '';
				while ( true ) {

					const ch = fp.readUByte();
					if ( ch === 0 ) break;
					name += String.fromCharCode( ch );

				}

				model.textureNames.push( name );

			}

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_ANIM & 0xFFFFFFFF ) ) {

			// Animation data chunk — per-state angles for each submodel
			// Ported from: POLYOBJ.C lines 376-399 — ID_ANIM handler
			const n_frames = fp.readShort();

			if ( n_frames > 0 && model.n_models > 0 ) {

				model.anim_angs = [];

				for ( let f = 0; f < n_frames; f ++ ) {

					const stateAngles = [];

					for ( let m = 0; m < model.n_models; m ++ ) {

						stateAngles.push( { p: 0, b: 0, h: 0 } );

					}

					model.anim_angs.push( stateAngles );

				}

				// Read order: for each submodel m, for each state f
				// Each vms_angvec = 3 * int16 (p, b, h in fixang units)
				const ANG_SCALE = 2.0 * Math.PI / 65536.0;

				for ( let m = 0; m < model.n_models; m ++ ) {

					for ( let f = 0; f < n_frames; f ++ ) {

						const p = fp.readShort();
						const b = fp.readShort();
						const h = fp.readShort();
						model.anim_angs[ f ][ m ].p = p * ANG_SCALE;
						model.anim_angs[ f ][ m ].b = b * ANG_SCALE;
						model.anim_angs[ f ][ m ].h = h * ANG_SCALE;

					}

				}

			}

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_IDTA & 0xFFFFFFFF ) ) {

			// Interpreter data (bytecode)
			model.model_data_size = chunkLen;
			model.model_data = fp.readBytes( chunkLen );

		} else if ( ( chunkId & 0xFFFFFFFF ) === ( ID_GUNS & 0xFFFFFFFF ) ) {

			// Gun hardpoints — ported from polyobj.c read_model_guns() / pof_read_data() ID_GUNS handler
			// Format: int(n_guns), then per gun (28 bytes):
			//   short(gun_id), short(submodel), fix(px,py,pz), fix(dx,dy,dz)
			model.n_guns = fp.readInt();

			// Pre-allocate arrays so gun_id indexing works (guns may be out of order)
			for ( let i = 0; i < model.n_guns; i ++ ) {

				model.gun_submodels.push( 0 );
				model.gun_points.push( { x: 0, y: 0, z: 0 } );
				model.gun_dirs.push( { x: 0, y: 0, z: 0 } );

			}

			for ( let i = 0; i < model.n_guns; i ++ ) {

				const gun_id = fp.readShort();
				const submodel = fp.readShort();
				const px = fp.readFix();
				const py = fp.readFix();
				const pz = fp.readFix();
				const dx = fp.readFix();
				const dy = fp.readFix();
				const dz = fp.readFix();

				if ( gun_id >= 0 && gun_id < model.n_guns ) {

					model.gun_submodels[ gun_id ] = submodel;
					model.gun_points[ gun_id ] = { x: px, y: py, z: pz };
					model.gun_dirs[ gun_id ] = { x: dx, y: dy, z: dz };

				}

			}

		}

		// Skip to end of chunk
		fp.seek( chunkStart + chunkLen );

	}

	return model;

}

// Interpret model bytecode and extract polygons for Three.js
// Returns { flatPolys, texPolys }
// startOffset: byte offset in model_data to start interpreting from
function interpretModelData( model, startOffset, offsetX, offsetY, offsetZ, subobj_flags ) {

	const data = model.model_data;
	if ( data === null ) return null;

	const dv = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const startPtr = startOffset;

	// Vertex buffer built by DEFPOINTS/DEFP_START
	const points = [];	// array of {x, y, z}

	// Collected polygons
	const flatPolys = [];	// { verts: [{x,y,z}...], color: int }
	const texPolys = [];	// { verts: [{x,y,z}...], uvs: [{u,v}...], bitmap: int }

	// Track current submodel for subobj_flags filtering
	let currentSubmodel = 0;

	// Glow state: set by OP_GLOW, consumed by next OP_TMAPPOLY
	// Ported from: 3D/INTERP.ASM — glow_num variable
	let glowNum = - 1;

	// Recursive interpreter — offX/Y/Z accumulate submodel offsets
	function interpret( ptr, offX, offY, offZ ) {

		while ( ptr < data.length - 2 ) {

			const opcode = readU16( dv, ptr );

			switch ( opcode ) {

				case OP_EOF:
					return;

				case OP_DEFPOINTS: {

					const n = readU16( dv, ptr + 2 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 4 + i * 12 );
						points[ i ] = {
							x: v.x + offX,
							y: v.y + offY,
							z: v.z + offZ
						};

					}

					ptr += 4 + n * 12;
					break;

				}

				case OP_DEFP_START: {

					const n = readU16( dv, ptr + 2 );
					const start = readU16( dv, ptr + 4 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 8 + i * 12 );
						points[ start + i ] = {
							x: v.x + offX,
							y: v.y + offY,
							z: v.z + offZ
						};

					}

					ptr += 8 + n * 12;
					break;

				}

				case OP_FLATPOLY: {

					const nv = readU16( dv, ptr + 2 );

					if ( subobj_flags === undefined || ( subobj_flags & ( 1 << currentSubmodel ) ) !== 0 ) {

					// Normal at ptr+4 (12 bytes), center at ptr+16 (12 bytes)
					const color = readU16( dv, ptr + 28 );

					const verts = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					if ( verts.length >= 3 ) {

						flatPolys.push( { verts, color } );

					}

					}

					ptr += 30 + ( nv | 1 ) * 2;
					break;

				}

				case OP_TMAPPOLY: {

					const nv = readU16( dv, ptr + 2 );
					const uvlOffset = 30 + ( nv | 1 ) * 2;

					if ( subobj_flags === undefined || ( subobj_flags & ( 1 << currentSubmodel ) ) !== 0 ) {

					// Normal at ptr+4, center at ptr+16
					const bitmap = readU16( dv, ptr + 28 );

					const verts = [];
					const uvs = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					for ( let i = 0; i < nv; i ++ ) {

						uvs.push( {
							u: readFix( dv, ptr + uvlOffset + i * 12 ),
							v: readFix( dv, ptr + uvlOffset + i * 12 + 4 )
						} );

					}

					if ( verts.length >= 3 ) {

						// Mark glow polygons — OP_GLOW sets glowNum for the next OP_TMAPPOLY
						// Ported from: 3D/INTERP.ASM — glow_num consumed by tmappoly handler
						const isGlow = ( glowNum >= 0 );
						texPolys.push( { verts, uvs, bitmap, isGlow } );

					}

					// Reset glow state after consuming (single-use per original)
					glowNum = - 1;

					}

					ptr += uvlOffset + nv * 12;
					break;

				}

				case OP_SORTNORM: {

					// BSP node: interpret both children (Three.js handles depth sorting)
					// After processing both subtrees, return — the children contain all
					// geometry for this BSP subtree.  Continuing the while loop would
					// re-enter the first child's data (when its offset == 32) and cause
					// exponential polygon duplication with nested BSP depth.
					const backOff = readU16( dv, ptr + 28 );
					const frontOff = readU16( dv, ptr + 30 );
					interpret( ptr + backOff, offX, offY, offZ );
					interpret( ptr + frontOff, offX, offY, offZ );
					return;

				}

				case OP_RODBM: {

					// Rod bitmap - skip for now (rare in level models)
					ptr += 36;
					break;

				}

				case OP_SUBCALL: {

					const subNum = readU16( dv, ptr + 2 );
					const subOffset = readVec( dv, ptr + 4 );
					const codeOffset = readU16( dv, ptr + 16 );

					// Only interpret submodel if its flag is set (or render all if no flags)
					if ( subobj_flags === undefined || ( subobj_flags & ( 1 << subNum ) ) !== 0 ) {

						const prevSubmodel = currentSubmodel;
						currentSubmodel = subNum;
						interpret(
							ptr + codeOffset,
							offX + subOffset.x,
							offY + subOffset.y,
							offZ + subOffset.z
						);
						currentSubmodel = prevSubmodel;

					}

					ptr += 20;
					break;

				}

				case OP_GLOW: {

					// Set glow index for the next OP_TMAPPOLY polygon
					// Ported from: 3D/INTERP.ASM op_glow — reads 2-byte glow_num at offset +2
					glowNum = readU16( dv, ptr + 2 );
					ptr += 4;
					break;

				}

				default:
					// Unknown opcode, bail
					console.warn( 'POF: Unknown opcode ' + opcode + ' at offset ' + ptr );
					return;

			}

		}

	}

	interpret( startPtr, offsetX, offsetY, offsetZ );

	return { flatPolys, texPolys };

}

// Convert RGB 5-5-5 packed color to float RGB
// Ported from: 3D/INTERP.ASM — OP_FLATPOLY color field is 15-bit RGB (not a palette index).
// The original code calls gr_find_closest_color_15bpp() to convert to palette at init time,
// but since we render in true color, we decode directly.
// Format: bits 10-14 = Red(0-31), bits 5-9 = Green(0-31), bits 0-4 = Blue(0-31)
function rgb15toFloat( rgb15 ) {

	const r = ( ( rgb15 >> 10 ) & 31 ) / 31;
	const g = ( ( rgb15 >> 5 ) & 31 ) / 31;
	const b = ( rgb15 & 31 ) / 31;
	return { r, g, b };

}

// Cache for model textures (keyed by PIG bitmap index)
const modelTextureCache = new Map();

// Build a Three.js DataTexture from PIG bitmap data
function buildModelTexture( bitmapIndex, pigFile, palette ) {

	if ( modelTextureCache.has( bitmapIndex ) ) {

		return modelTextureCache.get( bitmapIndex );

	}

	const pixels = pigFile.getBitmapPixels( bitmapIndex );
	if ( pixels === null ) return null;

	const bm = pigFile.bitmaps[ bitmapIndex ];
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

			rgba[ i * 4 + 0 ] = palette[ palIdx * 3 + 0 ];
			rgba[ i * 4 + 1 ] = palette[ palIdx * 3 + 1 ];
			rgba[ i * 4 + 2 ] = palette[ palIdx * 3 + 2 ];
			rgba[ i * 4 + 3 ] = 255;

		}

	}

	const texture = new THREE.DataTexture( rgba, w, h );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestMipmapLinearFilter;
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;

	modelTextureCache.set( bitmapIndex, texture );
	return texture;

}

// Build a Three.js Mesh for a group of texture-mapped polys sharing the same bitmap slot
// isGlow: if true, create emissive material for engine glow polygons
// Ported from: 3D/INTERP.ASM — glow polygons use glow_values[] intensity instead of normal lighting
function buildTexGroupMesh( bitmapSlot, polys, textureBitmapIndices, pigFile, palette, isGlow ) {

	const positions = [];
	const uvs = [];

	for ( let i = 0; i < polys.length; i ++ ) {

		const poly = polys[ i ];

		for ( let j = 1; j < poly.verts.length - 1; j ++ ) {

			const v0 = poly.verts[ 0 ];
			const v1 = poly.verts[ j ];
			const v2 = poly.verts[ j + 1 ];

			positions.push( v0.x, v0.y, - v0.z );
			positions.push( v1.x, v1.y, - v1.z );
			positions.push( v2.x, v2.y, - v2.z );

			const uv0 = poly.uvs[ 0 ];
			const uv1 = poly.uvs[ j ];
			const uv2 = poly.uvs[ j + 1 ];

			uvs.push( uv0.u, uv0.v );
			uvs.push( uv1.u, uv1.v );
			uvs.push( uv2.u, uv2.v );

		}

	}

	if ( positions.length === 0 ) return null;

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );

	// Look up actual texture for this bitmap slot
	const pigBitmapIndex = textureBitmapIndices[ bitmapSlot ];
	let mat;

	if ( pigBitmapIndex !== undefined && pigBitmapIndex >= 0 ) {

		const texture = buildModelTexture( pigBitmapIndex, pigFile, palette );
		if ( texture !== null ) {

			mat = new THREE.MeshBasicMaterial( {
				map: texture,
				side: THREE.DoubleSide
			} );

		} else {

			mat = new THREE.MeshBasicMaterial( {
				color: 0x808080,
				side: THREE.DoubleSide
			} );

		}

	} else {

		mat = new THREE.MeshBasicMaterial( {
			color: 0x808080,
			side: THREE.DoubleSide
		} );

	}

	const mesh = new THREE.Mesh( geo, mat );
	if ( isGlow ) mesh.userData.isGlowMesh = true;
	return mesh;

}

// After cloning a model group, rebuild the glowMeshes array from tagged children
// Required because .clone() creates new child objects but userData.glowMeshes still references originals
export function polyobj_rebuild_glow_refs( group ) {

	if ( group === null ) return;

	const glowMeshes = [];

	group.traverse( ( child ) => {

		if ( child.userData.isGlowMesh === true ) {

			glowMeshes.push( child );

		}

	} );

	if ( glowMeshes.length > 0 ) {

		group.userData.glowMeshes = glowMeshes;

	} else {

		delete group.userData.glowMeshes;

	}

}

// Build a Three.js mesh from a polymodel
// pigFile: PigFile instance for texture lookup
// palette: Uint8Array(768) VGA palette scaled to 0-255
export function buildModelMesh( model, pigFile, palette, subobj_flags ) {

	if ( model === null || model.model_data === null ) return null;

	// Interpret the master bytecode starting at offset 0 (contains BSP tree + SUBCALLs)
	const result = interpretModelData( model, 0, 0, 0, 0, subobj_flags );
	if ( result === null ) return null;

	const { flatPolys, texPolys } = result;

	if ( flatPolys.length === 0 && texPolys.length === 0 ) return null;

	// Resolve model texture names to PIG bitmap indices
	const textureBitmapIndices = [];
	for ( let i = 0; i < model.textureNames.length; i ++ ) {

		const idx = pigFile.findBitmapIndexByName( model.textureNames[ i ] );
		textureBitmapIndices.push( idx );

	}

	// Group to hold all sub-meshes
	const group = new THREE.Group();

	// --- Build flat-shaded polygons mesh (vertex colors) ---
	if ( flatPolys.length > 0 ) {

		const positions = [];
		const colors = [];

		for ( let i = 0; i < flatPolys.length; i ++ ) {

			const poly = flatPolys[ i ];
			const rgb = rgb15toFloat( poly.color );

			for ( let j = 1; j < poly.verts.length - 1; j ++ ) {

				const v0 = poly.verts[ 0 ];
				const v1 = poly.verts[ j ];
				const v2 = poly.verts[ j + 1 ];

				positions.push( v0.x, v0.y, - v0.z );
				positions.push( v1.x, v1.y, - v1.z );
				positions.push( v2.x, v2.y, - v2.z );

				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );

			}

		}

		if ( positions.length > 0 ) {

			const geo = new THREE.BufferGeometry();
			geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
			geo.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );

			const mat = new THREE.MeshBasicMaterial( {
				vertexColors: true,
				side: THREE.DoubleSide
			} );

			group.add( new THREE.Mesh( geo, mat ) );

		}

	}

	// --- Build texture-mapped polygons (grouped by bitmap index) ---
	// Separate glow polys from normal polys — glow polys get emissive materials
	// Ported from: 3D/INTERP.ASM — OP_GLOW sets glow_num, consumed by next tmappoly
	const texGroupsNormal = new Map();
	const texGroupsGlow = new Map();

	for ( let i = 0; i < texPolys.length; i ++ ) {

		const poly = texPolys[ i ];
		const bitmapSlot = poly.bitmap;
		const targetMap = ( poly.isGlow === true ) ? texGroupsGlow : texGroupsNormal;

		if ( targetMap.has( bitmapSlot ) !== true ) {

			targetMap.set( bitmapSlot, [] );

		}

		targetMap.get( bitmapSlot ).push( poly );

	}

	// Build normal texture meshes
	for ( const [ bitmapSlot, polys ] of texGroupsNormal ) {

		const mesh = buildTexGroupMesh( bitmapSlot, polys, textureBitmapIndices, pigFile, palette, false );
		if ( mesh !== null ) group.add( mesh );

	}

	// Build glow texture meshes (emissive materials for engine glow)
	const glowMeshes = [];

	for ( const [ bitmapSlot, polys ] of texGroupsGlow ) {

		const mesh = buildTexGroupMesh( bitmapSlot, polys, textureBitmapIndices, pigFile, palette, true );
		if ( mesh !== null ) {

			glowMeshes.push( mesh );
			group.add( mesh );

		}

	}

	if ( glowMeshes.length > 0 ) {

		group.userData.glowMeshes = glowMeshes;

	}

	if ( group.children.length === 0 ) return null;

	return group;

}

// Shareware model table: maps model_num to .pof filename
// Built from analyzing bitmaps.bin with shareware (@) prefix filtering
// Each $ROBOT with simple_model loads 2 models (main + simple)
// $OBJECT with dead_pof loads 2 models
// $PLAYER_SHIP with simple + dying loads 3 models
const SHAREWARE_MODEL_TABLE = [
	'robot09.pof',		// 0: Robot 0 main
	'robot09s.pof',		// 1: Robot 0 simple
	'robot17.pof',		// 2: Robot 1 main
	'robot17s.pof',		// 3: Robot 1 simple
	'robot22.pof',		// 4: Robot 2 main
	'robot22s.pof',		// 5: Robot 2 simple
	'robot01.pof',		// 6: Robot 3 main
	'robot01s.pof',		// 7: Robot 3 simple
	'robot23.pof',		// 8: Robot 4 main
	'robot23s.pof',		// 9: Robot 4 simple
	'robot32.pof',		// 10: Robot 5 main
	'robot32s.pof',		// 11: Robot 5 simple
	'robot09.pof',		// 12: Robot 6 main (reuse)
	'robot09s.pof',		// 13: Robot 6 simple
	'boss01.pof',		// 14: Robot 7 (boss, no simple)
	'robot35.pof',		// 15: Robot 8 main
	'robot35s.pof',		// 16: Robot 8 simple
	'robot37.pof',		// 17: Robot 9 main
	'robot37s.pof',		// 18: Robot 9 simple
	'robot38.pof',		// 19: Robot 10 main
	'robot38s.pof',		// 20: Robot 10 simple
	'reactor.pof',		// 21: Reactor main
	'reactor2.pof',		// 22: Reactor destroyed
	'exit01.pof',		// 23: Exit main
	'exit01d.pof',		// 24: Exit destroyed
	'pship1.pof',		// 25: Player ship main
	'pship1s.pof',		// 26: Player ship simple
	'pship1b.pof',		// 27: Player ship dying
];

// Load all polygon models from HOG file for shareware
export function loadSharewareModels( hogFile ) {

	const loaded = {};	// cache: filename -> Polymodel

	for ( let i = 0; i < SHAREWARE_MODEL_TABLE.length; i ++ ) {

		const filename = SHAREWARE_MODEL_TABLE[ i ];

		// Check cache first (some models are reused)
		if ( loaded[ filename ] !== undefined ) {

			Polygon_models[ i ] = loaded[ filename ];

		} else {

			const pofFile = hogFile.findFile( filename );
			if ( pofFile !== null ) {

				const model = load_polygon_model( pofFile );
				if ( model !== null ) {

					Polygon_models[ i ] = model;
					loaded[ filename ] = model;

				} else {

					console.warn( 'POF: Failed to parse ' + filename );
					Polygon_models[ i ] = null;

				}

			} else {

				console.warn( 'POF: ' + filename + ' not found in HOG' );
				Polygon_models[ i ] = null;

			}

		}

	}

	// Keep N_polygon_models as max of table size and any previously loaded models (e.g. weapon POFs)
	if ( SHAREWARE_MODEL_TABLE.length > N_polygon_models ) {

		N_polygon_models = SHAREWARE_MODEL_TABLE.length;

	}

	console.log( 'POF: Loaded ' + Object.keys( loaded ).length + ' unique models, ' + N_polygon_models + ' total entries' );

}

// Calculate gun points in model-local coordinates by accumulating submodel offsets
// Ported from: BMREAD.C lines 1485-1498 (player ship gun point setup)
// Returns array of {x,y,z} gun points transformed from submodel-local to model-local space
export function polyobj_calc_gun_points( model ) {

	const result = [];

	for ( let gun_num = 0; gun_num < model.n_guns; gun_num ++ ) {

		// Start with gun point relative to its submodel
		let px = model.gun_points[ gun_num ].x;
		let py = model.gun_points[ gun_num ].y;
		let pz = model.gun_points[ gun_num ].z;

		// Instance up the tree for this gun — accumulate submodel offsets
		let mn = model.gun_submodels[ gun_num ];

		while ( mn !== 0 ) {

			px += model.submodel_offsets[ mn ].x;
			py += model.submodel_offsets[ mn ].y;
			pz += model.submodel_offsets[ mn ].z;
			mn = model.submodel_parents[ mn ];

		}

		result.push( { x: px, y: py, z: pz } );

	}

	return result;

}

// Build a Three.js mesh for a single submodel of a polymodel
// Caches result on the model object for reuse
// Ported from: object_create_debris() in FIREBALL.C (renders with subobj_flags = 1<<subobj_num)
export function buildSubmodelMesh( model, submodelNum, pigFile, palette ) {

	if ( model === null || model.model_data === null ) return null;

	// Check cache
	if ( model._submodelMeshes === undefined ) {

		model._submodelMeshes = {};

	}

	if ( model._submodelMeshes[ submodelNum ] !== undefined ) {

		return model._submodelMeshes[ submodelNum ];

	}

	// Build mesh with only this submodel's polys visible
	const mesh = buildModelMesh( model, pigFile, palette, 1 << submodelNum );
	model._submodelMeshes[ submodelNum ] = mesh;
	return mesh;

}

// Interpret bytecode for a single submodel, extracting only that submodel's geometry
// Does NOT follow OP_SUBCALL — each submodel is built independently
// Points are in submodel-local coordinates (no parent offset accumulation)
function interpretSingleSubmodel( model, submodelNum ) {

	const data = model.model_data;
	if ( data === null ) return null;

	const dv = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const startPtr = ( submodelNum === 0 ) ? 0 : model.submodel_ptrs[ submodelNum ];

	const points = [];
	const flatPolys = [];
	const texPolys = [];

	// Glow state for OP_GLOW tracking (same as interpretModelData)
	let glowNum = - 1;

	function interpret( ptr ) {

		while ( ptr < data.length - 2 ) {

			const opcode = readU16( dv, ptr );

			switch ( opcode ) {

				case OP_EOF:
					return;

				case OP_DEFPOINTS: {

					const n = readU16( dv, ptr + 2 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 4 + i * 12 );
						points[ i ] = { x: v.x, y: v.y, z: v.z };

					}

					ptr += 4 + n * 12;
					break;

				}

				case OP_DEFP_START: {

					const n = readU16( dv, ptr + 2 );
					const start = readU16( dv, ptr + 4 );
					for ( let i = 0; i < n; i ++ ) {

						const v = readVec( dv, ptr + 8 + i * 12 );
						points[ start + i ] = { x: v.x, y: v.y, z: v.z };

					}

					ptr += 8 + n * 12;
					break;

				}

				case OP_FLATPOLY: {

					const nv = readU16( dv, ptr + 2 );
					const color = readU16( dv, ptr + 28 );
					const verts = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					if ( verts.length >= 3 ) {

						flatPolys.push( { verts, color } );

					}

					ptr += 30 + ( nv | 1 ) * 2;
					break;

				}

				case OP_TMAPPOLY: {

					const nv = readU16( dv, ptr + 2 );
					const uvlOffset = 30 + ( nv | 1 ) * 2;
					const bitmap = readU16( dv, ptr + 28 );
					const verts = [];
					const uvs = [];
					for ( let i = 0; i < nv; i ++ ) {

						const idx = readU16( dv, ptr + 30 + i * 2 );
						if ( points[ idx ] !== undefined ) {

							verts.push( { x: points[ idx ].x, y: points[ idx ].y, z: points[ idx ].z } );

						}

					}

					for ( let i = 0; i < nv; i ++ ) {

						uvs.push( {
							u: readFix( dv, ptr + uvlOffset + i * 12 ),
							v: readFix( dv, ptr + uvlOffset + i * 12 + 4 )
						} );

					}

					if ( verts.length >= 3 ) {

						const isGlow = ( glowNum >= 0 );
						texPolys.push( { verts, uvs, bitmap, isGlow } );

					}

					glowNum = - 1;

					ptr += uvlOffset + nv * 12;
					break;

				}

				case OP_SORTNORM: {

					const backOff = readU16( dv, ptr + 28 );
					const frontOff = readU16( dv, ptr + 30 );
					interpret( ptr + backOff );
					interpret( ptr + frontOff );
					return;

				}

				case OP_RODBM: {

					ptr += 36;
					break;

				}

				case OP_SUBCALL: {

					// Skip child submodel calls — build each submodel independently
					ptr += 20;
					break;

				}

				case OP_GLOW: {

					// Set glow index for next OP_TMAPPOLY
					glowNum = readU16( dv, ptr + 2 );
					ptr += 4;
					break;

				}

				default:
					return;

			}

		}

	}

	interpret( startPtr );
	return { flatPolys, texPolys };

}

// Build a Three.js Group from flat/tex polys (shared helper for mesh building)
function buildGroupFromPolys( flatPolys, texPolys, textureBitmapIndices, pigFile, palette ) {

	const group = new THREE.Group();

	// Build flat-shaded polygons mesh (vertex colors)
	if ( flatPolys.length > 0 ) {

		const positions = [];
		const colors = [];

		for ( let i = 0; i < flatPolys.length; i ++ ) {

			const poly = flatPolys[ i ];
			const rgb = rgb15toFloat( poly.color );

			for ( let j = 1; j < poly.verts.length - 1; j ++ ) {

				const v0 = poly.verts[ 0 ];
				const v1 = poly.verts[ j ];
				const v2 = poly.verts[ j + 1 ];

				positions.push( v0.x, v0.y, - v0.z );
				positions.push( v1.x, v1.y, - v1.z );
				positions.push( v2.x, v2.y, - v2.z );

				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );
				colors.push( rgb.r, rgb.g, rgb.b );

			}

		}

		if ( positions.length > 0 ) {

			const geo = new THREE.BufferGeometry();
			geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
			geo.setAttribute( 'color', new THREE.Float32BufferAttribute( colors, 3 ) );

			const mat = new THREE.MeshBasicMaterial( {
				vertexColors: true,
				side: THREE.DoubleSide
			} );

			group.add( new THREE.Mesh( geo, mat ) );

		}

	}

	// Build texture-mapped polygons — separate glow polys from normal polys
	const texGroupsNormal = new Map();
	const texGroupsGlow = new Map();

	for ( let i = 0; i < texPolys.length; i ++ ) {

		const poly = texPolys[ i ];
		const bitmapSlot = poly.bitmap;
		const targetMap = ( poly.isGlow === true ) ? texGroupsGlow : texGroupsNormal;

		if ( targetMap.has( bitmapSlot ) !== true ) {

			targetMap.set( bitmapSlot, [] );

		}

		targetMap.get( bitmapSlot ).push( poly );

	}

	// Build normal texture meshes
	for ( const [ bitmapSlot, polys ] of texGroupsNormal ) {

		const mesh = buildTexGroupMesh( bitmapSlot, polys, textureBitmapIndices, pigFile, palette, false );
		if ( mesh !== null ) group.add( mesh );

	}

	// Build glow texture meshes (emissive materials)
	const glowMeshes = [];

	for ( const [ bitmapSlot, polys ] of texGroupsGlow ) {

		const mesh = buildTexGroupMesh( bitmapSlot, polys, textureBitmapIndices, pigFile, palette, true );
		if ( mesh !== null ) {

			glowMeshes.push( mesh );
			group.add( mesh );

		}

	}

	if ( glowMeshes.length > 0 ) {

		group.userData.glowMeshes = glowMeshes;

	}

	return group;

}

// Build a hierarchical Three.js mesh with per-submodel groups for joint animation
// Returns a root THREE.Group with submodel groups arranged in parent-child tree
// Each submodel group tagged with userData.submodelIndex for extraction after cloning
// Ported from: g3_draw_polygon_model() + draw_polygon_model() — renders submodels hierarchically
export function buildAnimatedModelMesh( model, pigFile, palette ) {

	if ( model === null || model.model_data === null ) return null;
	if ( model.n_models <= 0 ) return null;

	// Resolve model texture names to PIG bitmap indices
	const textureBitmapIndices = [];
	for ( let i = 0; i < model.textureNames.length; i ++ ) {

		const idx = pigFile.findBitmapIndexByName( model.textureNames[ i ] );
		textureBitmapIndices.push( idx );

	}

	// Build per-submodel geometry and create groups
	const submodelGroups = new Array( model.n_models );

	for ( let s = 0; s < model.n_models; s ++ ) {

		const result = interpretSingleSubmodel( model, s );

		// Create the submodel's pivot group (rotations applied here)
		const pivotGroup = new THREE.Group();
		pivotGroup.userData.submodelIndex = s;
		pivotGroup.rotation.order = 'YXZ';

		if ( result !== null && ( result.flatPolys.length > 0 || result.texPolys.length > 0 ) ) {

			const geoGroup = buildGroupFromPolys(
				result.flatPolys, result.texPolys,
				textureBitmapIndices, pigFile, palette
			);

			// Transfer children from geoGroup to pivotGroup
			// (geoGroup.children mutates during add, so always take index 0)
			while ( geoGroup.children.length > 0 ) {

				pivotGroup.add( geoGroup.children[ 0 ] );

			}

			// Transfer glow mesh references from geoGroup to pivotGroup
			if ( geoGroup.userData.glowMeshes !== undefined ) {

				pivotGroup.userData.glowMeshes = geoGroup.userData.glowMeshes;

			}

		}

		// Position relative to parent (converted to Three.js coords: negate Z)
		if ( s > 0 ) {

			const off = model.submodel_offsets[ s ];
			pivotGroup.position.set( off.x, off.y, - off.z );

		}

		submodelGroups[ s ] = pivotGroup;

	}

	// Build parent-child hierarchy
	for ( let s = 1; s < model.n_models; s ++ ) {

		const parentIdx = model.submodel_parents[ s ];
		if ( parentIdx < model.n_models && submodelGroups[ parentIdx ] !== undefined ) {

			submodelGroups[ parentIdx ].add( submodelGroups[ s ] );

		}

	}

	// Collect glow meshes from all submodel groups into the root
	// This allows polyobj_set_glow() to update all glow meshes from the root group
	const allGlowMeshes = [];

	for ( let s = 0; s < model.n_models; s ++ ) {

		const sg = submodelGroups[ s ];
		if ( sg.userData.glowMeshes !== undefined ) {

			for ( let g = 0; g < sg.userData.glowMeshes.length; g ++ ) {

				allGlowMeshes.push( sg.userData.glowMeshes[ g ] );

			}

		}

	}

	if ( allGlowMeshes.length > 0 ) {

		submodelGroups[ 0 ].userData.glowMeshes = allGlowMeshes;

	}

	// Root is submodel 0
	return submodelGroups[ 0 ];

}

// Update engine glow intensity on a model mesh's glow polygons
// Ported from: OBJECT.C lines 618-638 — engine_glow_value computation
// glowValue: 0.0 to 1.0 (0.2 base + up to 0.8 from velocity/thrust)
export function polyobj_set_glow( group, glowValue ) {

	if ( group === null ) return;

	const glowMeshes = group.userData.glowMeshes;
	if ( glowMeshes === undefined ) return;

	for ( let i = 0; i < glowMeshes.length; i ++ ) {

		// With MeshBasicMaterial, modulate color to simulate glow brightness
		glowMeshes[ i ].material.color.setScalar( glowValue );

	}

}

// Compute engine glow value for an object based on its velocity
// Ported from: OBJECT.C lines 618-638 — engine_glow_value = F1_0/5 + speed/max * 4/5
// Returns: 0.2 to 1.0
const MAX_VELOCITY = 50.0;	// i2f(50) from OBJECT.C

export function compute_engine_glow( vx, vy, vz ) {

	const speed = Math.sqrt( vx * vx + vy * vy + vz * vz );
	const ratio = speed / MAX_VELOCITY;
	const clamped = ratio > 1.0 ? 1.0 : ratio;
	return 0.2 + clamped * 0.8;

}
