// Ported from: descent-master/2D/FONT.C
// FNT file parser and bitmap font text renderer

// Font flags (from GR.H)
const FT_COLOR = 1;
const FT_PROPORTIONAL = 2;
const FT_KERNED = 4;

function BITS_TO_BYTES( x ) {

	return ( ( x + 7 ) >> 3 );

}

// Parsed font structure (mirrors grs_font in GR.H)
export class GrsFont {

	constructor() {

		this.ft_w = 0;			// Width in pixels
		this.ft_h = 0;			// Height in pixels
		this.ft_flags = 0;		// FT_COLOR | FT_PROPORTIONAL | FT_KERNED
		this.ft_baseline = 0;
		this.ft_minchar = 0;	// First char code defined
		this.ft_maxchar = 0;	// Last char code defined
		this.ft_bytewidth = 0;
		this.ft_data = null;	// Uint8Array of raw glyph data
		this.ft_chars = null;	// Array of offsets into ft_data for each char (proportional)
		this.ft_widths = null;	// Int16Array of per-char widths (proportional)
		this.ft_kerndata = null;	// Uint8Array of kerning triplets
		this.ft_palette = null;	// Uint8Array(768) for color fonts (already remapped to game palette)

	}

}

// Parse a .fnt file from a CFile
// Ported from: gr_init_font() in FONT.C lines 1006-1089
export function gr_init_font( cfile, gamePalette ) {

	// Read header
	const file_id = cfile.readUInt();
	const datasize = cfile.readInt();

	// 'NFSP' multi-char constant in C = 0x4E465350
	// File bytes: P(0x50), S(0x53), F(0x46), N(0x4E) → little-endian uint32 = 0x4E465350
	if ( file_id !== 0x4E465350 ) {

		console.error( 'FONT: Invalid font file_id: 0x' + file_id.toString( 16 ) );
		return null;

	}

	// Read the entire font data block (struct + glyph data)
	const fontDataStart = cfile.tell();
	const fontData = cfile.readBytes( datasize );

	const font = new GrsFont();
	const view = new DataView( fontData.buffer, fontData.byteOffset, fontData.byteLength );

	// Parse struct fields (28 bytes at start of fontData)
	// Ported from: grs_font struct in GR.H lines 174-185
	font.ft_w = view.getInt16( 0, true );
	font.ft_h = view.getInt16( 2, true );
	font.ft_flags = view.getInt16( 4, true );
	font.ft_baseline = view.getInt16( 6, true );
	font.ft_minchar = view.getUint8( 8 );
	font.ft_maxchar = view.getUint8( 9 );
	font.ft_bytewidth = view.getInt16( 10, true );

	// Offsets stored as pointers (relative to struct start when loaded)
	const dataOffset = view.getUint32( 12, true );
	const charsOffset = view.getUint32( 16, true );
	const widthsOffset = view.getUint32( 20, true );
	const kerndataOffset = view.getUint32( 24, true );

	const STRUCT_SIZE = 28;
	const nchars = font.ft_maxchar - font.ft_minchar + 1;

	if ( ( font.ft_flags & FT_PROPORTIONAL ) !== 0 ) {

		// Proportional font: widths array + per-char data pointers
		// In the C code: font->ft_widths = (short *) (((int) font->ft_widths) + ((ubyte *) font))
		// The stored value is an offset from the struct start
		const wOff = widthsOffset;
		font.ft_widths = new Int16Array( nchars );

		for ( let i = 0; i < nchars; i ++ ) {

			font.ft_widths[ i ] = view.getInt16( wOff + i * 2, true );

		}

		// ft_data offset
		const dOff = dataOffset;
		font.ft_data = fontData.subarray( dOff );

		// Build ft_chars: array of offsets into ft_data for each character
		font.ft_chars = new Array( nchars );
		let ptr = 0;

		for ( let i = 0; i < nchars; i ++ ) {

			font.ft_chars[ i ] = ptr;

			if ( ( font.ft_flags & FT_COLOR ) !== 0 ) {

				ptr += font.ft_widths[ i ] * font.ft_h;

			} else {

				ptr += BITS_TO_BYTES( font.ft_widths[ i ] ) * font.ft_h;

			}

		}

	} else {

		// Fixed-width font: data starts right after the struct
		font.ft_data = fontData.subarray( STRUCT_SIZE );
		font.ft_chars = null;
		font.ft_widths = null;

	}

	// Kerning data
	if ( ( font.ft_flags & FT_KERNED ) !== 0 ) {

		font.ft_kerndata = fontData.subarray( kerndataOffset );

	}

	// Color font: read palette after datasize bytes, remap to game palette
	if ( ( font.ft_flags & FT_COLOR ) !== 0 ) {

		const fontPalette = cfile.readBytes( 768 );

		// Build colormap: for each font palette index, find closest color in game palette
		const colormap = new Uint8Array( 256 );

		for ( let i = 0; i < 256; i ++ ) {

			if ( i === 255 ) {

				colormap[ i ] = 255; // Transparent stays transparent
				continue;

			}

			const fr = fontPalette[ i * 3 + 0 ];
			const fg = fontPalette[ i * 3 + 1 ];
			const fb = fontPalette[ i * 3 + 2 ];

			// Find closest color in game palette (palette values are 0-63)
			let bestDist = Infinity;
			let bestIdx = 0;

			for ( let j = 0; j < 256; j ++ ) {

				const gr = gamePalette[ j * 3 + 0 ] / 4; // Scale 0-255 to 0-63
				const gg = gamePalette[ j * 3 + 1 ] / 4;
				const gb = gamePalette[ j * 3 + 2 ] / 4;
				const dr = fr - gr;
				const dg = fg - gg;
				const db = fb - gb;
				const dist = dr * dr + dg * dg + db * db;

				if ( dist < bestDist ) {

					bestDist = dist;
					bestIdx = j;

					if ( dist === 0 ) break;

				}

			}

			colormap[ i ] = bestIdx;

		}

		// Remap font pixel data through colormap
		// Ported from: decode_data_asm() in FONT.C lines 995-1004
		const dataLen = font.ft_data.length;

		for ( let i = 0; i < dataLen; i ++ ) {

			font.ft_data[ i ] = colormap[ font.ft_data[ i ] ];

		}

		// Store font palette (already remapped indices — store the game palette for color lookup)
		font.ft_palette = fontPalette;

	}

	return font;

}

