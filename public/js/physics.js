/**
 * Rapier 3D physics world wrapper.
 *
 * Responsibilities:
 *   - Async init of the WASM module
 *   - Single World instance with zero gravity
 *   - Per-frame step
 *   - Accessor for the RAPIER module (needed for body descriptors, etc.)
 */

import RAPIER from "@dimforge/rapier3d-compat";

let world = null;
let initialized = false;

export async function initPhysics() {
	if (initialized) return;
	await RAPIER.init();
	world = new RAPIER.World({ x: 0, y: 0, z: 0 });
	initialized = true;
}

export function getWorld() {
	return world;
}

export function getRapier() {
	return RAPIER;
}

export function isReady() {
	return initialized;
}

export function step(dt) {
	if (!world) return;
	world.timestep = dt;
	world.step();
}
