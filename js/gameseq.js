// Ported from: descent-master/MAIN/GAMESEQ.C
// Game sequencing: level flow, player state, object placement, set_externals wiring

import * as THREE from 'three';
import { load_mine_data_compiled_old, load_mine_data_compiled_new } from './gamemine.js';
import { buildMineGeometry, clearRenderCaches, updateDoorMesh, updateEclipTexture, setWallMeshVisible, rebuildSideOverlay } from './render.js';
import { game_init, game_set_mine, game_loop, game_set_player_start, game_set_player_dead, game_reset_physics, getScene, getCamera, getPlayerPos, getPlayerSegnum, game_set_frame_callback, game_set_automap, game_set_fusion_externals, game_set_quit_callback, game_set_cockpit_mode_callback, game_set_save_callback, game_set_load_callback } from './game.js';
import { load_game_data, get_Gamesave_num_org_robots } from './gamesave.js';
import { Polygon_models, buildModelMesh, buildAnimatedModelMesh, polyobj_set_glow, compute_engine_glow, polyobj_rebuild_glow_refs } from './polyobj.js';
import { OBJ_PLAYER, OBJ_ROBOT, OBJ_CNTRLCEN, OBJ_HOSTAGE, OBJ_POWERUP, RT_POLYOBJ, RT_POWERUP, RT_HOSTAGE,
	init_objects, obj_set_segments } from './object.js';
import { wall_set_externals, wall_set_render_callback, wall_set_player_callbacks, wall_set_illusion_callback, wall_set_explosion_callback, wall_set_explode_wall_callback, wall_init_door_textures, wall_reset, wall_toggle } from './wall.js';
import { collide_set_externals, apply_damage_to_player, collide_robot_and_weapon, collide_weapon_and_wall, collide_badass_explosion, collide_player_and_powerup, collide_player_and_nasty_robot, collide_robot_and_player, drop_player_eggs, scrape_object_on_wall } from './collide.js';
import { init_special_effects, effects_set_externals, effects_set_render_callback, reset_special_effects } from './effects.js';
import { switch_set_externals } from './switch.js';
import { laser_init, laser_set_externals, laser_get_homing_object_dist, laser_get_stuck_flares, Primary_weapon, Secondary_weapon, set_primary_weapon, set_secondary_weapon } from './laser.js';
import { fireball_init, fireball_set_badass_wall_callback, object_create_explosion, explode_model, debris_cleanup, init_exploding_walls, explode_wall, VCLIP_PLAYER_HIT } from './fireball.js';
import { ai_set_externals, init_robots_for_level, ai_reset_gun_point_cache, ai_reset_anim_cache, AILocalInfo, ai_notify_player_fired_laser, ai_do_cloak_stuff } from './ai.js';
import { digi_play_sample, digi_play_sample_once, digi_play_sample_3d, digi_sync_sounds,
	SOUND_CLOAK_OFF, SOUND_INVULNERABILITY_OFF, SOUND_PLAYER_GOT_HIT,
	SOUND_REFUEL_STATION_GIVING_FUEL, SOUND_HOMING_WARNING, SOUND_PLAYER_HIT_WALL,
	SOUND_BADASS_EXPLOSION, SOUND_ROBOT_DESTROYED } from './digi.js';
import { Sounds } from './bm.js';
import { autoSelectPrimary as weapon_autoSelectPrimary, autoSelectSecondary as weapon_autoSelectSecondary } from './weapon.js';
import { songs_play_level_song, songs_stop, songs_play_song, SONG_TITLE } from './songs.js';
import { do_briefing_screens, hide_title_canvas, show_title_canvas } from './titles.js';
import { do_main_menu } from './menu.js';
import { Segments, Vertices, Num_segments, Highest_segment_index, Side_to_verts, Walls, FrameTime, GameTime, Automap_visited, Textures } from './mglobal.js';
import { buildAutomapGeometry } from './automap.js';
import { fuelcen_init, fuelcen_reset, fuelcen_set_externals, fuelcen_frame_process, SEGMENT_IS_FUELCEN } from './fuelcen.js';
import { cntrlcen_set_externals, cntrlcen_set_reactor, init_controlcen_for_level, startSelfDestruct,
	cntrlcen_is_self_destruct_active, cntrlcen_reset,
	do_controlcen_frame, do_controlcen_destroyed_frame } from './cntrlcen.js';
import { Robot_info, N_robot_types } from './robot.js';
import { do_morph_frame } from './morph.js';
import { gauges_init, gauges_update, gauges_flash_damage, gauges_set_white_flash, gauges_draw, gauges_set_externals, gauges_add_score_points, gauges_set_cockpit_mode } from './gauges.js';
import { hud_show_message } from './hud.js';
import { powerup_set_externals, powerup_place, powerup_place_hostage, powerup_do_frame, powerup_cleanup, powerup_get_live, spawnDroppedPowerup, buildSpriteTexture } from './powerup.js';
import { hostage_get_in_level, hostage_get_level_saved, hostage_get_total_saved,
	hostage_add_in_level, hostage_add_level_saved, hostage_add_total_saved,
	hostage_reset_level, hostage_reset_all } from './hostage.js';
import { physics_set_wall_hit_callback, getPlayerVelocity } from './physics.js';
import { lighting_init, lighting_frame, lighting_cleanup } from './lighting.js';

// External references (injected from main.js)
let _hogFile = null;
let _pigFile = null;
let _palette = null;
let _setStatus = null;

export function gameseq_set_externals( ext ) {

	if ( ext.hogFile !== undefined ) _hogFile = ext.hogFile;
	if ( ext.pigFile !== undefined ) _pigFile = ext.pigFile;
	if ( ext.palette !== undefined ) _palette = ext.palette;
	if ( ext.setStatus !== undefined ) _setStatus = ext.setStatus;

}

function setStatus( msg ) {

	if ( _setStatus !== null ) _setStatus( msg );

}

// --- Tracked robots for collision detection by weapon system ---
const liveRobots = [];

// --- Player state ---
let playerShields = 100;
let playerEnergy = 100;

// Cloak and invulnerability timers (0 = inactive)
// Ported from: Players[].cloak_time and Players[].invulnerable_time in PLAYER.H
const CLOAK_TIME_MAX = 30.0;		// 30 seconds (F1_0*30 in original)
const INVULNERABLE_TIME_MAX = 30.0;
let playerCloakTime = 0;		// time remaining, 0 = not cloaked
let playerInvulnerableTime = 0;	// time remaining, 0 = not invulnerable

// Player death/respawn state
let playerDead = false;
let deathTimer = 0;
let deathExplosionTimer = 0;
let savedPlayerStart = null;
let _pendingSaveRestore = null;	// save data set by loadGame, applied after level loads

// Level tracking (shareware: levels 1-7)
let currentLevelNum = 1;
const MAX_SHAREWARE_LEVELS = 7;
let levelTransitioning = false;
let gameInitialized = false;
let soundInitialized = false;

// Difficulty level: 0=Trainee, 1=Rookie, 2=Hotshot, 3=Ace, 4=Insane
// Ported from: GAME.H (#define NDL 5, Difficulty_level 0..NDL-1)
let Difficulty_level = 1;	// default: Rookie

// Player inventory
let playerKeys = { blue: false, red: false, gold: false };
let playerPrimaryFlags = 1;	// bit 0 = laser (always have)
let playerSecondaryFlags = 1;	// bit 0 = concussion (start with it)
const playerSecondaryAmmo = [ 3, 0, 0, 0, 0 ];	// concussion, homing, proximity, smart, mega
let playerVulcanAmmo = 0;
let playerLaserLevel = 0;	// 0-3 (4 levels)
let playerQuadLasers = false;	// Ported from: PLAYER.H PLAYER_FLAGS_QUAD_LASERS
let playerLives = 3;
let playerScore = 0;
let playerLastScore = 0;	// Score at level start (for skill points calculation)
let playerKills = 0;

// --- Getters for external access ---
export function gameseq_get_difficulty() { return Difficulty_level; }
export function gameseq_set_difficulty( d ) { Difficulty_level = d; }
export function gameseq_get_secondary_ammo() { return playerSecondaryAmmo; }
export function gameseq_get_sound_initialized() { return soundInitialized; }
export function gameseq_set_sound_initialized( v ) { soundInitialized = v; }

// --- HUD wrappers ---
function updateHUD() {

	gauges_update( {
		shields: playerShields,
		energy: playerEnergy,
		primaryWeapon: Primary_weapon,
		secondaryWeapon: Secondary_weapon,
		laserLevel: playerLaserLevel,
		vulcanAmmo: playerVulcanAmmo,
		secondaryAmmo: playerSecondaryAmmo,
		quadLasers: playerQuadLasers,
		keysBlue: playerKeys.blue,
		keysRed: playerKeys.red,
		keysGold: playerKeys.gold,
		score: playerScore,
		lives: playerLives,
		homingObjectDist: laser_get_homing_object_dist(),
		gameTime: GameTime,
		playerDead: playerDead,
		playerExploded: playerDead,
		cloakTimeRemaining: playerCloakTime,
		invulnerableTimeRemaining: playerInvulnerableTime
	} );

}

function flashDamage( color ) {

	gauges_flash_damage( color );

}

function showMessage( msg ) {

	hud_show_message( msg );

}

// --- Cloak/Invulnerability helpers ---
// Ported from: PLAYER.H PLAYER_FLAGS_CLOAKED / PLAYER_FLAGS_INVULNERABLE

function isPlayerCloaked() {

	return playerCloakTime > 0;

}