// Find kerning entry for a character pair
// Ported from: find_kern_entry() in FONT.C lines 154-165
function find_kern_entry( font, first, second ) {

	const kd = font.ft_kerndata;
	if ( kd === null ) return - 1;

	let p = 0;

	while ( kd[ p ] !== 255 ) {

		if ( kd[ p ] === first && kd[ p + 1 ] === second ) {

			return kd[ p + 2 ];

		}

		p += 3;

	}

	return - 1;

}

// Get character width and spacing
// Ported from: get_char_width() in FONT.C lines 171-210
function get_char_width( font, c, c2 ) {

	const letter = c - font.ft_minchar;
	let width, spacing;

	if ( letter < 0 || letter > font.ft_maxchar - font.ft_minchar ) {

		// Not in font, draw as space
		width = 0;

		if ( ( font.ft_flags & FT_PROPORTIONAL ) !== 0 ) {

			spacing = Math.floor( font.ft_w / 2 );

		} else {

			spacing = font.ft_w;

		}

		return { width: width, spacing: spacing };

	}

	if ( ( font.ft_flags & FT_PROPORTIONAL ) !== 0 ) {

		width = font.ft_widths[ letter ];

	} else {

		width = font.ft_w;

	}

	spacing = width;

	if ( ( font.ft_flags & FT_KERNED ) !== 0 ) {

		if ( c2 !== 0 && c2 !== 10 ) { // not null or newline

			const letter2 = c2 - font.ft_minchar;

			if ( letter2 >= 0 && letter2 <= font.ft_maxchar - font.ft_minchar ) {

				const kernSpacing = find_kern_entry( font, letter, letter2 );

				if ( kernSpacing !== - 1 ) {

					spacing = kernSpacing;

				}

			}

		}

	}

	return { width: width, spacing: spacing };

}

