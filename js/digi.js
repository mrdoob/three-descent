// Ported from: descent-master/MAIN/DIGI.C
// Digital sound playback via Web Audio API

// Sound ID constants (from SOUNDS.H)
export const SOUND_LASER_FIRED = 10;
export const SOUND_WEAPON_HIT_BLASTABLE = 11;
export const SOUND_BADASS_EXPLOSION = 11;		// alias
export const SOUND_ROBOT_HIT_PLAYER = 17;
export const SOUND_ROBOT_HIT = 20;
export const SOUND_ROBOT_DESTROYED = 21;
export const SOUND_VOLATILE_WALL_HIT = 21;		// alias
export const SOUND_DROP_BOMB = 26;
export const SOUND_WEAPON_HIT_DOOR = 27;
export const SOUND_LASER_HIT_CLUTTER = 30;
export const SOUND_CONTROL_CENTER_HIT = 30;		// alias
export const SOUND_EXPLODING_WALL = 31;
export const SOUND_CONTROL_CENTER_DESTROYED = 31;	// alias
export const SOUND_CONTROL_CENTER_WARNING_SIREN = 32;
export const SOUND_MINE_BLEW_UP = 33;
export const SOUND_FUSION_WARMUP = 34;
export const SOUND_REFUEL_STATION_GIVING_FUEL = 62;
export const SOUND_PLAYER_HIT_WALL = 70;
export const SOUND_PLAYER_GOT_HIT = 71;
export const SOUND_HOSTAGE_RESCUED = 91;

// Countdown voice sounds (SOUND_COUNTDOWN_0_SECS through SOUND_COUNTDOWN_29_SECS)
export const SOUND_COUNTDOWN_0_SECS = 100;
export const SOUND_COUNTDOWN_13_SECS = 113;
export const SOUND_COUNTDOWN_29_SECS = 114;

export const SOUND_HUD_MESSAGE = 117;
export const SOUND_HUD_KILL = 118;
export const SOUND_HOMING_WARNING = 122;
export const SOUND_VOLATILE_WALL_HISS = 151;
export const SOUND_GOOD_SELECTION_PRIMARY = 153;
export const SOUND_GOOD_SELECTION_SECONDARY = 154;
export const SOUND_ALREADY_SELECTED = 155;
export const SOUND_BAD_SELECTION = 156;
export const SOUND_CLOAK_OFF = 161;
export const SOUND_INVULNERABILITY_OFF = 163;
export const SOUND_BOSS_SHARE_SEE = 183;
export const SOUND_BOSS_SHARE_DIE = 185;

// Sounds[] array maps game sound IDs to PIG sound file indices
// Built from $SOUNDS in bitmaps.bin (shareware) or HAM data (registered)
let Sounds = null;

// Audio system state
let _audioContext = null;
let _masterGain = null;		// overall master gain → destination
let _digiGain = null;		// SFX gain → master (separate from music)
let _soundBuffers = [];		// AudioBuffer[] indexed by PIG sound index
let _pigFile = null;
let _initialized = false;

// Maximum simultaneous sounds (avoid audio overload)
const MAX_CONCURRENT_SOUNDS = 16;
let _activeSources = 0;

// Channel stealing: track active sources with their volumes
// Ported from: DIGI.C digi_start_sound() — replaces quietest sound when channels full
const _activeSourceEntries = [];

// Track active one-shot sound IDs (for digi_play_sample_once)
const _activeOneShotSounds = new Set();

// Track source nodes for digi_play_sample_once (soundId → source)
// Ported from: DIGI.C digi_play_sample_once() — stops previous instance before replaying
const _onceSourceMap = new Map();

// Per-sound-ID concurrent instance tracking (prevents stacking)
// Ported from: DIGI.C — limits same sound playing simultaneously
const MAX_SAME_SOUND = 3;
const _soundInstanceCounts = new Map();

// Sound sample rate (from original Descent)
const SOUND_SAMPLE_RATE = 11025;

// Initialize the digital sound system
export function digi_init( pigFile ) {

	_pigFile = pigFile;

	// Don't create AudioContext until user gesture (browser policy)
	// We'll lazily create it on first play

	console.log( 'DIGI: Sound system ready (' + pigFile.sounds.length + ' sounds available)' );

}

