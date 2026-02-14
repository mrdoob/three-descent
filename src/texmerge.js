// Ported from: descent-master/MAIN/TEXMERGE.C
// Texture merging - composites overlay textures (tmap_num2) onto base textures (tmap_num)

// tmap_num2 encoding:
// bits 0-13: texture index
// bits 14-15: rotation (0=0deg, 1=90deg, 2=180deg, 3=270deg)

// Bitmap flags (from GR.H)
const BM_FLAG_SUPER_TRANSPARENT = 2;

export function decode_tmap_num2( tmap_num2 ) {

	return {
		index: tmap_num2 & 0x3FFF,
		rotation: ( tmap_num2 >> 14 ) & 3
	};

}

// Merge two 64x64 textures: base + overlay
// Overlay pixels with palette index 255 (transparent) are skipped
// If overlayFlags has BM_FLAG_SUPER_TRANSPARENT set, palette index 254 also maps to transparent (255)
// Rotation formulas from C (TEXMERGE.C):
//   0: src[y*64+x]           (identity)
//   1: src[x*64+(63-y)]      (90 CW)
//   2: src[(63-y)*64+(63-x)] (180)
//   3: src[(63-x)*64+y]      (270 CW)
export function texmerge_get_cached_bitmap( basePixels, overlayPixels, overlayRotation, width, height, overlayFlags ) {

	if ( basePixels === null ) return null;
	if ( overlayPixels === null ) return basePixels;

	const superTransparent = ( ( overlayFlags !== undefined ? overlayFlags : 0 ) & BM_FLAG_SUPER_TRANSPARENT ) !== 0;

	const result = new Uint8Array( width * height );
	result.set( basePixels );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			// Compute source position based on rotation
			// Ported from merge_textures_new() / merge_textures_super_xparent() in TEXMERGE.C
			let sx, sy;

			switch ( overlayRotation ) {

				case 0: sx = x; sy = y; break;
				case 1: sx = ( height - 1 ) - y; sy = x; break;
				case 2: sx = ( width - 1 ) - x; sy = ( height - 1 ) - y; break;
				case 3: sx = y; sy = ( width - 1 ) - x; break;
				default: sx = x; sy = y;

			}

			const srcIdx = sy * width + sx;
			if ( srcIdx >= 0 && srcIdx < overlayPixels.length ) {

				const pixel = overlayPixels[ srcIdx ];

				if ( superTransparent === true ) {

					// Super-transparent merge: 255 = use base, 254 = write transparent (255)
					// Ported from: merge_textures_super_xparent() in TEXMERGE.C
					if ( pixel === 255 ) {

						// Keep base pixel (already in result)

					} else if ( pixel === 254 ) {

						// Super-transparent: write 255 (transparent) to result
						result[ y * width + x ] = 255;

					} else {

						result[ y * width + x ] = pixel;

					}

				} else {

					// Normal merge: 255 = transparent (keep base)
					if ( pixel !== 255 ) {

						result[ y * width + x ] = pixel;

					}

				}

			}

		}

	}

	return result;

}
