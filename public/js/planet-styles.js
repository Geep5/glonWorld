/**
 * Planet styles — local overrides for object appearance.
 *
 * Purely presentational; stored in localStorage per object id.
 * No DAG impact, no proto changes.
 */

import * as THREE from "three";

// ── localStorage helpers ─────────────────────────────────────────

const LS_PREFIX = "glonAstrolabe.planetStyle.";

function lsGet(id) {
	try { return JSON.parse(localStorage.getItem(LS_PREFIX + id)); } catch { return null; }
}

function lsSet(id, style) {
	try { localStorage.setItem(LS_PREFIX + id, JSON.stringify(style)); } catch { /* ignore */ }
}

export function lsClear(id) {
	try { localStorage.removeItem(LS_PREFIX + id); } catch { /* ignore */ }
}

// ── Style application ────────────────────────────────────────────

/**
 * Apply a style config to an existing mesh.
 * Called after buildCosmos creates the mesh, or when a style changes.
 */
export function applyStyle(mesh, style) {
	if (!mesh || !style) return;
	const mat = mesh.material;
	if (!mat) return;

	// Material overrides
	if (style.color) mat.color.set(style.color);
	if (style.emissive) mat.emissive.set(style.emissive);
	if (style.emissiveIntensity !== undefined) mat.emissiveIntensity = style.emissiveIntensity;
	if (style.metalness !== undefined) mat.metalness = style.metalness;
	if (style.roughness !== undefined) mat.roughness = style.roughness;

	// Surface texture override
	if (style.surfaceType) {
		const newTex = surfaceTextureFor(style.surfaceType, style.color || "#888888", mesh.userData.id);
		if (mat.map) mat.map = newTex;
		if (mat.emissiveMap) mat.emissiveMap = newTex;
		mat.needsUpdate = true;
	}

	// Features
	clearFeatures(mesh);
	if (style.features?.length) {
		for (const f of style.features) {
			addFeature(mesh, f);
		}
	}
}

/** Remove all feature children from a mesh. */
function clearFeatures(mesh) {
	const toRemove = [];
	mesh.traverse((c) => {
		if (c.userData.isFeature) toRemove.push(c);
	});
	for (const c of toRemove) c.parent.remove(c);
}

/** Add a feature mesh as a child of the planet. */
function addFeature(mesh, feature) {
	const scale = feature.scale ?? 1;
	switch (feature.type) {
		case "volcano": {
			const geom = new THREE.ConeGeometry(0.3 * scale, 0.6 * scale, 8);
			const mat = new THREE.MeshStandardMaterial({
				color: 0x1a0a00,
				ramoughness: 0.9,
				emissive: 0xff4400,
				emissiveIntensity: 1.5,
			});
			const cone = new THREE.Mesh(geom, mat);
			cone.position.set(0, 0.8, 0);
			cone.userData.isFeature = true;
			mesh.add(cone);
			break;
		}
		case "ring": {
			const ir = feature.innerRadius ?? 1.4;
			const or = feature.outerRadius ?? 2.0;
			const geom = new THREE.RingGeometry(ir, or, 64);
			const mat = new THREE.MeshBasicMaterial({
				color: feature.color ?? 0xc8b89a,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.6,
			});
			const ring = new THREE.Mesh(geom, mat);
			ring.rotation.x = Math.PI / 2 + (feature.tilt ?? 0.2);
			ring.userData.isFeature = true;
			mesh.add(ring);
			break;
		}
		case "moon": {
			const geom = new THREE.SphereGeometry(0.25 * scale, 16, 12);
			const mat = new THREE.MeshStandardMaterial({ color: feature.color ?? 0xaaaaaa, roughness: 0.9 });
			const moon = new THREE.Mesh(geom, mat);
			moon.position.set(1.5 * scale, 0.2, 0);
			moon.userData.isFeature = true;
			mesh.add(moon);
			break;
		}
	}
}

// ── Surface textures ─────────────────────────────────────────────

const textureCache = new Map();

function surfaceTextureFor(surfaceType, hex, seed) {
	const key = `${surfaceType}:${hex}:${seed}`;
	const cached = textureCache.get(key);
	if (cached) return cached;

	const W = 256, H = 128;
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d");

	// Seeded RNG from combined key
	let s = hashSeed(key);
	const rng = () => {
		s = Math.imul(s ^ (s >>> 16), 2246822507) >>> 0;
		s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
		s = (s ^ (s >>> 16)) >>> 0;
		return s / 4294967296;
	};

	const base = parseHex(hex);

	switch (surfaceType) {
		case "magma": drawMagma(ctx, W, H, base, rng); break;
		case "ice": drawIce(ctx, W, H, base, rng); break;
		case "gas": drawGas(ctx, W, H, base, rng); break;
		case "crystalline": drawCrystalline(ctx, W, H, base, rng); break;
		default: drawTerran(ctx, W, H, base, rng); break;
	}

	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = THREE.RepeatWrapping;
	tex.anisotropy = 4;
	textureCache.set(key, tex);
	return tex;
}

