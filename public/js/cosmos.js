/**
 * Cosmos view: every object in the glon environment as a ball, with
 * activity "heat" mapped onto emissive intensity, halo opacity, and a
 * subtle scale pulse.
 *
 * Layout: one ring per type (agent at center, peers/programs/files in
 * outward orbits). Members are placed at deterministic angles around
 * each ring with a small id-seeded jitter on y, so reloads produce a
 * stable scene.
 *
 * Heat: each ball remembers `lastSeen`. The frontend bumps it on every
 * SSE event for that object id, and we initialize from `obj.updatedAt`.
 * Per frame, `heat = exp(-(now - lastSeen) / HEAT_TAU_MS)` drives a
 * brightness boost, halo opacity, and a small breathing pulse so live
 * activity is obvious without rebuilding any geometry.
 *
 * Tubes between objects are rebuilt each frame so they track the float
 * + magnet-displaced ball positions exactly.
 */

	import * as THREE from "three";
	import { colorForType } from "./colors.js";
	import { applyStoredStyle } from "./planet-styles.js";


// \u2500\u2500 Procedural planet textures \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// One canvas-baked surface per typeKey (cached on first use). The pattern
// is a deterministic stack of soft radial blotches whose lightness varies
// around the type's base hue, so every "agent" world looks like a sibling
// of every other agent world but distinct from a "program" world. Cheap
// (~60 fillRect calls per type, ~10 types in practice) and zero network
// fetches \u2014 no texture assets to ship.
const planetTextureCache = new Map();
function planetTextureFor(typeKey, hex) {
	const cached = planetTextureCache.get(typeKey);
	if (cached) return cached;
	const W = 256, H = 128;
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d");

	// Stable seeded RNG from typeKey: same type \u2192 same surface every run.
	let s = 0x9e3779b9;
	for (let i = 0; i < typeKey.length; i++) s = (s * 31 + typeKey.charCodeAt(i)) | 0;
	s = s >>> 0;
	const rng = () => {
		s = Math.imul(s ^ (s >>> 16), 2246822507);
		s = Math.imul(s ^ (s >>> 13), 3266489909);
		s = (s ^ (s >>> 16)) >>> 0;
		return s / 4294967296;
	};

	// Base fill so seams between blotches stay on-hue.
	ctx.fillStyle = hex;
	ctx.fillRect(0, 0, W, H);

	// 60-100 soft radial blotches with mixed dark/light lobes give a
	// believable "cloud and continent" pattern across the equirectangular
	// projection. Wrapping is handled by drawing every blotch twice when it
	// crosses the seam, so the texture tiles seamlessly along longitude.
	const base = parseHex(hex);
	const patches = 60 + Math.floor(rng() * 40);
	for (let i = 0; i < patches; i++) {
		const x = rng() * W;
		const y = rng() * H;
		const r = 6 + rng() * 50;
		const dark = rng() < 0.55;
		const k = dark ? -(0.25 + rng() * 0.45) : (0.15 + rng() * 0.4);
		const tinted = shadeRgb(base, k);
		const alpha = 0.18 + rng() * 0.5;
		drawBlotch(ctx, x, y, r, tinted, alpha);
		if (x - r < 0)     drawBlotch(ctx, x + W, y, r, tinted, alpha);
		if (x + r > W) drawBlotch(ctx, x - W, y, r, tinted, alpha);
	}

	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = THREE.RepeatWrapping;
	tex.anisotropy = 4;
	planetTextureCache.set(typeKey, tex);
	return tex;
}

