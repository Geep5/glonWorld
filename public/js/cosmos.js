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
	peer:       { radius: 9,  y: 0.5,  scale: 1.2 },
	chat:       { radius: 11, y: -0.5, scale: 1.0 },
	ttt:        { radius: 12, y: 0.8,  scale: 0.9 },
	account:    { radius: 12, y: -0.8, scale: 0.9 },
	pinned_fact: { radius: 13, y: -1.0, scale: 0.85 },
	reminder:    { radius: 14, y: 0.6,  scale: 0.8 },
	type:        { radius: 15, y: -0.3, scale: 0.8 },
	milestone:   { radius: 17, y: 1.0,  scale: 1.0 },
	program:    { radius: 20, y: 0,    scale: 1.0 },
	proto:      { radius: 30, y: 2.0,  scale: 0.9 },
	typescript: { radius: 30, y: 0,    scale: 0.65 },
	javascript: { radius: 30, y: 0,    scale: 0.65 },
	json:       { radius: 30, y: -2.0, scale: 0.7 },
	source:     { radius: 30, y: 0,    scale: 0.7 },
	unknown:    { radius: 36, y: 0,    scale: 0.7 },
};

function layoutForType(typeKey) {
	return TYPE_LAYOUT[typeKey] ?? { radius: 36, y: 0, scale: 0.7 };
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
const FLOAT_AMP_RANGE  = [0.18, 0.55];
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
const MAGNET_RADIUS = 4.5;     // world units around the cursor ray
const MAGNET_PULL   = 0.55;    // fraction of the gap to close at full strength
const MAGNET_LERP   = 0.20;    // smoothing per frame (also smooths back to rest)

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
const CONTEXT_SCALE  = 1.18;       // 18% larger when in-context

// Push-out tunables: when a ball intersects a highlight halo (selection or
// in-context), it slides outward along the radial axis until its surface
// just touches the halo. PUSH_LERP smooths the slide so balls never pop;
// PUSH_PADDING bakes in a small visible gap on top of the geometric clear-
// point so balls don't look like they're scraping the halo.
const PUSH_LERP    = 0.20;
const PUSH_PADDING = 0.15;

// Build a dashed-wireframe halo as a Group of LineLoops (latitude rings)
// and Lines (longitude meridians) sharing one LineDashedMaterial. Each
// great circle is its own continuous polyline so the line-distance
// attribute accumulates around the full circle \u2014 only that gives a clean
// dash pattern. computeLineDistances() runs once per polyline at unit
// radius; subsequent scaling of the group preserves the dash count per
// circle (both lineDistance and dashSize live in geometry space).
//
// Returns `{ group, material }` so the per-frame tick can lerp opacity on
// the shared material with a single assignment.
function makeDashedHalo({ lats, lons, color, dashSize, gapSize }) {
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

	// Latitude rings (closed \u2014 use LineLoop so the seam dash is correct).
	for (let i = 1; i < lats; i++) {
		const phi = (i / lats) * Math.PI;
		const r   = Math.sin(phi);
		const y   = Math.cos(phi);
		const pos = new Float32Array(SEG * 3);
		for (let j = 0; j < SEG; j++) {
			const t = (j / SEG) * Math.PI * 2;
			pos[j * 3]     = r * Math.cos(t);
			pos[j * 3 + 1] = y;
			pos[j * 3 + 2] = r * Math.sin(t);
		}
		const geom = new THREE.BufferGeometry();
		geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		const ring = new THREE.LineLoop(geom, material);
		ring.computeLineDistances();
		group.add(ring);
	}

	// Longitude meridians (open polylines pole to pole).
	for (let i = 0; i < lons; i++) {
		const theta = (i / lons) * Math.PI * 2;
		const pos = new Float32Array((SEG + 1) * 3);
		for (let j = 0; j <= SEG; j++) {
			const phi = (j / SEG) * Math.PI;
			pos[j * 3]     = Math.sin(phi) * Math.cos(theta);
			pos[j * 3 + 1] = Math.cos(phi);
			pos[j * 3 + 2] = Math.sin(phi) * Math.sin(theta);
		}
		const geom = new THREE.BufferGeometry();
		geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		const meridian = new THREE.Line(geom, material);
		meridian.computeLineDistances();
		group.add(meridian);
	}

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

	// Map child agent id \u2192 parent agent id, sourced from spawn_parent links.
	// Subagents orbit their parent like moons rather than colliding at the
	// agent ring (radius 0). Multi-level chains (subagent of a subagent) are
	// supported because we sort agents by depth ascending below, so a parent
	// is always already placed before its child reaches the loop.
	const parentOf = new Map();
	for (const link of state.links) {
		if (link.relationKey === "spawn_parent") parentOf.set(link.sourceId, link.targetId);
	}
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
			? sorted.filter((o) => !parentOf.has(o.id)).length
			: 0;

		for (let i = 0; i < sorted.length; i++) {
			const obj = sorted[i];
			let pos;
			let placementScale = 1.0;
			let isFeatured = !!featured;
			if (typeKey === "agent" && parentOf.has(obj.id) && positions.has(parentOf.get(obj.id))) {
				// Subagent: small orbit around the parent. Multiple siblings fan
				// around the parent on a deterministic ring (XZ plane), each
				// level out adds a touch of radius so deeper chains don't pile.
				const parentId = parentOf.get(obj.id);
				const parentPos = positions.get(parentId);
				const siblings = sorted.filter((o) => parentOf.get(o.id) === parentId);
				const sIdx = siblings.findIndex((o) => o.id === obj.id);
				const sCount = siblings.length;
				const depth = Math.max(1, spawnDepthOf(obj));
				// Park the subagent's center just outside the parent's halo so it
				// reads as a separate world from the start \u2014 the per-frame push
				// then only has to handle dynamic intersections (e.g. when the
				// parent's halo grows during a context-active or selection state).
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
					? sorted.filter((o) => !parentOf.has(o.id)).findIndex((o) => o.id === obj.id)
					: i;
				const ringCount = typeKey === "agent" ? primaryCount : sorted.length;
				const ringRadius = typeKey === "agent" && primaryCount > 1 ? 2 : radius;
				const theta0 = angleFor(primaryIdx, ringCount, typeKey);
				const yJitter = jitterY(obj.id);
				const baseY = y + yJitter;
				pos = new THREE.Vector3(
					Math.cos(theta0) * ringRadius,
					baseY,
					Math.sin(theta0) * ringRadius,
				);
			}
			// Log-scaled size by change count (floor at 0.6).
			const changeScale = Math.max(0.6, Math.min(2.2, Math.log10(1 + obj.changeCount) * 0.8 + 0.7));
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
				baseEmissive = 0.05;
				mat = new THREE.MeshStandardMaterial({
					// White color so the procedural texture's tones come through pure;
					// emissive still uses the type color so heat bumps tint the world.
					color: 0xffffff,
					map: surface,
					emissive: color,
					emissiveIntensity: baseEmissive,
					metalness: 0.05,
					roughness: 0.85,
				});
			}
			const mesh = new THREE.Mesh(materials.sphere, mat);
			mesh.position.copy(pos);
			mesh.scale.setScalar(r);
			mesh.userData = { kind: "object", id: obj.id, typeKey, obj };
			group.add(mesh);

			// Every ball gets one indicator halo \u2014 dashed great-circle wireframe.
			// Opacity in tick sums three contributions:
			//   - featured base (Graice's persistent "working sphere")
			//   - context-active boost (ball is in the agent's live context)
			//   - heat boost (transient flash on a recent change)
			// Heat-only balls remain invisible at rest because all three terms
			// are zero unless something happens.
			const baseHaloOpacity = isFeatured ? 0.32 : 0.0;
			const haloScale = isFeatured ? r * 3.2 : r * 2.1;
			const { group: halo, material: haloMat } = makeDashedHalo({
				lats: 4, lons: 6,
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



	// Links --------------------------------------------------------
	const linkMeshes = [];
	// Subagent lineage (spawn_parent) is drawn thicker, brighter, and with a
	// larger arch so it reads as a parent→child tree even in a dense cosmos.
	for (const link of state.links) {
		const a = positions.get(link.sourceId);
		const b = positions.get(link.targetId);
		if (!a || !b) continue;

		const isLineage = link.relationKey === "spawn_parent";

		const mid = a.clone().add(b).multiplyScalar(0.5);
		const lift = Math.max(2, a.distanceTo(b) * (isLineage ? 0.32 : 0.2));
		const outward = mid.clone().normalize().multiplyScalar(lift * 0.3);
		mid.add(new THREE.Vector3(0, lift, 0)).add(outward);

		const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
		const geom = new THREE.TubeGeometry(curve, 48, isLineage ? 0.075 : 0.04, 6, false);
		const mat = new THREE.MeshBasicMaterial({
			color: new THREE.Color(isLineage ? "#ffc857" : "#5eead4"),
			transparent: true,
			opacity: isLineage ? 0.85 : 0.6,
		});
		const mesh = new THREE.Mesh(geom, mat);
		mesh.userData = { kind: "link", link, isLineage };
		group.add(mesh);
		linkMeshes.push(mesh);
	}

	// Selection indicator: the selected ball's halo material is tinted white
	// in tick(), with a small extra opacity boost so even non-featured balls
	// without context halos still light up clearly. No separate mesh \u2014 the
	// dashed rings already encode the ball's presence; the color shift is
	// what makes the selection legible.
	const WHITE = new THREE.Color(0xffffff);
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

	// Drive the white selection halo to the currently-selected ball. Pass null
	// to clear it.
	function setSelected(id) {
		selectedId = id ?? null;
	}

	function tick(elapsedSec, cursorRay) {
		const now = Date.now();

		// Phase 1 \u2014 float + cursor-magnet, stored as `_floatX/Y/Z` so phase 2
		// can read every ball's tentative position before any push runs.
		for (const [id, o] of orbits) {
			const node = nodes.get(id);
			if (!node) continue;
			const fx = o.baseX + Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
			const fy = o.baseY + Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
			const fz = o.baseZ + Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
			let tgtX = 0, tgtY = 0, tgtZ = 0;
			if (cursorRay && o.canMagnet) {
				tmpBase.set(fx, fy, fz);
				cursorRay.closestPointToPoint(tmpBase, tmpClosest);
				const d = tmpBase.distanceTo(tmpClosest);
				if (d < MAGNET_RADIUS) {
					const k = MAGNET_PULL * (1 - d / MAGNET_RADIUS);
					tgtX = (tmpClosest.x - fx) * k;
					tgtY = (tmpClosest.y - fy) * k;
					tgtZ = (tmpClosest.z - fz) * k;
				}
			}
			o.magnetX += (tgtX - o.magnetX) * MAGNET_LERP;
			o.magnetY += (tgtY - o.magnetY) * MAGNET_LERP;
			o.magnetZ += (tgtZ - o.magnetZ) * MAGNET_LERP;
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

		// Phase 3 \u2014 compute push offset against every highlight, smooth, and
		// commit the final position + spin + heat/emissive/halo state.
		for (const [id, o] of orbits) {
			const node = nodes.get(id);
			if (!node) continue;
			let pushTgtX = 0, pushTgtY = 0, pushTgtZ = 0;
			// Featured balls (the agent stars) are anchored: their float position
			// is the world's reference frame, so we never push them. Other balls
			// glide around them. The pushTgt accumulator stays at zero \u2014 any
			// previous push from a transient highlight smoothly relaxes back to 0.
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
			node.mesh.material.emissiveIntensity = o.baseEmissive + ctx + heat * HEAT_EMISSIVE_BOOST;
			const pulseScale = 1 + heat * HEAT_SCALE_AMP * Math.sin(elapsedSec * HEAT_PULSE_FREQ + o.pulsePhase);
			const ctxScale = o.contextActive ? CONTEXT_SCALE : 1;
			node.mesh.scale.setScalar(o.baseRadius * pulseScale * ctxScale);
			// Single dotted halo: featured base + context boost + heat sum into
			// the target opacity. Smooth-lerp so toggles fade rather than pop;
			// scale follows the same pulse + context multipliers as the ball.
			node.halo.position.set(x, y, z);
			node.halo.scale.setScalar(o.haloScale * pulseScale * ctxScale);
			node.halo.rotation.y = elapsedSec * 0.12;
			const isSelected = id === selectedId;
			// One sin wave drives both the opacity bump and the dash-length
			// undulation when selected, so the breathing reads as a single,
			// coherent pulse rather than two separate animations.
			const selectWave = isSelected ? Math.sin(elapsedSec * 2.4) : 0;
			const selectOpacity = isSelected ? 0.45 + selectWave * 0.10 : 0;
			const targetHaloOpacity =
				o.baseHaloOpacity +
				(o.contextActive ? CONTEXT_HALO : 0) +
				heat * HEAT_HALO_BOOST +
				selectOpacity;
			const curHaloOpacity = node.haloMat.opacity;
			node.haloMat.opacity = curHaloOpacity + (targetHaloOpacity - curHaloOpacity) * 0.18;
			// Color tint: white when selected, otherwise the ball's type color.
			node.haloMat.color.copy(isSelected ? WHITE : o.haloColor);
			// Dash undulation: dashSize on the selected ball oscillates around its
			// resting value so the segments visibly breathe in length. The gap
			// stays fixed so the dash count per circle doesn't churn \u2014 only the
			// individual dashes grow and shrink. Non-selected balls get the
			// resting value (idempotent assignment, cheap uniform write).
			node.haloMat.dashSize = isSelected ? 0.10 + selectWave * 0.06 : 0.10;
		}
		for (const m of linkMeshes) {
			const link = m.userData.link;
			const a = positions.get(link.sourceId);
			const b = positions.get(link.targetId);
			if (!a || !b) continue;
			tmpA.copy(a); tmpB.copy(b);
			tmpMid.copy(tmpA).add(tmpB).multiplyScalar(0.5);
			const lift = Math.max(2, tmpA.distanceTo(tmpB) * (m.userData.isLineage ? 0.32 : 0.2));
			if (tmpMid.lengthSq() > 1e-6) {
				tmpOut.copy(tmpMid).normalize().multiplyScalar(lift * 0.3);
				tmpMid.add(tmpOut);
			}
			tmpMid.addScaledVector(yAxis, lift);
			const curve = new THREE.QuadraticBezierCurve3(tmpA.clone(), tmpMid.clone(), tmpB.clone());
			const newGeom = new THREE.TubeGeometry(curve, 48, m.userData.isLineage ? 0.075 : 0.04, 6, false);
			m.geometry.dispose();

			m.geometry = newGeom;
		}
	}

	return { group, nodes, positions, linkMeshes, tick, bumpHeat, setContextActive, setSelected };
}