// Set the Sounds[] mapping table (game sound ID -> PIG sound index)
export function digi_set_sounds_table( soundsTable ) {

	Sounds = soundsTable;

}

// Ensure AudioContext exists (must be called after user gesture)
function ensureAudioContext() {

	if ( _audioContext !== null ) return true;

	try {

		_audioContext = new ( window.AudioContext || window.webkitAudioContext )();

		// Master gain → destination
		_masterGain = _audioContext.createGain();
		_masterGain.gain.value = 1.0;
		_masterGain.connect( _audioContext.destination );

		// SFX gain → master (separate volume control from music)
		_digiGain = _audioContext.createGain();
		_digiGain.gain.value = 0.5;
		_digiGain.connect( _masterGain );

		// Pre-allocate buffer array
		_soundBuffers = new Array( _pigFile.sounds.length );

		return true;

	} catch ( e ) {

		console.warn( 'DIGI: Could not create AudioContext:', e );
		return false;

	}

}

// Convert 8-bit unsigned PCM to AudioBuffer
function createAudioBuffer( soundIndex ) {

	if ( _soundBuffers[ soundIndex ] !== undefined ) return _soundBuffers[ soundIndex ];

	const rawData = _pigFile.getSoundData( soundIndex );
	if ( rawData === null ) {

		_soundBuffers[ soundIndex ] = null;
		return null;

	}

	const sampleCount = rawData.length;
	const audioBuffer = _audioContext.createBuffer( 1, sampleCount, SOUND_SAMPLE_RATE );
	const channelData = audioBuffer.getChannelData( 0 );

	// Convert unsigned 8-bit (0-255) to signed float (-1.0 to +1.0)
	for ( let i = 0; i < sampleCount; i ++ ) {

		channelData[ i ] = ( rawData[ i ] - 128 ) / 128.0;

	}

	_soundBuffers[ soundIndex ] = audioBuffer;
	return audioBuffer;

}

// Channel stealing: stop the quietest active source to make room for a new one
// Ported from: DIGI.C digi_start_sound() lines 993-1000 — replaces lowest-volume channel
function steal_lowest_volume_channel( newVolume ) {

	if ( _activeSourceEntries.length === 0 ) return false;

	let quietest = 0;
	let quietestVol = _activeSourceEntries[ 0 ].volume;

	for ( let i = 1; i < _activeSourceEntries.length; i ++ ) {

		if ( _activeSourceEntries[ i ].volume < quietestVol ) {

			quietestVol = _activeSourceEntries[ i ].volume;
			quietest = i;

		}

	}

	// Only steal if the new sound is louder than the quietest
	if ( newVolume <= quietestVol ) return false;

	const entry = _activeSourceEntries[ quietest ];
	try {

		entry.source.onended = null;
		entry.source.stop();

	} catch ( e ) { /* ignore */ }

	// Clean up counters manually since we nulled onended
	_activeSources --;
	const cnt = _soundInstanceCounts.get( entry.soundId ) || 1;
	if ( cnt <= 1 ) {

		_soundInstanceCounts.delete( entry.soundId );

	} else {

		_soundInstanceCounts.set( entry.soundId, cnt - 1 );

	}

	_activeSourceEntries.splice( quietest, 1 );
	return true;

}

// Resolve a game sound ID to its PIG file sound index
function resolveSoundIndex( soundId ) {

	let pigIndex = soundId;

	if ( Sounds !== null && soundId < Sounds.length ) {

		pigIndex = Sounds[ soundId ];

	}

	if ( pigIndex < 0 || pigIndex >= _pigFile.sounds.length ) return - 1;

	return pigIndex;

}