function isPlayerInvulnerable() {

	return playerInvulnerableTime > 0;

}

function activateCloak() {

	playerCloakTime = CLOAK_TIME_MAX;
	showMessage( 'CLOAK ON!' );

	// Initialize AI cloak tracking to current player position
	// Ported from: ai_do_cloak_stuff() in AI.C lines 3549-3560
	ai_do_cloak_stuff();

}

function activateInvulnerability() {

	playerInvulnerableTime = INVULNERABLE_TIME_MAX;
	showMessage( 'INVULNERABILITY ON!' );

}

// --- High score persistence (localStorage) ---
// Ported from: SCORES.C — high score table
const HIGH_SCORE_KEY = 'descent_high_scores';
const MAX_HIGH_SCORES = 10;

function getHighScores() {

	try {

		const data = localStorage.getItem( HIGH_SCORE_KEY );
		if ( data !== null ) return JSON.parse( data );

	} catch ( e ) { /* ignore */ }

	return [];

}

function saveHighScore( score, kills, hostages, difficulty ) {

	const scores = getHighScores();

	scores.push( { score: score, kills: kills, hostages: hostages, difficulty: difficulty, date: Date.now() } );
	scores.sort( function ( a, b ) { return b.score - a.score; } );

	if ( scores.length > MAX_HIGH_SCORES ) scores.length = MAX_HIGH_SCORES;

	try {

		localStorage.setItem( HIGH_SCORE_KEY, JSON.stringify( scores ) );

	} catch ( e ) { /* ignore */ }

	return scores;

}

function getHighestScore() {

	const scores = getHighScores();
	if ( scores.length === 0 ) return 0;
	return scores[ 0 ].score;

}

// --- Save / Load game ---
// Ported from: GAMESAVE.C save/restore functionality
// Uses localStorage for checkpoint-style saves (saves player state + current level)
const SAVE_KEY = 'descent_savegame';

function saveGame() {

	const pp = getPlayerPos();
	if ( pp === null ) return false;

	const cam = getCamera();

	const saveData = {
		version: 1,
		level: currentLevelNum,
		shields: playerShields,
		energy: playerEnergy,
		primaryFlags: playerPrimaryFlags,
		secondaryFlags: playerSecondaryFlags,
		secondaryAmmo: [ playerSecondaryAmmo[ 0 ], playerSecondaryAmmo[ 1 ], playerSecondaryAmmo[ 2 ], playerSecondaryAmmo[ 3 ], playerSecondaryAmmo[ 4 ] ],
		vulcanAmmo: playerVulcanAmmo,
		laserLevel: playerLaserLevel,
		quadLasers: playerQuadLasers,
		lives: playerLives,
		score: playerScore,
		kills: playerKills,
		keys: { blue: playerKeys.blue, red: playerKeys.red, gold: playerKeys.gold },
		pos: { x: pp.x, y: pp.y, z: pp.z },
		quat: cam !== null ? { x: cam.quaternion.x, y: cam.quaternion.y, z: cam.quaternion.z, w: cam.quaternion.w } : null,
		difficulty: Difficulty_level,
		hostagesSaved: hostage_get_total_saved()
	};

	try {

		localStorage.setItem( SAVE_KEY, JSON.stringify( saveData ) );
		console.log( 'SAVE: Game saved at level ' + currentLevelNum );
		return true;

	} catch ( e ) {

		console.error( 'SAVE: Failed to save game:', e );
		return false;

	}

}

function loadGame() {

	try {

		const json = localStorage.getItem( SAVE_KEY );
		if ( json === null ) return false;

		const saveData = JSON.parse( json );
		if ( saveData.version !== 1 ) return false;

		console.log( 'LOAD: Loading saved game from level ' + saveData.level );

		// Set difficulty before level load (affects robot spawns, etc.)
		Difficulty_level = saveData.difficulty !== undefined ? saveData.difficulty : 1;

		// Store full save data for deferred restoration after advanceLevel() resets
		// (advanceLevel() overwrites shields/energy/keys during its init phase)
		_pendingSaveRestore = saveData;

		// Navigate to saved level
		currentLevelNum = saveData.level;
		advanceLevel();

		return true;

	} catch ( e ) {

		console.error( 'LOAD: Failed to load game:', e );
		return false;

	}

}

// --- Score / extra lives ---
// Ported from: add_points_to_score() in GAUGES.C lines 1179-1219
const EXTRA_SHIP_SCORE = 50000;

function addPlayerScore( points ) {

	const prevScore = playerScore;
	playerScore += points;
	gauges_add_score_points( points );

	// Award extra lives every 50,000 points
	const prevShips = Math.floor( prevScore / EXTRA_SHIP_SCORE );
	const newShips = Math.floor( playerScore / EXTRA_SHIP_SCORE );

	if ( newShips > prevShips ) {

		playerLives += ( newShips - prevShips );
		showMessage( 'EXTRA LIFE!' );

	}

	updateHUD();

}

// --- Auto-select wrappers ---
function autoSelectPrimary() {

	weapon_autoSelectPrimary( playerPrimaryFlags, playerVulcanAmmo, playerEnergy,
		set_primary_weapon, showMessage, updateHUD );

}

function autoSelectSecondary() {

	weapon_autoSelectSecondary( playerSecondaryAmmo, set_secondary_weapon, showMessage, updateHUD );

}

// --- Player death sequence ---
// Ported from: DoPlayerDead() in GAME.C
function startPlayerDeath() {

	if ( playerDead === true ) return;

	playerDead = true;
	deathTimer = 4.0;		// 4 seconds before respawn
	deathExplosionTimer = 0;
	game_set_player_dead( true );

	// Drop weapons/powerups at death location
	// Ported from: drop_player_eggs() in COLLIDE.C lines 1447-1546
	drop_player_eggs();

	// Create explosion at player position
	const pp = getPlayerPos();
	object_create_explosion( pp.x, pp.y, pp.z, 5.0 );
	showMessage( 'YOU WERE DESTROYED!' );

	console.log( 'Player destroyed! Lives remaining: ' + ( playerLives - 1 ) );

}

function respawnPlayer() {

	playerLives --;

	if ( playerLives <= 0 ) {

		console.log( 'GAME OVER — no lives remaining' );
		showGameOver();
		return;

	}

	// Reset player state
	// Ported from: init_player_stats_new_ship() in GAMESEQ.C lines 580-617
	playerDead = false;
	playerShields = 100;
	playerEnergy = 100;
	playerCloakTime = 0;
	playerInvulnerableTime = 0;
	playerKeys = { blue: false, red: false, gold: false };
	playerPrimaryFlags = 1;		// HAS_LASER_FLAG only
	playerSecondaryFlags = 1;	// HAS_CONCUSSION_FLAG
	playerQuadLasers = false;	// Lose quad lasers on death
	// Starting concussion missiles: 2 + NDL - Difficulty_level (more on easier)
	playerSecondaryAmmo[ 0 ] = 2 + 5 - Difficulty_level;
	playerSecondaryAmmo[ 1 ] = 0;
	playerSecondaryAmmo[ 2 ] = 0;
	playerSecondaryAmmo[ 3 ] = 0;
	playerSecondaryAmmo[ 4 ] = 0;
	playerVulcanAmmo = 0;
	playerLaserLevel = 0;

	// Reset weapons to defaults
	set_primary_weapon( 0 );
	set_secondary_weapon( 0 );

	// Reset physics (zero velocity/rotation)
	game_reset_physics();

	// Teleport to start position
	if ( savedPlayerStart !== null ) {

		game_set_player_start( savedPlayerStart );

	}

	game_set_player_dead( false );
	updateHUD();
	showMessage( 'RESPAWNING... Lives: ' + playerLives );

	// Create respawn flash effect at player position
	// Ported from: create_player_appearance_effect() in GAMESEQ.C lines 752-778
	const respawnPos = getPlayerPos();
	object_create_explosion( respawnPos.x, respawnPos.y, respawnPos.z, 5.0, VCLIP_PLAYER_HIT );

}

// --- Handle level exit trigger ---
function handleLevelExit( isSecret ) {

	if ( levelTransitioning === true ) return;
	levelTransitioning = true;

	console.log( 'LEVEL EXIT: ' + ( isSecret === true ? 'Secret' : 'Normal' ) + ' exit from level ' + currentLevelNum );

	const isFinalLevel = ( currentLevelNum >= MAX_SHAREWARE_LEVELS );

	// Show end-of-level bonus screen
	// Ported from: DoEndLevelScoreGlitz() in GAMESEQ.C
	showBonusScreen( isFinalLevel, async () => {

		if ( isFinalLevel === true ) {

			// Beat the game!
			showMessage( 'CONGRATULATIONS! You completed all levels!' );
			console.log( 'GAME COMPLETE! All ' + MAX_SHAREWARE_LEVELS + ' levels finished.' );
			showGameOver();
			return;

		}

		// Advance to next level
		currentLevelNum ++;
		await advanceLevel();

	} );

}

// --- End-of-level score bonus screen ---
// Ported from: DoEndLevelScoreGlitz() in GAMESEQ.C
let bonusOverlay = null;