// Measure string dimensions
// Ported from: gr_get_string_size() in FONT.C lines 923-960
export function gr_get_string_size( font, text ) {

	let stringWidth = 0;
	let stringHeight = font.ft_h;
	let longestWidth = 0;
	let i = 0;

	while ( i < text.length ) {

		while ( i < text.length && text.charCodeAt( i ) === 10 ) {

			i ++;
			stringHeight += font.ft_h;
			stringWidth = 0;

		}

		if ( i >= text.length ) break;

		const c = text.charCodeAt( i );
		const c2 = ( i + 1 < text.length ) ? text.charCodeAt( i + 1 ) : 0;
		const cw = get_char_width( font, c, c2 );

		stringWidth += cw.spacing;

		if ( stringWidth > longestWidth ) {

			longestWidth = stringWidth;

		}

		i ++;

	}

	return { width: longestWidth, height: stringHeight, average_width: font.ft_w };

}

// Render text into an ImageData buffer
// x=0x8000 means center horizontally
// Ported from: gr_internal_string0m() (monochrome transparent) and
//              gr_internal_color_string() (color fonts) in FONT.C
export function gr_string( imageData, font, x, y, text, gamePalette, fgColorIndex ) {

	const pixels = imageData.data;
	const canvasW = imageData.width;
	const canvasH = imageData.height;

	if ( ( font.ft_flags & FT_COLOR ) !== 0 ) {

		_gr_color_string( pixels, canvasW, canvasH, font, x, y, text, gamePalette );

	} else {

		_gr_mono_string( pixels, canvasW, canvasH, font, x, y, text, gamePalette, fgColorIndex );

	}

}

// Get centered X position for a line of text
// Ported from: get_centered_x() in FONT.C lines 212-222
function _get_centered_x( font, text, startIdx, canvasW ) {

	let w = 0;
	let i = startIdx;

	while ( i < text.length && text.charCodeAt( i ) !== 0 && text.charCodeAt( i ) !== 10 ) {

		const c = text.charCodeAt( i );
		const c2 = ( i + 1 < text.length ) ? text.charCodeAt( i + 1 ) : 0;
		const cw = get_char_width( font, c, c2 );
		w += cw.spacing;
		i ++;

	}

	return Math.floor( ( canvasW - w ) / 2 );

}

// Monochrome transparent string renderer
// Ported from: gr_internal_string0m() in FONT.C lines 321-413
function _gr_mono_string( pixels, canvasW, canvasH, font, x, y, text, gamePalette, fgColorIndex ) {

	// Resolve foreground color to RGB
	let fgR, fgG, fgB;

	if ( fgColorIndex !== undefined && fgColorIndex !== null && gamePalette !== null ) {

		fgR = gamePalette[ fgColorIndex * 3 + 0 ];
		fgG = gamePalette[ fgColorIndex * 3 + 1 ];
		fgB = gamePalette[ fgColorIndex * 3 + 2 ];

	} else {

		// Default: bright green
		fgR = 0;
		fgG = 255;
		fgB = 0;

	}

	let lineStart = 0; // index into text where current line starts
	let curY = y;

	while ( lineStart <= text.length ) {

		// Find end of this line
		let lineEnd = text.indexOf( '\n', lineStart );

		if ( lineEnd === - 1 ) {

			lineEnd = text.length;

		}

		// Compute x for this line
		let curX;

		if ( x === 0x8000 ) {

			curX = _get_centered_x( font, text, lineStart, canvasW );

		} else {

			curX = x;

		}

		// Render each row of pixels for this line of text
		for ( let r = 0; r < font.ft_h; r ++ ) {

			let px = curX;
			let ti = lineStart;

			while ( ti < lineEnd ) {

				const c = text.charCodeAt( ti );
				const c2 = ( ti + 1 < lineEnd ) ? text.charCodeAt( ti + 1 ) : 0;
				const cw = get_char_width( font, c, c2 );
				const letter = c - font.ft_minchar;

				if ( letter < 0 || letter > font.ft_maxchar - font.ft_minchar ) {

					// Not in font — skip as space
					px += cw.spacing;
					ti ++;
					continue;

				}

				const width = cw.width;
				const spacing = cw.spacing;

				// Get pointer to glyph data for this row
				let fp, fpOff;

				if ( ( font.ft_flags & FT_PROPORTIONAL ) !== 0 ) {

					fpOff = font.ft_chars[ letter ] + BITS_TO_BYTES( width ) * r;

				} else {

					fpOff = letter * BITS_TO_BYTES( width ) * font.ft_h + BITS_TO_BYTES( width ) * r;

				}

				fp = font.ft_data;

				let bitMask = 0;
				let bits = 0;

				for ( let i = 0; i < width; i ++ ) {

					if ( bitMask === 0 ) {

						bits = fp[ fpOff ++ ];
						bitMask = 0x80;

					}

					if ( ( bits & bitMask ) !== 0 ) {

						const sy = curY + r;

						if ( px >= 0 && px < canvasW && sy >= 0 && sy < canvasH ) {

							const off = ( sy * canvasW + px ) * 4;
							pixels[ off + 0 ] = fgR;
							pixels[ off + 1 ] = fgG;
							pixels[ off + 2 ] = fgB;
							pixels[ off + 3 ] = 255;

						}

					}

					px ++;
					bitMask >>= 1;

				}

				px += spacing - width; // kerning gap
				ti ++;

			}

		}

		curY += font.ft_h;
		lineStart = lineEnd + 1;

		if ( lineEnd === text.length ) break;

	}

}

