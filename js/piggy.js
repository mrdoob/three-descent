// Ported from: descent-master/MAIN/PIGGY.C
// Functions for managing the PIG files (textures/bitmaps and sounds)

import { CFile } from './cfile.js';

// Bitmap flags from GR.H
export const BM_FLAG_TRANSPARENT = 1;
export const BM_FLAG_SUPER_TRANSPARENT = 2;
export const BM_FLAG_NO_LIGHTING = 4;
export const BM_FLAG_RLE = 8;
export const BM_FLAG_PAGED_OUT = 16;

const DBM_FLAG_LARGE = 128;
const DBM_FLAG_ABM = 64;

const MAX_BITMAP_FILES = 1800;
const MAX_SOUND_FILES = 254;

// SOS CODEC ADPCM tables (from SOSCODEC.ASM)
// Index adjustment table: maps 4-bit code to step index delta
const _adpcmIndexTab = new Int8Array( [
	- 1, - 1, - 1, - 1, 2, 4, 6, 8,
	- 1, - 1, - 1, - 1, 2, 4, 6, 8
] );

// Step size table: 89 entries
const _adpcmStepTab = new Int16Array( [
	7, 8, 9, 10, 11, 12, 13, 14,
	16, 17, 19, 21, 23, 25, 28,
	31, 34, 37, 41, 45, 50, 55,
	60, 66, 73, 80, 88, 97, 107,
	118, 130, 143, 157, 173, 190, 209,
	230, 253, 279, 307, 337, 371, 408,
	449, 494, 544, 598, 658, 724, 796,
	876, 963, 1060, 1166, 1282, 1411, 1552,
	1707, 1878,
	2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
	4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
	9493, 10442, 11487, 12635, 13899, 15289, 16818,
	18500, 20350, 22385, 24623, 27086, 29794, 32767
] );

// Known Descent 1 PIG file sizes (from DXX-Rebirth)
const D1_SHARE_PIGSIZE = 2509799;		// v1.4 shareware
const D1_SHARE_10_PIGSIZE = 2529454;	// v1.0 - 1.2 shareware
const D1_SHARE_BIG_PIGSIZE = 5092871;	// v1.0 - 1.4 before RLE compression
const D1_10_PIGSIZE = 4520145;			// v1.0 registered
const D1_10_BIG_PIGSIZE = 7640220;		// v1.0 before RLE compression
const D1_PIGSIZE = 4920305;			// v1.4 - 1.5 registered
const D1_OEM_PIGSIZE = 5039735;			// v1.0 OEM

// DiskBitmapHeader: { name[8], dflags, width, height, flags, avg_color, offset(int) }
// Total: 8 + 1 + 1 + 1 + 1 + 1 + 4 = 17 bytes

// DiskSoundHeader: { name[8], length(int), data_length(int), offset(int) }
// Total: 8 + 4 + 4 + 4 = 20 bytes

export class GameBitmap {

	constructor() {

		this.name = '';
		this.width = 0;
		this.height = 0;
		this.flags = BM_FLAG_PAGED_OUT;
		this.avg_color = 0;
		this.data = null;	// Uint8Array of palette-indexed pixel data

	}

}

export class GameSound {

	constructor() {

		this.name = '';
		this.length = 0;		// Number of decompressed samples
		this.data_length = 0;	// Number of bytes stored on disk (may be ADPCM compressed)
		this.data = null;		// Uint8Array of 8-bit unsigned PCM data (decompressed)

	}

}

export class PigFile {

	constructor() {

		this.bitmaps = [];			// GameBitmap[]
		this.bitmapOffsets = [];		// absolute offset in PIG file for each bitmap's pixel data
		this.bitmapFlags = [];		// original flags from disk headers
		this.sounds = [];			// GameSound[]
		this.soundOffsets = [];		// absolute offset in PIG file for each sound's data
		this.GameBitmapXlat = null;	// Uint16Array - texture translation table
		this.palette = null;		// Uint8Array(768) - RGB palette, 0-255 per component
		this.pigBuffer = null;		// ArrayBuffer - raw PIG file data
		this.hamData = null;		// raw HAM data (for bm_read_all)
		this.N_bitmaps = 0;
		this.N_sounds = 0;

	}