function showBonusScreen( isFinalLevel, onContinue ) {

	// Calculate bonuses — multiplied by (Difficulty_level + 1)
	// Ported from GAMESEQ.C: shield_points = f2i(shields) * 10 * (Difficulty_level+1)
	const diffMultiplier = Difficulty_level + 1;
	const shieldBonus = Math.floor( playerShields ) * 10 * diffMultiplier;
	const energyBonus = Math.floor( playerEnergy ) * 5 * diffMultiplier;
	const hostageBonus = hostage_get_level_saved() * 500 * diffMultiplier;

	// Full rescue bonus: all hostages in level rescued
	let allHostageBonus = 0;
	if ( hostage_get_in_level() > 0 && hostage_get_level_saved() === hostage_get_in_level() ) {

		allHostageBonus = hostage_get_level_saved() * 1000 * diffMultiplier;

	}

	// Skill points bonus: extra points for playing on higher difficulty
	// Ported from: GAMESEQ.C lines 1059-1066
	let skillBonus = 0;
	if ( Difficulty_level > 1 ) {

		const levelPoints = playerScore - playerLastScore;
		skillBonus = Math.floor( levelPoints * ( Difficulty_level - 1 ) / 2 );
		skillBonus -= skillBonus % 100;	// Round down to nearest 100
		if ( skillBonus < 0 ) skillBonus = 0;

	}

	// Endgame bonus: lives remaining on final level
	let endgameBonus = 0;
	if ( isFinalLevel === true && playerLives > 0 ) {

		endgameBonus = playerLives * 10000;

	}

	const totalBonus = shieldBonus + energyBonus + hostageBonus + allHostageBonus + skillBonus + endgameBonus;
	playerScore += totalBonus;

	// Build the overlay
	if ( bonusOverlay === null ) {

		bonusOverlay = document.createElement( 'div' );
		bonusOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;font-family:monospace;';
		document.body.appendChild( bonusOverlay );

	}

	bonusOverlay.innerHTML = '';
	bonusOverlay.style.display = 'flex';

	// Title
	const title = document.createElement( 'div' );
	title.style.cssText = 'color:#ff6600;font-size:36px;font-weight:bold;text-shadow:0 0 20px #ff6600;margin-bottom:30px;';
	title.textContent = 'LEVEL ' + currentLevelNum + ' COMPLETE';
	bonusOverlay.appendChild( title );

	// Bonus lines
	const lines = [
		[ 'SHIELD BONUS', shieldBonus ],
		[ 'ENERGY BONUS', energyBonus ],
		[ 'HOSTAGE BONUS', hostageBonus ]
	];

	if ( allHostageBonus > 0 ) {

		lines.push( [ 'FULL RESCUE BONUS', allHostageBonus ] );

	}

	if ( skillBonus > 0 ) {

		lines.push( [ 'SKILL BONUS', skillBonus ] );

	}

	if ( endgameBonus > 0 ) {

		lines.push( [ 'SHIP BONUS', endgameBonus ] );

	}

	lines.push( [ '', '' ] );	// spacer
	lines.push( [ 'TOTAL BONUS', totalBonus ] );
	lines.push( [ 'TOTAL SCORE', playerScore ] );

	for ( let i = 0; i < lines.length; i ++ ) {

		const row = document.createElement( 'div' );
		row.style.cssText = 'display:flex;justify-content:space-between;width:400px;margin:4px 0;';

		if ( lines[ i ][ 0 ] === '' ) {

			// Spacer
			row.style.height = '16px';

		} else {

			const label = document.createElement( 'span' );
			const isTotalLine = ( lines[ i ][ 0 ] === 'TOTAL BONUS' || lines[ i ][ 0 ] === 'TOTAL SCORE' );
			label.style.cssText = 'color:' + ( isTotalLine === true ? '#ff6600' : '#0f0' ) + ';font-size:' + ( isTotalLine === true ? '18px' : '14px' ) + ';';
			label.textContent = lines[ i ][ 0 ];
			row.appendChild( label );

			const value = document.createElement( 'span' );
			value.style.cssText = 'color:' + ( isTotalLine === true ? '#ff6600' : '#0f0' ) + ';font-size:' + ( isTotalLine === true ? '18px' : '14px' ) + ';';
			value.textContent = '' + lines[ i ][ 1 ];
			row.appendChild( value );

		}

		bonusOverlay.appendChild( row );

	}

	// Stats
	const stats = document.createElement( 'div' );
	stats.style.cssText = 'color:#666;font-size:12px;margin-top:20px;';
	stats.textContent = 'Hostages: ' + hostage_get_level_saved() + '/' + hostage_get_in_level() + '  |  Kills: ' + playerKills + '  |  Lives: ' + playerLives;
	bonusOverlay.appendChild( stats );

	// Continue prompt
	const prompt = document.createElement( 'div' );
	prompt.style.cssText = 'color:#0f0;font-size:16px;margin-top:30px;animation:blink 1.5s infinite;';
	prompt.textContent = 'CLICK TO CONTINUE';
	bonusOverlay.appendChild( prompt );

	// Click handler
	const clickHandler = () => {

		bonusOverlay.style.display = 'none';
		bonusOverlay.removeEventListener( 'click', clickHandler );
		updateHUD();

		if ( onContinue !== null ) {

			onContinue();

		}

	};

	bonusOverlay.addEventListener( 'click', clickHandler );

	console.log( 'BONUS: Shield=' + shieldBonus + ' Energy=' + energyBonus + ' Hostage=' + hostageBonus +
		' AllHostage=' + allHostageBonus + ' Endgame=' + endgameBonus + ' Total=' + totalBonus );

}

// --- Clean up current level and load next ---
async function advanceLevel() {

	const scene = getScene();

	// Remove all tracked objects from scene
	for ( let i = 0; i < liveRobots.length; i ++ ) {

		if ( liveRobots[ i ].mesh !== null ) {

			scene.remove( liveRobots[ i ].mesh );

		}

	}

	powerup_cleanup( scene );

	// Clear tracked arrays
	liveRobots.length = 0;

	// Clean up debris from previous level
	debris_cleanup();

	// Reset dynamic object lights
	lighting_cleanup();

	// Reset wall/door state
	wall_reset();

	// Reset automap visited segments for new level
	Automap_visited.fill( 0 );

	// Reset player state (keep weapons between levels)
	// Ported from: init_ammo_and_energy() in GAMESEQ.C lines 572-578
	// Ensure shields and energy are at least starting values
	if ( playerShields < 100 ) playerShields = 100;
	if ( playerEnergy < 100 ) playerEnergy = 100;
	// Keys are level-specific — clear for new level
	playerKeys = { blue: false, red: false, gold: false };
	playerDead = false;
	playerCloakTime = 0;
	playerInvulnerableTime = 0;
	game_set_player_dead( false );
	game_reset_physics();
	cntrlcen_reset();
	fuelcen_reset();
	reset_special_effects();
	gauges_set_white_flash( 0 );
	levelTransitioning = false;

	// Show briefing screens for the next level (skip on save game load)
	if ( _pendingSaveRestore === null ) {

		show_title_canvas();
		await do_briefing_screens( _hogFile, currentLevelNum );
		hide_title_canvas();

	}

	// Build level filename
	const num = currentLevelNum < 10 ? '0' + currentLevelNum : '' + currentLevelNum;
	const levelName = 'level' + num + '.sdl';

	console.log( 'Loading level: ' + levelName );
	songs_play_level_song( currentLevelNum );
	loadLevel( levelName );

}

// --- Level loading ---
export function loadLevel( levelName ) {

	// Find the level file in the HOG
	let levelFile = _hogFile.findFile( levelName );

	if ( levelFile === null ) {

		// Try uppercase
		levelFile = _hogFile.findFile( levelName.toUpperCase() );

	}

	if ( levelFile === null ) {

		// List available level files (.sdl and .rdl) for debugging
		const files = _hogFile.listFiles();
		const levelFiles = files.filter( f => {

			const upper = f.toUpperCase();
			return upper.endsWith( '.SDL' ) || upper.endsWith( '.RDL' );

		} );

		console.log( 'Available level files:', levelFiles );

		if ( levelFiles.length > 0 ) {

			setStatus( 'Level "' + levelName + '" not found, trying ' + levelFiles[ 0 ] + '...' );
			levelFile = _hogFile.findFile( levelFiles[ 0 ] );

		}

	}

	if ( levelFile === null ) {

		setStatus( 'Error: Could not find any level files in HOG' );
		return;

	}

	// Track score at level start for skill points calculation
	// Ported from: GAMESEQ.C init_player_stats_level() — Players[Player_num].last_score
	playerLastScore = playerScore;

	loadLevelData( levelFile );

}

// Check if any objects (player or robots) are blocking a door side
// Ported from: check_poke() in WALL.C lines 641-652
// Simplified: instead of get_seg_masks(), check if object center is close to the door plane
// and within the doorway area. Returns true if any object is blocking.
// Pre-allocated scratch vectors (Golden Rule #5)
const _doorNormal = { x: 0, y: 0, z: 0 };
const _doorCenter = { x: 0, y: 0, z: 0 };

