/**
 * Cosmos view: every object in the glon environment as a ball, with
 * activity "heat" mapped onto emissive intensity, halo opacity, and a
 * subtle scale pulse.
 *
 * Layout: one ring per type (agent at center, peers/programs/files in
 * outward visuals). Members are placed at deterministic angles around
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
	import { getWorld, getRapier, step } from "./physics.js";

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
	agent:      { radius: 0,  y: 0,    scale: 2.2, featured: true },
	trading_agent: { radius: 2, y: 0, scale: 0.9, featured: false },
	peer:       { radius: 3,  y: 0.5,  scale: 0.9 },
	chat:       { radius: 4, y: -0.5, scale: 0.75 },
	ttt:        { radius: 5, y: 0.8,  scale: 0.65 },
	account:    { radius: 6, y: -0.8, scale: 0.65 },
	pinned_fact: { radius: 7, y: -1.0, scale: 0.6 },
	reminder:    { radius: 8, y: 0.6,  scale: 0.6 },
	type:        { radius: 9, y: -0.3, scale: 0.6 },
	milestone:   { radius: 10, y: 1.0,  scale: 0.65 },
	"chain.token": { radius: 11, y: 0.5, scale: 0.8 },
	"chain.coin.bucket": { radius: 12, y: 0.3, scale: 0.8 },
	"chain.coin.offer": { radius: 13, y: -0.3, scale: 0.8 },
	program:    { radius: 14, y: 1.5,  scale: 0.45 },
	typescript: { radius: 16, y: 0,    scale: 0.4 },
	javascript: { radius: 17, y: 0,    scale: 0.4 },
	json:       { radius: 18, y: -2.0, scale: 0.4 },
	source:     { radius: 19, y: 0,    scale: 0.4 },
	proto:      { radius: 20, y: 2.0,  scale: 0.4 },
	"chain.anchor": { radius: 22, y: 0, scale: 0.25 },
	unknown:    { radius: 24, y: 0,    scale: 0.25 },
};

function layoutForType(typeKey, computedRadii) {
	const base = TYPE_LAYOUT[typeKey] ?? { radius: 24, y: 0, scale: 0.25 };
	const radius = computedRadii?.get(typeKey) ?? base.radius;
	return { ...base, radius };
}

// Priority order for ring placement (inner to outer).
// Types earlier in the list get priority placement near the center.
// New types not listed here are appended automatically after the last known type.
const TYPE_PRIORITY = [
	"agent",
	"trading_agent",
	"peer",
	"chat",
	"ttt",
	"account",
	"pinned_fact",
	"reminder",
	"type",
	"milestone",
	"chain.token",
	"chain.coin.bucket",
	"chain.coin.offer",
	"program",
	"typescript",
	"javascript",
	"json",
	"source",
	"proto",
	"unknown",
];

function computeTypeRadii(byType) {
	const computed = new Map();
	let prevRadius = 0;

	for (const typeKey of TYPE_PRIORITY) {
		const list = byType.get(typeKey);
		if (!list || list.length === 0) continue;
		const base = TYPE_LAYOUT[typeKey] ?? TYPE_LAYOUT.unknown;
		const gap = Math.min(4.0, Math.max(1.5, 1.0 + list.length * 0.15));
		const radius = Math.max(base.radius, prevRadius + gap);
		computed.set(typeKey, radius);
		prevRadius = radius;
	}

	// Self-adjusting: any unexpected types not in TYPE_PRIORITY get appended
	// after all known types, maintaining automatic spacing.
	for (const [typeKey, list] of byType) {
		if (computed.has(typeKey) || typeKey === "chain.anchor") continue;
		if (!list || list.length === 0) continue;
		const base = TYPE_LAYOUT[typeKey] ?? TYPE_LAYOUT.unknown;
		const gap = Math.min(4.0, Math.max(1.5, 1.0 + list.length * 0.15));
		const radius = Math.max(base.radius, prevRadius + gap);
		computed.set(typeKey, radius);
		prevRadius = radius;
	}

	return { computed, maxRadius: prevRadius };
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

	// Snap-magnet tunables
	const SNAP_RADIUS = 5.0;      // cursor-ray distance to snap a node
	const SNAP_SPRING_K = 28.0;   // how hard snapped nodes are pulled toward cursor
	const SNAP_DAMP = 1.0;        // low damping so they feel responsive

	// Selected-node repulsion: nearby balls are gently pushed away so they
	// don't visually pass through the selected node.
	const REPEL_RADIUS   = 8;
	const REPEL_STRENGTH = 4.0;

	// Orbit-spring tunables: how strongly bodies are pulled toward their
	// orbital target and how much velocity damping keeps them from oscillating.
	const ORBIT_SPRING_K = 10.0;
	const ORBIT_DAMP_K   = 3.5;
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

	// ── Crypto value scaling ───────────────────────────────────────
	// Coin buckets, tokens, and offers scale by economic weight so a
	// wallet holding 1M coins is visually distinct from one holding 5.
	function cryptoValue(obj) {
		const type = obj.typeKey;
		if (type === "chain.coin.bucket" && obj.coinState) {
			try { return Number(obj.coinState.totalAmount) || 0; } catch { return 0; }
		}
		if (type === "chain.token") {
			const supply = obj.rawFields?.total_supply ?? obj.rawFields?.supply ?? obj.scalars?.total_supply;
			if (supply != null) try { return Number(supply) || 0; } catch { return 0; }
		}
		if (type === "chain.coin.offer") {
			const amount = obj.rawFields?.amount ?? obj.scalars?.amount;
			if (amount != null) try { return Number(amount) || 0; } catch { return 0; }
		}
		return 0;
	}
	const cryptoMax = new Map();
	for (const obj of state.objects) {
		const val = cryptoValue(obj);
		if (val > 0) {
			const prev = cryptoMax.get(obj.typeKey) ?? 0;
			if (val > prev) cryptoMax.set(obj.typeKey, val);
		}
	}
	function valueScaleFor(obj) {
		const type = obj.typeKey;
		const val = cryptoValue(obj);
		const max = cryptoMax.get(type);
		if (!val || !max || max <= 0) return null;
		// Log-scaled 0.5..2.0 range; tiny wallets still visible, whales prominent
		const t = Math.log10(1 + val) / Math.log10(1 + max);
		return 0.5 + t * 1.5;
	}
	const positions = new Map(); // id → THREE.Vector3
	const homePositions = new Map(); // id → THREE.Vector3 (frozen after placement)
	const nodes = new Map();     // id → { mesh, ring, halo? }

	const visuals = new Map();   // id → visual state (lastSeen, baseEmissive, etc.)

	// ── Dynamic layout radii ───────────────────────────────────────
	// Compute radii based on actual node counts so dense rings get more space
	// and new types are accommodated automatically.
	const { computed: computedRadii, maxRadius } = computeTypeRadii(byType);

	// Deterministic processing order: priority list first, then any
	// unknown types appended. Ensures parents are placed before satellites.
	const typeKeysOrdered = [];
	for (const tk of TYPE_PRIORITY) if (byType.has(tk)) typeKeysOrdered.push(tk);
	for (const tk of byType.keys()) if (!typeKeysOrdered.includes(tk)) typeKeysOrdered.push(tk);

	// Nodes --------------------------------------------------------
	for (const typeKey of typeKeysOrdered) {
		const list = byType.get(typeKey);
		if (!list || list.length === 0) continue;
		const isAgentType = typeKey === "agent" || typeKey === "trading_agent";
		const { radius, y, scale, featured } = layoutForType(typeKey, computedRadii);
		const { color, hex } = colorForType(typeKey);
		const surface = planetTextureFor(typeKey, hex);

		// Deterministic ordering. Agents are sorted by spawn_depth first so
		// every primary lands before its subagents \u2014 the subagent placement
		// reads positions.get(parent) and would otherwise miss the parent.
		const sorted = isAgentType
			? [...list].sort((a, b) => spawnDepthOf(a) - spawnDepthOf(b) || a.id.localeCompare(b.id))
			: [...list].sort((a, b) => a.id.localeCompare(b.id));
		const floatScale = radius < 1 ? 0.4 : 1.0; // central anchor drifts less

		// Pre-compute primary-agent count + index for ring-distribution when
		// the user has more than one top-level agent in their store.
		const primaryCount = isAgentType
			? sorted.filter((o) => !orbitParentOf.has(o.id)).length
			: 0;

		for (let i = 0; i < sorted.length; i++) {
			const obj = sorted[i];
			let pos;
			let placementScale = 1.0;
			let isFeatured = !!featured;
			let orbitCenterY = 0, orbitYOffset = 0, orbitRadius = 0, orbitAngle = 0, parentId = null;
			if (orbitParentOf.has(obj.id) && positions.has(orbitParentOf.get(obj.id))) {
				// Satellite: orbit around the parent. Multiple siblings fan
				// around the parent on a deterministic ring (XZ plane), each
				// level out adds a touch of radius so deeper chains don't pile.
				parentId = orbitParentOf.get(obj.id);
				const parentPos = positions.get(parentId);
				const siblings = orbitChildren.get(parentId) ?? [];
				const sIdx = siblings.indexOf(obj.id);
				const sCount = siblings.length;
				const depth = (isAgentType ? Math.max(1, spawnDepthOf(obj)) : 1);
				const parentOrbit = visuals.get(parentId);
				const parentHaloR = parentOrbit?.haloScale ?? 4;
				const orbitR = Math.max(
					parentHaloR + 1.5 + (depth - 1) * 1.5,
					sCount * 0.45,
				);
				const theta = angleFor(sIdx, sCount, "sub" + parentId);
				pos = new THREE.Vector3(
					parentPos.x + Math.cos(theta) * orbitR,
					parentPos.y + jitterY(obj.id) * 0.4,
					parentPos.z + Math.sin(theta) * orbitR,
				);
				placementScale = 0.45;          // moon-sized next to the parent star
				isFeatured = false;             // planet-style (low emissive, no big halo)
				orbitRadius = orbitR;
				orbitAngle = theta;
				orbitYOffset = jitterY(obj.id) * 0.4;
			} else {
				// Primary placement on the type's ring. For 'agent' this is r=0
				// unless multiple primaries exist, in which case spread them on a
				// tiny inner ring so they don't stack.
				const primaryIdx = isAgentType
					? sorted.filter((o) => !orbitParentOf.has(o.id)).findIndex((o) => o.id === obj.id)
					: i;
				const ringCount = isAgentType ? primaryCount : sorted.length;
			const ringRadius = typeKey === "agent" && primaryCount > 1
				? 2
				: Math.max(radius, ringCount * 0.35);
				const theta0 = angleFor(primaryIdx, ringCount, typeKey);
				const yJitter = jitterY(obj.id);
				const baseY = y + yJitter;
				pos = new THREE.Vector3(
					Math.cos(theta0) * jitterR(obj.id, ringRadius),
					baseY,
					Math.sin(theta0) * jitterR(obj.id, ringRadius),
				);
				orbitRadius = ringRadius;
				orbitAngle = theta0;
				orbitCenterY = baseY;
				parentId = null;
			}
			// Log-scaled size by change count (floor at 0.5, gentler growth).
			const vScale = valueScaleFor(obj);
			const changeScale = vScale != null ? vScale : Math.max(0.5, Math.min(1.6, Math.log10(1 + obj.changeCount) * 0.5 + 0.6));
			const r = scale * placementScale * changeScale * 0.6;
			let baseEmissive;
			let mat;
			if (isFeatured) {
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
				// Everything else is a planet: Lambert (no specular/reflection)
				// for performance. Per-vertex lighting is much cheaper than PBR.
				baseEmissive = 0.05;
				mat = new THREE.MeshLambertMaterial({
					color: 0xffffff,
					map: surface,
					emissive: color,
					emissiveIntensity: baseEmissive,
				});
			}
			const mesh = new THREE.Mesh(typeKey === "chain.anchor" ? materials.sphereSmall : materials.sphere, mat);
			mesh.position.copy(pos);
			mesh.scale.setScalar(r);
			mesh.userData = { kind: "object", id: obj.id, typeKey, obj, valueScale: vScale };
			applyStoredStyle(mesh);
			group.add(mesh);

			// Every ball gets one indicator halo — a dashed equator ring.
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

			// Rapier rigid body + collider
			const RAPIER = getRapier();
			const world = getWorld();
			const isKinematic = isFeatured;
			const bodyDesc = isKinematic
				? RAPIER.RigidBodyDesc.kinematicPositionBased()
					.setTranslation(pos.x, pos.y, pos.z)
				: RAPIER.RigidBodyDesc.dynamic()
					.setTranslation(pos.x, pos.y, pos.z)
					.setLinearDamping(2.0)
					.setAngularDamping(1.0)
					.setCanSleep(true);
			const body = world.createRigidBody(bodyDesc);
			const colliderDesc = RAPIER.ColliderDesc.ball(r)
				.setFriction(0.0)
				.setRestitution(0.0)
				.setDensity(1.0);
			world.createCollider(colliderDesc, body);

			positions.set(obj.id, pos);
			nodes.set(obj.id, { mesh, halo, haloMat, body, isKinematic });
			visuals.set(obj.id, {
				ampX: floatAmp(obj.id, "x") * floatScale,
				ampY: floatAmp(obj.id, "y") * floatScale,
				ampZ: floatAmp(obj.id, "z") * floatScale,
				freqX: floatFreq(obj.id, "x"),
				freqY: floatFreq(obj.id, "y"),
				freqZ: floatFreq(obj.id, "z"),
				phaseX: hash01(obj.id + "px") * Math.PI * 2,
				phaseY: hash01(obj.id + "py") * Math.PI * 2,
				phaseZ: hash01(obj.id + "pz") * Math.PI * 2,
				canMagnet: !isFeatured,
				lastSeen: obj.updatedAt || 0,
				baseEmissive,
				baseRadius: r,
				baseHaloOpacity,
				pulsePhase: hash01(obj.id + "hp") * Math.PI * 2,
				haloScale,
				spinRate: (isFeatured ? 0.05 : 0.15) + hash01(obj.id + "sr") * 0.18,
				spinPhase: hash01(obj.id + "sp") * Math.PI * 2,
				tilt: (hash01(obj.id + "tl") - 0.5) * 0.6,
				haloColor: color.clone(),
				contextActive: false,
				orbitCenterY,
				orbitYOffset,
				orbitRadius,
				orbitAngle,
				orbitSpeed: typeKey === "chain.anchor" ? 0 : 0.025,
				parentId,
			});
		}
	}
	// Second pass: any object whose parent was placed in a later type group
	// gets promoted from its type ring into orbit around the now-known parent.
	for (const [childId, parentId] of orbitParentOf) {
		const node = nodes.get(childId);
		if (!node || !positions.has(parentId)) continue;
		const o = visuals.get(childId);
		const parentPos = positions.get(parentId);
		const siblings = orbitChildren.get(parentId) ?? [];
		const sIdx = siblings.indexOf(childId);
		const sCount = siblings.length;
		const depth = 1;
		const parentOrbit = visuals.get(parentId);
		const parentHaloR = parentOrbit?.haloScale ?? 4;
		const orbitR = Math.max(
			parentHaloR + 1.5 + (depth - 1) * 1.5,
			sCount * 0.45,
		);
		const theta = angleFor(sIdx, sCount, "sub" + parentId);
		const newPos = new THREE.Vector3(
			parentPos.x + Math.cos(theta) * orbitR,
			parentPos.y + jitterY(childId) * 0.4,
			parentPos.z + Math.sin(theta) * orbitR,
		);
		node.mesh.position.copy(newPos);
		node.halo.position.copy(newPos);
		positions.get(childId).copy(newPos);
		node.body.setTranslation({ x: newPos.x, y: newPos.y, z: newPos.z }, true);
		const v = visuals.get(childId);
		v.parentId = parentId;
		v.orbitRadius = orbitR;
		v.orbitAngle = theta;
		v.orbitYOffset = jitterY(childId) * 0.4;
		v.orbitCenterY = 0;

	}
	// Anchor chain: arrange anchors in a flat outward ring.
	const anchors = state.objects.filter((o) => o.typeKey === "chain.anchor");
	const anchorChain = [];
	if (anchors.length > 0) {
		const anchorById = new Map(anchors.map((a) => [a.id, a]));
		const seen = new Set();
		// Find genesis (no previous_anchor or previous_anchor not in our set)
		let head = anchors.find((a) => {
			const prev = a.scalars?.previous_anchor;
			return !prev || !anchorById.has(String(prev));
		});
		if (!head) {
			head = [...anchors].sort((a, b) => Number(a.scalars?.height ?? 0) - Number(b.scalars?.height ?? 0))[0];
		}
		// Walk forward by building a next-map from previous_anchor
		const nextOf = new Map();
		for (const a of anchors) {
			const prev = String(a.scalars?.previous_anchor ?? "");
			if (prev && anchorById.has(prev)) nextOf.set(prev, a.id);
		}
		let curId = head?.id;
		while (curId && !seen.has(curId)) {
			seen.add(curId);
			const a = anchorById.get(curId);
			if (!a) break;
			anchorChain.push(a);
			curId = nextOf.get(curId);
		}
		// Append any unvisited anchors (orphans / broken links) so they don't
		// sit on the outer TYPE_LAYOUT ring at radius 22.
		for (const a of anchors) {
			if (!seen.has(a.id)) anchorChain.push(a);
		}

		// Dynamic spiral placement: starts just outside the outermost non-anchor
		// ring and scales tightness based on anchor count.
		const anchorGap = Math.min(4.0, Math.max(2.0, 1.5 + anchors.length * 0.1));
		const R0 = maxRadius + anchorGap;
		const DR = anchors.length > 1 ? Math.max(0.003, 2.5 / anchors.length) : 0;
		const DTHETA = 0.04;
		for (let i = 0; i < anchorChain.length; i++) {
			const obj = anchorChain[i];
			const node = nodes.get(obj.id);
			if (!node) continue;
			const theta = i * DTHETA + 0.3;
			const r = R0 + i * DR;
			const y = jitterY(obj.id) * 0.08;
			const pos = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
			positions.get(obj.id).copy(pos);
			node.mesh.position.copy(pos);
			if (node.halo) node.halo.position.copy(pos);
			node.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
			// Head anchor (newest) gets a size + glow boost so the chain tip is obvious.
			if (i === anchorChain.length - 1) {
				node.mesh.scale.multiplyScalar(1.6);
				visuals.get(obj.id).baseRadius *= 1.6;
				if (node.mesh.material.emissiveIntensity !== undefined) {
					node.mesh.material.emissiveIntensity = 0.8;
				}
			}
		}
	}

	// Links — updatable line geometry instead of per-frame TubeGeometry recreation
	const linkMeshes = [];
	const LINK_STYLE = {
		spawn_parent:  { color: "#ffc857", opacity: 0.85, width: 2 },
		owner:         { color: "#60a5fa", opacity: 0.7,  width: 2 },
		token:         { color: "#4ade80", opacity: 0.7,  width: 2 },
		principal:     { color: "#f472b6", opacity: 0.6,  width: 1.5 },
		target:        { color: "#a78bfa", opacity: 0.5,  width: 1.5 },
		context_source:{ color: "#94a3b8", opacity: 0.4,  width: 1 },
	};
	const DEFAULT_LINK_STYLE = { color: "#5eead4", opacity: 0.5, width: 1 };
	const LINK_SEGMENTS = 32;
	for (const link of state.links) {
		const a = positions.get(link.sourceId);
		const b = positions.get(link.targetId);
		if (!a || !b) continue;

		const style = LINK_STYLE[link.relationKey] ?? DEFAULT_LINK_STYLE;
		const isLineage = link.relationKey === "spawn_parent";

		// Pre-allocate buffer geometry with curve points
		const posArray = new Float32Array((LINK_SEGMENTS + 1) * 3);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(posArray, 3));

		const mat = new THREE.LineBasicMaterial({
			color: new THREE.Color(style.color),
			transparent: true,
			opacity: style.opacity,
			linewidth: style.width, // note: WebGL line width is limited
		});
		const mesh = new THREE.Line(geometry, mat);
		mesh.userData = { kind: "link", link, isLineage, a: a.clone(), b: b.clone(), mid: new THREE.Vector3() };
		group.add(mesh);
		linkMeshes.push(mesh);
	}

	// Anchor chain: single cheap line instead of 1,700 TubeGeometry meshes.
	if (anchorChain.length > 1) {
		const chainPositions = new Float32Array(anchorChain.length * 3);
		for (let i = 0; i < anchorChain.length; i++) {
			const p = positions.get(anchorChain[i].id);
			chainPositions[i * 3] = p.x;
			chainPositions[i * 3 + 1] = p.y;
			chainPositions[i * 3 + 2] = p.z;
		}
		const chainGeom = new THREE.BufferGeometry();
		chainGeom.setAttribute("position", new THREE.BufferAttribute(chainPositions, 3));
		const chainMat = new THREE.LineBasicMaterial({
			color: 0xfbbf24,
			transparent: true,
			opacity: 0.45,
			depthWrite: false,
		});
		const chainLine = new THREE.Line(chainGeom, chainMat);
		chainLine.userData = { kind: "anchor-chain-line" };
		group.add(chainLine);

		// Update the line positions each frame by hooking into the existing tick.
		// We stash a reference so tick() can update it without regenerating geometry.
		chainLine.userData.update = () => {
			const posAttr = chainLine.geometry.attributes.position;
			const arr = posAttr.array;
			for (let i = 0; i < anchorChain.length; i++) {
				const p = positions.get(anchorChain[i].id);
				arr[i * 3] = p.x;
				arr[i * 3 + 1] = p.y;
				arr[i * 3 + 2] = p.z;
			}
			posAttr.needsUpdate = true;
		};
		linkMeshes.push(chainLine); // push so tick() visits it
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
	// Reused per-frame buffer for highlight spheres. Cleared and refilled in
	// Bump heat for an object id (called from the SSE event handler in main.js).
	// `ts` defaults to now; pass an earlier value to seed historical activity.
	function bumpHeat(id, ts) {
		const o = visuals.get(id);
		const node = nodes.get(id);
		if (!o || !node) return;
		o.lastSeen = ts ?? Date.now();
		// Small outward "pop" impulse
		const body = node.body;
		if (!node.isKinematic) {
			const mass = body.mass();
			body.applyImpulse({
				x: (Math.random() - 0.5) * 0.01 * mass,
				y: (Math.random() - 0.5) * 0.01 * mass,
				z: (Math.random() - 0.5) * 0.01 * mass,
			}, true);
		}
	}

	// Toggle the in-context state on every ball given the agent's current
	// referenced-objects set. Applied each frame via the orbit map; balls
	// not in the set decay to their resting halo/emissive.
	function setContextActive(idSet) {
		for (const [id, o] of visuals) {
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
	function applyOrbitBase(out, id, o, elapsedSec) {
		if (o.orbitSpeed !== 0 && o.orbitRadius > 0) {
			if (o.parentId && positions.has(o.parentId)) {
				const pp = positions.get(o.parentId);
				const angle = o.orbitAngle + elapsedSec * o.orbitSpeed;
				out.x = pp.x + Math.cos(angle) * o.orbitRadius;
				out.y = pp.y + (o.orbitYOffset || 0);
				out.z = pp.z + Math.sin(angle) * o.orbitRadius;
				return;
			}
			const angle = o.orbitAngle + elapsedSec * o.orbitSpeed;
			out.x = Math.cos(angle) * o.orbitRadius;
			out.y = o.orbitCenterY;
			out.z = Math.sin(angle) * o.orbitRadius;
			return;
		}
		const home = homePositions.get(id);
		out.x = home.x; out.y = home.y; out.z = home.z;
	}

	function tick(elapsedSec, dt, cursorRay) {
		const now = Date.now();

		// Pre-sync positions from physics bodies for orbit math
		for (const [id, node] of nodes) {
			const p = node.body.translation();
			positions.get(id).set(p.x, p.y, p.z);
		}

		// ── Phase 1: find snapped ball (closest to cursor ray) ───────
		let snappedId = null;
		let snapClosest = null;
		let snapMinD = Infinity;
		if (cursorRay) {
			for (const [id, o] of visuals) {
				if (!o.canMagnet) continue;
				if (id === selectedId) continue;
				const node = nodes.get(id);
				if (!node || !node.mesh.visible) continue;
				// Use actual body position for accurate snap detection
				const p = node.body.translation();
				tmpBase.set(p.x, p.y, p.z);
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

		// Compute selected node's actual position for repulsion
		let selBaseX = 0, selBaseY = 0, selBaseZ = 0;
		if (selectedId) {
			const selNode = nodes.get(selectedId);
			if (selNode) {
				const p = selNode.body.translation();
				selBaseX = p.x;
				selBaseY = p.y;
				selBaseZ = p.z;
			}
		}

		// ── Phase 2: apply physics impulses ──────────────────────────
		for (const [id, o] of visuals) {
			const node = nodes.get(id);
			if (!node || node.isKinematic) continue;

			// Orbit target
			let targetX, targetY, targetZ;
			if (id === snappedId && snapClosest) {
				// Compute orbit base so we can leash the snap
				applyOrbitBase(tmpBase, id, o, elapsedSec);
				const fx = Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
				const fy = Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
				const fz = Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
				const orbitX = tmpBase.x + fx;
				const orbitY = tmpBase.y + fy;
				const orbitZ = tmpBase.z + fz;
				// Leash: snapped target is clamped to 4 units from orbit base
				const ldx = snapClosest.x - orbitX;
				const ldy = snapClosest.y - orbitY;
				const ldz = snapClosest.z - orbitZ;
				const ld = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz);
				const MAX_SNAP_DISPLACEMENT = 4.0;
				if (ld > MAX_SNAP_DISPLACEMENT) {
					const s = MAX_SNAP_DISPLACEMENT / ld;
					targetX = orbitX + ldx * s;
					targetY = orbitY + ldy * s;
					targetZ = orbitZ + ldz * s;
				} else {
					targetX = snapClosest.x;
					targetY = snapClosest.y;
					targetZ = snapClosest.z;
				}
			} else {
				applyOrbitBase(tmpBase, id, o, elapsedSec);
				const fx = Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
				const fy = Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
				const fz = Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
				targetX = tmpBase.x + fx;
				targetY = tmpBase.y + fy;
				targetZ = tmpBase.z + fz;
			}
			const body = node.body;
			const pos = body.translation();
			const vel = body.linvel();
			const mass = body.mass();

			// Spring toward target (orbit or cursor)
			const springK = (id === snappedId) ? SNAP_SPRING_K : ORBIT_SPRING_K;
			let ix = springK * (targetX - pos.x) * mass * dt;
			let iy = springK * (targetY - pos.y) * mass * dt;
			let iz = springK * (targetZ - pos.z) * mass * dt;

			// Velocity damping (lighter for snapped nodes so they feel responsive)
			const damp = (id === snappedId) ? SNAP_DAMP : ORBIT_DAMP_K;
			ix -= damp * vel.x * mass * dt;
			iy -= damp * vel.y * mass * dt;
			iz -= damp * vel.z * mass * dt;

			// No nearby gentle pull — only the snapped node reacts to cursor

			// Selected-node repulsion
			if (selectedId && id !== selectedId) {
				const rdx = pos.x - selBaseX;
				const rdy = pos.y - selBaseY;
				const rdz = pos.z - selBaseZ;
				const rd = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
				if (rd < REPEL_RADIUS && rd > 0.001) {
					const strength = REPEL_STRENGTH * (1 - rd / REPEL_RADIUS);
					ix += (rdx / rd) * strength * mass * dt;
					iy += (rdy / rd) * strength * mass * dt;
					iz += (rdz / rd) * strength * mass * dt;
				}
			}

			body.applyImpulse({ x: ix, y: iy, z: iz }, true);
		}

		// Step physics
		step(dt);

		// ── Phase 3: sync meshes + visual effects from physics ───────
		for (const [id, o] of visuals) {
			const node = nodes.get(id);
			if (!node) continue;

			let px, py, pz;
			if (node.isKinematic) {
				applyOrbitBase(tmpBase, id, o, elapsedSec);
				const kfx = Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
				const kfy = Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
				const kfz = Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
				const orbitX = tmpBase.x + kfx;
				const orbitY = tmpBase.y + kfy;
				const orbitZ = tmpBase.z + kfz;
				if (id === snappedId && snapClosest) {
					// Leash: clamp cursor target to 4 units from orbit base
					const ldx = snapClosest.x - orbitX;
					const ldy = snapClosest.y - orbitY;
					const ldz = snapClosest.z - orbitZ;
					const ld = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz);
					const MAX_SNAP_DISPLACEMENT = 4.0;
					if (ld > MAX_SNAP_DISPLACEMENT) {
						const s = MAX_SNAP_DISPLACEMENT / ld;
						px = orbitX + ldx * s;
						py = orbitY + ldy * s;
						pz = orbitZ + ldz * s;
					} else {
						px = snapClosest.x;
						py = snapClosest.y;
						pz = snapClosest.z;
					}
				} else {
					px = orbitX;
					py = orbitY;
					pz = orbitZ;
				}
				node.body.setTranslation({ x: px, y: py, z: pz }, true);
			} else {
				const p = node.body.translation();
				px = p.x; py = p.y; pz = p.z;
			}
			node.mesh.position.set(px, py, pz);
			node.halo.position.set(px, py, pz);
			positions.get(id).set(px, py, pz);

			node.mesh.rotation.set(o.tilt, elapsedSec * o.spinRate + o.spinPhase, 0);

			const age = now - o.lastSeen;
			const heat = o.lastSeen > 0 && age < HEAT_TAU_MS * 6
				? Math.exp(-age / HEAT_TAU_MS)
				: 0;
			const ctx = o.contextActive ? CONTEXT_BOOST : 0;
			const isSelected = id === selectedId;
			node.mesh.material.emissiveIntensity = o.baseEmissive + ctx + heat * HEAT_EMISSIVE_BOOST + (isSelected ? SELECT_BOOST : 0);

			const pulseScale = 1 + heat * HEAT_SCALE_AMP * Math.sin(elapsedSec * HEAT_PULSE_FREQ + o.pulsePhase);
			const ctxScale = o.contextActive ? CONTEXT_SCALE : 1;
			node.mesh.scale.setScalar(o.baseRadius * pulseScale * ctxScale);

			node.halo.scale.setScalar(o.haloScale * pulseScale * ctxScale);
			const targetHaloOpacity =
				o.baseHaloOpacity +
				(o.contextActive ? CONTEXT_HALO : 0) +
				heat * HEAT_HALO_BOOST;
			node.haloMat.opacity += (targetHaloOpacity - node.haloMat.opacity) * 0.18;
			node.haloMat.color.copy(o.haloColor);
			node.haloMat.dashSize = 0.10;
		}

		// Selection follow-light
		const selNode = selectedId ? nodes.get(selectedId) : null;
		if (selNode) {
			selectLight.position.copy(selNode.mesh.position);
			selectLight.intensity += (2.2 - selectLight.intensity) * 0.12;
			selectLight.distance += (35 - selectLight.distance) * 0.12;
		} else {
			selectLight.intensity += (0 - selectLight.intensity) * 0.08;
		}

		// Update link curves so they track displaced ball positions
		for (const m of linkMeshes) {
			if (m.userData.update) {
				m.userData.update();
				continue;
			}
			const link = m.userData.link;
			const a = positions.get(link.sourceId);
			const b = positions.get(link.targetId);
			if (!a || !b) continue;

			// Compute control points for quadratic bezier
			tmpA.copy(a); tmpB.copy(b);
			tmpMid.copy(tmpA).add(tmpB).multiplyScalar(0.5);
			const lift = Math.max(1, tmpA.distanceTo(tmpB) * (m.userData.isLineage ? 0.32 : 0.2));
			if (tmpMid.lengthSq() > 1e-6) {
				tmpOut.copy(tmpMid).normalize().multiplyScalar(lift * 0.3);
				tmpMid.add(tmpOut);
			}
			tmpMid.addScaledVector(yAxis, lift);

			// Update pre-allocated buffer geometry directly
			const posAttr = m.geometry.attributes.position;
			const arr = posAttr.array;
			for (let i = 0; i <= LINK_SEGMENTS; i++) {
				const t = i / LINK_SEGMENTS;
				const u = 1 - t;
				const w0 = u * u;
				const w1 = 2 * u * t;
				const w2 = t * t;
				arr[i * 3]     = w0 * tmpA.x + w1 * tmpMid.x + w2 * tmpB.x;
				arr[i * 3 + 1] = w0 * tmpA.y + w1 * tmpMid.y + w2 * tmpB.y;
				arr[i * 3 + 2] = w0 * tmpA.z + w1 * tmpMid.z + w2 * tmpB.z;
			}
			posAttr.needsUpdate = true;
		}
	}

	// Freeze current placement as home positions so physics drift can be
	// corrected by a restoring spring in tick().
	for (const [id, pos] of positions) {
		homePositions.set(id, pos.clone());
	}
	return { group, nodes, positions, linkMeshes, tick, bumpHeat, setContextActive, setSelected };
}

