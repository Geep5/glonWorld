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

	const positions = new Map(); // id → THREE.Vector3
	const nodes = new Map();     // id → { mesh, ring, halo? }

	const orbits = new Map();   // id → { baseX, baseY, baseZ, ampX/Y/Z, freqX/Y/Z, phaseX/Y/Z }

	// Nodes --------------------------------------------------------
	for (const [typeKey, list] of byType) {
		const { radius, y, scale, featured } = layoutForType(typeKey);
		const { color } = colorForType(typeKey);

		// Deterministic ordering so layout is stable between reloads.
		const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
		const floatScale = radius < 1 ? 0.4 : 1.0; // central anchor drifts less

		for (let i = 0; i < sorted.length; i++) {
			const obj = sorted[i];
			const theta0 = angleFor(i, sorted.length, typeKey);
			const yJitter = jitterY(obj.id);
			const baseY = y + yJitter;
			const pos = new THREE.Vector3(
				Math.cos(theta0) * radius,
				baseY,
				Math.sin(theta0) * radius,
			);
			// Log-scaled size by change count (floor at 0.6).
			const changeScale = Math.max(0.6, Math.min(2.2, Math.log10(1 + obj.changeCount) * 0.8 + 0.7));
			const r = scale * changeScale * 0.6;
			const baseEmissive = featured ? 0.9 : 0.35;
			const mat = new THREE.MeshStandardMaterial({
				color,
				emissive: color,
				emissiveIntensity: baseEmissive,
				metalness: 0.2,
				roughness: 0.45,
			});
			const mesh = new THREE.Mesh(materials.sphere, mat);
			mesh.position.copy(pos);
			mesh.scale.setScalar(r);
			mesh.userData = { kind: "object", id: obj.id, typeKey, obj };
			group.add(mesh);

			// Every ball gets a halo: featured balls (agents) wear a big bright
			// star halo always; the rest stay invisible at rest and only light
			// up when the ball is in the agent's live context or has fresh heat.
			const baseHaloOpacity = featured ? 0.18 : 0.0;
			const haloScale = featured ? r * 3.2 : r * 2.1;
			const halo = new THREE.Mesh(
				materials.halo,
				new THREE.MeshBasicMaterial({
					color,
					transparent: true,
					opacity: baseHaloOpacity,
					side: THREE.BackSide,
					depthWrite: false,
				}),
			);
			halo.position.copy(pos);
			halo.scale.setScalar(haloScale);
			halo.userData = { kind: "halo", id: obj.id };
			group.add(halo);


			positions.set(obj.id, pos);
			nodes.set(obj.id, { mesh, halo });
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
				// Featured balls (the agent) shouldn't drift toward the cursor;
				// the world is built around them as a stable anchor.
				canMagnet: !featured,
				// Heat state: lastSeen seeds emissive/halo/scale boost; bumped
				// from the SSE stream and decayed each frame.
				lastSeen: obj.updatedAt || 0,
				baseEmissive,
				baseRadius: r,
				baseHaloOpacity,
				pulsePhase: hash01(obj.id + "hp") * Math.PI * 2,
				haloScale,
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

	function tick(elapsedSec, cursorRay) {
		const now = Date.now();
		for (const [id, o] of orbits) {
			const node = nodes.get(id);
			if (!node) continue;
			// Base float position (no magnet).
			const fx = o.baseX + Math.sin(elapsedSec * o.freqX + o.phaseX) * o.ampX;
			const fy = o.baseY + Math.sin(elapsedSec * o.freqY + o.phaseY) * o.ampY;
			const fz = o.baseZ + Math.sin(elapsedSec * o.freqZ + o.phaseZ) * o.ampZ;
			// Magnet target offset: zero when the cursor is far or absent.
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
			// Smooth toward target so balls glide in/out of range.
			o.magnetX += (tgtX - o.magnetX) * MAGNET_LERP;
			o.magnetY += (tgtY - o.magnetY) * MAGNET_LERP;
			o.magnetZ += (tgtZ - o.magnetZ) * MAGNET_LERP;
			const x = fx + o.magnetX;
			const y = fy + o.magnetY;
			const z = fz + o.magnetZ;
			node.mesh.position.set(x, y, z);
			if (node.halo) node.halo.position.set(x, y, z);
			positions.get(id).set(x, y, z);
			// Heat decay: hot when recently touched, cold otherwise.
			const dt = now - o.lastSeen;
			const heat = o.lastSeen > 0 && dt < HEAT_TAU_MS * 6
				? Math.exp(-dt / HEAT_TAU_MS)
				: 0;
			// Context-active boost: a steady persistent glow on top of resting
			// state. Mirrors what's referenced by an in-context block of the agent.
			const ctx = o.contextActive ? CONTEXT_BOOST : 0;
			node.mesh.material.emissiveIntensity = o.baseEmissive + ctx + heat * HEAT_EMISSIVE_BOOST;
			const pulseScale = 1 + heat * HEAT_SCALE_AMP * Math.sin(elapsedSec * HEAT_PULSE_FREQ + o.pulsePhase);
			const ctxScale = o.contextActive ? CONTEXT_SCALE : 1;
			node.mesh.scale.setScalar(o.baseRadius * pulseScale * ctxScale);
			node.halo.material.opacity = o.baseHaloOpacity + (o.contextActive ? CONTEXT_HALO : 0) + heat * HEAT_HALO_BOOST;
			node.halo.scale.setScalar(o.haloScale * pulseScale * ctxScale);
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

	return { group, nodes, positions, linkMeshes, tick, bumpHeat, setContextActive };
}

