// Ported from: descent-master/MAIN/COLLIDE.C
// Collision detection and response

import { Segments, Walls, Num_segments, GameTime } from './mglobal.js';
import { TmapInfos, TMI_VOLATILE, Powerup_info, N_powerup_types } from './bm.js';
import { Robot_info, N_robot_types, Weapon_info, N_weapon_types } from './bm.js';
import { get_side_dist } from './gameseg.js';
import { wall_damage, wall_open_door, WALL_BLASTABLE, WALL_DOOR } from './wall.js';
import { cntrlcen_notify_hit } from './cntrlcen.js';
import { find_vector_intersection, HIT_WALL, FQ_TRANSWALL } from './fvi.js';
import { find_point_seg } from './gameseg.js';
import { object_create_explosion, explode_model, get_explosion_vclip, VCLIP_PLAYER_HIT, VCLIP_VOLATILE_WALL_HIT } from './fireball.js';
import { check_effect_blowup } from './effects.js';
import { OBJ_ROBOT } from './object.js';
import { ai_do_robot_hit, create_awareness_event, start_boss_death_sequence, ai_set_boss_hit } from './ai.js';
import { phys_apply_force, phys_apply_force_to_player, phys_apply_rot, getPlayerVelocity } from './physics.js';
import { digi_play_sample, digi_play_sample_3d,
	SOUND_ROBOT_HIT, SOUND_ROBOT_DESTROYED, SOUND_WEAPON_HIT_BLASTABLE,
	SOUND_PLAYER_GOT_HIT, SOUND_EXPLODING_WALL, SOUND_VOLATILE_WALL_HISS,
	SOUND_VOLATILE_WALL_HIT,
	SOUND_HOSTAGE_RESCUED, SOUND_CLOAK_OFF, SOUND_HUD_MESSAGE,
	SOUND_ROBOT_HIT_PLAYER,
	SOUND_CONTROL_CENTER_HIT, SOUND_CONTROL_CENTER_DESTROYED,
	SOUND_WEAPON_HIT_DOOR } from './digi.js';

// Powerup type constants (from POWERUP.H)
export const POW_EXTRA_LIFE = 0;
export const POW_ENERGY = 1;
export const POW_SHIELD_BOOST = 2;
export const POW_LASER = 3;
export const POW_KEY_BLUE = 4;
export const POW_KEY_RED = 5;
export const POW_KEY_GOLD = 6;
export const POW_MISSILE_1 = 10;
export const POW_MISSILE_4 = 11;
export const POW_QUAD_FIRE = 12;
export const POW_VULCAN_WEAPON = 13;
export const POW_SPREADFIRE_WEAPON = 14;
export const POW_PLASMA_WEAPON = 15;
export const POW_FUSION_WEAPON = 16;
export const POW_PROXIMITY_WEAPON = 17;
export const POW_HOMING_AMMO_1 = 18;
export const POW_HOMING_AMMO_4 = 19;
export const POW_SMARTBOMB_WEAPON = 20;
export const POW_MEGA_WEAPON = 21;
export const POW_VULCAN_AMMO = 22;
export const POW_CLOAK = 23;
export const POW_INVULNERABILITY = 25;

// Vulcan ammo constants (from POWERUP.H)
const VULCAN_WEAPON_AMMO_AMOUNT = 196;
const VULCAN_AMMO_AMOUNT = 98;
const VULCAN_AMMO_MAX = VULCAN_WEAPON_AMMO_AMOUNT * 4; // 784

// Score constants
const CONTROL_CEN_SCORE = 5000;
const HOSTAGE_SCORE = 1000;

// External callbacks (set via collide_set_externals)
let _getPlayerShields = null;
let _setPlayerShields = null;
let _getPlayerEnergy = null;
let _setPlayerEnergy = null;
let _getPlayerLaserLevel = null;
let _setPlayerLaserLevel = null;
let _getPlayerPrimaryFlags = null;
let _setPlayerPrimaryFlags = null;
let _getPlayerSecondaryFlags = null;
let _setPlayerSecondaryFlags = null;
let _getPlayerSecondaryAmmo = null;
let _setPlayerSecondaryAmmo = null;
let _getPlayerVulcanAmmo = null;
let _setPlayerVulcanAmmo = null;
let _getPlayerKeys = null;
let _setPlayerKey = null;
let _getPlayerLives = null;
let _setPlayerLives = null;
let _addPlayerScore = null;
let _addPlayerKills = null;
let _addHostageSaved = null;
let _addLevelHostagesSaved = null;
let _getPlayerPos = null;
let _getPlayerSegnum = null;
let _getScene = null;
let _updateHUD = null;
let _showMessage = null;
let _flashDamage = null;
let _startPlayerDeath = null;
let _startSelfDestruct = null;
let _spawnDroppedPowerup = null;
let _liveRobots = null;
let _isPlayerInvulnerable = null;
let _isPlayerCloaked = null;
let _activateCloak = null;
let _activateInvulnerability = null;
let _getPlayerQuadLasers = null;
let _setPlayerQuadLasers = null;
let _getDifficultyLevel = null;

// Number of difficulty levels (from GAME.H: #define NDL 5)
const NDL = 5;

// Volatile wall scrape sound throttle
let lastVolatileScrapeTime = 0;

