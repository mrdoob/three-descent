// Ported from: descent-master/HOGFILE/HOGFILE.C and CFILE/CFILE.C
// HOG file format: "DHF" signature + entries of [13-byte name, 4-byte int length, data]

import { CFile } from './cfile.js';

const MAX_HOGFILES = 250;

export class HogFile {

	constructor() {

		this.entries = []; // { name, offset, length }
		this.buffer = null;

	}

	// Parse a HOG file from an ArrayBuffer
	// Mirrors cfile_init_hogfile() in CFILE.C
	init( buffer ) {

		this.buffer = buffer;
		this.entries = [];

		const view = new DataView( buffer );

		// Read and verify "DHF" signature (3 bytes)
		const d = view.getUint8( 0 );
		const h = view.getUint8( 1 );
		const f = view.getUint8( 2 );

		if ( d !== 0x44 || h !== 0x48 || f !== 0x46 ) {

			console.error( 'HOG: Invalid signature' );
			return false;

		}

		let pos = 3;

		while ( pos < buffer.byteLength ) {

			if ( this.entries.length >= MAX_HOGFILES ) {

				console.warn( 'HOG: File limit reached (' + MAX_HOGFILES + ')' );
				break;

			}

			// Read 13-byte filename
			if ( pos + 13 > buffer.byteLength ) break;

			let name = '';
			for ( let i = 0; i < 13; i ++ ) {

				const ch = view.getUint8( pos + i );
				if ( ch === 0 ) break;
				name += String.fromCharCode( ch );

			}

			pos += 13;

			// Read 4-byte length (little-endian int)
			if ( pos + 4 > buffer.byteLength ) break;

			const length = view.getInt32( pos, true );
			pos += 4;

			// Store entry with data offset
			this.entries.push( {
				name: name,
				offset: pos,
				length: length
			} );

			// Skip over the file data
			pos += length;

		}

		console.log( 'HOG: Loaded ' + this.entries.length + ' files' );
		return true;

	}

	// Find a file by name (case-insensitive), return a CFile or null
	// Mirrors cfile_find_libfile() in CFILE.C
	findFile( name ) {

		const upperName = name.toUpperCase();

		for ( let i = 0; i < this.entries.length; i ++ ) {

			if ( this.entries[ i ].name.toUpperCase() === upperName ) {

				return new CFile(
					this.buffer,
					this.entries[ i ].offset,
					this.entries[ i ].length
				);

			}

		}

		return null;

	}

	// List all file names in the HOG
	listFiles() {

		return this.entries.map( e => e.name );

	}

}
