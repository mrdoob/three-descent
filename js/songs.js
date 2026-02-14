// Ported from: descent-master/MAIN/SONGS.C
// Song/music management and MIDI playback via Web Audio API

import { hmp_parse, hmp_get_events } from './hmp.js';

// Song constants (from SONGS.H)
export const SONG_TITLE = 0;
export const SONG_BRIEFING = 1;
export const SONG_ENDLEVEL = 2;
export const SONG_ENDGAME = 3;
export const SONG_CREDITS = 4;
export const SONG_LEVEL_MUSIC = 5;	// first level music index

// Shareware song file mapping
// The shareware HOG contains: descent.hmp, briefing.hmp, credits.hmp, game0-4.hmp
const SHAREWARE_SONGS = [
	'descent.hmp',		// 0: Title
	'briefing.hmp',	// 1: Briefing
	null,				// 2: End level (not in shareware)
	null,				// 3: End game (not in shareware)
	'credits.hmp',		// 4: Credits
	'game0.hmp',		// 5: Level 1
	'game1.hmp',		// 6: Level 2
	'game2.hmp',		// 7: Level 3
	'game3.hmp',		// 8: Level 4
	'game4.hmp',		// 9: Level 5
	'game0.hmp',		// 10: Level 6 (cycles)
	'game1.hmp',		// 11: Level 7 (cycles)
];

// External references
let _hogFile = null;

// Playback state
let _audioContext = null;
let _masterGain = null;
let _compressor = null;
let _currentSong = - 1;
let _playing = false;
let _looping = false;
let _events = null;
let _eventIndex = 0;
let _startTime = 0;
let _scheduledUntil = 0;
let _scheduleTimer = null;
let _songDuration = 0;
let _volume = 0.4;

// Per-channel state (16 MIDI channels)
const NUM_CHANNELS = 16;
const _channels = [];

// Active note tracking for cleanup
const _activeNotes = new Map(); // key: "channel-note" -> { carrier, modulator, noteGain, ... }

// ============================================================
// OPL2 FM Synthesis Engine
// Uses exact instrument parameters from Descent's melodic.bnk
// ============================================================

// OPL2 waveforms with feedback: cached as PeriodicWave objects
// Key: "wave-fb" e.g. "0-0" for sine no feedback, "1-4" for half-sine with FB=4
const _oplWaveCache = new Map();

