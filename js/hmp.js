// Ported from: DXX-Rebirth common/misc/hmp.cpp
// HMP (Human Machine Interfaces MIDI) file parser
// Converts HMP format to scheduled MIDI events for Web Audio playback

// HMP header offsets (from DXX-Rebirth hmp_open)
const HMP_SIGNATURE = 'HMIMIDIP';
const HMP_OFFSET_NUM_TRACKS = 0x30;	// 48
const HMP_OFFSET_TEMPO = 0x38;			// 56
const HMP_OFFSET_TRACK_DATA = 0x308;	// 776

// MIDI command lengths: for status bytes 0x80-0xE0
const MIDI_CMD_LEN = [ 3, 3, 3, 3, 2, 2, 3 ];

// Read HMI-style variable length quantity (different from standard MIDI VLQ)
// In HMI: MSB=0 means "more bytes follow", MSB=1 means "last byte"
// (Standard MIDI VLQ is the opposite)
function readHmiVLQ( data, offset ) {

	let value = 0;
	let shift = 0;
	let pos = offset;

	// Read bytes while MSB is clear (more bytes follow)
	while ( pos < data.length && ( data[ pos ] & 0x80 ) === 0 ) {

		value += data[ pos ] << shift;
		shift += 7;
		pos ++;

	}

	if ( pos >= data.length ) return { value: 0, bytesRead: 0 };

	// Last byte has MSB set
	value += ( data[ pos ] & 0x7F ) << shift;
	pos ++;

	return { value: value, bytesRead: pos - offset };

}

// Parse an HMP file and extract MIDI events
// Returns: { tempo, tracks: [ { events: [ { time, type, channel, data1, data2 } ] } ] }
export function hmp_parse( hmpData ) {

	const view = new DataView( hmpData.buffer, hmpData.byteOffset, hmpData.byteLength );

	// Verify signature
	let sig = '';
	for ( let i = 0; i < 8; i ++ ) {

		sig += String.fromCharCode( hmpData[ i ] );

	}

	if ( sig !== HMP_SIGNATURE ) {

		console.warn( 'HMP: Invalid signature: ' + sig );
		return null;

	}

	// Read header
	const numTracks = view.getUint32( HMP_OFFSET_NUM_TRACKS, true );
	const tempo = view.getUint32( HMP_OFFSET_TEMPO, true );

	if ( numTracks < 1 || numTracks > 32 ) {

		console.warn( 'HMP: Invalid track count: ' + numTracks );
		return null;

	}

	// Read track data starting at offset 0x308
	const tracks = [];
	let offset = HMP_OFFSET_TRACK_DATA;

	for ( let t = 0; t < numTracks; t ++ ) {

		if ( offset + 12 > hmpData.length ) break;

		// Each track has a 12-byte header: 3 × int32
		// tdata[0] = unknown, tdata[1] = data length (including header), tdata[2] = unknown
		const tdata0 = view.getInt32( offset, true );
		const tdata1 = view.getInt32( offset + 4, true );
		const tdata2 = view.getInt32( offset + 8, true );
		offset += 12;

		const dataLen = tdata1 - 12;

		if ( dataLen <= 0 || offset + dataLen > hmpData.length ) {

			console.warn( 'HMP: Track ' + t + ' invalid data length: ' + dataLen );
			break;

		}

		// Extract track event data
		const trackData = hmpData.slice( offset, offset + dataLen );
		offset += dataLen;

		// Parse MIDI events from track data
		const events = parseTrackEvents( trackData );
		tracks.push( { events: events } );

	}

	return {
		tempo: tempo,	// ticks per quarter note (PPQN)
		numTracks: numTracks,
		tracks: tracks
	};

}

// Parse MIDI events from HMP track data
function parseTrackEvents( data ) {

	const events = [];
	let pos = 0;
	let currentTime = 0; // cumulative time in ticks

	while ( pos < data.length - 1 ) {

		// Read delta time (HMI VLQ)
		const vlq = readHmiVLQ( data, pos );

		if ( vlq.bytesRead === 0 ) break;

		pos += vlq.bytesRead;
		currentTime += vlq.value;

		if ( pos >= data.length ) break;

		const statusByte = data[ pos ];

		// Check for end-of-track meta event (0xFF 0x2F)
		if ( statusByte === 0xFF ) {

			if ( pos + 1 < data.length && data[ pos + 1 ] === 0x2F ) {

				// End of track
				break;

			}

			// Other meta event — skip it
			pos ++; // skip 0xFF
			if ( pos >= data.length ) break;
			pos ++; // skip meta type

			// Read meta data length (standard MIDI VLQ)
			let metaLen = 0;

			while ( pos < data.length && ( data[ pos ] & 0x80 ) !== 0 ) {

				metaLen = ( metaLen << 7 ) + ( data[ pos ] & 0x7F );
				pos ++;

			}

			if ( pos < data.length ) {

				metaLen = ( metaLen << 7 ) + data[ pos ];
				pos ++;

			}

			pos += metaLen; // skip meta data
			continue;

		}

		// SysEx — skip (not supported in HMP)
		if ( statusByte >= 0xF0 && statusByte < 0xFF ) {

			pos ++;
			continue;

		}

		// Invalid status byte
		if ( statusByte < 0x80 ) {

			pos ++;
			continue;

		}

		// Channel MIDI event
		const cmd = ( statusByte >> 4 ) & 0x07; // 0-6 for 0x80-0xE0
		const channel = statusByte & 0x0F;
		const cmdLen = MIDI_CMD_LEN[ cmd ];
		pos ++; // skip status byte

		if ( pos >= data.length ) break;

		const data1 = data[ pos ++ ];
		let data2 = 0;

		if ( cmdLen === 3 ) {

			if ( pos >= data.length ) break;
			data2 = data[ pos ++ ];

		}

		events.push( {
			time: currentTime,
			status: statusByte,
			type: ( statusByte >> 4 ),
			channel: channel,
			data1: data1,
			data2: data2
		} );

	}

	return events;

}

// Flatten all tracks into a single sorted event list with absolute times in seconds
export function hmp_get_events( hmpFile ) {

	if ( hmpFile === null ) return [];

	// HMP tempo = ticks per quarter note (PPQN), use directly
	// DXX-Rebirth Windows path: time_div = hmp->tempo, tempo = 1,000,000 µs/beat
	// DXX-Rebirth hmp2mid path: time_div = hmp->tempo*1.6, tempo = 0x188000 µs/beat
	// Both paths produce the same tick duration — use the simpler Windows formula
	const ppqn = hmpFile.tempo;
	const usPerQuarter = 1000000;
	const tickDuration = usPerQuarter / ppqn / 1000000; // seconds per tick

	const allEvents = [];

	// Skip track 0 — DXX-Rebirth starts at track 1 (hmp.cpp line 710)
	for ( let t = 1; t < hmpFile.tracks.length; t ++ ) {

		const track = hmpFile.tracks[ t ];

		for ( let e = 0; e < track.events.length; e ++ ) {

			const ev = track.events[ e ];
			allEvents.push( {
				time: ev.time * tickDuration,
				status: ev.status,
				type: ev.type,
				channel: ev.channel,
				data1: ev.data1,
				data2: ev.data2
			} );

		}

	}

	// Sort by time
	allEvents.sort( ( a, b ) => a.time - b.time );

	return allEvents;

}
