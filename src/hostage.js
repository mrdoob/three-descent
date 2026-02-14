// Ported from: descent-master/MAIN/HOSTAGE.C
// Hostage tracking: counts for current level and total game

// Total hostages placed in current level
let hostagesInLevel = 0;
// Hostages saved during current level
let levelHostagesSaved = 0;
// Total hostages saved across entire game
let hostageSaved = 0;

export function hostage_get_in_level() { return hostagesInLevel; }
export function hostage_get_level_saved() { return levelHostagesSaved; }
export function hostage_get_total_saved() { return hostageSaved; }

export function hostage_add_in_level( n ) { hostagesInLevel += n; }
export function hostage_add_level_saved( n ) { levelHostagesSaved += n; }
export function hostage_add_total_saved( n ) { hostageSaved += n; }

// Reset level-specific counters (called at start of each level)
export function hostage_reset_level() {

	hostagesInLevel = 0;
	levelHostagesSaved = 0;

}

// Reset all hostage state (called on game restart)
export function hostage_reset_all() {

	hostagesInLevel = 0;
	levelHostagesSaved = 0;
	hostageSaved = 0;

}
