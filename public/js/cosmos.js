/**
 * Cosmos view — every object in the Glon environment laid out in 3D.
 *
 * Layout: objects are grouped by type; each type gets a ring at a
 * type-dependent radius + Y offset, with members placed at even
 * angles around that ring. The agent sits closest to the origin so
 * it reads as the center of gravity.
 *
 * Link edges are drawn as quadratic Bezier arcs between linked
 * objects. All geometry is in a single group so we can fade it
 * in/out as a whole when switching to the agent view.
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
	reminder:   { radius: 14, y: 0.6,  scale: 0.8 },
	type:       { radius: 15, y: -0.3, scale: 0.8 },
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
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return ((h % 1000) / 1000 - 0.5) * 1.6;
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

	const positions = new Map(); // id → THREE.Vector3
	const nodes = new Map();     // id → { mesh, ring, halo? }

	// Nodes --------------------------------------------------------
	for (const [typeKey, list] of byType) {
		const { radius, y, scale, featured } = layoutForType(typeKey);
		const { color } = colorForType(typeKey);

		// Deterministic ordering so layout is stable between reloads.
		const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));

		for (let i = 0; i < sorted.length; i++) {
			const obj = sorted[i];
			const theta = angleFor(i, sorted.length, typeKey);
			const pos = new THREE.Vector3(
				Math.cos(theta) * radius,
				y + jitterY(obj.id),
				Math.sin(theta) * radius,
			);
			// Log-scaled size by change count (floor at 0.6).
			const changeScale = Math.max(0.6, Math.min(2.2, Math.log10(1 + obj.changeCount) * 0.8 + 0.7));
			const r = scale * changeScale * 0.6;

			const mat = new THREE.MeshStandardMaterial({
				color,
				emissive: color,
				emissiveIntensity: featured ? 0.9 : 0.35,
				metalness: 0.2,
				roughness: 0.45,
			});
			const mesh = new THREE.Mesh(materials.sphere, mat);
			mesh.position.copy(pos);
			mesh.scale.setScalar(r);
			mesh.userData = { kind: "object", id: obj.id, typeKey, obj };
			group.add(mesh);

			// Halo for agents so they read as stars.
			let halo = null;
			if (featured) {
				halo = new THREE.Mesh(
					materials.halo,
					new THREE.MeshBasicMaterial({
						color,
						transparent: true,
						opacity: 0.18,
						side: THREE.BackSide,
						depthWrite: false,
					}),
				);
				halo.position.copy(pos);
				halo.scale.setScalar(r * 3.2);
				halo.userData = { kind: "halo", id: obj.id };
				group.add(halo);
			}

			positions.set(obj.id, pos);
			nodes.set(obj.id, { mesh, halo });
		}
	}

	// Rings (subtle orbital guides) -------------------------------
	const drawnRadii = new Set();
	for (const [typeKey, list] of byType) {
		const { radius } = layoutForType(typeKey);
		if (radius === 0) continue;
		if (drawnRadii.has(radius)) continue;
		drawnRadii.add(radius);
		const ring = makeRing(radius, new THREE.Color("#1c2130"));
		group.add(ring);
	}

	// Links --------------------------------------------------------
	const linkMeshes = [];
	for (const link of state.links) {
		const a = positions.get(link.sourceId);
		const b = positions.get(link.targetId);
		if (!a || !b) continue;

		const mid = a.clone().add(b).multiplyScalar(0.5);
		// Arc the midpoint upward (or away from origin) for readability.
		const lift = Math.max(2, a.distanceTo(b) * 0.2);
		const outward = mid.clone().normalize().multiplyScalar(lift * 0.3);
		mid.add(new THREE.Vector3(0, lift, 0)).add(outward);

		const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
		const geom = new THREE.TubeGeometry(curve, 40, 0.04, 6, false);
		const mat = new THREE.MeshBasicMaterial({
			color: new THREE.Color("#5eead4"),
			transparent: true,
			opacity: 0.6,
		});
		const mesh = new THREE.Mesh(geom, mat);
		mesh.userData = { kind: "link", link };
		group.add(mesh);
		linkMeshes.push(mesh);
	}

	return { group, nodes, positions, linkMeshes };
}

function makeRing(radius, color) {
	const segments = 128;
	const pts = [];
	for (let i = 0; i <= segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		pts.push(new THREE.Vector3(Math.cos(t) * radius, 0, Math.sin(t) * radius));
	}
	const geom = new THREE.BufferGeometry().setFromPoints(pts);
	const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 });
	return new THREE.LineLoop(geom, mat);
}