	// Parse a PIG file from an ArrayBuffer
	// Mirrors piggy_init() in PIGGY.C
	// Handles both registered (v1.4+) and shareware (v1.0-1.4) formats
	init( buffer ) {

		this.pigBuffer = buffer;
		const fp = new CFile( buffer );
		const fileSize = buffer.byteLength;

		console.log( 'PIG: file size=' + fileSize );

		// Detect format by file size (matching DXX-Rebirth approach)
		let Pigdata_start = 0;
		this.isShareware = false;

		if ( fileSize === D1_SHARE_PIGSIZE || fileSize === D1_SHARE_10_PIGSIZE || fileSize === D1_SHARE_BIG_PIGSIZE ) {

			// Shareware PIG: no Pigdata_start header, no HAM data
			// File starts directly with N_bitmaps, N_sounds
			this.isShareware = true;
			Pigdata_start = 0;
			console.log( 'PIG: Detected shareware format' );

		} else if ( fileSize === D1_10_PIGSIZE || fileSize === D1_10_BIG_PIGSIZE ) {

			// Registered v1.0: no Pigdata_start header but has different structure
			Pigdata_start = 0;
			console.log( 'PIG: Detected v1.0 registered format' );

		} else {

			// Registered v1.4+: first int is Pigdata_start
			Pigdata_start = fp.readInt();
			console.log( 'PIG: Detected registered format, Pigdata_start=' + Pigdata_start );

		}

		// Initialize GameBitmapXlat with identity mapping (default)
		this.GameBitmapXlat = new Uint16Array( MAX_BITMAP_FILES );
		for ( let i = 0; i < MAX_BITMAP_FILES; i ++ ) {

			this.GameBitmapXlat[ i ] = i;

		}

		// For registered v1.4+, read HAM data and GameBitmapXlat
		if ( Pigdata_start > 0 ) {

			// HAM data region: from current position to Pigdata_start - MAX_BITMAP_FILES * 2
			const xlatSize = MAX_BITMAP_FILES * 2;
			const xlatOffset = Pigdata_start - xlatSize;
			const hamSize = xlatOffset - fp.tell();

			if ( hamSize > 0 ) {

				this.hamData = new CFile( buffer, fp.tell(), hamSize );

			}

			// Read GameBitmapXlat
			if ( xlatOffset >= 4 && xlatOffset + xlatSize <= fileSize ) {

				fp.seek( xlatOffset );
				for ( let i = 0; i < MAX_BITMAP_FILES; i ++ ) {

					this.GameBitmapXlat[ i ] = fp.readUShort();

				}

			}

		} else {

			// Shareware/v1.0: no HAM data or GameBitmapXlat in PIG
			this.hamData = null;

		}

		// Seek to Pigdata_start to read bitmap and sound headers
		fp.seek( Pigdata_start );

		const N_bitmaps = fp.readInt();
		const N_sounds = fp.readInt();
		this.N_bitmaps = N_bitmaps;
		this.N_sounds = N_sounds;

		const header_size = ( N_bitmaps * 17 ) + ( N_sounds * 20 );

		console.log( 'PIG: ' + N_bitmaps + ' bitmaps, ' + N_sounds + ' sounds' );

		// Register bogus bitmap at index 0
		const bogus = new GameBitmap();
		bogus.name = 'bogus';
		bogus.width = 64;
		bogus.height = 64;
		bogus.flags = 0;
		bogus.avg_color = 0;
		bogus.data = new Uint8Array( 64 * 64 );
		this.bitmaps.push( bogus );
		this.bitmapOffsets.push( 0 );
		this.bitmapFlags.push( 0 );

		// Read DiskBitmapHeaders
		for ( let i = 0; i < N_bitmaps; i ++ ) {

			const name = fp.readString( 8 );
			const dflags = fp.readUByte();
			let width = fp.readUByte();
			const height = fp.readUByte();
			const flags = fp.readUByte();
			const avg_color = fp.readUByte();
			const offset = fp.readInt();

			// DBM_FLAG_LARGE means width + 256
			if ( ( dflags & DBM_FLAG_LARGE ) !== 0 ) {

				width += 256;

			}

			const bm = new GameBitmap();

			// Build name with animation frame suffix if ABM
			if ( ( dflags & DBM_FLAG_ABM ) !== 0 ) {

				bm.name = name + '#' + ( dflags & 63 );

			} else {

				bm.name = name;

			}

			bm.width = width;
			bm.height = height;
			bm.flags = BM_FLAG_PAGED_OUT;
			bm.avg_color = avg_color;

			// Store original flags for paging
			let origFlags = 0;
			if ( ( flags & BM_FLAG_TRANSPARENT ) !== 0 ) origFlags |= BM_FLAG_TRANSPARENT;
			if ( ( flags & BM_FLAG_SUPER_TRANSPARENT ) !== 0 ) origFlags |= BM_FLAG_SUPER_TRANSPARENT;
			if ( ( flags & BM_FLAG_NO_LIGHTING ) !== 0 ) origFlags |= BM_FLAG_NO_LIGHTING;
			if ( ( flags & BM_FLAG_RLE ) !== 0 ) origFlags |= BM_FLAG_RLE;

			// Calculate absolute offset: bmh.offset + header_size + 8 + Pigdata_start
			const absOffset = offset + header_size + 8 + Pigdata_start;

			this.bitmaps.push( bm );
			this.bitmapOffsets.push( absOffset );
			this.bitmapFlags.push( origFlags );

		}

		// Read DiskSoundHeaders
		for ( let i = 0; i < N_sounds; i ++ ) {

			const name = fp.readString( 8 );
			const length = fp.readInt();
			const data_length = fp.readInt();
			const offset = fp.readInt();

			const snd = new GameSound();
			snd.name = name;
			snd.length = length;
			snd.data_length = data_length;

			// Calculate absolute offset: offset + header_size + 8 + Pigdata_start
			const absOffset = offset + header_size + 8 + Pigdata_start;

			this.sounds.push( snd );
			this.soundOffsets.push( absOffset );

		}

		console.log( 'PIG: Registered ' + this.bitmaps.length + ' bitmaps, ' + this.sounds.length + ' sounds' );

		return true;

	}