function getOplWaveform( waveType, fb ) {

	if ( _audioContext === null ) return null;

	const cacheKey = waveType + '-' + fb;

	if ( _oplWaveCache.has( cacheKey ) ) return _oplWaveCache.get( cacheKey );

	// Build PeriodicWave from Fourier coefficients
	const N = 64; // number of harmonics
	const real = new Float32Array( N );
	const imag = new Float32Array( N );

	if ( waveType === 0 ) {

		// Pure sine
		imag[ 1 ] = 1.0;

	} else if ( waveType === 1 ) {

		// Half-sine: positive half only (negative clamped to 0)
		// Fourier: 1/π + sin(x)/2 - Σ 2/((4n²-1)π) cos(2nx)
		real[ 0 ] = 1.0 / Math.PI;
		imag[ 1 ] = 0.5;
		for ( let n = 1; n < N / 2; n ++ ) {

			real[ 2 * n ] = - 2.0 / ( ( 4 * n * n - 1 ) * Math.PI );

		}

	} else if ( waveType === 2 ) {

		// Abs-sine: full-wave rectified (always positive)
		// Fourier: 2/π - Σ 4/((4n²-1)π) cos(2nx)
		real[ 0 ] = 2.0 / Math.PI;
		for ( let n = 1; n < N / 2; n ++ ) {

			real[ 2 * n ] = - 4.0 / ( ( 4 * n * n - 1 ) * Math.PI );

		}

	} else if ( waveType === 3 ) {

		// Quarter-sine: sin(x) for 0≤x<π/2, 0 elsewhere
		// Computed numerically from DFT of the target waveform
		const M = 1024;

		for ( let k = 0; k < N; k ++ ) {

			let rSum = 0, iSum = 0;

			for ( let j = 0; j < M; j ++ ) {

				const x = ( 2 * Math.PI * j ) / M;
				const val = ( x < Math.PI / 2 ) ? Math.sin( x ) : 0;
				rSum += val * Math.cos( 2 * Math.PI * k * j / M );
				iSum -= val * Math.sin( 2 * Math.PI * k * j / M );

			}

			real[ k ] = rSum / M * 2;
			imag[ k ] = iSum / M * 2;

		}

		real[ 0 ] /= 2;

	}

	// Apply OPL2 feedback to the waveform
	// Feedback = modulator self-modulates: output(t) = sin(phase + FB_level * prev_output)
	// This morphs the waveform from sine → saw-like → noise-like as FB increases
	// Pre-compute the steady-state waveform for each FB level
	if ( fb > 0 ) {

		// OPL2 feedback: π / 2^(8-FB) scaling of averaged previous two outputs
		const fbAmount = Math.PI / Math.pow( 2, 8 - fb );

		// Iterate the feedback equation to find the steady-state waveform
		const M = 1024;
		const waveform = new Float32Array( M );
		let prev1 = 0, prev2 = 0;

		// Run 3 cycles to reach steady state
		for ( let cycle = 0; cycle < 3; cycle ++ ) {

			for ( let j = 0; j < M; j ++ ) {

				const phase = ( 2 * Math.PI * j ) / M;
				const fbPhase = phase + fbAmount * ( prev1 + prev2 ) * 0.5;
				let val;

				if ( waveType === 0 ) {

					val = Math.sin( fbPhase );

				} else if ( waveType === 1 ) {

					val = Math.sin( fbPhase );
					if ( val < 0 ) val = 0;

				} else if ( waveType === 2 ) {

					val = Math.abs( Math.sin( fbPhase ) );

				} else {

					const normPhase = ( ( fbPhase % ( 2 * Math.PI ) ) + 2 * Math.PI ) % ( 2 * Math.PI );
					val = ( normPhase < Math.PI / 2 ) ? Math.sin( normPhase ) : 0;

				}

				waveform[ j ] = val;
				prev2 = prev1;
				prev1 = val;

			}

		}

		// DFT to get Fourier coefficients of the feedback-modified waveform
		for ( let k = 0; k < N; k ++ ) {

			let rSum = 0, iSum = 0;

			for ( let j = 0; j < M; j ++ ) {

				rSum += waveform[ j ] * Math.cos( 2 * Math.PI * k * j / M );
				iSum -= waveform[ j ] * Math.sin( 2 * Math.PI * k * j / M );

			}

			real[ k ] = rSum / M * 2;
			imag[ k ] = iSum / M * 2;

		}

		real[ 0 ] /= 2;

	}

	const wave = _audioContext.createPeriodicWave( real, imag, { disableNormalization: false } );
	_oplWaveCache.set( cacheKey, wave );
	return wave;

}

// Convert OPL2 4-bit attack rate (0-15) to time constant (seconds)
// Derived from OPL2 base rate: AR_BASE = 2826.24ms at effective rate 4
// Each increment of 4 in effective rate halves the time
// Register rate R maps to effective rate R*4
function oplAttackRate( rate ) {

	if ( rate === 0 ) return 10.0; // effectively infinite
	// OPL2 attack: base 2826ms at rate 1, halving per rate step
	return 2.826 / Math.pow( 2, rate - 1 );

}

// Convert OPL2 4-bit decay/release rate (0-15) to seconds
// Derived from OPL2 base rate: DR_BASE = 39280.64ms at effective rate 4
// Decay/release is ~14x slower than attack at the same register rate
function oplDecayRate( rate ) {

	if ( rate === 0 ) return 30.0; // effectively infinite
	// OPL2 decay: base 39280ms at rate 1, halving per rate step
	return 39.28 / Math.pow( 2, rate - 1 );

}

// Convert OPL2 4-bit sustain level (attenuation) to linear gain
// SL 0 = 0dB (full sustain), SL 1-14 = -3dB steps, SL 15 = -93dB (silence)
function oplSustainLevel( sl ) {

	if ( sl === 0 ) return 1.0;
	if ( sl >= 15 ) return 0.00002; // -93dB, effectively silent
	return Math.pow( 10, - 3.0 * sl / 20.0 );

}