export function collide_set_externals( ext ) {

	if ( ext.getPlayerShields !== undefined ) _getPlayerShields = ext.getPlayerShields;
	if ( ext.setPlayerShields !== undefined ) _setPlayerShields = ext.setPlayerShields;
	if ( ext.getPlayerEnergy !== undefined ) _getPlayerEnergy = ext.getPlayerEnergy;
	if ( ext.setPlayerEnergy !== undefined ) _setPlayerEnergy = ext.setPlayerEnergy;
	if ( ext.getPlayerLaserLevel !== undefined ) _getPlayerLaserLevel = ext.getPlayerLaserLevel;
	if ( ext.setPlayerLaserLevel !== undefined ) _setPlayerLaserLevel = ext.setPlayerLaserLevel;
	if ( ext.getPlayerPrimaryFlags !== undefined ) _getPlayerPrimaryFlags = ext.getPlayerPrimaryFlags;
	if ( ext.setPlayerPrimaryFlags !== undefined ) _setPlayerPrimaryFlags = ext.setPlayerPrimaryFlags;
	if ( ext.getPlayerSecondaryFlags !== undefined ) _getPlayerSecondaryFlags = ext.getPlayerSecondaryFlags;
	if ( ext.setPlayerSecondaryFlags !== undefined ) _setPlayerSecondaryFlags = ext.setPlayerSecondaryFlags;
	if ( ext.getPlayerSecondaryAmmo !== undefined ) _getPlayerSecondaryAmmo = ext.getPlayerSecondaryAmmo;
	if ( ext.setPlayerSecondaryAmmo !== undefined ) _setPlayerSecondaryAmmo = ext.setPlayerSecondaryAmmo;
	if ( ext.getPlayerVulcanAmmo !== undefined ) _getPlayerVulcanAmmo = ext.getPlayerVulcanAmmo;
	if ( ext.setPlayerVulcanAmmo !== undefined ) _setPlayerVulcanAmmo = ext.setPlayerVulcanAmmo;
	if ( ext.getPlayerKeys !== undefined ) _getPlayerKeys = ext.getPlayerKeys;
	if ( ext.setPlayerKey !== undefined ) _setPlayerKey = ext.setPlayerKey;
	if ( ext.getPlayerLives !== undefined ) _getPlayerLives = ext.getPlayerLives;
	if ( ext.setPlayerLives !== undefined ) _setPlayerLives = ext.setPlayerLives;
	if ( ext.addPlayerScore !== undefined ) _addPlayerScore = ext.addPlayerScore;
	if ( ext.addPlayerKills !== undefined ) _addPlayerKills = ext.addPlayerKills;
	if ( ext.addHostageSaved !== undefined ) _addHostageSaved = ext.addHostageSaved;
	if ( ext.addLevelHostagesSaved !== undefined ) _addLevelHostagesSaved = ext.addLevelHostagesSaved;
	if ( ext.getPlayerPos !== undefined ) _getPlayerPos = ext.getPlayerPos;
	if ( ext.getPlayerSegnum !== undefined ) _getPlayerSegnum = ext.getPlayerSegnum;
	if ( ext.getScene !== undefined ) _getScene = ext.getScene;
	if ( ext.updateHUD !== undefined ) _updateHUD = ext.updateHUD;
	if ( ext.showMessage !== undefined ) _showMessage = ext.showMessage;
	if ( ext.flashDamage !== undefined ) _flashDamage = ext.flashDamage;
	if ( ext.startPlayerDeath !== undefined ) _startPlayerDeath = ext.startPlayerDeath;
	if ( ext.startSelfDestruct !== undefined ) _startSelfDestruct = ext.startSelfDestruct;
	if ( ext.spawnDroppedPowerup !== undefined ) _spawnDroppedPowerup = ext.spawnDroppedPowerup;
	if ( ext.liveRobots !== undefined ) _liveRobots = ext.liveRobots;
	if ( ext.isPlayerInvulnerable !== undefined ) _isPlayerInvulnerable = ext.isPlayerInvulnerable;
	if ( ext.isPlayerCloaked !== undefined ) _isPlayerCloaked = ext.isPlayerCloaked;
	if ( ext.activateCloak !== undefined ) _activateCloak = ext.activateCloak;
	if ( ext.activateInvulnerability !== undefined ) _activateInvulnerability = ext.activateInvulnerability;
	if ( ext.getPlayerQuadLasers !== undefined ) _getPlayerQuadLasers = ext.getPlayerQuadLasers;
	if ( ext.setPlayerQuadLasers !== undefined ) _setPlayerQuadLasers = ext.setPlayerQuadLasers;
	if ( ext.getDifficultyLevel !== undefined ) _getDifficultyLevel = ext.getDifficultyLevel;

}

// ---------------------------------------------------------------
// bump_two_objects — apply collision forces between two objects
// Ported from: bump_two_objects() in COLLIDE.C lines 613-636
// ---------------------------------------------------------------
export function bump_two_objects( robot, robotVel_x, robotVel_y, robotVel_z, robotMass ) {

	if ( _getPlayerPos === null ) return;

	// Compute relative velocity (player - robot) for elastic collision
	// Ported from: bump_two_objects() in COLLIDE.C lines 613-636
	const pv = getPlayerVelocity();
	const rel_x = pv.x - robotVel_x;
	const rel_y = pv.y - robotVel_y;
	const rel_z = pv.z - robotVel_z;

	const playerMass = 4.0; // PLAYER_MASS from physics.js
	const massFactor = 2.0 * robotMass * playerMass / ( robotMass + playerMass );

	// Force = massFactor * relative_velocity (Newton's 3rd law elastic collision)
	const force_x = rel_x * massFactor;
	const force_y = rel_y * massFactor;
	const force_z = rel_z * massFactor;

	// Apply to player: force/4 (linear only)
	// Ported from: bump_this_object() in COLLIDE.C lines 583-588
	phys_apply_force_to_player( force_x * 0.25, force_y * 0.25, force_z * 0.25 );

	// Apply opposite force to robot: full linear force
	// Ported from: bump_this_object() in COLLIDE.C lines 592-606
	// Note: rotational force omitted — our robots don't have rotational physics
	phys_apply_force( robot, - force_x, - force_y, - force_z );

}

// ---------------------------------------------------------------
// collide_robot_and_player — handle robot physically bumping into player
// Ported from: collide_robot_and_player() in COLLIDE.C lines 1052-1066
// Called from ai.js when robot is within contact distance of player
// ---------------------------------------------------------------
export function collide_robot_and_player( robot, robotVel_x, robotVel_y, robotVel_z, robotMass ) {

	const obj = robot.obj;

	// Create awareness event — collision gets attention
	// Ported from: COLLIDE.C line 1054 — create_awareness_event(player, PA_PLAYER_COLLISION)
	create_awareness_event( obj.segnum, obj.pos_x, obj.pos_y, obj.pos_z, 3 ); // PA_PLAYER_COLLISION

	// Alert robot it was hit
	ai_do_robot_hit( robot, 4 ); // PA_WEAPON_ROBOT_COLLISION

	// Play bump sound
	digi_play_sample_3d( SOUND_ROBOT_HIT_PLAYER, 0.8, obj.pos_x, obj.pos_y, obj.pos_z );

	// Apply physics bump
	bump_two_objects( robot, robotVel_x, robotVel_y, robotVel_z, robotMass );

	// Apply bump damage to player (only if significant force)
	const forceMag = Math.sqrt( robotVel_x * robotVel_x + robotVel_y * robotVel_y + robotVel_z * robotVel_z ) * robotMass;
	const damage = forceMag / ( 4.0 * 8.0 ); // force / (mass * 8), ported from apply_force_damage

	if ( damage > 0.5 ) {

		const pp = _getPlayerPos !== null ? _getPlayerPos() : { x: 0, y: 0, z: 0 };
		apply_damage_to_player( damage, pp.x, pp.y, pp.z );

	}

}