function checkObjectsInDoorway( segnum, sidenum, csegnum, csidenum ) {

	// Compute door side center and normal
	const seg = Segments[ segnum ];
	const sv = Side_to_verts[ sidenum ];
	let cx = 0, cy = 0, cz = 0;

	for ( let v = 0; v < 4; v ++ ) {

		const vi = seg.verts[ sv[ v ] ];
		cx += Vertices[ vi * 3 + 0 ];
		cy += Vertices[ vi * 3 + 1 ];
		cz += Vertices[ vi * 3 + 2 ];

	}

	_doorCenter.x = cx / 4;
	_doorCenter.y = cy / 4;
	_doorCenter.z = cz / 4;

	// Compute face normal from two edges (v0->v1 cross v0->v3)
	const vi0 = seg.verts[ sv[ 0 ] ];
	const vi1 = seg.verts[ sv[ 1 ] ];
	const vi3 = seg.verts[ sv[ 3 ] ];

	const e1x = Vertices[ vi1 * 3 + 0 ] - Vertices[ vi0 * 3 + 0 ];
	const e1y = Vertices[ vi1 * 3 + 1 ] - Vertices[ vi0 * 3 + 1 ];
	const e1z = Vertices[ vi1 * 3 + 2 ] - Vertices[ vi0 * 3 + 2 ];
	const e2x = Vertices[ vi3 * 3 + 0 ] - Vertices[ vi0 * 3 + 0 ];
	const e2y = Vertices[ vi3 * 3 + 1 ] - Vertices[ vi0 * 3 + 1 ];
	const e2z = Vertices[ vi3 * 3 + 2 ] - Vertices[ vi0 * 3 + 2 ];

	let nx = e1y * e2z - e1z * e2y;
	let ny = e1z * e2x - e1x * e2z;
	let nz = e1x * e2y - e1y * e2x;
	const nmag = Math.sqrt( nx * nx + ny * ny + nz * nz );

	if ( nmag < 0.0001 ) return false;

	nx /= nmag;
	ny /= nmag;
	nz /= nmag;

	_doorNormal.x = nx;
	_doorNormal.y = ny;
	_doorNormal.z = nz;

	// Check player position against the door plane
	const pp = getPlayerPos();
	if ( pp !== null ) {

		const playerSeg = getPlayerSegnum();
		if ( playerSeg === segnum || playerSeg === csegnum ) {

			const pdx = pp.x - _doorCenter.x;
			const pdy = pp.y - _doorCenter.y;
			const pdz = pp.z - _doorCenter.z;
			const playerDist = Math.abs( pdx * nx + pdy * ny + pdz * nz );
			const PLAYER_RADIUS = 3.2;	// approximate player collision radius

			if ( playerDist < PLAYER_RADIUS ) {

				return true;	// player is blocking the door

			}

		}

	}

	// Check robots in both segments adjacent to the door
	for ( let r = 0; r < liveRobots.length; r ++ ) {

		const robot = liveRobots[ r ];
		if ( robot.alive !== true ) continue;

		const robotSeg = robot.obj.segnum;
		if ( robotSeg !== segnum && robotSeg !== csegnum ) continue;

		const rdx = robot.obj.pos_x - _doorCenter.x;
		const rdy = robot.obj.pos_y - _doorCenter.y;
		const rdz = robot.obj.pos_z - _doorCenter.z;
		const robotDist = Math.abs( rdx * nx + rdy * ny + rdz * nz );
		const robotRadius = robot.obj.size > 0 ? robot.obj.size : 4.84;

		if ( robotDist < robotRadius ) {

			return true;	// robot is blocking the door

		}

	}

	return false;

}