	// Page in a bitmap by index - read its pixel data from the PIG file
	// Mirrors piggy_bitmap_page_in() in PIGGY.C
	pageIn( bitmapIndex ) {

		if ( bitmapIndex < 1 ) return;
		if ( bitmapIndex >= this.bitmaps.length ) return;

		const bm = this.bitmaps[ bitmapIndex ];

		// Already paged in?
		if ( ( bm.flags & BM_FLAG_PAGED_OUT ) === 0 ) return;

		const offset = this.bitmapOffsets[ bitmapIndex ];
		if ( offset === 0 ) return;

		const flags = this.bitmapFlags[ bitmapIndex ];
		bm.flags = flags;

		if ( ( flags & BM_FLAG_RLE ) !== 0 ) {

			// RLE compressed bitmap: first 4 bytes are compressed size
			const view = new DataView( this.pigBuffer );
			const zsize = view.getInt32( offset, true );
			bm.data = new Uint8Array( this.pigBuffer, offset, zsize );

		} else {

			// Uncompressed bitmap: width * height bytes
			bm.data = new Uint8Array( this.pigBuffer, offset, bm.width * bm.height );

		}

	}

	// Page in all bitmaps
	pageInAll() {

		for ( let i = 1; i < this.bitmaps.length; i ++ ) {

			this.pageIn( i );

		}

		console.log( 'PIG: Paged in all ' + ( this.bitmaps.length - 1 ) + ' bitmaps' );

	}