// ---------------------------------------------------------------
// apply_damage_to_player
// Ported from: apply_damage_to_player() in COLLIDE.C lines 1548-1595
// ---------------------------------------------------------------
export function apply_damage_to_player( damage, pos_x, pos_y, pos_z ) {

	if ( _getPlayerShields === null ) return;

	const shields = _getPlayerShields();
	if ( shields <= 0 ) return;		// Already dead

	// Invulnerable player takes no damage — blue flash instead of red
	// Ported from: apply_damage_to_player() in COLLIDE.C lines 1548-1595
	if ( _isPlayerInvulnerable !== null && _isPlayerInvulnerable() === true ) {

		if ( _flashDamage !== null ) _flashDamage( 'blue' );
		return;

	}

	_setPlayerShields( shields - damage );

	// Visual and audio feedback
	object_create_explosion( pos_x, pos_y, pos_z, 1.0, VCLIP_PLAYER_HIT );
	if ( _flashDamage !== null ) _flashDamage();
	digi_play_sample( SOUND_PLAYER_GOT_HIT, 0.7 );
	if ( _updateHUD !== null ) _updateHUD();

	if ( _getPlayerShields() <= 0 ) {

		_setPlayerShields( 0 );
		if ( _updateHUD !== null ) _updateHUD();
		if ( _startPlayerDeath !== null ) _startPlayerDeath();

	}

}

// ---------------------------------------------------------------
// collide_player_and_nasty_robot
// Ported from: collide_player_and_nasty_robot() in COLLIDE.C lines 1655-1667
// Melee robot damages player by contact (attack_type 1)
// ---------------------------------------------------------------
export function collide_player_and_nasty_robot( damage, claw_sound, pos_x, pos_y, pos_z ) {

	if ( _getPlayerShields === null ) return;

	const shields = _getPlayerShields();
	if ( shields <= 0 ) return;		// Player already dead

	// Invulnerable player takes no damage
	if ( _isPlayerInvulnerable !== null && _isPlayerInvulnerable() === true ) {

		if ( _flashDamage !== null ) _flashDamage( 'blue' );
		return;

	}

	// Play claw sound at impact point
	if ( claw_sound >= 0 ) {

		digi_play_sample_3d( claw_sound, 0.8, pos_x, pos_y, pos_z );

	}

	// Create explosion at impact point (from C: i2f(10)/2 = 5.0)
	object_create_explosion( pos_x, pos_y, pos_z, 5.0, VCLIP_PLAYER_HIT );

	// Apply damage to player
	_setPlayerShields( shields - damage );

	if ( _flashDamage !== null ) _flashDamage();
	digi_play_sample( SOUND_PLAYER_GOT_HIT, 0.7 );
	if ( _updateHUD !== null ) _updateHUD();

	if ( _getPlayerShields() <= 0 ) {

		_setPlayerShields( 0 );
		if ( _updateHUD !== null ) _updateHUD();
		if ( _startPlayerDeath !== null ) _startPlayerDeath();

	}

}