function drawBlotch(ctx, x, y, r, rgb, alpha) {
	const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
	grad.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`);
	grad.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
	ctx.fillStyle = grad;
	ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function parseHex(hex) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return { r: 128, g: 128, b: 128 };
	const n = parseInt(m[1], 16);
	return { r: (n >>> 16) & 0xff, g: (n >>> 8) & 0xff, b: n & 0xff };
}

// Linear shade. k > 0 mixes toward white; k < 0 mixes toward black.
function shadeRgb({ r, g, b }, k) {
	if (k >= 0) {
		return {
			r: Math.round(r + (255 - r) * k),
			g: Math.round(g + (255 - g) * k),
			b: Math.round(b + (255 - b) * k),
		};
	}
	const f = 1 + k;
	return { r: Math.round(r * f), g: Math.round(g * f), b: Math.round(b * f) };
}

// ── Layout rules ─────────────────────────────────────────────────

// radius, y-offset, node scale, importance (bigger = featured)
const TYPE_LAYOUT = {
	agent:      { radius: 0,  y: 0,    scale: 2.4, featured: true },
	peer:       { radius: 5,  y: 0.5,  scale: 1.0 },
	chat:       { radius: 7, y: -0.5, scale: 0.8 },
	ttt:        { radius: 8, y: 0.8,  scale: 0.7 },
	account:    { radius: 9, y: -0.8, scale: 0.7 },
	pinned_fact: { radius: 10, y: -1.0, scale: 0.65 },
	reminder:    { radius: 11, y: 0.6,  scale: 0.65 },
	type:        { radius: 12, y: -0.3, scale: 0.65 },
	milestone:   { radius: 13, y: 1.0,  scale: 0.7 },
	"chain.token": { radius: 14, y: 0.5, scale: 0.9 },
	"chain.coin.bucket": { radius: 15, y: 0.3, scale: 0.9 },
	"chain.coin.offer": { radius: 16, y: -0.3, scale: 0.9 },
	program:    { radius: 22, y: 1.5,  scale: 0.5 },
	typescript: { radius: 28, y: 0,    scale: 0.45 },
	javascript: { radius: 30, y: 0,    scale: 0.45 },
	json:       { radius: 32, y: -2.0, scale: 0.45 },
	source:     { radius: 34, y: 0,    scale: 0.45 },
	proto:      { radius: 36, y: 2.0,  scale: 0.45 },
	"chain.anchor": { radius: 55, y: 0, scale: 0.3 },
	unknown:    { radius: 60, y: 0,    scale: 0.3 },
};

function layoutForType(typeKey) {
	return TYPE_LAYOUT[typeKey] ?? { radius: 60, y: 0, scale: 0.3 };
}

// Deterministic angle permutation so items of the same type don't
// all end up bunched together from a fixed starting point.
function angleFor(index, count, typeKey) {
	if (count === 0) return 0;
	// Offset by a stable hash of typeKey so different rings are out of phase.
	let h = 0;
	for (let i = 0; i < typeKey.length; i++) h = (h * 31 + typeKey.charCodeAt(i)) | 0;
	const phase = ((h % 1000) / 1000) * Math.PI * 2;
	return phase + (index / count) * Math.PI * 2;
}
// Slight deterministic jitter so objects on the same ring don't line
// up on perfectly flat y planes when seen from a side angle.
function jitterY(id) {
	return (hash01(id) - 0.5) * 1.6;
}

// Small radial jitter so objects on the same ring don't all sit on
// the exact same circle — creates a fuzzy orbital band instead of a
// hard line, which visually spreads dense rings.
function jitterR(id, radius) {
	return radius * (0.88 + hash01(id + "rad") * 0.24);
}

// 0..1 stable hash from a string id; used for orbital phase, bobbing,
// and twinkle so each ball drifts independently between reloads.
function hash01(id) {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return (h >>> 0) % 1000 / 1000;
}

// Per-axis float frequencies (rad/s) and amplitudes (world units).
// Tuned so balls drift visibly but never wander far enough to break
// the ring layout — picking and labels stay legible.
const FLOAT_FREQ_RANGE = [0.25, 0.75];
const FLOAT_AMP_RANGE  = [0.09, 0.28];
function floatAmp(id, axis) {
	const [lo, hi] = FLOAT_AMP_RANGE;
	return lo + hash01(id + "a" + axis) * (hi - lo);
}
function floatFreq(id, axis) {
	const [lo, hi] = FLOAT_FREQ_RANGE;
	return lo + hash01(id + "f" + axis) * (hi - lo);
}

// Cursor-as-magnet tunables. The cursor's world ray pulls nearby balls
// toward it so small targets are easier to click. Pull strength falls
// off linearly to zero at MAGNET_RADIUS so distant balls stay put.
const MAGNET_RADIUS = 2.5;
const MAGNET_PULL   = 0.55;
const MAGNET_LERP   = 0.20;
const SNAP_RADIUS   = 0.8;    // within this distance, ball snaps to cursor

// Heat tunables: how fast a touched ball cools, how strongly heat shows.
// HEAT_TAU_MS is the e-folding time: a ball touched 30s ago is at ~37%.
const HEAT_TAU_MS         = 30_000;
const HEAT_EMISSIVE_BOOST = 1.4;   // added to baseEmissive at heat=1
const HEAT_HALO_BOOST     = 0.35;  // added to halo opacity at heat=1
const HEAT_SCALE_AMP      = 0.16;  // scale multiplier at heat=1, peak of pulse
const HEAT_PULSE_FREQ     = 6.0;   // rad/s; faster than float to read as 'alive'

// Context-active tunables: persistent visual lift for balls referenced by
// any in-context block of the agent. Stacks on top of heat.
const CONTEXT_BOOST  = 0.55;       // emissive boost added at rest when in-context
const CONTEXT_HALO   = 0.32;       // halo opacity added when in-context
const CONTEXT_SCALE  = 1.18;
const SELECT_BOOST   = 3.2;        // emissive intensity boost when selected

// Push-out tunables: when a ball intersects a highlight halo (selection or
// in-context), it slides outward along the radial axis until its surface
// just touches the halo. PUSH_LERP smooths the slide so balls never pop;
// PUSH_PADDING bakes in a small visible gap on top of the geometric clear-
// point so balls don't look like they're scraping the halo.
const PUSH_LERP    = 0.20;
const PUSH_PADDING = 0.15;

// Build a dashed equator ring as a LineLoop on a LineDashedMaterial. The
// loop's continuous polyline lets line-distance accumulate around the full
// circle so the dash pattern reads cleanly. computeLineDistances() runs
// once at unit radius; subsequent scaling of the group preserves the dash
// count (both lineDistance and dashSize live in geometry space).
//
// Returns `{ group, material }` so the per-frame tick can lerp opacity on
// the shared material with a single assignment.
function makeDashedRing({ color, dashSize, gapSize }) {
	const SEG = 96;
	const material = new THREE.LineDashedMaterial({
		color,
		transparent: true,
		opacity: 0,
		dashSize,
		gapSize,
		depthWrite: false,
	});
	const group = new THREE.Group();

	const pos = new Float32Array(SEG * 3);
	for (let j = 0; j < SEG; j++) {
		const t = (j / SEG) * Math.PI * 2;
		pos[j * 3]     = Math.cos(t);
		pos[j * 3 + 1] = 0;
		pos[j * 3 + 2] = Math.sin(t);
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
	const ring = new THREE.LineLoop(geom, material);
	ring.computeLineDistances();
	group.add(ring);

	return { group, material };
}

// ── Scene construction ───────────────────────────────────────────

export function buildCosmos(state, materials) {
	const group = new THREE.Group();
	group.name = "cosmos";

	const byType = new Map();
	for (const obj of state.objects) {
		const arr = byType.get(obj.typeKey) ?? [];
		arr.push(obj);
		byType.set(obj.typeKey, arr);
	}

	// Map object id → orbit-parent id from link relations.
	// spawn_parent (agent subagents) takes priority; owner and token links
	// create secondary orbital clusters. Objects orbit their parent like
	// moons rather than sitting on the global type ring.
	const orbitParentOf = new Map();
	for (const link of state.links) {
		if (link.relationKey === "spawn_parent") orbitParentOf.set(link.sourceId, link.targetId);
	}
	for (const link of state.links) {
		if (link.relationKey === "owner" && !orbitParentOf.has(link.sourceId)) {
			orbitParentOf.set(link.sourceId, link.targetId);
		}
	}
	for (const link of state.links) {
		if (link.relationKey === "token" && !orbitParentOf.has(link.sourceId)) {
			orbitParentOf.set(link.sourceId, link.targetId);
		}
	}
	// Precompute siblings for every parent so orbit positioning is stable.
	const orbitChildren = new Map(); // parentId → [childId, ...]
	for (const [childId, parentId] of orbitParentOf) {
		const bucket = orbitChildren.get(parentId) ?? [];
		bucket.push(childId);
		orbitChildren.set(parentId, bucket);
	}
	for (const bucket of orbitChildren.values()) bucket.sort();
	const spawnDepthOf = (obj) => Number(obj.scalars?.spawn_depth ?? 0);

	const positions = new Map(); // id → THREE.Vector3
	const nodes = new Map();     // id → { mesh, ring, halo? }

	const orbits = new Map();   // id → { baseX, baseY, baseZ, ampX/Y/Z, freqX/Y/Z, phaseX/Y/Z }

	// Nodes --------------------------------------------------------
	for (const [typeKey, list] of byType) {
		const { radius, y, scale, featured } = layoutForType(typeKey);
		const { color, hex } = colorForType(typeKey);
		const surface = planetTextureFor(typeKey, hex);

		// Deterministic ordering. Agents are sorted by spawn_depth first so
		// every primary lands before its subagents \u2014 the subagent placement
		// reads positions.get(parent) and would otherwise miss the parent.
		const sorted = typeKey === "agent"
			? [...list].sort((a, b) => spawnDepthOf(a) - spawnDepthOf(b) || a.id.localeCompare(b.id))
			: [...list].sort((a, b) => a.id.localeCompare(b.id));
		const floatScale = radius < 1 ? 0.4 : 1.0; // central anchor drifts less

		// Pre-compute primary-agent count + index for ring-distribution when
		// the user has more than one top-level agent in their store.
		const primaryCount = typeKey === "agent"
			? sorted.filter((o) => !orbitParentOf.has(o.id)).length
			: 0;

		for (let i = 0; i < sorted.length; i++) {
			const obj = sorted[i];
			let pos;
			let placementScale = 1.0;
			let isFeatured = !!featured;
			if (orbitParentOf.has(obj.id) && positions.has(orbitParentOf.get(obj.id))) {
				// Satellite: orbit around the parent. Multiple siblings fan
				// around the parent on a deterministic ring (XZ plane), each
				// level out adds a touch of radius so deeper chains don't pile.
				const parentId = orbitParentOf.get(obj.id);
				const parentPos = positions.get(parentId);
				const siblings = orbitChildren.get(parentId) ?? [];
				const sIdx = siblings.indexOf(obj.id);
				const sCount = siblings.length;
				const depth = (typeKey === "agent" ? Math.max(1, spawnDepthOf(obj)) : 1);
				const parentOrbit = orbits.get(parentId);
				const parentHaloR = parentOrbit?.haloScale ?? 4;
				const orbitR = parentHaloR + 1.5 + (depth - 1) * 1.5;
				const theta = angleFor(sIdx, sCount, "sub" + parentId);
				pos = new THREE.Vector3(
					parentPos.x + Math.cos(theta) * orbitR,
					parentPos.y + jitterY(obj.id) * 0.4,
					parentPos.z + Math.sin(theta) * orbitR,
				);
				placementScale = 0.45;          // moon-sized next to the parent star
				isFeatured = false;             // planet-style (low emissive, no big halo)
			} else {
				// Primary placement on the type's ring. For 'agent' this is r=0
				// unless multiple primaries exist, in which case spread them on a
				// tiny inner ring so they don't stack.
				const primaryIdx = typeKey === "agent"
					? sorted.filter((o) => !orbitParentOf.has(o.id)).findIndex((o) => o.id === obj.id)
					: i;
				const ringCount = typeKey === "agent" ? primaryCount : sorted.length;
				const ringRadius = typeKey === "agent" && primaryCount > 1 ? 2 : radius;
				const theta0 = angleFor(primaryIdx, ringCount, typeKey);
				const yJitter = jitterY(obj.id);
				const baseY = y + yJitter;
				pos = new THREE.Vector3(
					Math.cos(theta0) * jitterR(obj.id, ringRadius),
					baseY,
					Math.sin(theta0) * jitterR(obj.id, ringRadius),
				);
			}
			// Log-scaled size by change count (floor at 0.5, gentler growth).
			const changeScale = Math.max(0.5, Math.min(1.6, Math.log10(1 + obj.changeCount) * 0.5 + 0.6));
			const r = scale * placementScale * changeScale * 0.6;
			let baseEmissive;
			let mat;
			if (isFeatured) {
				// Graice (the agent star) is a self-luminous body. Material has
				// no diffuse \u2014 it doesn't reflect, it emits \u2014 and the procedural
				// surface drives the emissive map so blotches read as plasma
				// cells. Tone mapping is bypassed so the emissive value stays
				// above the bloom threshold even after ACES rolls highlights off.
				baseEmissive = 1.4;
				mat = new THREE.MeshStandardMaterial({
					color: 0x000000,
					emissive: 0xc8ffe6,        // teal-tinted white \u2014 brand glow
					emissiveMap: surface,
					emissiveIntensity: baseEmissive,
					toneMapped: false,
				});
			} else {
				// Everything else is a planet: reflective surface, almost no self-
				// glow at rest, lit by Graice's PointLight from the origin.
				// Slightly raised metalness + lowered roughness so nearby PointLights
				// (e.g. the selection follow-light) create visible specular highlights.
				baseEmissive = 0.05;
				mat = new THREE.MeshStandardMaterial({
					// White color so the procedural texture's tones come through pure;
					// emissive still uses the type color so heat bumps tint the world.
					color: 0xffffff,
					map: surface,
					emissive: color,
					emissiveIntensity: baseEmissive,
					metalness: 0.12,
					roughness: 0.72,
				});
			}
			const mesh = new THREE.Mesh(materials.sphere, mat);
			mesh.position.copy(pos);
			mesh.scale.setScalar(r);
			mesh.userData = { kind: "object", id: obj.id, typeKey, obj };
			applyStoredStyle(mesh);
			group.add(mesh);

			// Every ball gets one indicator halo — a dashed equator ring.
			// Opacity in tick sums three contributions:
			//   - featured base (Graice's persistent "working ring")
			//   - context-active boost (ball is in the agent's live context)
			//   - heat boost (transient flash on a recent change)
			// Heat-only balls remain invisible at rest because all three terms
			// are zero unless something happens.
			const baseHaloOpacity = isFeatured ? 0.32 : 0.0;
			const haloScale = isFeatured ? r * 3.2 : r * 2.1;
			const { group: halo, material: haloMat } = makeDashedRing({
				color,
				dashSize: 0.10,
				gapSize:  0.06,
			});
			halo.position.copy(pos);
			halo.scale.setScalar(haloScale);
			halo.userData = { kind: "halo", id: obj.id };
			group.add(halo);


			positions.set(obj.id, pos);
			nodes.set(obj.id, { mesh, halo, haloMat });
			orbits.set(obj.id, {
				baseX: pos.x,
				baseY: pos.y,
				baseZ: pos.z,
				ampX: floatAmp(obj.id, "x") * floatScale,
				ampY: floatAmp(obj.id, "y") * floatScale,
				ampZ: floatAmp(obj.id, "z") * floatScale,
				freqX: floatFreq(obj.id, "x"),
				freqY: floatFreq(obj.id, "y"),
				freqZ: floatFreq(obj.id, "z"),
				phaseX: hash01(obj.id + "px") * Math.PI * 2,
				phaseY: hash01(obj.id + "py") * Math.PI * 2,
				phaseZ: hash01(obj.id + "pz") * Math.PI * 2,
				// Magnet offset (smoothly tweened toward the cursor target each frame).
				magnetX: 0,
				magnetY: 0,
				magnetZ: 0,
				// Push-out offset (smoothly tweened to clear any intersecting
				// highlight halo). Zero unless this ball overlaps the selection
				// or context halo of another ball.
				pushX: 0,
				pushY: 0,
				pushZ: 0,
				colPushX: 0,
				colPushY: 0,
				colPushZ: 0,
				// Featured balls (the agent) shouldn't drift toward the cursor;
				// the world is built around them as a stable anchor.
				canMagnet: !isFeatured,
				// Heat state: lastSeen seeds emissive/halo/scale boost; bumped
				// from the SSE stream and decayed each frame.
				lastSeen: obj.updatedAt || 0,
				baseEmissive,
				baseRadius: r,
				baseHaloOpacity,
				pulsePhase: hash01(obj.id + "hp") * Math.PI * 2,
				haloScale,
				// Slow self-rotation so the surface texture reads as a spinning
				// world. Featured (the agent) spins slower so it stays a stable
				// focal point. tilt mimics the axial tilt of the planet.
				spinRate: (isFeatured ? 0.05 : 0.15) + hash01(obj.id + "sr") * 0.18,
				spinPhase: hash01(obj.id + "sp") * Math.PI * 2,
				tilt: (hash01(obj.id + "tl") - 0.5) * 0.6,
				// Original halo color so we can restore it after a selection clears.
				haloColor: color.clone(),
				contextActive: false,
			});
		}
	}
	// Second pass: any object whose parent was placed in a later type group
	// gets promoted from its type ring into orbit around the now-known parent.
	for (const [childId, parentId] of orbitParentOf) {
		const node = nodes.get(childId);
		if (!node || !positions.has(parentId)) continue;
		const o = orbits.get(childId);
		const parentPos = positions.get(parentId);
		const siblings = orbitChildren.get(parentId) ?? [];
		const sIdx = siblings.indexOf(childId);
		const sCount = siblings.length;
		const depth = 1;
		const parentOrbit = orbits.get(parentId);
		const parentHaloR = parentOrbit?.haloScale ?? 4;
		const orbitR = parentHaloR + 1.5 + (depth - 1) * 1.5;
		const theta = angleFor(sIdx, sCount, "sub" + parentId);
		const newPos = new THREE.Vector3(
			parentPos.x + Math.cos(theta) * orbitR,
			parentPos.y + jitterY(childId) * 0.4,
			parentPos.z + Math.sin(theta) * orbitR,
		);
		node.mesh.position.copy(newPos);
		node.halo.position.copy(newPos);
		positions.get(childId).copy(newPos);
		o.baseX = newPos.x;
		o.baseY = newPos.y;
		o.baseZ = newPos.z;
	}



	// Links --------------------------------------------------------
	const linkMeshes = [];
	const LINK_STYLE = {
		spawn_parent:  { color: "#ffc857", opacity: 0.85, width: 0.075 },
		owner:         { color: "#60a5fa", opacity: 0.7,  width: 0.05 },
		token:         { color: "#4ade80", opacity: 0.7,  width: 0.05 },
		principal:     { color: "#f472b6", opacity: 0.6,  width: 0.04 },
		target:        { color: "#a78bfa", opacity: 0.5,  width: 0.035 },
		context_source:{ color: "#94a3b8", opacity: 0.4,  width: 0.03 },
	};
	const DEFAULT_LINK_STYLE = { color: "#5eead4", opacity: 0.5, width: 0.035 };
	for (const link of state.links) {
		const a = positions.get(link.sourceId);
		const b = positions.get(link.targetId);
		if (!a || !b) continue;

		const style = LINK_STYLE[link.relationKey] ?? DEFAULT_LINK_STYLE;
		const isLineage = link.relationKey === "spawn_parent";

		const mid = a.clone().add(b).multiplyScalar(0.5);
		const lift = Math.max(1, a.distanceTo(b) * (isLineage ? 0.32 : 0.2));
		const outward = mid.clone().normalize().multiplyScalar(lift * 0.3);
		mid.add(new THREE.Vector3(0, lift, 0)).add(outward);

		const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
		const geom = new THREE.TubeGeometry(curve, 48, style.width, 6, false);
		const mat = new THREE.MeshBasicMaterial({
			color: new THREE.Color(style.color),
			transparent: true,
			opacity: style.opacity,
		});
		const mesh = new THREE.Mesh(geom, mat);
		mesh.userData = { kind: "link", link, isLineage, linkWidth: style.width };
		group.add(mesh);
		linkMeshes.push(mesh);
	}

	// Selection indicator: the selected ball gets a strong emissive boost
	// (SELECT_BOOST) so it glows brightly. A PointLight follows it so nearby
	// planets pick up real specular reflections. The halo keeps its type color
	// and only shows context/heat state.
	const selectLight = new THREE.PointLight(0xffffff, 0, 18, 2.0);
	selectLight.visible = false;
	group.add(selectLight);
	let _lastLightPos = new THREE.Vector3();
	let selectedId = null;

	// ── Per-frame float + tube re-anchoring ────────────────────
	// Every ball drifts independently on x/y/z via id-seeded sin waves;
	// no global rotation. Tube geometries follow the moving endpoints.
	const tmpA = new THREE.Vector3();
	const tmpB = new THREE.Vector3();
	const tmpMid = new THREE.Vector3();
	const tmpOut = new THREE.Vector3();
	const tmpBase = new THREE.Vector3();
	const tmpClosest = new THREE.Vector3();
	const yAxis = new THREE.Vector3(0, 1, 0);
	// Reused per-frame buffer for highlight spheres. Cleared and refilled in
	// phase 2 of tick() so the GC has nothing to do.
	const highlightBuf = [];

	// Bump heat for an object id (called from the SSE event handler in main.js).
	// `ts` defaults to now; pass an earlier value to seed historical activity.
	function bumpHeat(id, ts) {
		const o = orbits.get(id);
		if (!o) return;
		o.lastSeen = ts ?? Date.now();
	}

	// Toggle the in-context state on every ball given the agent's current
	// referenced-objects set. Applied each frame via the orbit map; balls
	// not in the set decay to their resting halo/emissive.
	function setContextActive(idSet) {
		for (const [id, o] of orbits) {
			o.contextActive = idSet.has(id);
		}
	}

	// Drive the selection glow + follow-light to the currently-selected ball.
	// Pass null to clear it.
	function setSelected(id) {
		selectedId = id ?? null;
		if (selectedId) {
			const node = nodes.get(selectedId);
			if (node) {
				const { color } = colorForType(node.mesh.userData.typeKey);
				selectLight.color.set(color);
				selectLight.intensity = 3.5;
				selectLight.visible = true;
			}
		} else {
			selectLight.visible = false;
			selectLight.intensity = 0;
		}
	}

	function tick(elapsedSec, cursorRay) {
		const now = Date.now();

		// Phase 1 — float + cursor-magnet, stored as `_floatX/Y/Z` so phase 2
		// can read every ball's tentative position before any push runs.
		let snappedId = null;
		let snapClosest = null;
		let snapMinD = Infinity;
		if (cursorRay) {
			for (const [id, o] of orbits) {
				if (!o.canMagnet) continue;
				const node = nodes.get(id);
				if (!node || !node.mesh.visible) continue;
				const fx = o.baseX + Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
				const fy = o.baseY + Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
				const fz = o.baseZ + Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
				tmpBase.set(fx, fy, fz);
				cursorRay.closestPointToPoint(tmpBase, tmpClosest);
				const d = tmpBase.distanceTo(tmpClosest);
				if (d < snapMinD) {
					snapMinD = d;
					snapClosest = tmpClosest.clone();
					snappedId = id;
				}
			}
			if (snapMinD > SNAP_RADIUS) snappedId = null;
		}
		for (const [id, o] of orbits) {
			const node = nodes.get(id);
			if (!node) continue;
			const fx = o.baseX + Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
			const fy = o.baseY + Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
			const fz = o.baseZ + Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
			let tgtX = 0, tgtY = 0, tgtZ = 0;
		if (cursorRay && o.canMagnet && node.mesh.visible) {
			if (id === snappedId && snapClosest) {
				// Snap candidate: aim for the cursor position with full strength
				// but still lerp so the approach stays smooth.
				tgtX = snapClosest.x - fx;
				tgtY = snapClosest.y - fy;
				tgtZ = snapClosest.z - fz;
				o.magnetX += (tgtX - o.magnetX) * MAGNET_LERP;
				o.magnetY += (tgtY - o.magnetY) * MAGNET_LERP;
				o.magnetZ += (tgtZ - o.magnetZ) * MAGNET_LERP;
			} else if (!snappedId) {
				// No snap candidate — regular magnet pull
				tmpBase.set(fx, fy, fz);
				cursorRay.closestPointToPoint(tmpBase, tmpClosest);
				const d = tmpBase.distanceTo(tmpClosest);
				if (d < MAGNET_RADIUS) {
					const k = MAGNET_PULL * (1 - d / MAGNET_RADIUS);
					tgtX = (tmpClosest.x - fx) * k;
					tgtY = (tmpClosest.y - fy) * k;
					tgtZ = (tmpClosest.z - fz) * k;
				}
				o.magnetX += (tgtX - o.magnetX) * MAGNET_LERP;
				o.magnetY += (tgtY - o.magnetY) * MAGNET_LERP;
				o.magnetZ += (tgtZ - o.magnetZ) * MAGNET_LERP;
			} else {
				// Another ball is snapped — lose magnetism and hover back
				o.magnetX += (0 - o.magnetX) * MAGNET_LERP;
				o.magnetY += (0 - o.magnetY) * MAGNET_LERP;
				o.magnetZ += (0 - o.magnetZ) * MAGNET_LERP;
			}
		} else {
			// No cursor or can't magnet — drift back
			o.magnetX += (0 - o.magnetX) * MAGNET_LERP;
			o.magnetY += (0 - o.magnetY) * MAGNET_LERP;
			o.magnetZ += (0 - o.magnetZ) * MAGNET_LERP;
		}
			o._floatX = fx + o.magnetX;
			o._floatY = fy + o.magnetY;
			o._floatZ = fz + o.magnetZ;
		}

		// Phase 2 \u2014 collect highlight spheres (selection halo + every
		// in-context ball's halo). These are the volumes that should clear
		// other balls. Heat halos are intentionally excluded \u2014 they're a
		// transient activity flicker, not a sticky highlight.
		highlightBuf.length = 0;
		// Per ball, take the LARGEST visible halo as that ball's push source.
		// Three radii contribute and any ball can have all three at once:
		//   - selection halo (white, only for the currently-selected ball)
		//   - in-context halo (the persistent ring on context-active balls)
		//   - featured base halo (the agent's "working sphere" \u2014 always lit
		//     for any ball with baseHaloOpacity>0, regardless of context state)
		// Heat halos are intentionally excluded: they're a transient flicker
		// rather than a sticky highlight, so they don't push.
		for (const [id, o] of orbits) {
			let radius = 0;
			if (o.contextActive)       radius = Math.max(radius, o.haloScale * CONTEXT_SCALE);
			if (o.baseHaloOpacity > 0) radius = Math.max(radius, o.haloScale);
			// Receiver-side outer extent: when this ball is itself a highlight
			// source, its halo (not its ball) is what should clear other halos.
			o._outerRadius = Math.max(o.baseRadius, radius);
			if (radius <= 0) continue;
			highlightBuf.push({
				x: o._floatX, y: o._floatY, z: o._floatZ,
				radius,
				sourceId: id,
			});
		}

		// Phase 2.5 — ball-ball collision repulsion.
		// Only visible balls participate; hidden/muted ones are ignored.
		const colBalls = [];
		for (const [id, o] of orbits) {
			const node = nodes.get(id);
			if (!node || !node.mesh.visible) continue;
			colBalls.push({ id, o, r: o.baseRadius });
		}
		const COL_PADDING = 0.15;
		// Spatial hash: bucket objects by their (integer) float position.
		// Cell size = 3 units; only check same and adjacent cells.
		const cellSize = 3;
		const grid = new Map();
		for (const b of colBalls) {
			const cx = Math.floor(b.o._floatX / cellSize);
			const cy = Math.floor(b.o._floatY / cellSize);
			const cz = Math.floor(b.o._floatZ / cellSize);
			const key = `${cx},${cy},${cz}`;
			if (!grid.has(key)) grid.set(key, []);
			grid.get(key).push(b);
		}
		for (const [key, cell] of grid) {
			const [cx, cy, cz] = key.split(",").map(Number);
			const neighbors = [];
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (let dz = -1; dz <= 1; dz++) {
						const nkey = `${cx+dx},${cy+dy},${cz+dz}`;
						if (grid.has(nkey)) neighbors.push(...grid.get(nkey));
					}
				}
			}
			for (let i = 0; i < cell.length; i++) {
				const a = cell[i];
				const oa = a.o;
				for (let j = 0; j < neighbors.length; j++) {
					const b = neighbors[j];
					if (a.id >= b.id) continue;
					const ob = b.o;
					const ddx = oa._floatX - ob._floatX;
					const ddy = oa._floatY - ob._floatY;
					const ddz = oa._floatZ - ob._floatZ;
					const dSq = ddx * ddx + ddy * ddy + ddz * ddz;
					const minD = a.r + b.r + COL_PADDING;
					if (dSq >= minD * minD || dSq < 1e-6) continue;
					const d = Math.sqrt(dSq);
					const overlap = minD - d;
					const inv = 1 / d;
					const fx = ddx * inv * overlap * 0.5;
					const fy = ddy * inv * overlap * 0.5;
					const fz = ddz * inv * overlap * 0.5;
					oa._colPushX = (oa._colPushX || 0) + fx;
					oa._colPushY = (oa._colPushY || 0) + fy;
					oa._colPushZ = (oa._colPushZ || 0) + fz;
					ob._colPushX = (ob._colPushX || 0) - fx;
					ob._colPushY = (ob._colPushY || 0) - fy;
					ob._colPushZ = (ob._colPushZ || 0) - fz;
				}
			}
		}

		// Phase 3 \u2014 compute push offset against every highlight, smooth, and
		// commit the final position + spin + heat/emissive/halo state.
		for (const [id, o] of orbits) {
			const node = nodes.get(id);
			if (!node) continue;
			let pushTgtX = o._colPushX || 0;
			let pushTgtY = o._colPushY || 0;
			let pushTgtZ = o._colPushZ || 0;
			o._colPushX = o._colPushY = o._colPushZ = 0;
			// Featured balls (the agent stars) are anchored: their float position
			// is the world's reference frame, so we never push them. Other balls
			// glide around them. The pushTgt accumulator starts from collision
			// repulsion; any previous push from a transient highlight smoothly
			// relaxes back to 0.
			if (o.canMagnet) for (const h of highlightBuf) {
				if (h.sourceId === id) continue;
				const dx = o._floatX - h.x;
				const dy = o._floatY - h.y;
				const dz = o._floatZ - h.z;
				const dSq = dx * dx + dy * dy + dz * dz;
				// Clear point: receiver's outer extent just outside the source's
				// halo, with a small visual padding so the meeting line never
				// reads as a graze. Using _outerRadius (rather than baseRadius)
				// is what makes halo-vs-halo (not just ball-vs-halo) clear.
				const clearD = h.radius + o._outerRadius + PUSH_PADDING;
				if (dSq >= clearD * clearD || dSq < 1e-6) continue;
				const d = Math.sqrt(dSq);
				const overlap = clearD - d;
				const inv = 1 / d;
				pushTgtX += dx * inv * overlap;
				pushTgtY += dy * inv * overlap;
				pushTgtZ += dz * inv * overlap;
			}
			o.pushX += (pushTgtX - o.pushX) * PUSH_LERP;
			o.pushY += (pushTgtY - o.pushY) * PUSH_LERP;
			o.pushZ += (pushTgtZ - o.pushZ) * PUSH_LERP;
			const x = o._floatX + o.pushX;
			const y = o._floatY + o.pushY;
			const z = o._floatZ + o.pushZ;
			node.mesh.position.set(x, y, z);
			positions.get(id).set(x, y, z);
			node.mesh.rotation.set(o.tilt, elapsedSec * o.spinRate + o.spinPhase, 0);
			const dt = now - o.lastSeen;
			const heat = o.lastSeen > 0 && dt < HEAT_TAU_MS * 6
				? Math.exp(-dt / HEAT_TAU_MS)
				: 0;
			const ctx = o.contextActive ? CONTEXT_BOOST : 0;
			const isSelected = id === selectedId;
			node.mesh.material.emissiveIntensity = o.baseEmissive + ctx + heat * HEAT_EMISSIVE_BOOST + (isSelected ? SELECT_BOOST : 0);
			const pulseScale = 1 + heat * HEAT_SCALE_AMP * Math.sin(elapsedSec * HEAT_PULSE_FREQ + o.pulsePhase);
			const ctxScale = o.contextActive ? CONTEXT_SCALE : 1;
			node.mesh.scale.setScalar(o.baseRadius * pulseScale * ctxScale);
			// Single dotted halo: featured base + context boost + heat sum into
			// the target opacity. Smooth-lerp so toggles fade rather than pop;
			// scale follows the same pulse + context multipliers as the ball.
			node.halo.position.set(x, y, z);
			node.halo.scale.setScalar(o.haloScale * pulseScale * ctxScale);
			// Halo opacity: base + context + heat only. Selection glow is on
			// the mesh emissive, not the halo color.
			const targetHaloOpacity =
				o.baseHaloOpacity +
				(o.contextActive ? CONTEXT_HALO : 0) +
				heat * HEAT_HALO_BOOST;
			const curHaloOpacity = node.haloMat.opacity;
			node.haloMat.opacity = curHaloOpacity + (targetHaloOpacity - curHaloOpacity) * 0.18;
			node.haloMat.color.copy(o.haloColor);
			node.haloMat.dashSize = 0.10;
		}
		// Move the selection follow-light to the selected ball's current position.
		// Only update when the ball has actually moved (> 0.05) to avoid
		// re-uploading light uniforms to all 600+ MeshStandardMaterials every frame.
		if (selectedId) {
			const selPos = positions.get(selectedId);
			if (selPos && selPos.distanceToSquared(_lastLightPos) > 0.0025) {
				selectLight.position.copy(selPos);
				_lastLightPos.copy(selPos);
			}
		}
		for (const m of linkMeshes) {
			const link = m.userData.link;
			const a = positions.get(link.sourceId);
			const b = positions.get(link.targetId);
			if (!a || !b) continue;
			tmpA.copy(a); tmpB.copy(b);
			tmpMid.copy(tmpA).add(tmpB).multiplyScalar(0.5);
			const lift = Math.max(1, tmpA.distanceTo(tmpB) * (m.userData.isLineage ? 0.32 : 0.2));
			if (tmpMid.lengthSq() > 1e-6) {
				tmpOut.copy(tmpMid).normalize().multiplyScalar(lift * 0.3);
				tmpMid.add(tmpOut);
			}
			tmpMid.addScaledVector(yAxis, lift);
			const curve = new THREE.QuadraticBezierCurve3(tmpA.clone(), tmpMid.clone(), tmpB.clone());
			const newGeom = new THREE.TubeGeometry(curve, 48, m.userData.linkWidth, 6, false);
			m.geometry.dispose();

			m.geometry = newGeom;
		}
	}

	return { group, nodes, positions, linkMeshes, tick, bumpHeat, setContextActive, setSelected };
}