	// Decode an RLE-compressed bitmap into raw pixels
	// Ported from: descent-master/2D/RLE.C
	//
	// Descent 1 RLE format:
	// Bytes 0-3: int32 total compressed size (including these 4 bytes)
	// Bytes 4 through 4+height-1: ubyte per-row compressed sizes
	// Bytes 4+height onwards: RLE-encoded scanline data
	//
	// RLE encoding per scanline:
	// - byte < 0xE0: literal pixel value
	// - byte == 0xE0: end of row
	// - byte 0xE1-0xFF: run of (byte & 0x1F) copies of the next byte

	decodeRLE( bitmapIndex ) {

		const bm = this.bitmaps[ bitmapIndex ];
		if ( bm.data === null ) return null;
		if ( ( bm.flags & BM_FLAG_RLE ) === 0 ) return bm.data;

		const RLE_CODE = 0xE0;

		const src = bm.data;
		const w = bm.width;
		const h = bm.height;
		const dest = new Uint8Array( w * h );

		// Row data starts after: 4-byte size + h bytes of row sizes
		// Use row size table (bm_data[4+row]) to advance source position,
		// matching original C: sbits += (int)bmp->bm_data[4+i]
		let srcPos = 4 + h;

		for ( let row = 0; row < h; row ++ ) {

			const rowStart = srcPos;
			const rowSize = src[ 4 + row ];
			let destPos = row * w;
			let col = 0;

			while ( col < w ) {

				if ( srcPos >= src.length ) break;

				const code = src[ srcPos ++ ];

				if ( ( code & RLE_CODE ) === RLE_CODE ) {

					// RLE code
					const count = code & 0x1F;

					if ( count === 0 ) {

						// 0xE0 = end of row
						break;

					}

					// Run of 'count' copies of next byte
					if ( srcPos >= src.length ) break;
					const val = src[ srcPos ++ ];

					for ( let j = 0; j < count && col < w; j ++ ) {

						dest[ destPos ++ ] = val;
						col ++;

					}

				} else {

					// Literal pixel value
					dest[ destPos ++ ] = code;
					col ++;

				}

			}

			// Advance to next row using the row size table
			srcPos = rowStart + rowSize;

		}

		return dest;

	}

	// Load raw sound data by index
	// Handles ADPCM decompression if data_length < length (shareware PIG)
	getSoundData( soundIndex ) {

		if ( soundIndex < 0 || soundIndex >= this.sounds.length ) return null;

		const snd = this.sounds[ soundIndex ];
		if ( snd.data !== null ) return snd.data;

		const offset = this.soundOffsets[ soundIndex ];
		if ( offset === 0 || snd.length === 0 ) return null;

		if ( snd.data_length < snd.length ) {

			// ADPCM compressed: read data_length bytes and decompress
			// Ported from: descent-master/MAIN/SOSCODEC.ASM (sosCODECDecompressData)
			const compressed = new Uint8Array( this.pigBuffer, offset, snd.data_length );
			snd.data = this.decompressADPCM( compressed, snd.length );

		} else {

			// Uncompressed: read length bytes directly
			snd.data = new Uint8Array( this.pigBuffer, offset, snd.length );

		}

		return snd.data;

	}