function loadLevelData( levelFile ) {

	// PLVL format (used by both shareware .sdl and registered .rdl):
	// sig (int) = 'PLVL' (0x504c564c as little-endian int32)
	// version (int)
	// minedata_offset (int)
	// gamedata_offset (int)
	// hostagetext_offset (int)

	const sig = levelFile.readInt();
	const version = levelFile.readInt();
	const minedata_offset = levelFile.readInt();
	const gamedata_offset = levelFile.readInt();
	const hostagetext_offset = levelFile.readInt();

	console.log( 'Level: sig=0x' + ( sig >>> 0 ).toString( 16 ) +
		', version=' + version +
		', minedata_offset=' + minedata_offset +
		', gamedata_offset=' + gamedata_offset );

	// 'PLVL' = 0x504c564c when read as big-endian multi-char constant
	// But stored in file as little-endian, so readInt() gives 0x4c564c50
	// Actually in C, 'PLVL' = 0x504c564c, written via write_int as little-endian bytes:
	// 0x4c, 0x56, 0x4c, 0x50, then read back via read_int as 0x504c564c
	const PLVL_SIG = 0x504c564c;

	if ( sig !== PLVL_SIG ) {

		console.error( 'Level: Invalid signature 0x' + ( sig >>> 0 ).toString( 16 ) + ' (expected PLVL=0x504c564c)' );
		setStatus( 'Error: Invalid level file signature' );
		return;

	}

	// Seek to mine data and load it
	levelFile.seek( minedata_offset );

	setStatus( 'Parsing mine data...' );

	let result;

	if ( _pigFile.isShareware === true ) {

		// Shareware uses the old compiled mine format (no bitmasks, int sizes)
		result = load_mine_data_compiled_old( levelFile );

	} else {

		// Registered uses the new compressed mine format (bitmasks, ushort sizes)
		result = load_mine_data_compiled_new( levelFile );

	}

	if ( result !== 0 ) {

		setStatus( 'Error loading mine data' );
		return;

	}

	// Initialize object pool before loading game data
	// Wire up Segments reference for per-segment linked lists
	obj_set_segments( Segments, () => Highest_segment_index );
	init_objects();

	// Load game data (objects, walls, triggers, etc.)
	setStatus( 'Loading game data...' );

	levelFile.seek( gamedata_offset );
	const gameData = load_game_data( levelFile );

	// Wire up wall system before building geometry
	wall_set_externals( {
		Segments: Segments,
		Walls: Walls,
		Vertices: Vertices,
		Side_to_verts: Side_to_verts,
		Textures: Textures,
		pigFile: _pigFile,
		getFrameTime: () => FrameTime,
		checkObjectsInDoorway: checkObjectsInDoorway
	} );
	wall_set_render_callback( updateDoorMesh );
	wall_set_player_callbacks(
		() => playerKeys,
		showMessage
	);
	wall_set_illusion_callback( ( segnum, sidenum, visible ) => {

		setWallMeshVisible( segnum, sidenum, visible );

	} );
	wall_set_explosion_callback( ( pos_x, pos_y, pos_z, size ) => {

		// Create explosion at the blasted wall face
		// Ported from: explode_wall() in FIREBALL.C
		object_create_explosion( pos_x, pos_y, pos_z, size );

	} );
	wall_set_explode_wall_callback( explode_wall );

	// Build Three.js geometry
	setStatus( 'Building geometry...' );
	clearRenderCaches();
	const mineGeometry = buildMineGeometry( _pigFile, _palette );

	// Initialize door textures to their wall clip's frame 0
	// Must be done after buildMineGeometry so door meshes exist
	wall_init_door_textures();

	// Wire up trigger system
	switch_set_externals( {
		getFrameTime: () => FrameTime,
		onLevelExit: handleLevelExit,
		onPlayerShieldDamage: ( amount ) => {

			playerShields -= amount;
			if ( playerShields < 0 ) playerShields = 0;
			updateHUD();
			flashDamage();
			digi_play_sample( SOUND_PLAYER_GOT_HIT, 0.6 );

			if ( playerShields <= 0 && playerDead !== true ) {

				startPlayerDeath();

			}

		},
		onPlayerEnergyDrain: ( amount ) => {

			playerEnergy -= amount;
			if ( playerEnergy < 0 ) playerEnergy = 0;
			updateHUD();

		}
	} );

	// Wire up effects system (animated textures)
	effects_set_externals( {
		getFrameTime: () => FrameTime,
		createExplosion: object_create_explosion,
		onSideOverlayChanged: rebuildSideOverlay
	} );
	effects_set_render_callback( updateEclipTexture );
	init_special_effects();

	// Initialize the game engine (only once)
	if ( gameInitialized !== true ) {

		setStatus( 'Starting game...' );
		game_init();

	}

	game_set_mine( mineGeometry );

	// Build automap wireframe
	const automapMesh = buildAutomapGeometry();
	game_set_automap( automapMesh );

	// Wire up powerup system BEFORE placing objects (powerup_place needs pigFile/palette)
	powerup_set_externals( {
		pigFile: _pigFile,
		palette: _palette,
		scene: getScene(),
		collide_player_and_powerup: collide_player_and_powerup
	} );

	// Place objects in the scene
	if ( gameData !== null ) {

		setStatus( 'Placing objects...' );
		placeObjects( gameData );

		// Set player start position from level data
		if ( gameData.playerObj !== null ) {

			savedPlayerStart = gameData.playerObj;
			game_set_player_start( gameData.playerObj );

			// Mark starting segment as visited for automap
			if ( gameData.playerObj.segnum >= 0 ) {

				Automap_visited[ gameData.playerObj.segnum ] = 1;

			}

		}

	}

	// Initialize weapon system (pool created once, externals re-wired per level)
	if ( gameInitialized !== true ) {

		laser_init();

	}

	laser_set_externals( {
		pigFile: _pigFile,
		palette: _palette,
		scene: getScene(),
		robots: liveRobots,
		onRobotHit: collide_robot_and_weapon,
		onPlayerHit: apply_damage_to_player,
		onWallHit: collide_weapon_and_wall,
		getPlayerPos: getPlayerPos,
		getPlayerEnergy: () => playerEnergy,
		setPlayerEnergy: ( e ) => { playerEnergy = e; updateHUD(); },
		getVulcanAmmo: () => playerVulcanAmmo,
		setVulcanAmmo: ( a ) => { playerVulcanAmmo = a; },
		getSecondaryAmmo: ( slot ) => playerSecondaryAmmo[ slot ],
		setSecondaryAmmo: ( slot, a ) => { playerSecondaryAmmo[ slot ] = a; },
		onBadassExplosion: collide_badass_explosion,
		onAutoSelectPrimary: autoSelectPrimary,
		onAutoSelectSecondary: autoSelectSecondary,
		getPlayerPrimaryFlags: () => playerPrimaryFlags,
		getPlayerSecondaryAmmo: ( slot ) => playerSecondaryAmmo[ slot ],
		getPlayerLaserLevel: () => playerLaserLevel,
		onPlayerFiredLaser: ai_notify_player_fired_laser,
		isPlayerCloaked: isPlayerCloaked
	} );

	// Initialize collision system (COLLIDE.C)
	collide_set_externals( {
		getPlayerShields: () => playerShields,
		setPlayerShields: ( s ) => { playerShields = s; },
		getPlayerEnergy: () => playerEnergy,
		setPlayerEnergy: ( e ) => { playerEnergy = e; },
		getPlayerLaserLevel: () => playerLaserLevel,
		setPlayerLaserLevel: ( l ) => { playerLaserLevel = l; },
		getPlayerPrimaryFlags: () => playerPrimaryFlags,
		setPlayerPrimaryFlags: ( f ) => { playerPrimaryFlags = f; },
		getPlayerQuadLasers: () => playerQuadLasers,
		setPlayerQuadLasers: ( v ) => { playerQuadLasers = v; },
		getPlayerSecondaryFlags: () => playerSecondaryFlags,
		setPlayerSecondaryFlags: ( f ) => { playerSecondaryFlags = f; },
		getPlayerSecondaryAmmo: ( slot ) => playerSecondaryAmmo[ slot ],
		setPlayerSecondaryAmmo: ( slot, a ) => { playerSecondaryAmmo[ slot ] = a; },
		getPlayerVulcanAmmo: () => playerVulcanAmmo,
		setPlayerVulcanAmmo: ( a ) => { playerVulcanAmmo = a; },
		getPlayerKeys: () => playerKeys,
		setPlayerKey: ( key, val ) => { playerKeys[ key ] = val; },
		getPlayerLives: () => playerLives,
		setPlayerLives: ( l ) => { playerLives = l; },
		addPlayerScore: ( s ) => { addPlayerScore( s ); },
		addPlayerKills: ( k ) => { playerKills += k; },
		addHostageSaved: ( n ) => { hostage_add_total_saved( n ); },
		addLevelHostagesSaved: ( n ) => { hostage_add_level_saved( n ); },
		getPlayerPos: getPlayerPos,
		getPlayerSegnum: getPlayerSegnum,
		getScene: getScene,
		updateHUD: updateHUD,
		showMessage: showMessage,
		flashDamage: flashDamage,
		startPlayerDeath: startPlayerDeath,
		startSelfDestruct: startSelfDestruct,
		spawnDroppedPowerup: spawnDroppedPowerup,
		liveRobots: liveRobots,
		isPlayerInvulnerable: isPlayerInvulnerable,
		isPlayerCloaked: isPlayerCloaked,
		activateCloak: activateCloak,
		activateInvulnerability: activateInvulnerability,
		getDifficultyLevel: () => Difficulty_level
	} );

	// Wire up reactor / self-destruct system
	cntrlcen_set_externals( {
		getPlayerPos: getPlayerPos,
		getCamera: getCamera,
		getDifficultyLevel: () => Difficulty_level,
		isPlayerDead: () => playerDead,
		showMessage: showMessage,
		updateHUD: updateHUD,
		gauges_set_white_flash: gauges_set_white_flash,
		startPlayerDeath: startPlayerDeath,
		getPlayerShields: () => playerShields,
		setPlayerShields: ( s ) => { playerShields = s; },
		controlCenterTriggers: gameData.controlCenterTriggers,
		wallToggle: wall_toggle,
		isPlayerCloaked: isPlayerCloaked
	} );

	// Initialize exploding wall slots for this level
	// Ported from: init_exploding_walls() in FIREBALL.C line 1149
	init_exploding_walls();

	// Initialize explosion effects (pass texture builder callback)
	if ( gameInitialized !== true ) {

		fireball_init( getScene(), buildSpriteTexture, _pigFile, _palette );

		// Wire badass wall explosion callback (area damage from exploding walls)
		// Ported from: object_create_badass_explosion() calls in do_exploding_wall_frame()
		fireball_set_badass_wall_callback( collide_badass_explosion );

		// Initialize dynamic object lighting pool (robots, powerups emit glow)
		lighting_init( getScene() );

		// Sound/music already initialized in startGame() before title sequence
		if ( soundInitialized !== true ) {

			// This path should not be reached normally since sound is initialized in main.js startGame()
			soundInitialized = true;

		}

	}

	// Wire up fusion cannon externals (energy access for charge mechanic)
	game_set_fusion_externals( {
		getPlayerEnergy: () => playerEnergy,
		setPlayerEnergy: ( e ) => { playerEnergy = e; },
		flashDamage: flashDamage,
		updateHUD: updateHUD,
		applyPlayerDamage: ( damage ) => { apply_damage_to_player( damage, 0, 0, 0 ); },
		getPlayerQuadLasers: () => playerQuadLasers
	} );

	// Initialize robot AI
	ai_set_externals( {
		getPlayerPos: getPlayerPos,
		getPlayerVelocity: getPlayerVelocity,
		getPlayerSeg: getPlayerSegnum,
		robots: liveRobots,
		getDifficultyLevel: () => Difficulty_level,
		getPlayerDead: () => playerDead,
		onMeleeAttack: ( damage, claw_sound, pos_x, pos_y, pos_z ) =>
			collide_player_and_nasty_robot( damage, claw_sound, pos_x, pos_y, pos_z ),
		onBumpPlayer: ( robot, vel_x, vel_y, vel_z, mass ) =>
			collide_robot_and_player( robot, vel_x, vel_y, vel_z, mass ),
		isPlayerCloaked: isPlayerCloaked,
		onSpawnGatedRobot: spawnGatedRobot,
		onBossDeath: ( robot ) => {

			// Boss death sequence complete — explode, award score, trigger self-destruct
			// Ported from: do_boss_dying_frame() completion in AI.C lines 2433-2437
			const scene = getScene();

			// Use per-robot death sound (exp2_sound_num) if available
			// Ported from: FIREBALL.C line 1087
			let bossDeathSound = SOUND_ROBOT_DESTROYED;
			const bossType = robot.obj.id;
			if ( bossType >= 0 && bossType < N_robot_types ) {

				const exp2 = Robot_info[ bossType ].exp2_sound_num;
				if ( exp2 >= 0 ) bossDeathSound = exp2;

			}

			digi_play_sample_3d( bossDeathSound, 1.0,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );

			// Create debris from model
			if ( robot.obj.rtype !== null ) {

				explode_model(
					robot.obj.rtype.model_num,
					robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z
				);

			}

			// Remove mesh from scene
			if ( scene !== null && robot.mesh !== null ) {

				scene.remove( robot.mesh );

			}

			// Create big explosion
			object_create_explosion(
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
				robot.obj.size * 2
			);

			// Award score
			const rtype = robot.obj.id;
			if ( rtype >= 0 && rtype < N_robot_types ) {

				playerScore += Robot_info[ rtype ].score_value;
				gauges_add_score_points( Robot_info[ rtype ].score_value );

			}

			playerKills ++;
			updateHUD();

			// Trigger self-destruct (do_controlcen_destroyed_stuff in C)
			console.log( 'BOSS DESTROYED! Self-destruct initiated!' );
			digi_play_sample_3d( SOUND_BADASS_EXPLOSION, 1.0,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );
			startSelfDestruct();

		},
		onCreateExplosion: object_create_explosion
	} );
	ai_reset_gun_point_cache();
	ai_reset_anim_cache();
	init_robots_for_level();

	// Initialize matcen (robot generator) system
	if ( gameData.matcens.length > 0 ) {

		fuelcen_init( gameData.matcens );
		fuelcen_set_externals( {
			getPlayerPos: getPlayerPos,
			spawnRobot: spawnMatcenRobot,
			createExplosion: object_create_explosion,
			getFrameTime: () => FrameTime,
			getDifficultyLevel: () => Difficulty_level,
			countRobotsFromMatcen: ( matcenNum ) => {

				// Count alive robots spawned by a specific matcen
				// Ported from: FUELCEN.C lines 673-676 — matcen_creator check
				let count = 0;
				for ( let r = 0; r < liveRobots.length; r ++ ) {

					if ( liveRobots[ r ].alive === true && liveRobots[ r ].matcen_creator === matcenNum ) count ++;

				}

				return count;

			},
			countLiveRobots: () => {

				let count = 0;
				for ( let r = 0; r < liveRobots.length; r ++ ) {

					if ( liveRobots[ r ].alive === true ) count ++;

				}

				return count;

			},
			getOrgRobotCount: () => get_Gamesave_num_org_robots(),
		getPlayerSegnum: getPlayerSegnum,
		damagePlayerMatcen: ( damage ) => {

			if ( playerDead === true ) return;
			if ( playerInvulnerableTime > 0 ) return;

			playerShields -= damage;
			if ( playerShields < 0 ) playerShields = 0;
			updateHUD();
			flashDamage();
			digi_play_sample( SOUND_PLAYER_GOT_HIT, 0.6 );

			if ( playerShields <= 0 && playerDead !== true ) {

				startPlayerDeath();

			}

		},
		damageRobotInSegment: ( segnum ) => {

			for ( let r = 0; r < liveRobots.length; r ++ ) {

				const robot = liveRobots[ r ];
				if ( robot.alive === true && robot.segnum === segnum ) {

					// Apply 1.0 damage to robot in matcen segment
					robot.shields -= 1.0;

					if ( robot.shields <= 0 ) {

						robot.alive = false;

						if ( robot.mesh !== null && robot.mesh !== undefined ) {

							robot.mesh.visible = false;

						}

					}

					return true;

				}

			}

			return false;

		}
		} );

	}

	if ( gameInitialized !== true ) {

		// Create HUD (Canvas 2D overlay)
		gauges_init( getCamera(), _pigFile, _palette );
		gauges_set_externals( {
			digi_play_sample: digi_play_sample,
			SOUND_HOMING_WARNING: SOUND_HOMING_WARNING
		} );

		// Set up wall-hit damage callback
		// Ported from: collide_player_and_wall() in COLLIDE.C lines 654-693
		physics_set_wall_hit_callback( function ( damage, volume, hit_x, hit_y, hit_z, hitseg, hitside ) {

			if ( playerDead === true ) return;
			if ( playerInvulnerableTime > 0 ) return;

			// Only damage if player has more than 10 shields (C: f1_0*10)
			if ( playerShields > 10 ) {

				playerShields -= damage;
				if ( playerShields < 0 ) playerShields = 0;
				updateHUD();
				flashDamage();

				if ( playerShields <= 0 && playerDead !== true ) {

					startPlayerDeath();

				}

			}

			// Play wall hit sound with volume proportional to impact
			if ( volume > 0 ) {

				digi_play_sample_3d( SOUND_PLAYER_HIT_WALL, volume, hit_x, hit_y, hit_z );

			}

		} );

		// Register frame callback for powerup collection and reactor
		game_set_frame_callback( onFrameCallback );

		// Register quit-to-menu callback for pause menu
		game_set_quit_callback( function () { restartGame(); } );

		// Register cockpit mode change callback (F3/H keys)
		game_set_cockpit_mode_callback( function ( mode ) { gauges_set_cockpit_mode( mode ); } );

		// Register save/load callbacks for pause menu
		game_set_save_callback( saveGame );
		game_set_load_callback( loadGame );

		// Start the render loop
		requestAnimationFrame( game_loop );

		gameInitialized = true;

	}

	setStatus( '' );
	updateHUD();

	// Restore saved game state if loading a save
	if ( _pendingSaveRestore !== null ) {

		const sd = _pendingSaveRestore;

		// Restore full player state (overrides advanceLevel() resets)
		playerShields = sd.shields;
		playerEnergy = sd.energy;
		playerPrimaryFlags = sd.primaryFlags;
		playerSecondaryFlags = sd.secondaryFlags;
		for ( let i = 0; i < 5; i ++ ) playerSecondaryAmmo[ i ] = sd.secondaryAmmo[ i ];
		playerVulcanAmmo = sd.vulcanAmmo;
		playerLaserLevel = sd.laserLevel;
		playerQuadLasers = sd.quadLasers === true;
		playerLives = sd.lives;
		playerScore = sd.score;
		playerKills = sd.kills;
		playerKeys.blue = sd.keys.blue === true;
		playerKeys.red = sd.keys.red === true;
		playerKeys.gold = sd.keys.gold === true;
		playerCloakTime = 0;
		playerInvulnerableTime = 0;
		playerDead = false;

		// Restore selected weapons
		if ( sd.primaryFlags > 1 ) {

			// Auto-select best available primary weapon
			autoSelectPrimary();

		}

		if ( sd.secondaryFlags > 1 || sd.secondaryAmmo[ 0 ] > 0 ) {

			autoSelectSecondary();

		}

		// Restore camera position/orientation
		const cam = getCamera();
		if ( cam !== null && sd.pos !== null && sd.pos !== undefined ) {

			// pos was saved from getPlayerPos() which returns Descent coords
			// Convert back to Three.js: negate Z
			cam.position.set( sd.pos.x, sd.pos.y, - sd.pos.z );

			if ( sd.quat !== null && sd.quat !== undefined ) {

				cam.quaternion.set( sd.quat.x, sd.quat.y, sd.quat.z, sd.quat.w );

			}

		}

		_pendingSaveRestore = null;
		updateHUD();
		showMessage( 'GAME LOADED' );

	}

}