// Convert OPL2 6-bit total level (attenuation) to linear gain
// TL 0 = 0dB (max), TL 63 = -47.25dB
// Each step = -0.75dB
function oplTotalLevel( tl ) {

	if ( tl === 0 ) return 1.0;
	if ( tl >= 63 ) return 0.005;
	return Math.pow( 10, - 0.75 * tl / 20.0 );

}

// Convert OPL2 frequency multiplier field to actual ratio
// 0=0.5, 1=1, 2=2, ..., 15=15
function oplMultiplier( mult ) {

	if ( mult === 0 ) return 0.5;
	return mult;

}

// Raw OPL2 instrument definitions from Descent's melodic.bnk
// Format: { mod: { mult, tl, ar, dr, sl, rr, wave, fb, eg, ksl, ksr, am, vib },
//           car: { mult, tl, ar, dr, sl, rr, wave, eg, ksl, ksr, am, vib } }
// eg: 0=non-sustaining (decays to silence), 1=sustaining (holds at sustain level)
const OPL_PATCHES = {};

// GM 0: default (copy of overdriven guitar in Descent's bank)
OPL_PATCHES[ 0 ] = {
	mod: { mult: 3, tl: 8, ar: 9, dr: 5, sl: 1, rr: 9, wave: 1, fb: 4, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 8, dr: 4, sl: 1, rr: 9, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

// GM 25: Acoustic Guitar (steel) — bright pluck, non-sustaining
OPL_PATCHES[ 25 ] = {
	mod: { mult: 3, tl: 20, ar: 15, dr: 3, sl: 9, rr: 10, wave: 1, fb: 6, eg: 0, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 14, rr: 7, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

// GM 29: Overdriven Guitar — Descent's signature driving riff
OPL_PATCHES[ 29 ] = {
	mod: { mult: 3, tl: 8, ar: 9, dr: 5, sl: 1, rr: 9, wave: 1, fb: 4, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 8, dr: 4, sl: 1, rr: 9, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

// GM 38: Synth Bass 1 — punchy, sustaining
OPL_PATCHES[ 38 ] = {
	mod: { mult: 1, tl: 11, ar: 15, dr: 4, sl: 14, rr: 8, wave: 0, fb: 5, eg: 1, ksl: 2, ksr: 1, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 7, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

// GM 39: Synth Bass 2 — squelchy, sustaining
OPL_PATCHES[ 39 ] = {
	mod: { mult: 1, tl: 18, ar: 15, dr: 1, sl: 2, rr: 8, wave: 0, fb: 5, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 1, sl: 1, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

// GM 80: Lead 1 / Square Lead — buzzy, sustaining
OPL_PATCHES[ 80 ] = {
	mod: { mult: 2, tl: 25, ar: 15, dr: 15, sl: 0, rr: 3, wave: 2, fb: 0, eg: 1, ksl: 1, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 15, dr: 15, sl: 0, rr: 15, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

// GM 90: Pad 3 / Polysynth — warm, vibrato, sustaining
OPL_PATCHES[ 90 ] = {
	mod: { mult: 1, tl: 23, ar: 9, dr: 1, sl: 3, rr: 4, wave: 0, fb: 6, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 },
	car: { mult: 1, tl: 0, ar: 5, dr: 5, sl: 1, rr: 6, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

// GM 94: Pad 7 / Halo — ethereal, slow attack, carrier vibrato
OPL_PATCHES[ 94 ] = {
	mod: { mult: 1, tl: 9, ar: 1, dr: 1, sl: 3, rr: 3, wave: 0, fb: 5, eg: 1, ksl: 2, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 3, ar: 4, dr: 2, sl: 2, rr: 5, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

// GM 95: Pad 8 / Sweep — half-sine mod, tremolo
OPL_PATCHES[ 95 ] = {
	mod: { mult: 1, tl: 21, ar: 1, dr: 1, sl: 4, rr: 7, wave: 1, fb: 0, eg: 1, ksl: 0, ksr: 0, am: 1, vib: 0 },
	car: { mult: 1, tl: 0, ar: 12, dr: 15, sl: 0, rr: 7, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

// GM 100: FX 5 / Brightness — non-sustaining, vibrato, carrier mult 2
OPL_PATCHES[ 100 ] = {
	mod: { mult: 1, tl: 13, ar: 15, dr: 1, sl: 5, rr: 1, wave: 1, fb: 0, eg: 0, ksl: 1, ksr: 0, am: 0, vib: 1 },
	car: { mult: 2, tl: 0, ar: 15, dr: 2, sl: 15, rr: 5, wave: 0, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 1 }
};

// GM 113: Agogo / Taiko — inharmonic bell, high mod mult, non-sustaining
OPL_PATCHES[ 113 ] = {
	mod: { mult: 7, tl: 21, ar: 14, dr: 12, sl: 2, rr: 6, wave: 0, fb: 5, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 0 },
	car: { mult: 2, tl: 0, ar: 15, dr: 8, sl: 1, rr: 6, wave: 0, eg: 0, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

// GM 117: Melodic Tom — carrier at 0.5x freq, non-sustaining
OPL_PATCHES[ 117 ] = {
	mod: { mult: 1, tl: 1, ar: 15, dr: 8, sl: 4, rr: 7, wave: 2, fb: 2, eg: 0, ksl: 1, ksr: 1, am: 0, vib: 0 },
	car: { mult: 0, tl: 3, ar: 15, dr: 3, sl: 0, rr: 3, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

// GM 118: Synth Drum — max feedback, carrier at 0.5x, non-sustaining
OPL_PATCHES[ 118 ] = {
	mod: { mult: 1, tl: 14, ar: 15, dr: 1, sl: 0, rr: 6, wave: 2, fb: 7, eg: 0, ksl: 2, ksr: 0, am: 0, vib: 0 },
	car: { mult: 0, tl: 0, ar: 15, dr: 3, sl: 0, rr: 2, wave: 0, eg: 0, ksl: 0, ksr: 1, am: 0, vib: 0 }
};

// Generic fallback OPL patch for unmapped programs (basic FM tone)
const OPL_DEFAULT_PATCH = {
	mod: { mult: 1, tl: 20, ar: 12, dr: 4, sl: 4, rr: 8, wave: 0, fb: 3, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 },
	car: { mult: 1, tl: 0, ar: 12, dr: 4, sl: 2, rr: 8, wave: 0, eg: 1, ksl: 0, ksr: 0, am: 0, vib: 0 }
};

// Look up OPL patch for a GM program number
function getOplPatch( program ) {

	if ( OPL_PATCHES[ program ] !== undefined ) return OPL_PATCHES[ program ];
	return OPL_DEFAULT_PATCH;

}

// MIDI note to frequency conversion
function midiToFreq( note ) {

	return 440.0 * Math.pow( 2, ( note - 69 ) / 12.0 );

}

// Initialize song system
export function songs_init( hogFile ) {

	_hogFile = hogFile;

	// Initialize channel state
	for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

		_channels.push( {
			program: 0,		// current instrument (0-127)
			volume: 100,	// channel volume (0-127)
			pan: 64,		// pan (0=left, 64=center, 127=right)
			expression: 127,	// expression controller
			pitchBend: 0	// pitch bend in cents (±200 = ±2 semitones)
		} );

	}

	console.log( 'SONGS: Music system initialized' );

}

// Set shared AudioContext from digi.js (avoids Chrome's limit of ~6 AudioContexts)
export function songs_set_audio_context( ctx, masterGainNode ) {

	_audioContext = ctx;

	// Compressor prevents clipping with many simultaneous FM voices
	_compressor = ctx.createDynamicsCompressor();
	_compressor.threshold.value = - 12;
	_compressor.knee.value = 6;
	_compressor.ratio.value = 4;
	_compressor.attack.value = 0.003;
	_compressor.release.value = 0.1;

	// Chain: notes → _masterGain → _compressor → masterGainNode
	_masterGain = ctx.createGain();
	_masterGain.gain.value = _volume;
	_masterGain.connect( _compressor );
	_compressor.connect( masterGainNode );

}

// Ensure AudioContext exists (falls back to creating its own if none shared)
function ensureAudioContext() {

	if ( _audioContext !== null ) return true;

	try {

		_audioContext = new ( window.AudioContext || window.webkitAudioContext )();

		_compressor = _audioContext.createDynamicsCompressor();
		_compressor.threshold.value = - 12;
		_compressor.knee.value = 6;
		_compressor.ratio.value = 4;
		_compressor.attack.value = 0.003;
		_compressor.release.value = 0.1;

		_masterGain = _audioContext.createGain();
		_masterGain.gain.value = _volume;
		_masterGain.connect( _compressor );
		_compressor.connect( _audioContext.destination );

		return true;

	} catch ( e ) {

		console.warn( 'SONGS: Could not create AudioContext:', e );
		return false;

	}

}

// Play a song by index
export function songs_play_song( songnum, loop ) {

	if ( _hogFile === null ) return;

	// Stop current song
	songs_stop();

	// Get filename
	const filename = ( songnum < SHAREWARE_SONGS.length ) ? SHAREWARE_SONGS[ songnum ] : null;

	if ( filename === null ) {

		console.log( 'SONGS: No music file for song ' + songnum );
		return;

	}

	// Load HMP from HOG
	const file = _hogFile.findFile( filename );

	if ( file === null ) {

		console.warn( 'SONGS: ' + filename + ' not found in HOG' );
		return;

	}

	const hmpData = new Uint8Array( file.readBytes( file.length() ) );
	const hmpFile = hmp_parse( hmpData );

	if ( hmpFile === null ) {

		console.warn( 'SONGS: Failed to parse ' + filename );
		return;

	}

	// Get flattened event list with absolute times in seconds
	_events = hmp_get_events( hmpFile );

	if ( _events.length === 0 ) {

		console.warn( 'SONGS: No events in ' + filename );
		return;

	}

	// Find song duration
	_songDuration = _events[ _events.length - 1 ].time + 1.0;

	if ( ensureAudioContext() !== true ) return;

	// Resume if suspended
	if ( _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

	// Reset channel state
	for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

		_channels[ i ].program = 0;
		_channels[ i ].volume = 100;
		_channels[ i ].pan = 64;
		_channels[ i ].expression = 127;
		_channels[ i ].pitchBend = 0;

	}

	// Start playback
	_currentSong = songnum;
	_playing = true;
	_looping = ( loop === true || loop === 1 );
	_eventIndex = 0;
	_startTime = _audioContext.currentTime + 0.1; // small delay for scheduling
	_scheduledUntil = 0;

	// Schedule events in chunks
	scheduleNextChunk();

	console.log( 'SONGS: Playing ' + filename + ' (' + _events.length + ' events, ' +
		_songDuration.toFixed( 1 ) + 's' + ( _looping ? ', looping' : '' ) + ')' );

}

// Play level music
export function songs_play_level_song( levelnum ) {

	// Map level number to song index
	// Shareware has 5 game tracks (game0-4.hmp) cycling through 7 levels
	const songIndex = SONG_LEVEL_MUSIC + ( ( levelnum - 1 ) % 5 );
	songs_play_song( songIndex, true );

}

// Stop current song
export function songs_stop() {

	_playing = false;
	_currentSong = - 1;
	_events = null;

	if ( _scheduleTimer !== null ) {

		clearTimeout( _scheduleTimer );
		_scheduleTimer = null;

	}

	// Stop all active notes
	stopAllNotes();

}

// Pause current song (remember position for resume)
let _pauseTime = 0;

export function songs_pause() {

	if ( _playing !== true ) return;
	if ( _audioContext === null ) return;

	_pauseTime = _audioContext.currentTime - _startTime;
	_playing = false;

	if ( _scheduleTimer !== null ) {

		clearTimeout( _scheduleTimer );
		_scheduleTimer = null;

	}

	stopAllNotes();

}

// Resume paused song from saved position
export function songs_resume_playback() {

	if ( _events === null || _pauseTime <= 0 ) return;
	if ( _audioContext === null ) return;

	_playing = true;
	_startTime = _audioContext.currentTime - _pauseTime;

	// Find the event index that corresponds to our resume position
	_eventIndex = 0;
	for ( let i = 0; i < _events.length; i ++ ) {

		if ( _events[ i ].time > _pauseTime ) break;
		_eventIndex = i + 1;

	}

	scheduleNextChunk();

}

// Set music volume (0.0 to 1.0)
export function songs_set_volume( vol ) {

	_volume = vol;

	if ( _masterGain !== null ) {

		_masterGain.gain.value = vol;

	}

}

// Schedule the next chunk of MIDI events
function scheduleNextChunk() {

	if ( _playing !== true || _events === null ) return;

	const SCHEDULE_AHEAD = 2.0; // schedule 2 seconds ahead
	const now = _audioContext.currentTime;
	const songTime = now - _startTime;
	const scheduleUntilTime = songTime + SCHEDULE_AHEAD;

	while ( _eventIndex < _events.length ) {

		const ev = _events[ _eventIndex ];

		if ( ev.time > scheduleUntilTime ) break;

		const playTime = _startTime + ev.time;

		// Only schedule if in the future
		if ( playTime >= now - 0.01 ) {

			processMidiEvent( ev, playTime );

		}

		_eventIndex ++;

	}

	// Check if song is done
	if ( _eventIndex >= _events.length ) {

		if ( _looping === true ) {

			// Restart song
			_eventIndex = 0;
			_startTime = _startTime + _songDuration;

			// Reset channels
			for ( let i = 0; i < NUM_CHANNELS; i ++ ) {

				_channels[ i ].program = 0;
				_channels[ i ].volume = 100;
				_channels[ i ].pan = 64;
				_channels[ i ].expression = 127;
				_channels[ i ].pitchBend = 0;

			}

		} else {

			_playing = false;
			return;

		}

	}

	// Schedule next chunk
	_scheduleTimer = setTimeout( scheduleNextChunk, 500 );

}

// Process a single MIDI event
function processMidiEvent( ev, playTime ) {

	const ch = ev.channel;

	switch ( ev.type ) {

		case 0x8: // Note Off
			scheduleNoteOff( ch, ev.data1, playTime );
			break;

		case 0x9: // Note On
			if ( ev.data2 === 0 ) {

				// velocity 0 = note off
				scheduleNoteOff( ch, ev.data1, playTime );

			} else {

				scheduleNoteOn( ch, ev.data1, ev.data2, playTime );

			}

			break;

		case 0xB: // Control Change
			handleControlChange( ch, ev.data1, ev.data2 );
			break;

		case 0xC: // Program Change
			_channels[ ch ].program = ev.data1;
			break;

		case 0xE: // Pitch Bend
			handlePitchBend( ch, ev.data1, ev.data2, playTime );
			break;

	}

}

// Schedule a note-on using OPL2-accurate 2-operator FM synthesis
// Modulator → Carrier topology with exact bank file parameters
function scheduleNoteOn( channel, note, velocity, time ) {

	if ( _audioContext === null ) return;

	// Stop any existing note on this channel/pitch with a short fade to avoid click
	const key = channel + '-' + note;
	const existing = _activeNotes.get( key );

	if ( existing !== undefined ) {

		try {

			existing.noteGain.gain.cancelAndHoldAtTime( time );
			existing.noteGain.gain.linearRampToValueAtTime( 0, time + 0.003 );
			existing.carrier.stop( time + 0.005 );
			existing.modulator.stop( time + 0.005 );

		} catch ( e ) { /* already stopped */ }

		_activeNotes.delete( key );

	}

	// Get OPL patch from instrument program
	const program = _channels[ channel ].program;
	const opl = getOplPatch( program );
	const freq = midiToFreq( note );
	const vel = velocity / 127;

	// --- Convert OPL2 register values to Web Audio parameters ---

	// Frequency multipliers
	const modFreq = freq * oplMultiplier( opl.mod.mult );
	const carFreq = freq * oplMultiplier( opl.car.mult );

	// Modulator depth from total level (attenuation → linear gain)
	// In OPL2, modulator output modulates carrier phase. Web Audio FM works in Hz,
	// so we convert: modDepth_Hz = modIndex * carrierFreq
	// OPL2 at TL=0 produces ~4π radians of peak phase deviation
	const modDepthScale = oplTotalLevel( opl.mod.tl );
	const peakMod = modDepthScale * carFreq * 8.0; // velocity does NOT affect modulator (OPL2 spec)

	// Carrier output level from total level
	const carLevel = oplTotalLevel( opl.car.tl );

	// ADSR times
	const modAR = oplAttackRate( opl.mod.ar );
	const modDR = oplDecayRate( opl.mod.dr );
	const modSL = oplSustainLevel( opl.mod.sl );
	const modRR = oplDecayRate( opl.mod.rr );
	const carAR = oplAttackRate( opl.car.ar );
	const carDR = oplDecayRate( opl.car.dr );
	const carSL = oplSustainLevel( opl.car.sl );
	const carRR = oplDecayRate( opl.car.rr );

	// EG type: 0 = non-sustaining (after decay, continues at release rate to silence)
	const modSustaining = opl.mod.eg === 1;
	const carSustaining = opl.car.eg === 1;

	// --- Modulator oscillator ---
	// Waveform includes pre-computed feedback (baked into PeriodicWave)
	const modulator = _audioContext.createOscillator();
	const modWave = getOplWaveform( opl.mod.wave, opl.mod.fb );

	if ( modWave !== null ) {

		modulator.setPeriodicWave( modWave );

	} else {

		modulator.type = 'sine';

	}

	modulator.frequency.value = modFreq;

	// Modulator depth envelope (controls FM brightness over time)
	// OPL2: attack is exponential (fast rise then taper), decay is exponential in amplitude
	const modGain = _audioContext.createGain();
	modGain.gain.setValueAtTime( 0, time );

	if ( peakMod > 0.1 ) {

		const modSustainVal = modSustaining === true ? Math.max( peakMod * modSL, 0.0001 ) : 0.0001;

		// OPL2 attack: exponential approach (fast start, tapers off)
		// setTargetAtTime approximates this: reaches ~95% at 3×timeConstant
		modGain.gain.setTargetAtTime( peakMod, time, modAR / 3 );

		// OPL2 decay: exponential decay in amplitude (linear in dB)
		modGain.gain.setTargetAtTime( modSustainVal, time + modAR, modDR / 3 );

		// Non-sustaining: after decay phase, continue at release rate to silence
		if ( modSustaining !== true ) {

			modGain.gain.setTargetAtTime( 0.0001, time + modAR + modDR, modRR / 3 );

		}

	}

	modulator.connect( modGain );

	// --- Carrier oscillator (audible output) ---
	const carrier = _audioContext.createOscillator();
	const carWave = getOplWaveform( opl.car.wave, 0 ); // carrier never has feedback

	if ( carWave !== null ) {

		carrier.setPeriodicWave( carWave );

	} else {

		carrier.type = 'sine';

	}

	carrier.frequency.value = carFreq;

	// Connect modulator → carrier frequency (FM)
	modGain.connect( carrier.frequency );

	// Apply pitch bend to BOTH operators (OPL2 changes channel frequency for both)
	if ( _channels[ channel ].pitchBend !== 0 ) {

		carrier.detune.setValueAtTime( _channels[ channel ].pitchBend, time );
		modulator.detune.setValueAtTime( _channels[ channel ].pitchBend, time );

	}

	// --- Carrier amplitude ADSR envelope ---
	const noteGain = _audioContext.createGain();

	// Volume: velocity² × channel volume × expression × carrier level
	// Velocity only affects carrier (OPL2 spec: velocity maps to carrier TL only)
	const velSq = vel * vel;
	const channelVol = _channels[ channel ].volume / 127;
	const expression = _channels[ channel ].expression / 127;
	const vol = velSq * channelVol * expression * carLevel * 0.18;

	const carSustainVal = carSustaining === true ? Math.max( vol * carSL, 0.0001 ) : 0.0001;

	// OPL2 attack: exponential approach curve
	noteGain.gain.setValueAtTime( 0, time );
	noteGain.gain.setTargetAtTime( vol, time, carAR / 3 );

	// OPL2 decay: exponential decay in amplitude
	noteGain.gain.setTargetAtTime( carSustainVal, time + carAR, carDR / 3 );

	// Non-sustaining carrier: after decay, continue at release rate to silence
	if ( carSustaining !== true ) {

		noteGain.gain.setTargetAtTime( 0.0001, time + carAR + carDR, carRR / 3 );

	}

	// --- Build output chain ---
	carrier.connect( noteGain );

	// Pan: map MIDI 0-127 to Web Audio -1 to +1
	const panValue = ( _channels[ channel ].pan - 64 ) / 64;
	let panNode = null;

	if ( typeof _audioContext.createStereoPanner === 'function' ) {

		panNode = _audioContext.createStereoPanner();
		panNode.pan.setValueAtTime( panValue, time );
		noteGain.connect( panNode );
		panNode.connect( _masterGain );

	} else {

		noteGain.connect( _masterGain );

	}

	carrier.start( time );
	modulator.start( time );

	// Auto-stop: max note duration (non-sustaining notes stop sooner)
	const maxDuration = ( carSustaining === true ) ? 10.0 : ( carAR + carDR + carRR + 1.0 );
	const stopTime = time + Math.min( maxDuration, 10.0 );
	carrier.stop( stopTime );
	modulator.stop( stopTime );

	_activeNotes.set( key, {
		carrier: carrier,
		modulator: modulator,
		noteGain: noteGain,
		modGain: modGain,
		pan: panNode,
		carRR: carRR,
		modRR: modRR,
		endTime: stopTime
	} );

}

// Schedule a note-off with OPL2-style release envelopes
// Uses exponential decay (setTargetAtTime) matching OPL2's linear-in-dB release
function scheduleNoteOff( channel, note, time ) {

	const key = channel + '-' + note;
	const active = _activeNotes.get( key );

	if ( active === undefined ) return;

	const carRelease = active.carRR;
	const modRelease = active.modRR;
	const maxRelease = Math.max( carRelease, modRelease );
	const stopTime = time + maxRelease + 0.1;

	try {

		// Cancel any scheduled automation and freeze at current value
		active.noteGain.gain.cancelAndHoldAtTime( time );
		// OPL2 release: exponential decay in amplitude
		active.noteGain.gain.setTargetAtTime( 0.0001, time, carRelease / 3 );

		active.modGain.gain.cancelAndHoldAtTime( time );
		active.modGain.gain.setTargetAtTime( 0.0001, time, modRelease / 3 );

		active.carrier.stop( stopTime );
		active.modulator.stop( stopTime );

	} catch ( e ) { /* already stopped */ }

	_activeNotes.delete( key );

}

// Handle MIDI Control Change
function handleControlChange( channel, controller, value ) {

	switch ( controller ) {

		case 7: // Channel Volume
			_channels[ channel ].volume = value;
			break;

		case 10: // Pan
			_channels[ channel ].pan = value;
			break;

		case 11: // Expression
			_channels[ channel ].expression = value;
			break;

		case 121: // Reset All Controllers
			_channels[ channel ].volume = 100;
			_channels[ channel ].pan = 64;
			_channels[ channel ].expression = 127;
			_channels[ channel ].pitchBend = 0;
			break;

	}

}

// Handle MIDI Pitch Bend
// Pitch bend value: (data2 << 7) | data1, centered at 8192
// Range: ±2 semitones (±200 cents)
function handlePitchBend( channel, data1, data2, playTime ) {

	const bendValue = ( ( data2 << 7 ) | data1 ) - 8192;	// -8192 to +8191
	const bendCents = ( bendValue / 8192 ) * 200;			// ±200 cents = ±2 semitones
	_channels[ channel ].pitchBend = bendCents;

	// Apply to all active notes on this channel (both carrier AND modulator)
	for ( const [ key, active ] of _activeNotes ) {

		if ( key.startsWith( channel + '-' ) === true ) {

			try {

				active.carrier.detune.setValueAtTime( bendCents, playTime );
				active.modulator.detune.setValueAtTime( bendCents, playTime );

			} catch ( e ) { /* oscillator may have stopped */ }

		}

	}

}

// Stop all currently sounding notes
function stopAllNotes() {

	if ( _audioContext === null ) return;

	const now = _audioContext.currentTime;

	for ( const [ key, active ] of _activeNotes ) {

		try {

			active.noteGain.gain.cancelScheduledValues( now );
			active.noteGain.gain.setValueAtTime( 0, now );
			active.modGain.gain.cancelScheduledValues( now );
			active.modGain.gain.setValueAtTime( 0, now );
			active.carrier.stop( now + 0.01 );
			active.modulator.stop( now + 0.01 );

		} catch ( e ) { /* already stopped */ }

	}

	_activeNotes.clear();

}

// Resume audio context (call from user gesture)
export function songs_resume() {

	if ( _audioContext !== null && _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

}
