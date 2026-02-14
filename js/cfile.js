// Ported from: descent-master/CFILE/CFILE.C
// Binary file reader using DataView, replaces C's fread/fseek/ftell

export class CFile {

	constructor( buffer, offset = 0, length = null ) {

		this.buffer = buffer;
		this.view = new DataView( buffer );
		this.lib_offset = offset;
		this.size = ( length !== null ) ? length : buffer.byteLength - offset;
		this.raw_position = 0;

	}

	// Read signed 8-bit integer
	readByte() {

		const val = this.view.getInt8( this.lib_offset + this.raw_position );
		this.raw_position += 1;
		return val;

	}

	// Read unsigned 8-bit integer
	readUByte() {

		const val = this.view.getUint8( this.lib_offset + this.raw_position );
		this.raw_position += 1;
		return val;

	}

	// Read signed 16-bit integer (little-endian)
	readShort() {

		const val = this.view.getInt16( this.lib_offset + this.raw_position, true );
		this.raw_position += 2;
		return val;

	}

	// Read unsigned 16-bit integer (little-endian)
	readUShort() {

		const val = this.view.getUint16( this.lib_offset + this.raw_position, true );
		this.raw_position += 2;
		return val;

	}

	// Read signed 32-bit integer (little-endian)
	readInt() {

		const val = this.view.getInt32( this.lib_offset + this.raw_position, true );
		this.raw_position += 4;
		return val;

	}

	// Read unsigned 32-bit integer (little-endian)
	readUInt() {

		const val = this.view.getUint32( this.lib_offset + this.raw_position, true );
		this.raw_position += 4;
		return val;

	}

	// Read 16.16 fixed-point number, convert to float
	readFix() {

		const val = this.view.getInt32( this.lib_offset + this.raw_position, true );
		this.raw_position += 4;
		return val / 65536.0;

	}

	// Read raw bytes into a new Uint8Array
	readBytes( count ) {

		const bytes = new Uint8Array( this.buffer, this.lib_offset + this.raw_position, count );
		const copy = new Uint8Array( count );
		copy.set( bytes );
		this.raw_position += count;
		return copy;

	}

	// Read a null-terminated string of fixed byte length
	readString( length ) {

		const bytes = new Uint8Array( this.buffer, this.lib_offset + this.raw_position, length );
		this.raw_position += length;
		let str = '';
		for ( let i = 0; i < length; i ++ ) {

			if ( bytes[ i ] === 0 ) break;
			str += String.fromCharCode( bytes[ i ] );

		}
		return str;

	}

	// Seek to position (relative to start of this CFile's data)
	seek( offset ) {

		this.raw_position = offset;

	}

	// Get current position
	tell() {

		return this.raw_position;

	}

	// Get total size
	length() {

		return this.size;

	}

	// Check if at end
	eof() {

		return this.raw_position >= this.size;

	}

	// Skip bytes
	skip( count ) {

		this.raw_position += count;

	}

	// Create a sub-CFile that references a portion of this file's buffer
	subFile( offset, length ) {

		return new CFile( this.buffer, this.lib_offset + offset, length );

	}

}