function hashSeed(str) {
	let h = 0x9e3779b9;
	for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 2654435761);
	return h >>> 0;
}

function parseHex(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return { r: 128, g: 128, b: 128 };
	const n = parseInt(m[1], 16);
	return { r: (n >>> 16) & 0xff, g: (n >>> 8) & 0xff, b: n & 0xff };
}

function shadeRgb({ r, g, b }, k) {
	if (k >= 0) return { r: Math.round(r + (255 - r) * k), g: Math.round(g + (255 - g) * k), b: Math.round(b + (255 - b) * k) };
	const f = 1 + k;
	return { r: Math.round(r * f), g: Math.round(g * f), b: Math.round(b * f) };
}

// ── Surface generators ───────────────────────────────────────────

function drawTerran(ctx, W, H, base, rng) {
	ctx.fillStyle = rgbCss(base);
	ctx.fillRect(0, 0, W, H);
	const patches = 60 + Math.floor(rng() * 40);
	for (let i = 0; i < patches; i++) {
		const x = rng() * W, y = rng() * H, r = 6 + rng() * 50;
		const dark = rng() < 0.55;
		const k = dark ? -(0.25 + rng() * 0.45) : (0.15 + rng() * 0.4);
		const tinted = shadeRgb(base, k);
		const alpha = 0.18 + rng() * 0.5;
		drawBlotch(ctx, x, y, r, tinted, alpha);
		if (x - r < 0) drawBlotch(ctx, x + W, y, r, tinted, alpha);
		if (x + r > W) drawBlotch(ctx, x - W, y, r, tinted, alpha);
	}
}

function drawMagma(ctx, W, H, base, rng) {
	// Dark cracked crust
	ctx.fillStyle = "#1a0800";
	ctx.fillRect(0, 0, W, H);

	// Lava cracks
	const cracks = 40 + Math.floor(rng() * 30);
	for (let i = 0; i < cracks; i++) {
		const x = rng() * W;
		const y = rng() * H;
		const len = 10 + rng() * 40;
		const angle = rng() * Math.PI * 2;
		const w = 1 + rng() * 2;
		ctx.strokeStyle = `rgba(255, ${100 + Math.floor(rng() * 100)}, 0, ${0.4 + rng() * 0.5})`;
		ctx.lineWidth = w;
		ctx.beginPath();
		ctx.moveTo(x, y);
		// Jagged crack
		let cx = x, cy = y;
		for (let s = 0; s < 3; s++) {
			cx += Math.cos(angle + (rng() - 0.5)) * len / 3;
			cy += Math.sin(angle + (rng() - 0.5)) * len / 3;
			ctx.lineTo(cx, cy);
		}
		ctx.stroke();
		// Wrap
		if (x < 20) { ctx.beginPath(); ctx.moveTo(x + W, y); ctx.lineTo(cx + W, cy); ctx.stroke(); }
		if (x > W - 20) { ctx.beginPath(); ctx.moveTo(x - W, y); ctx.lineTo(cx - W, cy); ctx.stroke(); }
	}

	// Glowing pools
	const pools = 8 + Math.floor(rng() * 8);
	for (let i = 0; i < pools; i++) {
		const x = rng() * W, y = rng() * H, r = 8 + rng() * 25;
		const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
		grad.addColorStop(0, `rgba(255, ${80 + Math.floor(rng() * 120)}, 0, ${0.5 + rng() * 0.4})`);
		grad.addColorStop(1, "rgba(255, 60, 0, 0)");
		ctx.fillStyle = grad;
		ctx.fillRect(x - r, y - r, r * 2, r * 2);
	}
}

