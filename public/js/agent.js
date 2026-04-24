/**
 * Agent stellar view — the AI agent's DAG-backed conversation as a
 * three-dimensional spiral of blocks.
 *
 * Axis semantics (agent at origin):
 *   - spiral out on XZ:  time progresses outward (older → newer)
 *   - y lane:            block kind (user low, assistant mid-low,
 *                        tool_use mid-high, tool_result high)
 *   - color:             block kind (see colors.js)
 *   - tool arcs:         curved bridges from tool_use → matching
 *                        tool_result (shared tool_use_id)
 *   - compaction shell:  large semi-transparent bubble enclosing the
 *                        blocks the compaction summary replaced
 *   - tool ring:         registered tools as small planets in a
 *                        fixed equatorial ring at r=5
 */

import * as THREE from "three";
import { BLOCK_COLORS, blockColor, colorForType } from "./colors.js";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const INNER_RADIUS = 2.8;
const RADIUS_STEP = 0.22;       // how fast the spiral expands per block
const LANES = {
	user_text:      { y: -1.2 },
	assistant_text: { y: 0.2 },
	tool_use:       { y: 1.6 },
	tool_result:    { y: 1.6 },
	compaction:     { y: 0.2 },
	other:          { y: 0 },
};

export function buildAgentView(agent, blocks, tools, materials) {
	const group = new THREE.Group();
	group.name = "agent-view";
	group.visible = false;

	// ── Central star (the agent itself) ────────────────────────
	const agentColor = colorForType("agent").color;
	const star = new THREE.Mesh(
		materials.sphere,
		new THREE.MeshStandardMaterial({
			color: agentColor,
			emissive: agentColor,
			emissiveIntensity: 1.2,
			metalness: 0.1,
			roughness: 0.3,
		}),
	);
	star.scale.setScalar(1.4);
	star.userData = { kind: "agent", id: agent.id, obj: agent };
	group.add(star);

	// Corona — two nested inverted spheres pulse via shader uniform time.
	const corona = new THREE.Mesh(
		materials.halo,
		new THREE.MeshBasicMaterial({
			color: agentColor,
			transparent: true,
			opacity: 0.16,
			side: THREE.BackSide,
			depthWrite: false,
		}),
	);
	corona.scale.setScalar(4.2);
	group.add(corona);

	// ── Blocks ─────────────────────────────────────────────────
	// Position by time-index so order is canonical (blocks already
	// arrive sorted by timestamp from the server).
	const positions = new Map(); // blockId → Vec3
	const nodeMeshes = [];

	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		const theta = i * GOLDEN;
		const r = INNER_RADIUS + i * RADIUS_STEP;
		const lane = LANES[b.kind] ?? LANES.other;
		// Add a slight alternation for tool_use vs tool_result so they
		// don't overlap when paired on the same radius.
		let y = lane.y;
		if (b.kind === "tool_use") y += 0.3;
		if (b.kind === "tool_result") y -= 0.3;

		const pos = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
		positions.set(b.id, pos);

		if (b.kind === "compaction") {
			// Render compaction as a translucent bubble drawn later (below).
			continue;
		}

		const color = blockColor(b);
		const size = b.kind === "user_text" || b.kind === "assistant_text"
			? Math.min(0.6, 0.18 + Math.sqrt((b.text?.length ?? 0) / 200) * 0.12)
			: 0.18;

		const mat = new THREE.MeshStandardMaterial({
			color,
			emissive: color,
			emissiveIntensity: 0.6,
			metalness: 0.15,
			roughness: 0.5,
		});
		const mesh = new THREE.Mesh(materials.sphereSmall, mat);
		mesh.position.copy(pos);
		mesh.scale.setScalar(size);
		mesh.userData = { kind: "block", block: b, agentId: agent.id };
		group.add(mesh);
		nodeMeshes.push(mesh);
	}

	// Spine — a thin line tracing the spiral so you can see time flow.
	{
		const spinePts = [];
		for (let i = 0; i < blocks.length; i++) {
			const p = positions.get(blocks[i].id);
			if (p) spinePts.push(p);
		}
		if (spinePts.length > 1) {
			const geom = new THREE.BufferGeometry().setFromPoints(spinePts);
			const mat = new THREE.LineBasicMaterial({
				color: new THREE.Color("#243048"),
				transparent: true,
				opacity: 0.7,
			});
			group.add(new THREE.Line(geom, mat));
		}
	}

	// ── Tool-use arcs ──────────────────────────────────────────
	// Match tool_use ↔ tool_result by shared toolUseId and draw a
	// curved bridge between them so you can trace tool dispatches.
	const useIndex = new Map();
	for (const b of blocks) {
		if (b.kind === "tool_use" && b.toolUseId) useIndex.set(b.toolUseId, b);
	}
	for (const b of blocks) {
		if (b.kind !== "tool_result" || !b.toolUseId) continue;
		const use = useIndex.get(b.toolUseId);
		if (!use) continue;
		const a = positions.get(use.id);
		const c = positions.get(b.id);
		if (!a || !c) continue;

		const mid = a.clone().add(c).multiplyScalar(0.5);
		const span = a.distanceTo(c);
		mid.y += Math.min(2.8, 0.6 + span * 0.25);

		const curve = new THREE.QuadraticBezierCurve3(a, mid, c);
		const tube = new THREE.TubeGeometry(curve, 16, 0.025, 6, false);
		const color = b.isError ? BLOCK_COLORS.tool_error : BLOCK_COLORS.tool_result;
		const mat = new THREE.MeshBasicMaterial({
			color,
			transparent: true,
			opacity: b.isError ? 0.7 : 0.42,
		});
		const mesh = new THREE.Mesh(tube, mat);
		mesh.userData = { kind: "tool-arc", useBlock: use, resultBlock: b };
		group.add(mesh);
	}

	// ── Compaction event horizons ──────────────────────────────
	// A compaction block conceptually "swallows" every block between
	// the prior compaction's firstKeptBlockId and this one's. We draw
	// a translucent sphere whose size encompasses those block positions
	// so the replacement is visible in space.
	const sortedCompactions = blocks
		.filter((b) => b.kind === "compaction")
		.sort((a, b) => a.timestamp - b.timestamp);

	let priorCutId = null;
	for (const comp of sortedCompactions) {
		const range = collectRange(blocks, priorCutId, comp.firstKeptBlockId);
		const pts = range.map((id) => positions.get(id)).filter(Boolean);
		if (pts.length >= 2) {
			const { center, radius } = boundingSphere(pts);
			const horizonGeo = materials.sphere;
			const horizon = new THREE.Mesh(
				horizonGeo,
				new THREE.MeshBasicMaterial({
					color: BLOCK_COLORS.compaction,
					transparent: true,
					opacity: 0.1,
					side: THREE.BackSide,
					depthWrite: false,
				}),
			);
			horizon.position.copy(center);
			horizon.scale.setScalar(radius + 0.6);
			horizon.userData = { kind: "compaction-horizon", block: comp };
			group.add(horizon);

			// A visible marker sphere at the compaction itself
			const marker = new THREE.Mesh(
				materials.sphere,
				new THREE.MeshStandardMaterial({
					color: BLOCK_COLORS.compaction,
					emissive: BLOCK_COLORS.compaction,
					emissiveIntensity: 0.9,
				}),
			);
			marker.position.copy(center);
			marker.scale.setScalar(0.32);
			marker.userData = { kind: "block", block: comp, agentId: agent.id };
			group.add(marker);
		}
		priorCutId = comp.firstKeptBlockId;
	}

	// ── Tool ring ──────────────────────────────────────────────
	// Registered tools as fixed satellites around the agent.
	if (tools.length > 0) {
		for (let i = 0; i < tools.length; i++) {
			const theta = (i / tools.length) * Math.PI * 2 + Math.PI / 6;
			const r = 5.2;
			const pos = new THREE.Vector3(Math.cos(theta) * r, 0.9, Math.sin(theta) * r);
			const mesh = new THREE.Mesh(
				materials.sphere,
				new THREE.MeshStandardMaterial({
					color: BLOCK_COLORS.tool_use,
					emissive: BLOCK_COLORS.tool_use,
					emissiveIntensity: 0.5,
					metalness: 0.3,
					roughness: 0.3,
				}),
			);
			mesh.position.copy(pos);
			mesh.scale.setScalar(0.32);
			mesh.userData = { kind: "tool", tool: tools[i] };
			group.add(mesh);

			// Thin tether line from agent to tool planet.
			const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), pos]);
			const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
				color: BLOCK_COLORS.tool_use,
				transparent: true,
				opacity: 0.25,
			}));
			group.add(line);
		}
	}

	return { group, star, corona, positions, nodeMeshes };
}

// ── Helpers ────────────────────────────────────────────────────

function collectRange(blocks, fromId, toId) {
	// Return the ids of blocks strictly between `fromId` (exclusive, or
	// from start if null) and `toId` (exclusive). Used to identify which
	// blocks a compaction "swallowed".
	const out = [];
	let started = fromId == null;
	for (const b of blocks) {
		if (!started) {
			if (b.id === fromId) started = true;
			continue;
		}
		if (b.id === toId) break;
		if (b.kind === "compaction") continue;
		out.push(b.id);
	}
	return out;
}

function boundingSphere(points) {
	const center = new THREE.Vector3();
	for (const p of points) center.add(p);
	center.divideScalar(points.length);
	let radius = 0;
	for (const p of points) {
		const d = center.distanceTo(p);
		if (d > radius) radius = d;
	}
	return { center, radius };
}