// Play a non-positional (2D) sound — for player/UI sounds
// volume: 0.0 to 1.0
export function digi_play_sample( soundId, volume ) {

	if ( _pigFile === null ) return;
	if ( ensureAudioContext() !== true ) return;
	if ( volume === undefined ) volume = 1.0;

	// Channel stealing: if at max, try to replace quietest sound
	if ( _activeSources >= MAX_CONCURRENT_SOUNDS ) {

		if ( steal_lowest_volume_channel( volume ) !== true ) return;

	}

	// Limit concurrent instances of same sound to prevent stacking
	const curCount = _soundInstanceCounts.get( soundId ) || 0;
	if ( curCount >= MAX_SAME_SOUND ) return;

	const pigIndex = resolveSoundIndex( soundId );
	if ( pigIndex === - 1 ) return;

	const buffer = createAudioBuffer( pigIndex );
	if ( buffer === null ) return;

	const source = _audioContext.createBufferSource();
	source.buffer = buffer;

	// Volume control
	const gainNode = _audioContext.createGain();
	gainNode.gain.value = volume;
	source.connect( gainNode );
	gainNode.connect( _digiGain );

	_activeSources ++;
	_activeOneShotSounds.add( soundId );
	_soundInstanceCounts.set( soundId, curCount + 1 );

	// Track for channel stealing
	const entry = { source: source, volume: volume, soundId: soundId };
	_activeSourceEntries.push( entry );

	source.onended = function () {

		_activeSources --;
		_activeOneShotSounds.delete( soundId );
		const cnt = _soundInstanceCounts.get( soundId ) || 1;
		if ( cnt <= 1 ) {

			_soundInstanceCounts.delete( soundId );

		} else {

			_soundInstanceCounts.set( soundId, cnt - 1 );

		}

		// Remove from tracking array
		const idx = _activeSourceEntries.indexOf( entry );
		if ( idx !== - 1 ) _activeSourceEntries.splice( idx, 1 );

	};

	source.start( 0 );

	return source;

}

// Play a 3D positional sound at a world position (Descent coordinates)
// Uses Web Audio PannerNode for spatial audio
export function digi_play_sample_3d( soundId, volume, pos_x, pos_y, pos_z ) {

	if ( _pigFile === null ) return;
	if ( ensureAudioContext() !== true ) return;
	if ( volume === undefined ) volume = 1.0;

	// Channel stealing: if at max, try to replace quietest sound
	if ( _activeSources >= MAX_CONCURRENT_SOUNDS ) {

		if ( steal_lowest_volume_channel( volume ) !== true ) return;

	}

	// Limit concurrent instances of same sound to prevent stacking
	const curCount = _soundInstanceCounts.get( soundId ) || 0;
	if ( curCount >= MAX_SAME_SOUND ) return;

	const pigIndex = resolveSoundIndex( soundId );
	if ( pigIndex === - 1 ) return;

	const buffer = createAudioBuffer( pigIndex );
	if ( buffer === null ) return;

	const source = _audioContext.createBufferSource();
	source.buffer = buffer;

	// Volume control
	const gainNode = _audioContext.createGain();
	gainNode.gain.value = volume;

	// 3D panner for spatial positioning
	const panner = _audioContext.createPanner();
	panner.panningModel = 'HRTF';
	panner.distanceModel = 'inverse';
	panner.refDistance = 10.0;
	panner.maxDistance = 300.0;
	panner.rolloffFactor = 1.5;
	panner.coneOuterGain = 1.0;	// omnidirectional sound source

	// Set position (Descent coordinates — same as listener)
	if ( panner.positionX !== undefined ) {

		panner.positionX.value = pos_x;
		panner.positionY.value = pos_y;
		panner.positionZ.value = pos_z;

	} else {

		panner.setPosition( pos_x, pos_y, pos_z );

	}

	// Connect: source → gain → panner → digiGain (SFX bus)
	source.connect( gainNode );
	gainNode.connect( panner );
	panner.connect( _digiGain );

	_activeSources ++;
	_soundInstanceCounts.set( soundId, curCount + 1 );

	// Track for channel stealing
	const entry = { source: source, volume: volume, soundId: soundId };
	_activeSourceEntries.push( entry );

	source.onended = function () {

		_activeSources --;
		const cnt = _soundInstanceCounts.get( soundId ) || 1;
		if ( cnt <= 1 ) {

			_soundInstanceCounts.delete( soundId );

		} else {

			_soundInstanceCounts.set( soundId, cnt - 1 );

		}

		// Remove from tracking array
		const idx = _activeSourceEntries.indexOf( entry );
		if ( idx !== - 1 ) _activeSourceEntries.splice( idx, 1 );

	};

	source.start( 0 );

}