// ---------------------------------------------------------------
// collide_robot_and_weapon / apply_damage_to_robot
// Ported from: collide_robot_and_weapon() in COLLIDE.C lines 1276-1365
//              apply_damage_to_robot() in COLLIDE.C lines 1233-1274
// ---------------------------------------------------------------
export function collide_robot_and_weapon( robotIndex, damage, weapon_type, vel_x, vel_y, vel_z ) {

	if ( _liveRobots === null ) return;

	const robot = _liveRobots[ robotIndex ];
	if ( robot.alive !== true ) return;

	robot.obj.shields -= damage;

	// Notify reactor it was hit (enables firing AI)
	// Ported from: COLLIDE.C — Control_center_been_hit = 1
	if ( robot.isReactor === true ) {

		cntrlcen_notify_hit();

		// Play reactor-specific hit sound
		// Ported from: COLLIDE.C line 1199 — digi_link_sound_to_pos(SOUND_CONTROL_CENTER_HIT, ...)
		digi_play_sample_3d( SOUND_CONTROL_CENTER_HIT, 0.8, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );

	} else {

		// Use per-weapon robot hit sound if available
		// Ported from: collide_robot_and_weapon() in COLLIDE.C
		let hit_sound = SOUND_ROBOT_HIT;

		if ( weapon_type !== undefined && weapon_type >= 0 && weapon_type < N_weapon_types ) {

			const wi = Weapon_info[ weapon_type ];
			if ( wi.robot_hit_sound >= 0 ) hit_sound = wi.robot_hit_sound;

		}

		digi_play_sample_3d( hit_sound, 0.6, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );

		// Play per-robot first-explosion sound (exp1_sound_num) on hit
		// Ported from: COLLIDE.C line 1330-1331 — Robot_info[robot->id].exp1_sound_num
		const rtype_hit = robot.obj.id;
		if ( rtype_hit >= 0 && rtype_hit < N_robot_types ) {

			const exp1_sound = Robot_info[ rtype_hit ].exp1_sound_num;
			if ( exp1_sound >= 0 ) {

				digi_play_sample_3d( exp1_sound, 0.6, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );

			}

		}

	}

	// Apply knockback force to robot velocity
	// Ported from: bump_this_object() in COLLIDE.C lines 592-606
	// Force = weapon_velocity / (4 + Difficulty_level), applied as velocity change
	if ( vel_x !== undefined && robot.aiLocal !== undefined ) {

		const rtype = robot.obj.id;
		const isBoss = ( rtype >= 0 && rtype < N_robot_types && Robot_info[ rtype ].boss_flag > 0 );

		if ( isBoss !== true ) {

			// Ported from: bump_this_object() COLLIDE.C line 595-597
			// Robot knockback: force / (4 + Difficulty_level)
			const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
			const knockback_scale = 1.0 / ( 4 + difficulty );
			robot.aiLocal.vel_x += vel_x * knockback_scale;
			robot.aiLocal.vel_y += vel_y * knockback_scale;
			robot.aiLocal.vel_z += vel_z * knockback_scale;

		}

	}

	// Notify AI that this robot was hit (makes it immediately aware)
	ai_do_robot_hit( robotIndex );

	// Set Boss_hit_this_frame for boss cloak/teleport acceleration
	// Ported from: COLLIDE.C line 1279-1280
	{

		const rtype = robot.obj.id;
		if ( rtype >= 0 && rtype < N_robot_types && Robot_info[ rtype ].boss_flag > 0 ) {

			ai_set_boss_hit();

		}

	}

	// Propagate awareness to nearby robots (PA_WEAPON_ROBOT_COLLISION = 4)
	// Ported from: COLLIDE.C line 1054
	create_awareness_event( robot.obj.segnum, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z, 4 );

	if ( robot.obj.shields <= 0 ) {

		// Boss robot: start death sequence instead of immediate destruction
		// Ported from: COLLIDE.C line 1267
		const rtype2 = robot.obj.id;
		if ( rtype2 >= 0 && rtype2 < N_robot_types && Robot_info[ rtype2 ].boss_flag > 0 &&
			robot.isReactor !== true ) {

			start_boss_death_sequence( robot );
			return;

		}

		// Robot/reactor destroyed
		robot.alive = false;

		// Play per-robot death sound (exp2_sound_num) or fallback to generic
		// Ported from: FIREBALL.C line 1087 — Robot_info[del_obj->id].exp2_sound_num
		{

			let deathSound = SOUND_ROBOT_DESTROYED;
			const rtype_die = robot.obj.id;
			if ( robot.isReactor !== true && rtype_die >= 0 && rtype_die < N_robot_types ) {

				const exp2_sound = Robot_info[ rtype_die ].exp2_sound_num;
				if ( exp2_sound >= 0 ) deathSound = exp2_sound;

			}

			digi_play_sample_3d( deathSound, 0.8, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );

		}

		// Create debris from submodels before removing the mesh
		// Ported from: explode_model() in FIREBALL.C
		if ( robot.obj.rtype !== null ) {

			explode_model(
				robot.obj.rtype.model_num,
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z
			);

		}

		const scene = _getScene !== null ? _getScene() : null;
		if ( scene !== null ) {

			scene.remove( robot.mesh );

		}

		// Create explosion at robot position using robot-specific death vclip (stage 1 = exp2)
		// Ported from: explode_object() in FIREBALL.C line 992-994 (stage 0 initial)
		// and do_explosion_sequence() line 1064-1066 (stage 1 death)
		{

			const deathVclip = get_explosion_vclip( OBJ_ROBOT, robot.obj.id, 1 );
			object_create_explosion(
				robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
				robot.obj.size, deathVclip
			);

		}

		// Award score
		if ( robot.isReactor === true ) {

			if ( _addPlayerScore !== null ) _addPlayerScore( CONTROL_CEN_SCORE );

		} else {

			const rtype = robot.obj.id;
			if ( rtype >= 0 && rtype < N_robot_types ) {

				if ( _addPlayerScore !== null ) _addPlayerScore( Robot_info[ rtype ].score_value );

			}

			if ( _addPlayerKills !== null ) _addPlayerKills( 1 );

		}

		if ( _updateHUD !== null ) _updateHUD();

		// Reactor destroyed — trigger self-destruct countdown
		// Ported from: COLLIDE.C line 1081,1140 — digi_link_sound_to_pos(SOUND_CONTROL_CENTER_DESTROYED, ...)
		if ( robot.isReactor === true ) {

			console.log( 'REACTOR DESTROYED! Self-destruct initiated!' );
			digi_play_sample_3d( SOUND_CONTROL_CENTER_DESTROYED, 1.0, robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z );
			if ( _startSelfDestruct !== null ) _startSelfDestruct();
			return;

		}

		// Drop powerups from destroyed robot
		// Ported from: do_explosion_sequence() in FIREBALL.C lines 1068-1083
		// Two paths: (1) per-instance contains from level data → guaranteed drop,
		//            (2) Robot_info defaults → probability-based drop
		if ( _spawnDroppedPowerup !== null ) {

			if ( robot.obj.contains_count > 0 ) {

				// Path 1: Level designer placed guaranteed drops on this robot instance
				// (e.g., a specific robot always drops a key)
				// No probability check — these always drop
				for ( let d = 0; d < robot.obj.contains_count; d ++ ) {

					_spawnDroppedPowerup(
						robot.obj.contains_id,
						robot.obj.pos_x + ( Math.random() - 0.5 ) * 4,
						robot.obj.pos_y + ( Math.random() - 0.5 ) * 4,
						robot.obj.pos_z + ( Math.random() - 0.5 ) * 4,
						robot.obj.segnum
					);

				}

			} else {

				// Path 2: No per-instance contains, use Robot_info defaults with probability
				const robotType = robot.obj.id;
				if ( robotType >= 0 && robotType < N_robot_types ) {

					const ri = Robot_info[ robotType ];
					if ( ri.contains_count > 0 && ri.contains_prob > 0 ) {

						// Probability check: ((rand()*16)>>15) < contains_prob
						if ( Math.floor( Math.random() * 16 ) < ri.contains_prob ) {

							const count = Math.floor( Math.random() * ri.contains_count ) + 1;

							for ( let d = 0; d < count; d ++ ) {

								_spawnDroppedPowerup(
									ri.contains_id,
									robot.obj.pos_x + ( Math.random() - 0.5 ) * 4,
									robot.obj.pos_y + ( Math.random() - 0.5 ) * 4,
									robot.obj.pos_z + ( Math.random() - 0.5 ) * 4,
									robot.obj.segnum
								);

							}

						}

					}

				}

			}

		}

		console.log( 'Robot destroyed! (' + ( _liveRobots.filter( r => r.alive === true && r.isReactor !== true ).length ) + ' remaining)' );

	}

}