// Color font string renderer
// Ported from: gr_internal_color_string() in FONT.C lines 782-843
function _gr_color_string( pixels, canvasW, canvasH, font, x, y, text, gamePalette ) {

	let lineStart = 0;
	let curY = y;

	while ( lineStart <= text.length ) {

		let lineEnd = text.indexOf( '\n', lineStart );

		if ( lineEnd === - 1 ) {

			lineEnd = text.length;

		}

		let curX;

		if ( x === 0x8000 ) {

			curX = _get_centered_x( font, text, lineStart, canvasW );

		} else {

			curX = x;

		}

		let ti = lineStart;

		while ( ti < lineEnd ) {

			const c = text.charCodeAt( ti );
			const c2 = ( ti + 1 < lineEnd ) ? text.charCodeAt( ti + 1 ) : 0;
			const cw = get_char_width( font, c, c2 );
			const letter = c - font.ft_minchar;

			if ( letter < 0 || letter > font.ft_maxchar - font.ft_minchar ) {

				curX += cw.spacing;
				ti ++;
				continue;

			}

			const width = cw.width;

			// Get glyph data pointer
			let fpOff;

			if ( ( font.ft_flags & FT_PROPORTIONAL ) !== 0 ) {

				fpOff = font.ft_chars[ letter ];

			} else {

				fpOff = letter * width * font.ft_h;

			}

			// Blit the character (1 byte per pixel, 255 = transparent)
			for ( let row = 0; row < font.ft_h; row ++ ) {

				const sy = curY + row;

				if ( sy < 0 || sy >= canvasH ) {

					fpOff += width;
					continue;

				}

				for ( let col = 0; col < width; col ++ ) {

					const palIdx = font.ft_data[ fpOff ++ ];

					if ( palIdx === 255 ) continue; // transparent

					const px = curX + col;

					if ( px >= 0 && px < canvasW ) {

						const off = ( sy * canvasW + px ) * 4;

						if ( gamePalette !== null ) {

							pixels[ off + 0 ] = gamePalette[ palIdx * 3 + 0 ];
							pixels[ off + 1 ] = gamePalette[ palIdx * 3 + 1 ];
							pixels[ off + 2 ] = gamePalette[ palIdx * 3 + 2 ];

						} else {

							pixels[ off + 0 ] = palIdx;
							pixels[ off + 1 ] = palIdx;
							pixels[ off + 2 ] = palIdx;

						}

						pixels[ off + 3 ] = 255;

					}

				}

			}

			curX += cw.spacing;
			ti ++;

		}

		curY += font.ft_h;
		lineStart = lineEnd + 1;

		if ( lineEnd === text.length ) break;

	}

}