// --- Frame callback: check powerup collection + reactor status ---
function onFrameCallback( dt ) {

	// Draw Canvas 2D HUD overlay (handles damage flash + message timers internally)
	gauges_draw( dt );

	// Process player death sequence
	if ( playerDead === true ) {

		deathTimer -= dt;
		deathExplosionTimer -= dt;

		// Random explosions during death
		if ( deathExplosionTimer <= 0 ) {

			const pp = getPlayerPos();
			const rx = ( Math.random() - 0.5 ) * 10;
			const ry = ( Math.random() - 0.5 ) * 10;
			const rz = ( Math.random() - 0.5 ) * 10;
			object_create_explosion( pp.x + rx, pp.y + ry, pp.z + rz, 2.0 + Math.random() * 3.0 );
			deathExplosionTimer = 0.3;

		}

		if ( deathTimer <= 0 ) {

			// If self-destruct killed the player, advance to next level
			// Ported from: DoPlayerDead() in GAME.C — death during countdown = level exit
			if ( cntrlcen_is_self_destruct_active() === true ) {

				handleLevelExit( false );

			} else {

				respawnPlayer();

			}

		}

	}

	// Process cloak/invulnerability timers
	// Ported from: do_cloak_stuff() and do_invulnerable_stuff() in GAME.C
	if ( playerCloakTime > 0 ) {

		playerCloakTime -= dt;

		if ( playerCloakTime <= 3.0 && playerCloakTime + dt > 3.0 ) {

			showMessage( 'CLOAK WEARING OFF...' );

		}

		if ( playerCloakTime <= 0 ) {

			playerCloakTime = 0;
			digi_play_sample( SOUND_CLOAK_OFF, 0.8 );
			showMessage( 'CLOAK OFF!' );

		}

	}

	if ( playerInvulnerableTime > 0 ) {

		playerInvulnerableTime -= dt;

		if ( playerInvulnerableTime <= 3.0 && playerInvulnerableTime + dt > 3.0 ) {

			showMessage( 'INVULNERABILITY WEARING OFF...' );

		}

		if ( playerInvulnerableTime <= 0 ) {

			playerInvulnerableTime = 0;
			digi_play_sample( SOUND_INVULNERABILITY_OFF, 0.8 );
			showMessage( 'INVULNERABILITY OFF!' );

		}

	}

	// Process matcen (robot generator) timers
	fuelcen_frame_process();

	// Process morph animations for newly spawned matcen robots
	do_morph_frame( liveRobots, dt );

	// Sync sound objects (update positions of linked sounds each frame)
	digi_sync_sounds();

	// --- Reactor fires at player ---
	do_controlcen_frame( dt );

	// Skip pickup checks if player is dead
	if ( playerDead === true || playerShields <= 0 ) return;

	// --- Fuel center refueling ---
	// Ported from: fuelcen_give_fuel() in FUELCEN.C
	const playerSeg = getPlayerSegnum();
	if ( playerSeg >= 0 && playerSeg < Num_segments ) {

		const seg = Segments[ playerSeg ];
		if ( seg.special === SEGMENT_IS_FUELCEN ) {

			if ( playerEnergy < 200 ) {

				playerEnergy = Math.min( playerEnergy + 25.0 * dt, 200 );
				updateHUD();
				digi_play_sample_once( SOUND_REFUEL_STATION_GIVING_FUEL, 0.5 );

			}

		}

	}

	// --- Volatile wall (lava) damage ---
	// Ported from: scrape_object_on_wall() in COLLIDE.C
	scrape_object_on_wall( playerSeg, dt );

	// Animate powerup/hostage vclips and check pickup
	powerup_do_frame( dt, getPlayerPos() );

	// Update dynamic object lighting (robots/powerups emit glow)
	// Ported from: set_dynamic_light() in LIGHTING.C
	lighting_frame( getPlayerPos(), liveRobots, powerup_get_live(), laser_get_stuck_flares() );

	// Update engine glow on robot models based on velocity
	// Ported from: OBJECT.C lines 618-638 — engine_glow_value computed per rendered object
	for ( let i = 0; i < liveRobots.length; i ++ ) {

		const robot = liveRobots[ i ];
		if ( robot.alive !== true ) continue;
		if ( robot.mesh === null ) continue;

		const ailp = robot.aiLocal;
		if ( ailp !== undefined && ailp !== null ) {

			const glowValue = compute_engine_glow( ailp.vel_x, ailp.vel_y, ailp.vel_z );
			polyobj_set_glow( robot.mesh, glowValue );

		}

	}

	// Self-destruct countdown + white-out flash
	const pp = getPlayerPos();
	if ( cntrlcen_is_self_destruct_active() === true ) {

		do_controlcen_destroyed_frame( dt, pp );

	}

}