// ---------------------------------------------------------------
// collide_weapon_and_wall
// Ported from: collide_weapon_and_wall() in COLLIDE.C lines 862-982
// ---------------------------------------------------------------
export function collide_weapon_and_wall( pos_x, pos_y, pos_z, segnum, hit_side, damage, weapon_type ) {

	// Check for destructible monitors (eclip with dest_bm_num)
	// Ported from: collide_weapon_and_wall() in COLLIDE.C line 877
	if ( segnum >= 0 && hit_side >= 0 && hit_side <= 5 ) {

		check_effect_blowup( segnum, hit_side, pos_x, pos_y, pos_z );

	}

	// Check for volatile (lava) walls — create badass explosion instead of normal impact
	// Ported from: collide_weapon_and_wall() in COLLIDE.C lines 895-911
	if ( segnum >= 0 && hit_side >= 0 && hit_side <= 5 ) {

		const seg = Segments[ segnum ];
		if ( seg !== undefined ) {

			const side = seg.sides[ hit_side ];
			const tmi1 = TmapInfos[ side.tmap_num ];
			const tmap2 = side.tmap_num2 & 0x3fff;
			const tmi2 = tmap2 > 0 ? TmapInfos[ tmap2 ] : null;

			if ( ( tmi1 !== undefined && ( tmi1.flags & TMI_VOLATILE ) !== 0 ) ||
				( tmi2 !== null && tmi2 !== undefined && ( tmi2.flags & TMI_VOLATILE ) !== 0 ) ) {

				// Volatile wall hit — create large badass explosion
				// Constants from COLLIDE.C lines 855-858
				const VOLATILE_WALL_EXPL_STRENGTH = 10.0;	// i2f(10)
				const VOLATILE_WALL_IMPACT_SIZE = 3.0;		// i2f(3)
				const VOLATILE_WALL_DAMAGE_FORCE = 5.0;		// i2f(5)
				const VOLATILE_WALL_DAMAGE_RADIUS = 30.0;	// i2f(30)

				let explSize = VOLATILE_WALL_IMPACT_SIZE;
				let explDamage = VOLATILE_WALL_EXPL_STRENGTH;
				let explRadius = VOLATILE_WALL_DAMAGE_RADIUS;

				if ( weapon_type !== undefined && weapon_type >= 0 && weapon_type < N_weapon_types ) {

					const wi = Weapon_info[ weapon_type ];
					explSize += wi.impact_size;
					const difficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					explDamage += wi.strength[ difficulty ] / 4;
					explRadius += wi.damage_radius;

				}

				digi_play_sample_3d( SOUND_VOLATILE_WALL_HIT, 1.0, pos_x, pos_y, pos_z );
				object_create_explosion( pos_x, pos_y, pos_z, explSize, VCLIP_VOLATILE_WALL_HIT );
				collide_badass_explosion( pos_x, pos_y, pos_z, explDamage, explRadius );

				// Still check blastable/door walls below, but skip normal explosion
				// (fall through to wall check code)

				// Propagate awareness to nearby robots
				create_awareness_event( segnum, pos_x, pos_y, pos_z, 2 );

				// Check blastable walls
				if ( hit_side >= 0 && hit_side <= 5 ) {

					const wn = seg.sides[ hit_side ].wall_num;
					if ( wn !== - 1 && Walls[ wn ] !== undefined ) {

						if ( Walls[ wn ].type === WALL_BLASTABLE ) {

							wall_damage( segnum, hit_side, damage || 5.0 );

						} else if ( Walls[ wn ].type === WALL_DOOR ) {

							digi_play_sample_3d( SOUND_WEAPON_HIT_DOOR, 0.5, pos_x, pos_y, pos_z );
							wall_open_door( segnum, hit_side );

						}

					}

				}

				return;

			}

		}

	}

	// Use per-weapon impact vclip and sound if available
	// Ported from: collide_weapon_and_wall() in COLLIDE.C
	let hit_vclip = undefined;	// default = VCLIP_SMALL_EXPLOSION
	let hit_sound = SOUND_WEAPON_HIT_BLASTABLE;
	let hit_size = 1.0;

	if ( weapon_type !== undefined && weapon_type >= 0 && weapon_type < N_weapon_types ) {

		const wi = Weapon_info[ weapon_type ];
		if ( wi.wall_hit_vclip >= 0 ) hit_vclip = wi.wall_hit_vclip;
		if ( wi.wall_hit_sound >= 0 ) hit_sound = wi.wall_hit_sound;
		if ( wi.impact_size > 0 ) hit_size = wi.impact_size;

	}

	object_create_explosion( pos_x, pos_y, pos_z, hit_size, hit_vclip );
	digi_play_sample_3d( hit_sound, 0.4, pos_x, pos_y, pos_z );

	// Propagate awareness to nearby robots (PA_WEAPON_WALL_COLLISION = 2)
	// Ported from: COLLIDE.C lines 675, 931
	if ( segnum >= 0 ) {

		create_awareness_event( segnum, pos_x, pos_y, pos_z, 2 );

	}

	// Check for blastable walls on the hit side
	// Ported from: collide_weapon_and_wall() in COLLIDE.C — only damage the specific side hit
	if ( segnum >= 0 ) {

		const seg = Segments[ segnum ];
		if ( seg !== undefined ) {

			if ( hit_side >= 0 && hit_side <= 5 ) {

				// We know the exact side that was hit — only check that one
				const wn = seg.sides[ hit_side ].wall_num;
				if ( wn !== - 1 && Walls[ wn ] !== undefined ) {

					if ( Walls[ wn ].type === WALL_BLASTABLE ) {

						wall_damage( segnum, hit_side, damage || 5.0 );

					} else if ( Walls[ wn ].type === WALL_DOOR ) {

						// Weapon hits door — play door-hit sound and open it
						// Ported from: COLLIDE.C line 949 — digi_link_sound_to_pos(SOUND_WEAPON_HIT_DOOR, ...)
						digi_play_sample_3d( SOUND_WEAPON_HIT_DOOR, 0.5, pos_x, pos_y, pos_z );
						wall_open_door( segnum, hit_side );

					}

				}

			} else {

				// Fallback: no specific side provided (e.g., proximity bomb explosion)
				// Check all 6 sides
				for ( let s = 0; s < 6; s ++ ) {

					const wn = seg.sides[ s ].wall_num;
					if ( wn !== - 1 && Walls[ wn ] !== undefined ) {

						if ( Walls[ wn ].type === WALL_BLASTABLE ) {

							wall_damage( segnum, s, damage || 5.0 );
							break;

						} else if ( Walls[ wn ].type === WALL_DOOR ) {

							wall_open_door( segnum, s );
							break;

						}

					}

				}

			}

		}

	}

}

// ---------------------------------------------------------------
// collide_badass_explosion (area damage)
// Ported from: apply_force_damage() in COLLIDE.C lines 517-575
// Also: object_create_badass_explosion() in FIREBALL.C
// ---------------------------------------------------------------
export function collide_badass_explosion( pos_x, pos_y, pos_z, maxDamage, maxDistance ) {

	if ( _liveRobots === null ) return;

	// Find segment of explosion for LOS checks
	const explosionSeg = find_point_seg( pos_x, pos_y, pos_z, - 1 );

	// Damage all robots within radius (linear falloff) with LOS check
	// Ported from: apply_force_damage() in COLLIDE.C — object_to_object_visibility() check
	for ( let r = 0; r < _liveRobots.length; r ++ ) {

		const robot = _liveRobots[ r ];
		if ( robot.alive !== true ) continue;

		const dx = robot.obj.pos_x - pos_x;
		const dy = robot.obj.pos_y - pos_y;
		const dz = robot.obj.pos_z - pos_z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );

		if ( dist < maxDistance ) {

			// LOS check: don't damage through opaque walls (but damage through grates)
			// Ported from: FIREBALL.C line 188 — object_to_object_visibility(obj, obj0p, FQ_TRANSWALL)
			if ( explosionSeg !== - 1 ) {

				const losResult = find_vector_intersection(
					pos_x, pos_y, pos_z,
					robot.obj.pos_x, robot.obj.pos_y, robot.obj.pos_z,
					explosionSeg, 0.0,
					- 1, FQ_TRANSWALL
				);

				if ( losResult.hit_type === HIT_WALL ) continue;

			}

			// Linear damage falloff: full damage at center, zero at maxDistance
			const damage = maxDamage * ( 1.0 - dist / maxDistance );
			if ( damage > 0.1 ) {

				collide_robot_and_weapon( r, damage );

			}

		}

	}

	// Damage player within radius
	if ( _getPlayerShields !== null && _getPlayerShields() > 0 ) {

		const pp = _getPlayerPos !== null ? _getPlayerPos() : null;
		if ( pp !== null ) {

			const pdx = pp.x - pos_x;
			const pdy = pp.y - pos_y;
			const pdz = pp.z - pos_z;
			const pdist = Math.sqrt( pdx * pdx + pdy * pdy + pdz * pdz );

			if ( pdist < maxDistance ) {

				// LOS check: don't damage player through opaque walls (but damage through grates)
				// Ported from: FIREBALL.C line 188 — object_to_object_visibility uses FQ_TRANSWALL
				if ( explosionSeg !== - 1 ) {

					const losResult = find_vector_intersection(
						pos_x, pos_y, pos_z,
						pp.x, pp.y, pp.z,
						explosionSeg, 0.0,
						- 1, FQ_TRANSWALL
					);

					if ( losResult.hit_type === HIT_WALL ) {

						// Skip player damage — wall blocks explosion
					} else {

						const damage = maxDamage * ( 1.0 - pdist / maxDistance );
						if ( damage > 0.1 ) {

							apply_damage_to_player( damage, pos_x, pos_y, pos_z );

						}

					}

				} else {

					const damage = maxDamage * ( 1.0 - pdist / maxDistance );
					if ( damage > 0.1 ) {

						apply_damage_to_player( damage, pos_x, pos_y, pos_z );

					}

				}

			}

		}

	}

	// Create visual explosion proportional to damage radius
	object_create_explosion( pos_x, pos_y, pos_z, maxDistance * 0.15 );

}

