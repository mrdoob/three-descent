// Ported from: descent-master/MAIN/PCX.C
// PCX file parser — reads 8-bit RLE-encoded PCX files from HOG

// PCX header is 128 bytes:
// 0:   Manufacturer (1 byte, must be 10)
// 1:   Version (1 byte, must be 5 for 256-color)
// 2:   Encoding (1 byte, must be 1 for RLE)
// 3:   BitsPerPixel (1 byte, must be 8)
// 4-5: Xmin (short)
// 6-7: Ymin (short)
// 8-9: Xmax (short)
// 10-11: Ymax (short)
// 65:  Nplanes (1 byte, must be 1)
// 66-67: BytesPerLine (short)

const PCX_HEADER_SIZE = 128;

// Read a PCX file from HOG and return decoded pixel data + palette
// Returns { width, height, pixels: Uint8Array, palette: Uint8Array(768) } or null on error
export function pcx_read( hogFile, filename ) {

	const cfile = hogFile.findFile( filename );
	if ( cfile === null ) {

		console.warn( 'PCX: File not found: ' + filename );
		return null;

	}

	// Read header fields
	const manufacturer = cfile.readUByte();
	const version = cfile.readUByte();
	const encoding = cfile.readUByte();
	const bitsPerPixel = cfile.readUByte();
	const xmin = cfile.readShort();
	const ymin = cfile.readShort();
	const xmax = cfile.readShort();
	const ymax = cfile.readShort();

	// Validate header
	if ( manufacturer !== 10 || version !== 5 || encoding !== 1 ||
		bitsPerPixel !== 8 ) {

		console.warn( 'PCX: Invalid header in ' + filename +
			' (mfr=' + manufacturer + ' ver=' + version +
			' enc=' + encoding + ' bpp=' + bitsPerPixel + ')' );
		return null;

	}

	// Skip to Nplanes at offset 65
	cfile.seek( 65 );
	const nplanes = cfile.readUByte();
	const bytesPerLine = cfile.readShort();

	if ( nplanes !== 1 ) {

		console.warn( 'PCX: Unsupported Nplanes=' + nplanes + ' in ' + filename );
		return null;

	}

	const width = xmax - xmin + 1;
	const height = ymax - ymin + 1;

	// RLE decode from offset 128
	cfile.seek( PCX_HEADER_SIZE );

	const totalPixels = width * height;
	const pixels = new Uint8Array( totalPixels );
	let pixPos = 0;

	// Decode all scanlines
	for ( let row = 0; row < height; row ++ ) {

		let col = 0;

		while ( col < bytesPerLine ) {

			const byte = cfile.readUByte();

			if ( ( byte & 0xC0 ) === 0xC0 ) {

				// RLE run: lower 6 bits = count, next byte = pixel value
				const count = byte & 0x3F;
				const value = cfile.readUByte();

				for ( let j = 0; j < count; j ++ ) {

					if ( col < width && pixPos < totalPixels ) {

						pixels[ pixPos ] = value;
						pixPos ++;

					}

					col ++;

				}

			} else {

				// Literal pixel
				if ( col < width && pixPos < totalPixels ) {

					pixels[ pixPos ] = byte;
					pixPos ++;

				}

				col ++;

			}

		}

	}

	// Read 256-color palette from end of file
	// Palette is at fileEnd - 769: marker byte 0x0C + 768 bytes (256 * RGB)
	const paletteOffset = cfile.length() - 769;
	cfile.seek( paletteOffset );

	const marker = cfile.readUByte();
	if ( marker !== 0x0C ) {

		console.warn( 'PCX: No palette marker (got 0x' + marker.toString( 16 ) + ') in ' + filename );
		return null;

	}

	const palette = cfile.readBytes( 768 );

	// PCX palette is stored as 8-bit RGB (0-255), no conversion needed
	// (Descent's C code shifts right 2 to convert to VGA 6-bit DAC format,
	//  but we want 0-255 for canvas rendering)

	return { width, height, pixels, palette };

}

// Pre-allocated ImageData for canvas rendering (reused across calls)
let _sharedCanvas = null;
let _sharedCtx = null;

// Convert decoded PCX data to a canvas element
// Uses the PCX's embedded palette (not the game palette)
export function pcx_to_canvas( pcxData ) {

	if ( pcxData === null ) return null;

	const { width, height, pixels, palette } = pcxData;

	// Create or reuse canvas
	if ( _sharedCanvas === null ) {

		_sharedCanvas = document.createElement( 'canvas' );
		_sharedCtx = _sharedCanvas.getContext( '2d' );

	}

	_sharedCanvas.width = width;
	_sharedCanvas.height = height;

	const imageData = _sharedCtx.createImageData( width, height );
	const rgba = imageData.data;

	for ( let i = 0; i < pixels.length; i ++ ) {

		const palIdx = pixels[ i ];
		rgba[ i * 4 + 0 ] = palette[ palIdx * 3 + 0 ];
		rgba[ i * 4 + 1 ] = palette[ palIdx * 3 + 1 ];
		rgba[ i * 4 + 2 ] = palette[ palIdx * 3 + 2 ];
		rgba[ i * 4 + 3 ] = 255;

	}

	_sharedCtx.putImageData( imageData, 0, 0 );

	// Return a new canvas with the image (so the shared one can be reused)
	const result = document.createElement( 'canvas' );
	result.width = width;
	result.height = height;
	const rctx = result.getContext( '2d' );
	rctx.drawImage( _sharedCanvas, 0, 0 );

	return result;

}
