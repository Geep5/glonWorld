/**
 * Planet render scripts — freeform JS/CSS/HTML per object.
 *
 * Supports two modes:
 *   1. Canvas 2D script (script field) — draws to a CanvasTexture
 *   2. Three.js native code (threejs field) — adds child meshes/materials
 *
 * Plus optional HTML/CSS overlay.
 * All stored in localStorage; zero DAG impact.
 */

import * as THREE from "three";

const LS_PREFIX = "glonAstrolabe.planetRender.";

// ── localStorage ─────────────────────────────────────────────────

export function getRender(objectId) {
	try { return JSON.parse(localStorage.getItem(LS_PREFIX + objectId)); } catch { return null; }
}

export function setRender(objectId, render) {
	try { localStorage.setItem(LS_PREFIX + objectId, JSON.stringify(render)); } catch { /* ignore */ }
}

export function clearRender(objectId) {
	try { localStorage.removeItem(LS_PREFIX + objectId); } catch { /* ignore */ }
}

// ── Active renderer registry ─────────────────────────────────────

const activeRenders = new Map(); // mesh → { kind: "canvas"|"threejs", ... }
let animating = false;

function startLoop() {
	if (animating) return;
	animating = true;
	requestAnimationFrame(tickLoop);
}

function tickLoop() {
	const t = performance.now() / 1000;
	for (const [mesh, entry] of activeRenders) {
		if (!mesh.parent) { activeRenders.delete(mesh); continue; }
		if (entry.kind === "canvas") {
			entry.fn(entry.ctx, 256, 128, t, entry.seed);
			entry.texture.needsUpdate = true;
		} else if (entry.kind === "threejs") {
			try {
				entry.fn(THREE, entry.group, entry.seed, t);
			} catch (err) {
				// Silently skip frame errors to avoid console spam
			}
		}
	}
	if (activeRenders.size > 0) requestAnimationFrame(tickLoop);
	else animating = false;
}

// ── Apply / remove ───────────────────────────────────────────────

export function applyStoredStyle(mesh) {
	const id = mesh?.userData?.id;
	if (!id) return;
	const render = getRender(id);
	if (render) applyToMesh(mesh, render);
}

export function applyToMesh(mesh, render) {
	if (!mesh || !render) return;

	// Stop any previous renderer on this mesh
	removeFromMesh(mesh);

	// 1. Three.js native code (preferred)
	if (render.threejs) {
		try {
			const seed = makeSeed(mesh.userData.id);
			// Create or reuse a custom group attached to the mesh
			let group = mesh.userData._planetGroup;
			if (!group) {
				group = new THREE.Group();
				mesh.add(group);
				mesh.userData._planetGroup = group;
			}
			// Clear previous custom children
			while (group.children.length > 0) {
				const child = group.children[0];
				if (child.geometry) child.geometry.dispose();
				if (child.material) {
					if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
					else child.material.dispose();
				}
				group.remove(child);
			}
			// Execute the AI code
			const fn = new Function("THREE", "parent", "seed", "time", render.threejs);
			fn(THREE, group, seed, 0);

			// Store for animation
			activeRenders.set(mesh, { kind: "threejs", group, fn, seed });
			startLoop();
		} catch (err) {
			console.warn("Planet Three.js render error:", err);
		}
	}

	// 2. Canvas renderer (legacy / alternative)
	else if (render.script) {
		const mat = mesh.material;
		if (mat) {
			try {
				const seed = makeSeed(mesh.userData.id);
				const canvas = document.createElement("canvas");
				canvas.width = 256;
				canvas.height = 128;
				const ctx = canvas.getContext("2d");
				const fn = new Function("ctx", "W", "H", "t", "seed", render.script);
				fn(ctx, 256, 128, 0, seed);
				const tex = new THREE.CanvasTexture(canvas);
				tex.colorSpace = THREE.SRGBColorSpace;
				tex.wrapS = THREE.RepeatWrapping;
				tex.anisotropy = 4;
				mat.map = tex;
				if (mat.emissiveMap) mat.emissiveMap = tex;
				mat.needsUpdate = true;

				activeRenders.set(mesh, { kind: "canvas", canvas, ctx, texture: tex, fn, seed });
				startLoop();
			} catch (err) {
				console.warn("Planet canvas render error:", err);
			}
		}
	}

	// 3. Material color override (always applies)
	const mat = mesh.material;
	if (mat) {
		if (render.color) mat.color.set(render.color);
		if (render.emissive) mat.emissive.set(render.emissive);
	}

	// 4. HTML overlay
	updateOverlay(mesh, render);
}

export function removeFromMesh(mesh) {
	const entry = activeRenders.get(mesh);
	if (entry) {
		if (entry.kind === "threejs" && entry.group) {
			while (entry.group.children.length > 0) {
				const child = entry.group.children[0];
				if (child.geometry) child.geometry.dispose();
				if (child.material) {
					if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
					else child.material.dispose();
				}
				entry.group.remove(child);
			}
		}
		activeRenders.delete(mesh);
	}
	removeOverlay(mesh);
}

function makeSeed(str) {
	let h = 0x9e3779b9;
	for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 2654435761);
	let s = h >>> 0;
	return () => {
		s = Math.imul(s ^ (s >>> 16), 2246822507) >>> 0;
		s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
		s = (s ^ (s >>> 16)) >>> 0;
		return s / 4294967296;
	};
}

// ── HTML overlay ─────────────────────────────────────────────────

const overlays = new Map();

function updateOverlay(mesh, render) {
	const id = mesh.userData.id;
	removeOverlayById(id);
	if (!render.html && !render.css) return;

	const div = document.createElement("div");
	div.className = "planet-overlay";
	div.dataset.objectId = id;
	if (render.css) {
		const style = document.createElement("style");
		style.textContent = render.css;
		div.appendChild(style);
	}
	if (render.html) {
		div.innerHTML += render.html;
	}
	document.body.appendChild(div);
	overlays.set(id, { div, mesh });
}

function removeOverlay(mesh) {
	removeOverlayById(mesh?.userData?.id);
}

function removeOverlayById(id) {
	if (!id) return;
	const entry = overlays.get(id);
	if (entry) {
		entry.div.remove();
		overlays.delete(id);
	}
}

export function updateOverlays(camera, renderer) {
	for (const [id, { div, mesh }] of overlays) {
		if (!mesh.parent) { div.remove(); overlays.delete(id); continue; }
		const pos = mesh.position.clone();
		pos.project(camera);
		const x = (pos.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
		const y = (-pos.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
		div.style.left = x + "px";
		div.style.top = y + "px";
		div.style.display = pos.z < 1 ? "block" : "none";
	}
}

// ── Parse from agent text ────────────────────────────────────────

export function parseRenderFromText(text) {
	if (!text) return null;
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1].trim());
			if (isValidRender(parsed)) return parsed;
		} catch { /* not JSON */ }
	}
	return null;
}

function isValidRender(obj) {
	if (!obj || typeof obj !== "object") return false;
	return obj.threejs || obj.script || obj.css || obj.html || obj.color || obj.emissive;
}