// ---------------------------------------------------------------
// scrape_object_on_wall
// Ported from: scrape_object_on_wall() in COLLIDE.C lines 701-762
// Check all sides of player's segment for volatile wall damage
// ---------------------------------------------------------------
export function scrape_object_on_wall( playerSeg, dt ) {

	if ( _getPlayerShields === null || playerSeg < 0 || playerSeg >= Num_segments ) return;
	if ( _getPlayerShields() <= 0 ) return;

	const seg = Segments[ playerSeg ];
	const pp = _getPlayerPos !== null ? _getPlayerPos() : null;
	if ( pp === null ) return;

	const SCRAPE_RADIUS = 2.5;	// Same as PLAYER_RADIUS in game.js

	for ( let s = 0; s < 6; s ++ ) {

		const side = seg.sides[ s ];
		const tmi = TmapInfos[ side.tmap_num ];

		if ( tmi.damage <= 0 ) continue;

		// Check distance from player to this wall
		const dist = get_side_dist( pp.x, pp.y, pp.z, seg, s );

		if ( dist < SCRAPE_RADIUS ) {

			// Apply damage scaled by frame time
			const damage = tmi.damage * dt;

			_setPlayerShields( _getPlayerShields() - damage );
			if ( _flashDamage !== null ) _flashDamage();
			if ( _updateHUD !== null ) _updateHUD();

			// Apply small rotational jolt from lava contact
			// Ported from: COLLIDE.C scrape_object_on_wall() — random spin on volatile walls
			const rotScale = 0.04;
			phys_apply_rot(
				( Math.random() - 0.5 ) * rotScale,
				( Math.random() - 0.5 ) * rotScale,
				( Math.random() - 0.5 ) * rotScale
			);

			// Play volatile wall hiss sound (throttled to 0.25s intervals)
			if ( GameTime > lastVolatileScrapeTime + 0.25 || GameTime < lastVolatileScrapeTime ) {

				lastVolatileScrapeTime = GameTime;
				digi_play_sample( SOUND_VOLATILE_WALL_HISS, 0.5 );

			}

			if ( _getPlayerShields() <= 0 ) {

				_setPlayerShields( 0 );
				if ( _updateHUD !== null ) _updateHUD();
				if ( _startPlayerDeath !== null ) _startPlayerDeath();
				break;

			}

		}

	}

}

