// Ported from: descent-master/MAIN/LIGHTING.C
// Dynamic object lighting — disabled (MeshBasicMaterial with baked vertex colors)
// Original uses per-vertex Dynamic_light[] array; we use baked vertex colors instead

// Initialize dynamic object lighting (no-op — lights disabled)
export function lighting_init( scene ) {

}

// Update dynamic object lights each frame (no-op — lights disabled)
export function lighting_frame( playerPos, robots, powerups, stuckFlares ) {

}

// Clean up lights for level transitions (no-op — lights disabled)
export function lighting_cleanup() {

}