// Update the AudioListener position and orientation each frame
// All coordinates are in Descent space (X=right, Y=up, Z=forward)
export function digi_update_listener( pos_x, pos_y, pos_z, fwd_x, fwd_y, fwd_z, up_x, up_y, up_z ) {

	if ( _audioContext === null ) return;

	const listener = _audioContext.listener;

	if ( listener.positionX !== undefined ) {

		// Modern AudioParam API
		listener.positionX.value = pos_x;
		listener.positionY.value = pos_y;
		listener.positionZ.value = pos_z;
		listener.forwardX.value = fwd_x;
		listener.forwardY.value = fwd_y;
		listener.forwardZ.value = fwd_z;
		listener.upX.value = up_x;
		listener.upY.value = up_y;
		listener.upZ.value = up_z;

	} else {

		// Legacy API fallback
		listener.setPosition( pos_x, pos_y, pos_z );
		listener.setOrientation( fwd_x, fwd_y, fwd_z, up_x, up_y, up_z );

	}

}

// --- Sound Object Linking System (from DIGI.C) ---
// Persistent/looping 3D sounds attached to objects or positions

const SOF_USED = 1;
const SOF_PLAYING = 2;
const SOF_LINK_TO_OBJ = 4;
const SOF_LINK_TO_POS = 8;
const SOF_PLAY_FOREVER = 16;

const MAX_SOUND_OBJECTS = 16;
let _nextSignature = 1;

// Pre-allocated sound object pool (Golden Rule #5: no allocations in render loop)
const _soundObjects = [];

for ( let _si = 0; _si < MAX_SOUND_OBJECTS; _si ++ ) {

	_soundObjects.push( {
		signature: 0,
		flags: 0,
		soundnum: - 1,
		max_volume: 1.0,
		max_distance: 320.0,		// 256 * F1_0 / 65536 ≈ 256 units → ~320 for 1.25x factor
		// Link to object
		objnum: - 1,
		objsignature: 0,
		// Link to position
		segnum: - 1,
		sidenum: - 1,
		pos_x: 0,
		pos_y: 0,
		pos_z: 0,
		// Web Audio nodes (reused per slot)
		source: null,
		gainNode: null,
		panner: null
	} );

}

// Callback to get object position/alive state — set via digi_set_object_getter()
let _getObject = null;

// Set the object getter callback (avoids circular imports)
// getter(objnum) should return { pos_x, pos_y, pos_z, signature, type } or null
export function digi_set_object_getter( getter ) {

	_getObject = getter;

}

// Start playing a sound object slot
function startSoundObject( idx ) {

	const so = _soundObjects[ idx ];

	if ( _audioContext === null ) return;
	if ( so.flags === 0 ) return;

	const pigIndex = resolveSoundIndex( so.soundnum );
	if ( pigIndex === - 1 ) return;

	const buffer = createAudioBuffer( pigIndex );
	if ( buffer === null ) return;

	// Create audio nodes
	const source = _audioContext.createBufferSource();
	source.buffer = buffer;

	if ( ( so.flags & SOF_PLAY_FOREVER ) !== 0 ) {

		source.loop = true;

	}

	const gainNode = _audioContext.createGain();
	gainNode.gain.value = so.max_volume;

	const panner = _audioContext.createPanner();
	panner.panningModel = 'HRTF';
	panner.distanceModel = 'inverse';
	panner.refDistance = 10.0;
	panner.maxDistance = so.max_distance;
	panner.rolloffFactor = 1.5;
	panner.coneOuterGain = 1.0;

	// Set initial position
	let px = so.pos_x;
	let py = so.pos_y;
	let pz = so.pos_z;

	if ( ( so.flags & SOF_LINK_TO_OBJ ) !== 0 && _getObject !== null ) {

		const obj = _getObject( so.objnum );
		if ( obj !== null ) {

			px = obj.pos_x;
			py = obj.pos_y;
			pz = obj.pos_z;

		}

	}

	if ( panner.positionX !== undefined ) {

		panner.positionX.value = px;
		panner.positionY.value = py;
		panner.positionZ.value = pz;

	} else {

		panner.setPosition( px, py, pz );

	}

	// Connect: source → gain → panner → digiGain
	source.connect( gainNode );
	gainNode.connect( panner );
	panner.connect( _digiGain );

	// Store nodes for later update/stop
	so.source = source;
	so.gainNode = gainNode;
	so.panner = panner;
	so.flags |= SOF_PLAYING;

	_activeSources ++;

	const capturedIdx = idx;
	source.onended = function () {

		_activeSources --;
		const slot = _soundObjects[ capturedIdx ];
		if ( ( slot.flags & SOF_PLAY_FOREVER ) === 0 ) {

			slot.flags = 0;

		} else {

			slot.flags &= ~SOF_PLAYING;

		}

		slot.source = null;
		slot.gainNode = null;
		slot.panner = null;

	};

	source.start( 0 );

}