// ---------------------------------------------------------------
// drop_player_eggs
// Ported from: drop_player_eggs() in COLLIDE.C lines 1447-1546
// Drop powerups corresponding to player's current weapons/ammo
// ---------------------------------------------------------------
export function drop_player_eggs() {

	if ( _getPlayerPos === null || _getPlayerSegnum === null || _spawnDroppedPowerup === null ) return;

	const pp = _getPlayerPos();
	const seg = _getPlayerSegnum();

	// Drop laser level powerups (one per level above 0)
	const laserLevel = _getPlayerLaserLevel !== null ? _getPlayerLaserLevel() : 0;
	if ( laserLevel >= 1 ) {

		for ( let i = 0; i < laserLevel; i ++ ) {

			_spawnDroppedPowerup( POW_LASER, pp.x, pp.y, pp.z, seg );

		}

	}

	// Drop primary weapons (skip laser, bit 0 — player always has it)
	const primaryFlags = _getPlayerPrimaryFlags !== null ? _getPlayerPrimaryFlags() : 1;

	if ( ( primaryFlags & 2 ) !== 0 ) {

		_spawnDroppedPowerup( POW_VULCAN_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	if ( ( primaryFlags & 4 ) !== 0 ) {

		_spawnDroppedPowerup( POW_SPREADFIRE_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	if ( ( primaryFlags & 8 ) !== 0 ) {

		_spawnDroppedPowerup( POW_PLASMA_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	if ( ( primaryFlags & 16 ) !== 0 ) {

		_spawnDroppedPowerup( POW_FUSION_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Drop secondary weapons
	const secAmmo0 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 0 ) : 0;
	const secAmmo1 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 1 ) : 0;
	const secAmmo2 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 2 ) : 0;
	const secAmmo3 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 3 ) : 0;
	const secAmmo4 = _getPlayerSecondaryAmmo !== null ? _getPlayerSecondaryAmmo( 4 ) : 0;

	// Concussion missiles: up to 4, split as packs of 4 and singles
	const numConcussion = Math.min( secAmmo0, 4 );
	if ( Math.floor( numConcussion / 4 ) > 0 ) {

		_spawnDroppedPowerup( POW_MISSILE_4, pp.x, pp.y, pp.z, seg );

	}

	for ( let i = 0; i < numConcussion % 4; i ++ ) {

		_spawnDroppedPowerup( POW_MISSILE_1, pp.x, pp.y, pp.z, seg );

	}

	// Homing missiles: up to 6, split as packs of 4 and singles
	const numHoming = Math.min( secAmmo1, 6 );
	if ( Math.floor( numHoming / 4 ) > 0 ) {

		_spawnDroppedPowerup( POW_HOMING_AMMO_4, pp.x, pp.y, pp.z, seg );

	}

	for ( let i = 0; i < numHoming % 4; i ++ ) {

		_spawnDroppedPowerup( POW_HOMING_AMMO_1, pp.x, pp.y, pp.z, seg );

	}

	// Proximity bombs: (ammo+2)/4, max 3
	const numProx = Math.min( Math.floor( ( secAmmo2 + 2 ) / 4 ), 3 );
	for ( let i = 0; i < numProx; i ++ ) {

		_spawnDroppedPowerup( POW_PROXIMITY_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Smart missiles: ammo count, max 3
	const numSmart = Math.min( secAmmo3, 3 );
	for ( let i = 0; i < numSmart; i ++ ) {

		_spawnDroppedPowerup( POW_SMARTBOMB_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Mega missiles: ammo count, max 3
	const numMega = Math.min( secAmmo4, 3 );
	for ( let i = 0; i < numMega; i ++ ) {

		_spawnDroppedPowerup( POW_MEGA_WEAPON, pp.x, pp.y, pp.z, seg );

	}

	// Vulcan ammo: if player has ammo but no vulcan weapon, drop ammo packs
	const vulcanAmmo = _getPlayerVulcanAmmo !== null ? _getPlayerVulcanAmmo() : 0;
	if ( ( primaryFlags & 2 ) === 0 && vulcanAmmo > 0 ) {

		let amount = Math.min( vulcanAmmo, 200 );
		while ( amount > 0 ) {

			_spawnDroppedPowerup( POW_VULCAN_AMMO, pp.x, pp.y, pp.z, seg );
			amount -= VULCAN_AMMO_AMOUNT;

		}

	}

}

// ---------------------------------------------------------------
// collide_player_and_powerup
// Ported from: collide_player_and_powerup() in COLLIDE.C lines 1739-1776
//              do_powerup() in POWERUP.C
// ---------------------------------------------------------------
export function collide_player_and_powerup( powerup ) {

	const scene = _getScene !== null ? _getScene() : null;
	if ( scene === null ) return;

	const id = powerup.obj.id;
	let used = 0;

	// Hostages are always consumed
	if ( powerup.isHostage === true ) {

		if ( _addHostageSaved !== null ) _addHostageSaved( 1 );
		if ( _addLevelHostagesSaved !== null ) _addLevelHostagesSaved( 1 );
		if ( _addPlayerScore !== null ) _addPlayerScore( HOSTAGE_SCORE );
		if ( _showMessage !== null ) _showMessage( 'Hostage rescued!' );
		digi_play_sample( SOUND_HOSTAGE_RESCUED, 0.8 );
		if ( _flashDamage !== null ) _flashDamage( 'blue' );
		if ( _updateHUD !== null ) _updateHUD();
		used = 1;

	} else {

		// Ported from: do_powerup() in POWERUP.C lines 378-540
		// Returns used=0 if powerup should stay in the world (player maxed out)
		switch ( id ) {

			case POW_SHIELD_BOOST:
				if ( _getPlayerShields() < 200 ) {

					// Ported from: do_powerup() in POWERUP.C line 397
					// shields += 3*F1_0 + 3*F1_0*(NDL - Difficulty_level)
					const shieldDifficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					const shieldBoostAmount = 3 + 3 * ( NDL - shieldDifficulty );
					_setPlayerShields( Math.min( _getPlayerShields() + shieldBoostAmount, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Shield Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Shields maxed out!' );

				}

				break;

			case POW_ENERGY:
				if ( _getPlayerEnergy() < 200 ) {

					// Ported from: pick_up_energy() in POWERUP.C line 349
					// energy += 3*F1_0 + 3*F1_0*(NDL - Difficulty_level)
					const energyDifficulty = _getDifficultyLevel !== null ? _getDifficultyLevel() : 1;
					const energyBoostAmount = 3 + 3 * ( NDL - energyDifficulty );
					_setPlayerEnergy( Math.min( _getPlayerEnergy() + energyBoostAmount, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Energy Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Energy maxed out!' );

				}

				break;

			case POW_EXTRA_LIFE:
				if ( _setPlayerLives !== null ) _setPlayerLives( _getPlayerLives() + 1 );
				if ( _showMessage !== null ) _showMessage( 'Extra Life!' );
				used = 1;
				break;

			case POW_LASER:
				if ( _getPlayerLaserLevel() < 3 ) {

					_setPlayerLaserLevel( _getPlayerLaserLevel() + 1 );
					if ( _showMessage !== null ) _showMessage( 'Laser Level ' + ( _getPlayerLaserLevel() + 1 ) + '!' );
					used = 1;

				} else if ( _getPlayerEnergy() < 200 ) {

					_setPlayerEnergy( Math.min( _getPlayerEnergy() + 20, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Energy Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Laser maxed out!' );

				}

				break;

			case POW_KEY_BLUE:
				// Ported from: POWERUP.C — don't consume key if player already has it
				if ( _getPlayerKeys !== null && _getPlayerKeys().blue === true ) {

					break;

				}

				if ( _setPlayerKey !== null ) _setPlayerKey( 'blue', true );
				if ( _showMessage !== null ) _showMessage( 'Blue Access Key!' );
				used = 1;
				break;

			case POW_KEY_RED:
				// Ported from: POWERUP.C — don't consume key if player already has it
				if ( _getPlayerKeys !== null && _getPlayerKeys().red === true ) {

					break;

				}

				if ( _setPlayerKey !== null ) _setPlayerKey( 'red', true );
				if ( _showMessage !== null ) _showMessage( 'Red Access Key!' );
				used = 1;
				break;

			case POW_KEY_GOLD:
				// Ported from: POWERUP.C — don't consume key if player already has it
				if ( _getPlayerKeys !== null && _getPlayerKeys().gold === true ) {

					break;

				}

				if ( _setPlayerKey !== null ) _setPlayerKey( 'gold', true );
				if ( _showMessage !== null ) _showMessage( 'Gold Access Key!' );
				used = 1;
				break;

			case POW_VULCAN_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 2 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 2 );
					_setPlayerVulcanAmmo( Math.min( _getPlayerVulcanAmmo() + VULCAN_WEAPON_AMMO_AMOUNT, VULCAN_AMMO_MAX ) );
					if ( _showMessage !== null ) _showMessage( 'Vulcan Cannon!' );
					used = 1;

				} else if ( _getPlayerVulcanAmmo() < VULCAN_AMMO_MAX ) {

					_setPlayerVulcanAmmo( Math.min( _getPlayerVulcanAmmo() + VULCAN_AMMO_AMOUNT, VULCAN_AMMO_MAX ) );
					if ( _showMessage !== null ) _showMessage( 'Vulcan Ammo!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Vulcan ammo maxed out!' );

				}

				break;

			case POW_SPREADFIRE_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 4 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 4 );
					if ( _showMessage !== null ) _showMessage( 'Spreadfire Cannon!' );
					used = 1;

				} else if ( _getPlayerEnergy() < 200 ) {

					_setPlayerEnergy( Math.min( _getPlayerEnergy() + 20, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Energy Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Already have Spreadfire!' );

				}

				break;

			case POW_PLASMA_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 8 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 8 );
					if ( _showMessage !== null ) _showMessage( 'Plasma Cannon!' );
					used = 1;

				} else if ( _getPlayerEnergy() < 200 ) {

					_setPlayerEnergy( Math.min( _getPlayerEnergy() + 20, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Energy Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Already have Plasma!' );

				}

				break;

			case POW_FUSION_WEAPON:
				if ( ( _getPlayerPrimaryFlags() & 16 ) === 0 ) {

					_setPlayerPrimaryFlags( _getPlayerPrimaryFlags() | 16 );
					if ( _showMessage !== null ) _showMessage( 'Fusion Cannon!' );
					used = 1;

				} else if ( _getPlayerEnergy() < 200 ) {

					_setPlayerEnergy( Math.min( _getPlayerEnergy() + 20, 200 ) );
					if ( _showMessage !== null ) _showMessage( 'Energy Boost!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Already have Fusion!' );

				}

				break;

			case POW_MISSILE_1:
				if ( _getPlayerSecondaryAmmo( 0 ) < 20 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 1 );
					_setPlayerSecondaryAmmo( 0, Math.min( _getPlayerSecondaryAmmo( 0 ) + 1, 20 ) );
					if ( _showMessage !== null ) _showMessage( 'Concussion Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Concussion ammo maxed out!' );

				}

				break;

			case POW_MISSILE_4:
				if ( _getPlayerSecondaryAmmo( 0 ) < 20 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 1 );
					_setPlayerSecondaryAmmo( 0, Math.min( _getPlayerSecondaryAmmo( 0 ) + 4, 20 ) );
					if ( _showMessage !== null ) _showMessage( '4 Concussion Missiles!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Concussion ammo maxed out!' );

				}

				break;

			case POW_HOMING_AMMO_1:
				if ( _getPlayerSecondaryAmmo( 1 ) < 10 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 2 );
					_setPlayerSecondaryAmmo( 1, Math.min( _getPlayerSecondaryAmmo( 1 ) + 1, 10 ) );
					if ( _showMessage !== null ) _showMessage( 'Homing Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Homing ammo maxed out!' );

				}

				break;

			case POW_HOMING_AMMO_4:
				if ( _getPlayerSecondaryAmmo( 1 ) < 10 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 2 );
					_setPlayerSecondaryAmmo( 1, Math.min( _getPlayerSecondaryAmmo( 1 ) + 4, 10 ) );
					if ( _showMessage !== null ) _showMessage( '4 Homing Missiles!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Homing ammo maxed out!' );

				}

				break;

			case POW_PROXIMITY_WEAPON:
				if ( _getPlayerSecondaryAmmo( 2 ) < 10 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 4 );
					_setPlayerSecondaryAmmo( 2, Math.min( _getPlayerSecondaryAmmo( 2 ) + 4, 10 ) );
					if ( _showMessage !== null ) _showMessage( 'Proximity Bombs!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Proximity ammo maxed out!' );

				}

				break;

			case POW_SMARTBOMB_WEAPON:
				if ( _getPlayerSecondaryAmmo( 3 ) < 5 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 8 );
					_setPlayerSecondaryAmmo( 3, Math.min( _getPlayerSecondaryAmmo( 3 ) + 1, 5 ) );
					if ( _showMessage !== null ) _showMessage( 'Smart Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Smart ammo maxed out!' );

				}

				break;

			case POW_MEGA_WEAPON:
				if ( _getPlayerSecondaryAmmo( 4 ) < 5 ) {

					_setPlayerSecondaryFlags( _getPlayerSecondaryFlags() | 16 );
					_setPlayerSecondaryAmmo( 4, Math.min( _getPlayerSecondaryAmmo( 4 ) + 1, 5 ) );
					if ( _showMessage !== null ) _showMessage( 'Mega Missile!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Mega ammo maxed out!' );

				}

				break;

			case POW_VULCAN_AMMO:
				if ( _getPlayerVulcanAmmo() < VULCAN_AMMO_MAX ) {

					_setPlayerVulcanAmmo( Math.min( _getPlayerVulcanAmmo() + VULCAN_AMMO_AMOUNT, VULCAN_AMMO_MAX ) );
					if ( _showMessage !== null ) _showMessage( 'Vulcan Ammo!' );
					used = 1;

				} else {

					if ( _showMessage !== null ) _showMessage( 'Vulcan ammo maxed out!' );

				}

				break;

			case POW_QUAD_FIRE:
				// Ported from: POWERUP.C — set PLAYER_FLAGS_QUAD_LASERS
				if ( _getPlayerQuadLasers !== null && _getPlayerQuadLasers() === true ) {

					if ( _showMessage !== null ) _showMessage( 'Already have Quad Lasers!' );

				} else {

					if ( _setPlayerQuadLasers !== null ) _setPlayerQuadLasers( true );
					if ( _showMessage !== null ) _showMessage( 'Quad Lasers!' );
					used = 1;

				}

				break;

			case POW_CLOAK:
				// Ported from: do_megawow_powerup() / POWERUP.C lines 527-535
				if ( _isPlayerCloaked !== null && _isPlayerCloaked() === true ) {

					if ( _showMessage !== null ) _showMessage( 'Already cloaked!' );

				} else {

					if ( _activateCloak !== null ) _activateCloak();
					if ( _showMessage !== null ) _showMessage( 'Cloak!' );
					used = 1;

				}

				break;

			case POW_INVULNERABILITY:
				// Ported from: do_megawow_powerup() / POWERUP.C lines 543-553
				if ( _isPlayerInvulnerable !== null && _isPlayerInvulnerable() === true ) {

					if ( _showMessage !== null ) _showMessage( 'Already invulnerable!' );

				} else {

					if ( _activateInvulnerability !== null ) _activateInvulnerability();
					if ( _showMessage !== null ) _showMessage( 'Invulnerability!' );
					used = 1;

				}

				break;

			default:
				if ( _showMessage !== null ) _showMessage( 'Got Powerup!' );
				used = 1;
				break;

		}

	}

	// Only consume the powerup if it was actually used
	if ( used === 1 ) {

		// Play per-powerup-type pickup sound (hostage already plays its own)
		// Ported from: POWERUP.C line 569-574 — Powerup_info[obj->id].hit_sound
		if ( powerup.isHostage !== true ) {

			let pickupSound = SOUND_HUD_MESSAGE;	// fallback

			if ( id >= 0 && id < N_powerup_types ) {

				const pi_sound = Powerup_info[ id ].hit_sound;
				if ( pi_sound >= 0 ) pickupSound = pi_sound;

			}

			digi_play_sample( pickupSound, 0.7 );

		}

		powerup.alive = false;

		if ( powerup.sprite !== null ) {

			scene.remove( powerup.sprite );

		}

		if ( _updateHUD !== null ) _updateHUD();

	}

}