	// Decompress SOS CODEC 4-bit ADPCM to 8-bit unsigned PCM
	// Ported from: descent-master/MAIN/SOSCODEC.ASM (sosCODECDecompressData_)
	decompressADPCM( compressed, numSamples ) {

		const output = new Uint8Array( numSamples );

		let index = 0;			// Step table index (0-88)
		let step = 7;			// Current step value
		let predicted = 0;		// Predicted sample value (signed 16-bit range)
		let sampleIndex = 0;	// Even/odd sample counter
		let codeBuf = 0;		// Holds current byte (2 nibbles)
		let srcPos = 0;

		for ( let i = 0; i < numSamples; i ++ ) {

			let code;

			if ( ( sampleIndex & 1 ) === 0 ) {

				// Even sample: fetch new byte, use low nibble
				codeBuf = compressed[ srcPos ];
				srcPos ++;
				code = codeBuf & 0x0F;

			} else {

				// Odd sample: use high nibble
				code = ( codeBuf >> 4 ) & 0x0F;

			}

			// Calculate difference from step and code bits
			let difference = 0;

			if ( ( code & 4 ) !== 0 ) difference += step;
			if ( ( code & 2 ) !== 0 ) difference += ( step >> 1 );
			if ( ( code & 1 ) !== 0 ) difference += ( step >> 2 );
			difference += ( step >> 3 );

			if ( ( code & 8 ) !== 0 ) difference = - difference;

			// Add difference to predicted value
			predicted += difference;

			// Clamp to signed 16-bit range
			if ( predicted > 32767 ) predicted = 32767;
			if ( predicted < - 32768 ) predicted = - 32768;

			// Convert to unsigned 8-bit: take high byte and XOR with 0x80
			output[ i ] = ( ( predicted >> 8 ) & 0xFF ) ^ 0x80;

			// Adjust step index using index table
			index += _adpcmIndexTab[ code ];

			if ( index < 0 ) index = 0;
			if ( index > 88 ) index = 88;

			// Get new step value
			step = _adpcmStepTab[ index ];

			sampleIndex ++;

		}

		return output;

	}

	// Load all sounds
	loadAllSounds() {

		for ( let i = 0; i < this.sounds.length; i ++ ) {

			this.getSoundData( i );

		}

		console.log( 'PIG: Loaded all ' + this.sounds.length + ' sounds' );

	}

	// Find a sound index by name (case-insensitive)
	findSoundIndexByName( name ) {

		const nameLower = name.toLowerCase();
		for ( let i = 0; i < this.sounds.length; i ++ ) {

			if ( this.sounds[ i ].name.toLowerCase() === nameLower ) {

				return i;

			}

		}

		return - 1;

	}

	// Find a bitmap index by name (case-insensitive)
	findBitmapIndexByName( name ) {

		const nameLower = name.toLowerCase();
		for ( let i = 1; i < this.bitmaps.length; i ++ ) {

			if ( this.bitmaps[ i ].name.toLowerCase() === nameLower ) {

				return i;

			}

		}

		return - 1;

	}

	// Get raw pixel data for a bitmap (handling RLE decompression)
	getBitmapPixels( bitmapIndex ) {

		if ( bitmapIndex < 0 || bitmapIndex >= this.bitmaps.length ) return null;

		this.pageIn( bitmapIndex );
		const bm = this.bitmaps[ bitmapIndex ];
		if ( bm.data === null ) return null;

		if ( ( bm.flags & BM_FLAG_RLE ) !== 0 ) {

			return this.decodeRLE( bitmapIndex );

		}

		return bm.data;

	}

}

// Load and parse palette from HOG file
// Palette is 768 bytes: 256 entries of 3 bytes (R,G,B), each 0-63 (VGA 6-bit DAC)
export function loadPalette( hogFile ) {

	// Try common palette file names
	const names = [ 'palette.256', 'PALETTE.256', 'groupa.256', 'GROUPA.256' ];
	let cf = null;

	for ( const name of names ) {

		cf = hogFile.findFile( name );
		if ( cf !== null ) break;

	}

	if ( cf === null ) {

		console.warn( 'Could not find palette file in HOG' );
		return null;

	}

	// Read 256 * 3 = 768 bytes and scale from 0-63 to 0-255
	const palette = new Uint8Array( 768 );
	for ( let i = 0; i < 768; i ++ ) {

		// VGA DACs use 6-bit values (0-63), scale to 8-bit (0-255)
		const val = cf.readUByte();
		palette[ i ] = ( val << 2 ) | ( val >> 4 );

	}

	console.log( 'Loaded palette (768 bytes)' );
	return palette;

}