// Stop a sound object slot
function stopSoundObject( idx ) {

	const so = _soundObjects[ idx ];

	if ( so.source !== null ) {

		try {

			so.source.stop();

		} catch ( e ) { /* already stopped */ }

		so.source = null;
		so.gainNode = null;
		so.panner = null;

	}

	so.flags = 0;

}

// Link a sound to a moving object (follows the object each frame)
// Returns a signature ID, or -1 on failure
export function digi_link_sound_to_object( soundnum, objnum, forever, max_volume ) {

	return digi_link_sound_to_object2( soundnum, objnum, forever, max_volume, 320.0 );

}

export function digi_link_sound_to_object2( soundnum, objnum, forever, max_volume, max_distance ) {

	if ( _pigFile === null ) return - 1;
	if ( ensureAudioContext() !== true ) return - 1;
	if ( max_volume < 0 ) return - 1;

	// If not forever, just play a one-shot 3D sound at the object's position
	if ( forever !== true && forever !== 1 ) {

		if ( _getObject !== null ) {

			const obj = _getObject( objnum );
			if ( obj !== null ) {

				digi_play_sample_3d( soundnum, max_volume, obj.pos_x, obj.pos_y, obj.pos_z );

			}

		}

		return - 1;

	}

	// Find free slot
	let i;

	for ( i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		if ( _soundObjects[ i ].flags === 0 ) break;

	}

	if ( i === MAX_SOUND_OBJECTS ) return - 1;

	const so = _soundObjects[ i ];
	so.signature = _nextSignature ++;
	so.flags = SOF_USED | SOF_LINK_TO_OBJ | SOF_PLAY_FOREVER;
	so.soundnum = soundnum;
	so.objnum = objnum;
	so.max_volume = ( max_volume !== undefined ) ? max_volume : 1.0;
	so.max_distance = ( max_distance !== undefined ) ? max_distance : 320.0;

	// Get object signature for validity checking
	if ( _getObject !== null ) {

		const obj = _getObject( objnum );
		if ( obj !== null ) {

			so.objsignature = obj.signature;

		}

	}

	startSoundObject( i );

	return so.signature;

}

// Link a sound to a fixed position (e.g. a wall/door)
export function digi_link_sound_to_pos( soundnum, segnum, sidenum, pos_x, pos_y, pos_z, forever, max_volume ) {

	return digi_link_sound_to_pos2( soundnum, segnum, sidenum, pos_x, pos_y, pos_z, forever, max_volume, 320.0 );

}

export function digi_link_sound_to_pos2( soundnum, segnum, sidenum, pos_x, pos_y, pos_z, forever, max_volume, max_distance ) {

	if ( _pigFile === null ) return - 1;
	if ( ensureAudioContext() !== true ) return - 1;
	if ( max_volume < 0 ) return - 1;

	// If not forever, just play a one-shot 3D sound
	if ( forever !== true && forever !== 1 ) {

		digi_play_sample_3d( soundnum, max_volume, pos_x, pos_y, pos_z );
		return - 1;

	}

	// Find free slot
	let i;

	for ( i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		if ( _soundObjects[ i ].flags === 0 ) break;

	}

	if ( i === MAX_SOUND_OBJECTS ) return - 1;

	const so = _soundObjects[ i ];
	so.signature = _nextSignature ++;
	so.flags = SOF_USED | SOF_LINK_TO_POS | SOF_PLAY_FOREVER;
	so.soundnum = soundnum;
	so.segnum = segnum;
	so.sidenum = sidenum;
	so.pos_x = pos_x;
	so.pos_y = pos_y;
	so.pos_z = pos_z;
	so.max_volume = ( max_volume !== undefined ) ? max_volume : 1.0;
	so.max_distance = ( max_distance !== undefined ) ? max_distance : 320.0;

	startSoundObject( i );

	return so.signature;

}