// --- Spawn a robot from a matcen (robot generator) ---
// Called by fuelcen.js when a matcen timer fires
function spawnMatcenRobot( segnum, robotType, pos_x, pos_y, pos_z, matcenNum ) {

	const scene = getScene();
	if ( scene === null ) return;

	// Get model number for this robot type
	let modelNum = - 1;

	if ( robotType < N_robot_types ) {

		modelNum = Robot_info[ robotType ].model_num;

	}

	if ( modelNum === - 1 || modelNum >= Polygon_models.length ) {

		console.warn( 'MATCEN: Invalid model for robot type ' + robotType );
		return;

	}

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return;

	let mesh;
	let submodelGroups = null;

	if ( model.anim_angs !== null ) {

		if ( model.animatedMesh === null ) {

			model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

		}

		if ( model.animatedMesh !== null ) {

			mesh = model.animatedMesh.clone( true );
			submodelGroups = [];
			mesh.traverse( function ( child ) {

				if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

					submodelGroups[ child.userData.submodelIndex ] = child;

				}

			} );

		} else {

			if ( model.mesh === null ) {

				model.mesh = buildModelMesh( model, _pigFile, _palette );

			}

			if ( model.mesh === null ) return;
			mesh = model.mesh.clone();

		}

	} else {

		if ( model.mesh === null ) {

			model.mesh = buildModelMesh( model, _pigFile, _palette );

		}

		if ( model.mesh === null ) return;
		mesh = model.mesh.clone();

	}

	polyobj_rebuild_glow_refs( mesh );
	mesh.position.set( pos_x, pos_y, - pos_z );

	// Default orientation (face toward player if possible)
	const pp = getPlayerPos();
	const dx = pp.x - pos_x;
	const dy = pp.y - pos_y;
	const dz = pp.z - pos_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	// Create a game object for the spawned robot
	const obj = {
		type: OBJ_ROBOT,
		id: robotType,
		pos_x: pos_x,
		pos_y: pos_y,
		pos_z: pos_z,
		segnum: segnum,
		size: 4.84,	// default robot size
		shields: 10.0,
		orient_fvec_x: 0, orient_fvec_y: 0, orient_fvec_z: 1,
		orient_uvec_x: 0, orient_uvec_y: 1, orient_uvec_z: 0,
		orient_rvec_x: 1, orient_rvec_y: 0, orient_rvec_z: 0,
		ctype: { behavior: 0x81 },	// AIB_NORMAL
		rtype: { model_num: modelNum }
	};

	// Set shields from Robot_info if available
	if ( robotType < N_robot_types ) {

		obj.shields = Robot_info[ robotType ].strength;
		obj.size = model.rad || 4.84;

	}

	// Orient toward player
	if ( dist > 0.001 ) {

		obj.orient_fvec_x = dx / dist;
		obj.orient_fvec_y = dy / dist;
		obj.orient_fvec_z = dz / dist;

		// Recompute right and up from forward
		// Simple cross with world up
		let ux = 0, uy = 1, uz = 0;
		let rx = obj.orient_fvec_y * uz - obj.orient_fvec_z * uy;
		let ry = obj.orient_fvec_z * ux - obj.orient_fvec_x * uz;
		let rz = obj.orient_fvec_x * uy - obj.orient_fvec_y * ux;
		let rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );

		if ( rmag > 0.001 ) {

			rx /= rmag; ry /= rmag; rz /= rmag;
			ux = ry * obj.orient_fvec_z - rz * obj.orient_fvec_y;
			uy = rz * obj.orient_fvec_x - rx * obj.orient_fvec_z;
			uz = rx * obj.orient_fvec_y - ry * obj.orient_fvec_x;
			obj.orient_rvec_x = rx; obj.orient_rvec_y = ry; obj.orient_rvec_z = rz;
			obj.orient_uvec_x = ux; obj.orient_uvec_y = uy; obj.orient_uvec_z = uz;

		}

	}

	// Set mesh orientation
	const m = new THREE.Matrix4();
	m.set(
		obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
		obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
		- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
		0, 0, 0, 1
	);
	mesh.quaternion.setFromRotationMatrix( m );

	// Start with zero scale for morph animation (ported from MORPH.C)
	mesh.scale.set( 0.01, 0.01, 0.01 );

	scene.add( mesh );

	// Add to liveRobots for weapon collision + AI
	const robot = { obj: obj, mesh: mesh, alive: true };
	// Tag robot with its matcen source for per-matcen count limit
	// Ported from: FUELCEN.C line 675 — matcen_creator^0x80
	if ( matcenNum !== undefined && matcenNum >= 0 ) {

		robot.matcen_creator = matcenNum;

	}

	if ( submodelGroups !== null ) {

		robot.submodelGroups = submodelGroups;

	}

	liveRobots.push( robot );

	// Morph animation state (ported from morph_data in MORPH.H)
	// Scale animation approximates vertex morphing from bounding box to final position
	robot.morphing = true;
	robot.morph_timer = 0;
	robot.morph_duration = 1.0;	// seconds (matches VCLIP_MORPHING_ROBOT play time)

	// Initialize AI for the new robot — start still during morph
	robot.aiLocal = new AILocalInfo();
	robot.aiLocal.mode = 0;	// AIM_STILL — don't chase during morph animation
	robot.aiLocal.player_awareness_type = 4;
	robot.aiLocal.player_awareness_time = 6.0;
	robot.aiLocal.next_fire = Math.random() * 2.0;

	console.log( 'MATCEN: Spawned robot type ' + robotType + ' in seg ' + segnum +
		' (' + liveRobots.filter( r => r.alive === true ).length + ' total alive)' );

}

// --- Spawn a robot gated in by the boss ---
// Ported from: create_gated_robot() in AI.C lines 2115-2194
// Same as spawnMatcenRobot but tags robot with matcen_creator = -1 (BOSS_GATE_MATCEN_NUM)
function spawnGatedRobot( segnum, robotType, pos_x, pos_y, pos_z ) {

	const scene = getScene();
	if ( scene === null ) return;

	// Get model number for this robot type
	let modelNum = - 1;

	if ( robotType < N_robot_types ) {

		modelNum = Robot_info[ robotType ].model_num;

	}

	if ( modelNum === - 1 || modelNum >= Polygon_models.length ) {

		console.warn( 'BOSS GATE: Invalid model for robot type ' + robotType );
		return;

	}

	const model = Polygon_models[ modelNum ];
	if ( model === null || model === undefined ) return;

	let mesh;
	let submodelGroups = null;

	if ( model.anim_angs !== null ) {

		if ( model.animatedMesh === null ) {

			model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

		}

		if ( model.animatedMesh !== null ) {

			mesh = model.animatedMesh.clone( true );
			submodelGroups = [];
			mesh.traverse( function ( child ) {

				if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

					submodelGroups[ child.userData.submodelIndex ] = child;

				}

			} );

		} else {

			if ( model.mesh === null ) {

				model.mesh = buildModelMesh( model, _pigFile, _palette );

			}

			if ( model.mesh === null ) return;
			mesh = model.mesh.clone();

		}

	} else {

		if ( model.mesh === null ) {

			model.mesh = buildModelMesh( model, _pigFile, _palette );

		}

		if ( model.mesh === null ) return;
		mesh = model.mesh.clone();

	}

	polyobj_rebuild_glow_refs( mesh );
	mesh.position.set( pos_x, pos_y, - pos_z );

	// Default orientation (face toward player if possible)
	const pp = getPlayerPos();
	const dx = pp.x - pos_x;
	const dy = pp.y - pos_y;
	const dz = pp.z - pos_z;
	const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

	// Create a game object for the spawned robot
	const obj = {
		type: OBJ_ROBOT,
		id: robotType,
		pos_x: pos_x,
		pos_y: pos_y,
		pos_z: pos_z,
		segnum: segnum,
		size: 4.84,
		shields: 10.0,
		orient_fvec_x: 0, orient_fvec_y: 0, orient_fvec_z: 1,
		orient_uvec_x: 0, orient_uvec_y: 1, orient_uvec_z: 0,
		orient_rvec_x: 1, orient_rvec_y: 0, orient_rvec_z: 0,
		ctype: { behavior: 0x81 },	// AIB_NORMAL
		rtype: { model_num: modelNum },
		mtype: { mass: 4.0 },
		matcen_creator: - 1	// BOSS_GATE_MATCEN_NUM — tags this as a boss-gated robot
	};

	// Set shields/size/mass from Robot_info if available
	if ( robotType < N_robot_types ) {

		obj.shields = Robot_info[ robotType ].strength;
		obj.size = model.rad || 4.84;
		obj.mtype.mass = Robot_info[ robotType ].mass > 0 ? Robot_info[ robotType ].mass : 4.0;

	}

	// Orient toward player
	if ( dist > 0.001 ) {

		obj.orient_fvec_x = dx / dist;
		obj.orient_fvec_y = dy / dist;
		obj.orient_fvec_z = dz / dist;

		// Recompute right and up from forward
		let ux = 0, uy = 1, uz = 0;
		let rx = obj.orient_fvec_y * uz - obj.orient_fvec_z * uy;
		let ry = obj.orient_fvec_z * ux - obj.orient_fvec_x * uz;
		let rz = obj.orient_fvec_x * uy - obj.orient_fvec_y * ux;
		let rmag = Math.sqrt( rx * rx + ry * ry + rz * rz );

		if ( rmag > 0.001 ) {

			rx /= rmag; ry /= rmag; rz /= rmag;
			ux = ry * obj.orient_fvec_z - rz * obj.orient_fvec_y;
			uy = rz * obj.orient_fvec_x - rx * obj.orient_fvec_z;
			uz = rx * obj.orient_fvec_y - ry * obj.orient_fvec_x;
			obj.orient_rvec_x = rx; obj.orient_rvec_y = ry; obj.orient_rvec_z = rz;
			obj.orient_uvec_x = ux; obj.orient_uvec_y = uy; obj.orient_uvec_z = uz;

		}

	}

	// Set mesh orientation
	const m = new THREE.Matrix4();
	m.set(
		obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
		obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
		- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
		0, 0, 0, 1
	);
	mesh.quaternion.setFromRotationMatrix( m );

	// Start with zero scale for morph animation
	mesh.scale.set( 0.01, 0.01, 0.01 );

	scene.add( mesh );

	// Add to liveRobots for weapon collision + AI
	const robot = { obj: obj, mesh: mesh, alive: true };
	if ( submodelGroups !== null ) {

		robot.submodelGroups = submodelGroups;

	}

	liveRobots.push( robot );

	// Morph animation state
	robot.morphing = true;
	robot.morph_timer = 0;
	robot.morph_duration = 1.0;

	// Initialize AI — immediately aware and chasing
	robot.aiLocal = new AILocalInfo();
	robot.aiLocal.mode = 1;	// AIM_CHASE_OBJECT — gated robots immediately attack
	robot.aiLocal.player_awareness_type = 4;
	robot.aiLocal.player_awareness_time = 6.0;
	robot.aiLocal.next_fire = Math.random() * 1.5;

	console.log( 'BOSS GATE: Spawned robot type ' + robotType + ' in seg ' + segnum +
		' (' + liveRobots.filter( r => r.alive === true ).length + ' total alive)' );

}