function drawIce(ctx, W, H, base, rng) {
	// Pale base
	ctx.fillStyle = rgbCss(shadeRgb(base, 0.5));
	ctx.fillRect(0, 0, W, H);

	// Crystalline facets
	const facets = 30 + Math.floor(rng() * 20);
	for (let i = 0; i < facets; i++) {
		const x = rng() * W, y = rng() * H;
		const size = 5 + rng() * 20;
		ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + rng() * 0.3})`;
		ctx.beginPath();
		for (let j = 0; j < 6; j++) {
			const a = (j / 6) * Math.PI * 2;
			const px = x + Math.cos(a) * size;
			const py = y + Math.sin(a) * size * 0.5;
			if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
		}
		ctx.closePath();
		ctx.fill();
	}

	// Frost streaks
	const streaks = 20 + Math.floor(rng() * 15);
	for (let i = 0; i < streaks; i++) {
		const x = rng() * W, y = rng() * H;
		const w = 20 + rng() * 60, h = 1 + rng() * 3;
		const grad = ctx.createLinearGradient(x, y, x + w, y);
		grad.addColorStop(0, "rgba(255,255,255,0)");
		grad.addColorStop(0.5, `rgba(255,255,255,${0.15 + rng() * 0.25})`);
		grad.addColorStop(1, "rgba(255,255,255,0)");
		ctx.fillStyle = grad;
		ctx.fillRect(x, y, w, h);
	}
}

function drawGas(ctx, W, H, base, rng) {
	// Base color
	ctx.fillStyle = rgbCss(base);
	ctx.fillRect(0, 0, W, H);

	// Horizontal bands
	const bands = 6 + Math.floor(rng() * 4);
	for (let i = 0; i < bands; i++) {
		const y = (i / bands) * H;
		const bandH = (H / bands) * (0.8 + rng() * 0.4);
		const tint = shadeRgb(base, (rng() - 0.5) * 0.6);
		const alpha = 0.2 + rng() * 0.3;
		const grad = ctx.createLinearGradient(0, y, 0, y + bandH);
		grad.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},0)`);
		grad.addColorStop(0.5, `rgba(${tint.r},${tint.g},${tint.b},${alpha})`);
		grad.addColorStop(1, `rgba(${tint.r},${tint.g},${tint.b},0)`);
		ctx.fillStyle = grad;
		ctx.fillRect(0, y, W, bandH);
	}

	// Storm spots
	const spots = 2 + Math.floor(rng() * 3);
	for (let i = 0; i < spots; i++) {
		const x = rng() * W, y = rng() * H, r = 10 + rng() * 20;
		const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
		grad.addColorStop(0, `rgba(255,200,150,${0.3 + rng() * 0.3})`);
		grad.addColorStop(1, "rgba(255,200,150,0)");
		ctx.fillStyle = grad;
		ctx.fillRect(x - r, y - r, r * 2, r * 2);
	}
}

function drawCrystalline(ctx, W, H, base, rng) {
	// Dark reflective base
	ctx.fillStyle = rgbCss(shadeRgb(base, -0.3));
	ctx.fillRect(0, 0, W, H);

	// Polygonal crystal faces
	const crystals = 25 + Math.floor(rng() * 15);
	for (let i = 0; i < crystals; i++) {
		const x = rng() * W, y = rng() * H;
		const size = 8 + rng() * 25;
		const sides = 3 + Math.floor(rng() * 3);
		const bright = shadeRgb(base, 0.3 + rng() * 0.5);
		ctx.fillStyle = `rgba(${bright.r},${bright.g},${bright.b},${0.2 + rng() * 0.4})`;
		ctx.strokeStyle = `rgba(${bright.r},${bright.g},${bright.b},${0.3 + rng() * 0.4})`;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let j = 0; j < sides; j++) {
			const a = (j / sides) * Math.PI * 2 + rng() * 0.3;
			const px = x + Math.cos(a) * size;
			const py = y + Math.sin(a) * size;
			if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
		}
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
	}
}

function drawBlotch(ctx, x, y, r, rgb, alpha) {
	const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
	grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`);
	grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
	ctx.fillStyle = grad;
	ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function rgbCss({ r, g, b }) {
	return `rgb(${r},${g},${b})`;
}

// ── Public API ───────────────────────────────────────────────────

export function getStyle(objectId) {
	return lsGet(objectId);
}

export function setStyle(objectId, style) {
	lsSet(objectId, style);
}

export function clearStyle(objectId) {
	lsClear(objectId);
}

/** Apply any stored style to a mesh right after creation. */
export function applyStoredStyle(mesh) {
	const id = mesh?.userData?.id;
	if (!id) return;
	const style = getStyle(id);
	if (style) applyStyle(mesh, style);
}

/** Scan text for a planet-style JSON block and return it. */
export function parseStyleFromText(text) {
	if (!text) return null;
	// Look for fenced JSON blocks
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1].trim());
			if (isValidStyle(parsed)) return parsed;
		} catch { /* not JSON */ }
	}
	// Look for inline JSON object
	const inlineMatch = text.match(/\{\s*"(color|surfaceType|emissive)/);
	if (inlineMatch) {
		// Try to find a complete JSON object
		const start = text.indexOf("{");
		if (start >= 0) {
			let depth = 0;
			for (let i = start; i < text.length; i++) {
				if (text[i] === "{") depth++;
				else if (text[i] === "}") depth--;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(text.slice(start, i + 1));
						if (isValidStyle(parsed)) return parsed;
					} catch { break; }
				}
			}
		}
	}
	return null;
}

function isValidStyle(obj) {
	if (!obj || typeof obj !== "object") return false;
	const validKeys = ["color", "emissive", "emissiveIntensity", "metalness", "roughness", "surfaceType", "features"];
	return validKeys.some((k) => obj[k] !== undefined);
}