// Kill all sounds linked to a specific object
export function digi_kill_sound_linked_to_object( objnum ) {

	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) !== 0 && ( so.flags & SOF_LINK_TO_OBJ ) !== 0 ) {

			if ( so.objnum === objnum ) {

				stopSoundObject( i );

			}

		}

	}

}

// Kill sounds linked to a specific segment/side/sound combo
export function digi_kill_sound_linked_to_segment( segnum, sidenum, soundnum ) {

	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) !== 0 && ( so.flags & SOF_LINK_TO_POS ) !== 0 ) {

			if ( so.segnum === segnum && so.sidenum === sidenum && so.soundnum === soundnum ) {

				stopSoundObject( i );

			}

		}

	}

}

// Sync all sound objects each frame — update positions of object-linked sounds,
// remove sounds whose linked objects have died
export function digi_sync_sounds() {

	if ( _audioContext === null ) return;

	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) === 0 ) continue;

		if ( ( so.flags & SOF_LINK_TO_OBJ ) !== 0 ) {

			// Update position from linked object
			if ( _getObject !== null ) {

				const obj = _getObject( so.objnum );

				if ( obj === null || obj.signature !== so.objsignature ) {

					// Object is dead — stop the sound
					stopSoundObject( i );
					continue;

				}

				// Update panner position to follow the object
				if ( so.panner !== null ) {

					if ( so.panner.positionX !== undefined ) {

						so.panner.positionX.value = obj.pos_x;
						so.panner.positionY.value = obj.pos_y;
						so.panner.positionZ.value = obj.pos_z;

					} else {

						so.panner.setPosition( obj.pos_x, obj.pos_y, obj.pos_z );

					}

				}

			}

		}

		// Position-linked sounds don't need updating (they don't move)

	}

}

// Stop all sound objects (e.g. on level change)
export function digi_stop_all_sounds() {

	// Stop sound objects
	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		if ( _soundObjects[ i ].flags !== 0 ) {

			stopSoundObject( i );

		}

	}

}

// Check if a specific sound ID is currently playing (sound objects + one-shots)
export function digi_is_sound_playing( soundId ) {

	// Check one-shot sounds
	if ( _activeOneShotSounds.has( soundId ) === true ) return true;

	// Check sound objects
	for ( let i = 0; i < MAX_SOUND_OBJECTS; i ++ ) {

		const so = _soundObjects[ i ];

		if ( ( so.flags & SOF_USED ) !== 0 && ( so.flags & SOF_PLAYING ) !== 0 ) {

			if ( so.soundnum === soundId ) return true;

		}

	}

	return false;

}

// Play a sound, stopping any previous instance first (for continuous sounds like refueling)
// Ported from: DIGI.C digi_play_sample_once() — stops previous then replays from start
export function digi_play_sample_once( soundId, volume ) {

	// Stop previous instance of this sound if still playing
	if ( _onceSourceMap.has( soundId ) === true ) {

		const oldSource = _onceSourceMap.get( soundId );
		try { oldSource.stop(); } catch ( e ) { /* already stopped */ }
		_onceSourceMap.delete( soundId );

	}

	const source = digi_play_sample( soundId, volume );
	if ( source != null ) {

		_onceSourceMap.set( soundId, source );

		// Clean up map entry when sound finishes naturally
		const capturedId = soundId;
		const origOnEnded = source.onended;
		source.onended = function () {

			_onceSourceMap.delete( capturedId );
			if ( origOnEnded !== null ) origOnEnded();

		};

	}

}

// Set SFX volume (0.0 to 1.0)
export function digi_set_digi_volume( vol ) {

	if ( _digiGain !== null ) {

		_digiGain.gain.value = vol;

	}

}

// Get the shared AudioContext (for songs.js to reuse)
export function digi_get_audio_context() {

	if ( ensureAudioContext() !== true ) return null;
	return _audioContext;

}

// Get the master gain node (for songs.js to connect to)
export function digi_get_master_gain() {

	return _masterGain;

}

// Resume audio context after user gesture (required by browser policy)
export function digi_resume() {

	if ( _audioContext !== null && _audioContext.state === 'suspended' ) {

		_audioContext.resume();

	}

}