// --- Place game objects (robots, reactor, etc.) as meshes in the scene ---
function placeObjects( gameData ) {

	const scene = getScene();
	if ( scene === null ) return;

	let placedModels = 0;
	let placedSprites = 0;
	hostage_reset_level();

	for ( let i = 0; i < gameData.objects.length; i ++ ) {

		const obj = gameData.objects[ i ];

		// Skip player objects
		if ( obj.type === OBJ_PLAYER ) continue;

		// Polygon model objects (robots, reactor)
		if ( obj.render_type === RT_POLYOBJ ) {

			if ( obj.rtype === null ) continue;

			const modelNum = obj.rtype.model_num;
			const model = Polygon_models[ modelNum ];
			if ( model === null || model === undefined ) continue;

			// For robots with ANIM data, build hierarchical animated mesh
			let mesh;
			let submodelGroups = null;

			if ( obj.type === OBJ_ROBOT && model.anim_angs !== null ) {

				if ( model.animatedMesh === null ) {

					model.animatedMesh = buildAnimatedModelMesh( model, _pigFile, _palette );

				}

				if ( model.animatedMesh !== null ) {

					mesh = model.animatedMesh.clone( true );

					// Extract submodel group references from cloned hierarchy
					submodelGroups = [];
					mesh.traverse( function ( child ) {

						if ( child.userData !== undefined && child.userData.submodelIndex !== undefined ) {

							submodelGroups[ child.userData.submodelIndex ] = child;

						}

					} );

				} else {

					// Fallback to flat mesh
					if ( model.mesh === null ) {

						model.mesh = buildModelMesh( model, _pigFile, _palette );

					}

					if ( model.mesh === null ) continue;
					mesh = model.mesh.clone();

				}

			} else {

				if ( model.mesh === null ) {

					model.mesh = buildModelMesh( model, _pigFile, _palette );

				}

				if ( model.mesh === null ) continue;
				mesh = model.mesh.clone();

			}

			polyobj_rebuild_glow_refs( mesh );
			mesh.position.set( obj.pos_x, obj.pos_y, - obj.pos_z );

			const m = new THREE.Matrix4();
			m.set(
				obj.orient_rvec_x, obj.orient_uvec_x, - obj.orient_fvec_x, 0,
				obj.orient_rvec_y, obj.orient_uvec_y, - obj.orient_fvec_y, 0,
				- obj.orient_rvec_z, - obj.orient_uvec_z, obj.orient_fvec_z, 0,
				0, 0, 0, 1
			);

			mesh.quaternion.setFromRotationMatrix( m );
			scene.add( mesh );
			placedModels ++;

			// Track robots for weapon collision
			if ( obj.type === OBJ_ROBOT ) {

				const robotEntry = { obj: obj, mesh: mesh, alive: true };
				if ( submodelGroups !== null ) {

					robotEntry.submodelGroups = submodelGroups;

				}

				liveRobots.push( robotEntry );

			}

			// Track reactor for destruction (add to liveRobots so lasers can hit it)
			if ( obj.type === OBJ_CNTRLCEN ) {

				// Boost reactor shields based on level number
				// Ported from: init_controlcen_for_level() in CNTRLCEN.C lines 392-396
				// shields = 200 + 50 * level_num (positive levels)
				if ( currentLevelNum >= 0 ) {

					obj.shields = 200 + 50 * currentLevelNum;

				} else {

					obj.shields = 200 + Math.abs( currentLevelNum ) * 100;

				}

				const reactor = { obj: obj, mesh: mesh, alive: true, isReactor: true };
				cntrlcen_set_reactor( reactor );
				liveRobots.push( reactor );

				// Compute world-space gun positions from model hardpoints
				init_controlcen_for_level( obj );

			}

		}

		// Vclip sprite objects (powerups, hostages)
		if ( obj.render_type === RT_POWERUP || obj.render_type === RT_HOSTAGE ) {

			if ( obj.rtype === null ) continue;

			if ( obj.type === OBJ_POWERUP ) {

				if ( powerup_place( obj, scene ) === true ) {

					placedSprites ++;

				}

			}

			if ( obj.type === OBJ_HOSTAGE ) {

				hostage_add_in_level( powerup_place_hostage( obj, scene ) );
				placedSprites ++;

			}

		}

	}

	console.log( 'OBJECTS: Placed ' + placedModels + ' models, ' + placedSprites + ' sprites in scene' );

}

// --- Game Over screen ---
let gameOverOverlay = null;

function showGameOver() {

	// Stop level music
	songs_stop();

	// Save high score
	const savedScores = saveHighScore( playerScore, playerKills, hostage_get_total_saved(), Difficulty_level );
	const isNewHighScore = ( savedScores.length > 0 && savedScores[ 0 ].score === playerScore && playerScore > 0 );

	if ( gameOverOverlay !== null ) {

		// Update stats and show
		const statsEl = gameOverOverlay.querySelector( '.go-stats' );
		if ( statsEl !== null ) {

			let statsText = 'Score: ' + playerScore + '  |  Kills: ' + playerKills + '  |  Hostages: ' + hostage_get_total_saved();
			if ( isNewHighScore === true ) statsText += '\nNEW HIGH SCORE!';
			statsEl.textContent = statsText;

		}

		const hsEl = gameOverOverlay.querySelector( '.go-highscore' );
		if ( hsEl !== null ) {

			hsEl.textContent = 'High Score: ' + savedScores[ 0 ].score;

		}

		gameOverOverlay.style.display = 'flex';
		return;

	}

	gameOverOverlay = document.createElement( 'div' );
	gameOverOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;font-family:monospace;';

	const title = document.createElement( 'div' );
	title.style.cssText = 'color:#f00;font-size:48px;font-weight:bold;text-shadow:0 0 20px #f00;';
	title.textContent = 'GAME OVER';
	gameOverOverlay.appendChild( title );

	const stats = document.createElement( 'div' );
	stats.className = 'go-stats';
	stats.style.cssText = 'color:#0f0;font-size:14px;margin-top:20px;white-space:pre-line;text-align:center;';
	let statsText = 'Score: ' + playerScore + '  |  Kills: ' + playerKills + '  |  Hostages: ' + hostage_get_total_saved();
	if ( isNewHighScore === true ) statsText += '\nNEW HIGH SCORE!';
	stats.textContent = statsText;
	gameOverOverlay.appendChild( stats );

	if ( savedScores.length > 0 ) {

		const hs = document.createElement( 'div' );
		hs.className = 'go-highscore';
		hs.style.cssText = 'color:#ff0;font-size:14px;margin-top:10px;';
		hs.textContent = 'High Score: ' + savedScores[ 0 ].score;
		gameOverOverlay.appendChild( hs );

	}

	const prompt = document.createElement( 'div' );
	prompt.style.cssText = 'color:#0f0;font-size:16px;margin-top:30px;animation:blink 1.5s infinite;';
	prompt.textContent = 'CLICK TO RESTART';
	gameOverOverlay.appendChild( prompt );

	gameOverOverlay.addEventListener( 'click', () => {

		gameOverOverlay.style.display = 'none';
		restartGame();

	} );

	document.body.appendChild( gameOverOverlay );

}

// --- Restart game ---
export async function restartGame() {

	// Show menu again (skip logos on restart)
	songs_play_song( SONG_TITLE, true );
	show_title_canvas();

	const menuResult = await do_main_menu( _hogFile, Difficulty_level, _palette );
	Difficulty_level = menuResult.difficulty;

	// Reset all player state
	playerScore = 0;
	playerLastScore = 0;
	playerKills = 0;
	playerLives = 3;
	hostage_reset_all();
	playerShields = 100;
	playerEnergy = 100;
	playerKeys = { blue: false, red: false, gold: false };
	playerPrimaryFlags = 1;		// HAS_LASER_FLAG
	playerSecondaryFlags = 1;	// HAS_CONCUSSION_FLAG
	playerQuadLasers = false;

	// Starting concussion missiles: 2 + NDL - Difficulty_level
	playerSecondaryAmmo[ 0 ] = 2 + 5 - Difficulty_level;
	for ( let i = 1; i < 5; i ++ ) playerSecondaryAmmo[ i ] = 0;

	playerVulcanAmmo = 0;
	playerLaserLevel = 0;
	playerCloakTime = 0;
	playerInvulnerableTime = 0;

	set_primary_weapon( 0 );
	set_secondary_weapon( 0 );

	// Reset to level 1
	currentLevelNum = 1;
	Automap_visited.fill( 0 );
	cntrlcen_reset();
	gauges_set_white_flash( 0 );
	levelTransitioning = false;
	playerDead = false;
	game_set_player_dead( false );
	game_reset_physics();

	// Show briefing screens for level 1
	await do_briefing_screens( _hogFile, 1 );
	hide_title_canvas();

	songs_play_level_song( currentLevelNum );
	advanceLevel();
	updateHUD();

}
