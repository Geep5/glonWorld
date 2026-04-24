/**
 * glonWorld — bootstrap.
 *
 * Responsibilities:
 *   - Fetch the graph snapshot + pick an agent to feature
 *   - Set up three.js scene, camera, lights, controls, raycaster
 *   - Instantiate the cosmos view and the agent view as two groups
 *   - Manage interaction: hover, click-to-select, double-click-to-focus
 *   - Animate camera transitions between modes
 *   - Wire the legend, the inspector panel, search box, and the time scrubber
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildCosmos } from "./cosmos.js";
import { buildAgentView } from "./agent.js";
import { colorForType } from "./colors.js";
import { bindInspector, setLanding, showObject, clear as clearInspector } from "./inspector.js";

// ── State ──────────────────────────────────────────────────────────

let snapshot = null;
let agentConv = null;       // { agent, blocks, tools } for the featured agent
let featuredAgentId = null;

let scene, camera, renderer, controls;
let cosmosCtx, agentCtx;
let pickables = [];         // meshes the raycaster considers
let selectedId = null;
let hoverId = null;
let labelCanvas, labelCtx;
let mode = "cosmos";
let timeFilter = null;      // ms upper bound, or null for live
// Per-state visibility for agent blocks. All on = show everything.
const blockFilters = { inContext: true, compacted: true, memory: true };

// Shared reusable geometries + materials.
const materials = {
	sphere: new THREE.SphereGeometry(1, 32, 24),     // high-detail (featured nodes)
	sphereSmall: new THREE.SphereGeometry(1, 14, 10), // low-detail (blocks, many instances)
	halo: new THREE.SphereGeometry(1, 24, 18),
};

// ── Init ───────────────────────────────────────────────────────────

async function init() {
	// Fetch graph data.
	const [metaRes, stateRes] = await Promise.all([
		fetch("/api/meta").then((r) => r.json()),
		fetch("/api/state").then((r) => r.json()),
	]);
	document.getElementById("root-path").textContent = metaRes.root;
	snapshot = stateRes;

	// Pick featured agent — prefer the one with most activity.
	const agents = snapshot.objects.filter((o) => o.typeKey === "agent");
	agents.sort((a, b) => (b.agentStats?.lastActivity ?? 0) - (a.agentStats?.lastActivity ?? 0));
	featuredAgentId = agents[0]?.id ?? null;
	if (featuredAgentId) {
		agentConv = await fetch(`/api/agents/${featuredAgentId}/conversation`).then((r) => r.json());
	}

	setupThree();
	buildScenes();
	bindUI();
	setLanding(snapshot);

	animate();
}

function setupThree() {
	const canvas = document.getElementById("scene");
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setClearColor(0x05060a, 1);

	scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x05060a, 50, 140);

	camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
	camera.position.set(0, 25, 60);

	controls = new OrbitControls(camera, canvas);
	controls.target.set(0, 0, 0);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 3;
	controls.maxDistance = 120;

	// Stars backdrop for depth.
	scene.add(makeStarfield(1200, 160));

	// Lights — one key light + soft ambient so the agent halo stays readable.
	scene.add(new THREE.AmbientLight(0x404a62, 0.8));
	const key = new THREE.PointLight(0xffffff, 1.4, 200);
	key.position.set(20, 30, 20);
	scene.add(key);
	const rim = new THREE.PointLight(0x5eead4, 1.2, 80);
	rim.position.set(0, 0, 0);
	scene.add(rim);

	window.addEventListener("resize", onResize);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("click", onClick);
	canvas.addEventListener("dblclick", onDoubleClick);

	// Label overlay — CSS-canvas on top of WebGL for sharp billboard text.
	labelCanvas = document.createElement("canvas");
	labelCanvas.style.position = "fixed";
	labelCanvas.style.inset = "0";
	labelCanvas.style.pointerEvents = "none";
	labelCanvas.style.zIndex = "1";
	document.body.appendChild(labelCanvas);
	labelCtx = labelCanvas.getContext("2d");
	onResize();
}

function buildScenes() {
	cosmosCtx = buildCosmos(snapshot, materials);
	scene.add(cosmosCtx.group);

	if (agentConv) {
		agentCtx = buildAgentView(agentConv.agent, agentConv.blocks, agentConv.tools, materials);
		scene.add(agentCtx.group);
	}

	// Build pickable list — we only want meshes the user interacts with.
	refreshPickables();

	// Legend ------------------------------------------------------
	const legend = document.getElementById("legend-list");
	legend.innerHTML = "";
	const typeEntries = Object.entries(snapshot.byType).sort(([, a], [, b]) => b - a);
	for (const [type, count] of typeEntries) {
		const { hex } = colorForType(type);
		const li = document.createElement("li");
		li.className = "type-row";
		li.dataset.type = type;
		li.innerHTML = `<i style="background:${hex}"></i><span>${type}</span><span class="count">${count}</span>`;
		li.addEventListener("click", () => toggleTypeMute(type, li));
		legend.appendChild(li);
	}
}

function refreshPickables() {
	pickables = [];
	cosmosCtx.group.traverse((obj) => {
		if (obj.userData?.kind === "object") pickables.push(obj);
	});
	if (agentCtx) {
		agentCtx.group.traverse((obj) => {
			if (obj.userData?.kind === "block" || obj.userData?.kind === "tool" || obj.userData?.kind === "agent") {
				pickables.push(obj);
			}
		});
	}
}

function bindUI() {
	document.getElementById("btn-cosmos").addEventListener("click", () => switchMode("cosmos"));
	document.getElementById("btn-agent").addEventListener("click", () => switchMode("agent"));
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") switchMode("cosmos");
		if (e.key === "a" && !isTyping(e)) switchMode("agent");
		if (e.key === "c" && !isTyping(e)) switchMode("cosmos");
	});

	bindInspector({
		onNavigate: (id) => {
			select(id, { focus: true });
			switchMode("cosmos");
		},
		onEnterAgent: (id) => {
			if (id === featuredAgentId) switchMode("agent");
			else {
				// The inspector is showing an agent that isn't the featured one.
				// Swap the agent view to this agent on the fly.
				featureAgent(id);
			}
		},
	});

	// Search -----------------------------------------------------
	const search = document.getElementById("search");
	let searchDebounce = 0;
	search.addEventListener("input", () => {
		const q = search.value.trim().toLowerCase();
		highlightMatches(q);
		// Backend search runs debounced so typing fast doesn't storm the server.
		clearTimeout(searchDebounce);
		if (!q) { renderSearchResults(null); return; }
		searchDebounce = setTimeout(() => fetchSearchResults(q), 140);
	});
	search.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			const q = search.value.trim().toLowerCase();
			const match = findBestMatch(q);
			if (match) select(match.id, { focus: true });
			else fetchSearchResults(q); // still show block hits even if no object match
		} else if (e.key === "Escape") {
			renderSearchResults(null);
		}
	});

	// Block filter chips ------------------------------------------
	for (const chip of document.querySelectorAll("#block-filters .chip")) {
		chip.addEventListener("click", () => {
			const key = chip.dataset.filter;
			blockFilters[key] = !blockFilters[key];
			chip.classList.toggle("active", blockFilters[key]);
			applyAgentBlockVisibility();
		});
	}

	// Time scrubber ----------------------------------------------
	const range = document.getElementById("time-range");
	const label = document.getElementById("time-label");
	const timeline = snapshot.timeline;
	range.addEventListener("input", () => {
		const v = Number(range.value);
		if (v >= 100 || timeline.length === 0) {
			timeFilter = null;
			label.textContent = "live";
		} else {
			const first = timeline[0].bucket;
			const last = timeline[timeline.length - 1].bucket;
			const ms = first + (last - first) * (v / 100);
			timeFilter = ms;
			label.textContent = new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
		}
		applyTimeFilter();
	});
}

// ── Mode switching ─────────────────────────────────────────────────

async function featureAgent(id) {
	if (!id) return;
	featuredAgentId = id;
	agentConv = await fetch(`/api/agents/${id}/conversation`).then((r) => r.json());
	if (agentCtx) scene.remove(agentCtx.group);
	agentCtx = buildAgentView(agentConv.agent, agentConv.blocks, agentConv.tools, materials);
	scene.add(agentCtx.group);
	refreshPickables();
	switchMode("agent");
}

function switchMode(next) {
	if (next === mode) return;
	mode = next;
	document.getElementById("mode-label").textContent = mode;
	document.getElementById("btn-cosmos").classList.toggle("active", mode === "cosmos");
	document.getElementById("btn-agent").classList.toggle("active", mode === "agent");

	if (mode === "agent") {
		if (!agentCtx) return;
		cosmosCtx.group.visible = false;
		agentCtx.group.visible = true;
		tweenCamera(new THREE.Vector3(0, 18, 38), new THREE.Vector3(0, 0, 0));
		// Surface the agent in the inspector so stats are visible the moment
		// you land in the stellar view.
		if (featuredAgentId) select(featuredAgentId);
	} else {
		cosmosCtx.group.visible = true;
		if (agentCtx) agentCtx.group.visible = false;
		const home = new THREE.Vector3(0, 25, 60);
		tweenCamera(home, new THREE.Vector3(0, 0, 0));
	}
}

let activeTween = null;
function tweenCamera(targetPos, targetLookAt) {
	const from = camera.position.clone();
	const toLook = controls.target.clone();
	const t0 = performance.now();
	const dur = 900;
	activeTween = (now) => {
		const t = Math.min(1, (now - t0) / dur);
		const k = easeInOut(t);
		camera.position.lerpVectors(from, targetPos, k);
		controls.target.lerpVectors(toLook, targetLookAt, k);
		controls.update();
		if (t >= 1) activeTween = null;
	};
}

function easeInOut(t) {
	return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ── Interaction ───────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let pointer = { x: 0, y: 0 };

function onPointerMove(e) {
	pointer.x = e.clientX;
	pointer.y = e.clientY;
	mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
	mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
	raycaster.setFromCamera(mouse, camera);
	const hits = raycaster.intersectObjects(visiblePickables(), false);
	const first = hits[0]?.object;
	if (!first) {
		hoverId = null;
		document.getElementById("hover").textContent = "";
		hideTooltip();
		return;
	}
	const ud = first.userData;
	if (ud.kind === "object") {
		hoverId = ud.id;
		document.getElementById("hover").textContent = `${ud.typeKey} · ${shortId(ud.id)}`;
		showObjectTooltip(ud.obj);
	} else if (ud.kind === "block") {
		hoverId = ud.block.id;
		document.getElementById("hover").textContent = `${ud.block.kind} · ${new Date(ud.block.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
		showBlockTooltip(ud.block);
	} else if (ud.kind === "tool") {
		hoverId = null;
		document.getElementById("hover").textContent = `tool · ${ud.tool.name}`;
		showToolTooltip(ud.tool);
	} else if (ud.kind === "agent") {
		hoverId = ud.id;
		document.getElementById("hover").textContent = `agent · ${ud.obj.name ?? shortId(ud.id)}`;
		showObjectTooltip(ud.obj);
	}
}

function visiblePickables() {
	return pickables.filter((m) => {
		let p = m;
		while (p) {
			if (p.visible === false) return false;
			p = p.parent;
		}
		return true;
	});
}

function onClick(e) {
	// Ignore clicks that land on UI overlays.
	if (e.target !== renderer.domElement) return;
	raycaster.setFromCamera(mouse, camera);
	const hits = raycaster.intersectObjects(visiblePickables(), false);
	const first = hits[0]?.object;
	if (!first) return;
	const ud = first.userData;
	if (ud.kind === "object" || ud.kind === "agent") {
		select(ud.id);
	} else if (ud.kind === "block") {
		// Keep agent object selected but just update the inspector to the block
		showBlockInInspector(ud.block, ud.agentId);
	}
}

function onDoubleClick(e) {
	if (e.target !== renderer.domElement) return;
	raycaster.setFromCamera(mouse, camera);
	const hits = raycaster.intersectObjects(visiblePickables(), false);
	const first = hits[0]?.object;
	if (!first) return;
	const ud = first.userData;
	if (ud.kind === "agent" || (ud.kind === "object" && ud.typeKey === "agent")) {
		if (ud.id === featuredAgentId) switchMode("agent");
		else featureAgent(ud.id);
	} else if (ud.kind === "object") {
		// Focus the camera on the object.
		const target = first.position.clone();
		const offset = target.clone().normalize().multiplyScalar(6);
		tweenCamera(target.clone().add(offset).add(new THREE.Vector3(0, 3, 0)), target);
		select(ud.id);
	}
}

// ── Selection + highlighting ──────────────────────────────────────

function select(id, { focus = false } = {}) {
	selectedId = id;
	showObject(id);
	highlightSelected();
	if (focus) focusOnId(id);
}

function focusOnId(id) {
	const node = cosmosCtx.nodes.get(id);
	if (!node) return;
	const target = node.mesh.position.clone();
	const offset = target.clone().normalize().multiplyScalar(5);
	tweenCamera(target.clone().add(offset).add(new THREE.Vector3(0, 3, 0)), target);
}

function highlightSelected() {
	for (const [id, node] of cosmosCtx.nodes) {
		const active = id === selectedId;
		if (node.mesh.material && node.mesh.material.emissiveIntensity !== undefined) {
			const base = node.mesh.userData.obj.typeKey === "agent" ? 0.9 : 0.35;
			node.mesh.material.emissiveIntensity = active ? 1.4 : base;
		}
	}
}

function showBlockInInspector(block, agentId) {
	// When a block is clicked in agent view, surface the block content in
	// the panel without replacing the agent object selection.
	const wrap = document.getElementById("inspector-content");
	wrap.hidden = false;
	document.getElementById("inspector-empty").hidden = true;
	// Construct a synthetic "detail" focused on the block.
	const title = document.getElementById("insp-title");
	const sub = document.getElementById("insp-subtitle");
	const typeBadge = document.getElementById("insp-type");
	typeBadge.textContent = block.kind;
	typeBadge.style.background = emissiveHex(block.kind, block.isError);
	title.textContent = block.toolName
		? `${block.kind} · ${block.toolName}`
		: block.kind.replace("_text", "");
	sub.textContent = `${block.id} · ${new Date(block.timestamp).toLocaleString()}`;

	document.getElementById("insp-agent-section").hidden = true;
	document.getElementById("insp-scalars-section").hidden = true;
	document.getElementById("insp-links-section").hidden = true;

	const content = document.getElementById("insp-content");
	const contentSec = document.getElementById("insp-content-section");
	const contentTitle = document.getElementById("insp-content-title");
	contentSec.hidden = false;
	if (block.kind === "tool_use") {
		contentTitle.textContent = `tool input → ${block.toolName ?? ""}`;
		content.textContent = JSON.stringify(block.toolInput ?? {}, null, 2);
	} else if (block.kind === "tool_result") {
		contentTitle.textContent = block.isError ? "tool error" : "tool result";
		content.textContent = block.text ?? "";
	} else if (block.kind === "compaction") {
		contentTitle.textContent = `compaction summary — replaced ${block.turnCount} turns (≈${block.tokensBefore} tokens)`;
		content.textContent = block.summary ?? "";
	} else {
		contentTitle.textContent = block.kind;
		content.textContent = block.text ?? "";
	}

	document.getElementById("insp-changes").innerHTML = "";
	document.getElementById("insp-change-count").textContent = "—";
	renderRecallButton(block, agentId);
}

// Render a "Recall into context" button for compacted blocks and wire it to
// the server-side proxy. The button only appears when the block is
// currently out of the agent's live context window — an in-context block
// has nothing to recall.
function renderRecallButton(block, agentId) {
	const host = document.getElementById("insp-recall");
	if (!host) return;
	host.innerHTML = "";
	if (!agentId) return;
	if (block.kind === "compaction") return; // summaries don't need recall
	const isCompacted = block.inContext === false;
	if (!isCompacted) return;

	const btn = document.createElement("button");
	btn.className = "recall-btn";
	btn.textContent = "← Recall into context";
	btn.title = "Append this block as a fresh user turn so the agent's next reply sees it.";
	btn.addEventListener("click", async () => {
		btn.disabled = true;
		btn.textContent = "Recalling…";
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/recall/${encodeURIComponent(block.id)}`, { method: "POST" });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
			btn.textContent = `Recalled ✓ (new block ${String(data.newBlockId ?? "").slice(0, 8)})`;
			btn.classList.add("ok");
			if (typeof refreshAgentView === "function") refreshAgentView();
		} catch (err) {
			btn.textContent = `Recall failed: ${err?.message ?? err}`;
			btn.classList.add("err");
		}
	});
	host.appendChild(btn);
	const note = document.createElement("div");
	note.className = "recall-note";
	note.textContent = "This block is out of the agent's current context. Clicking appends it as a fresh user turn in the DAG so the next ask sees it.";
	host.appendChild(note);
}

function emissiveHex(kind, isError) {
	const map = {
		user_text: "#1e5a7b", assistant_text: "#6a1e58", tool_use: "#6a4e12",
		tool_result: isError ? "#5a1b20" : "#1e5a2a",
		compaction: "#3b2a6b",
	};
	return map[kind] ?? "#2a3044";
}

// ── Tooltips ──────────────────────────────────────────────────────

const tooltipEl = document.getElementById("tooltip");
function showObjectTooltip(obj) {
	const { hex } = colorForType(obj.typeKey);
	let preview = "";
	if (obj.agentStats) {
		preview = `turns: ${obj.agentStats.userTurns}u / ${obj.agentStats.assistantTurns}a · tokens ≈${formatNumber(obj.agentStats.effectiveTokens)}`;
	} else if (obj.scalars.name) preview = obj.scalars.name;
	tooltipEl.innerHTML = `
		<div class="title" style="color:${hex}">${escapeHtml(obj.typeKey)} · ${escapeHtml(obj.name ?? shortId(obj.id))}</div>
		<div class="sub">${escapeHtml(obj.id)}</div>
		<div class="sub">${obj.changeCount} change${obj.changeCount === 1 ? "" : "s"} · ${obj.blockCount} block${obj.blockCount === 1 ? "" : "s"}${obj.linkOutCount ? ` · ${obj.linkOutCount} link${obj.linkOutCount === 1 ? "" : "s"}` : ""}</div>
		${preview ? `<div class="preview">${escapeHtml(preview)}</div>` : ""}
	`;
	positionTooltip();
}

function showBlockTooltip(block) {
	const color = {
		user_text: "#4dd4ff", assistant_text: "#ff7ad6", tool_use: "#ffc857",
		tool_result: block.isError ? "#ff5b6b" : "#7ae582",
		compaction: "#b197fc",
	}[block.kind] ?? "#8690a3";
	const head = block.toolName ?? block.kind;
	const preview = block.kind === "compaction"
		? block.summary?.slice(0, 240)
		: (block.text ?? (block.toolInput ? JSON.stringify(block.toolInput).slice(0, 240) : ""));
	tooltipEl.innerHTML = `
		<div class="title" style="color:${color}">${escapeHtml(head)}</div>
		<div class="sub">${new Date(block.timestamp).toLocaleString()}</div>
		${preview ? `<div class="preview">${escapeHtml(String(preview).slice(0, 360))}${String(preview).length > 360 ? "…" : ""}</div>` : ""}
	`;
	positionTooltip();
}

function showToolTooltip(tool) {
	tooltipEl.innerHTML = `
		<div class="title" style="color:#ffc857">${escapeHtml(tool.name)}</div>
		<div class="sub">${escapeHtml(tool.targetPrefix)} · ${escapeHtml(tool.targetAction)}</div>
		${tool.description ? `<div class="preview">${escapeHtml(tool.description)}</div>` : ""}
	`;
	positionTooltip();
}

function positionTooltip() {
	tooltipEl.hidden = false;
	tooltipEl.style.left = pointer.x + "px";
	tooltipEl.style.top = pointer.y + "px";
}

function hideTooltip() {
	tooltipEl.hidden = true;
}

// ── Full-text search panel ───────────────────────────────────────
//
// Lives beside the search box. Object hits are already surfaced via live
// highlights; the panel's value-add is block hits — compacted turns the
// user can click to focus (and if out-of-context, recall via the inspector
// button).

async function fetchSearchResults(q) {
	try {
		const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
		if (!r.ok) { renderSearchResults({ query: q, objects: [], blocks: [], error: `HTTP ${r.status}` }); return; }
		const data = await r.json();
		renderSearchResults(data);
	} catch (err) {
		renderSearchResults({ query: q, objects: [], blocks: [], error: err?.message ?? String(err) });
	}
}

function renderSearchResults(data) {
	const host = document.getElementById("search-results");
	if (!host) return;
	if (!data) { host.hidden = true; host.innerHTML = ""; return; }
	host.hidden = false;
	host.innerHTML = "";

	if (data.error) {
		const err = document.createElement("div");
		err.className = "sr-err";
		err.textContent = `search failed: ${data.error}`;
		host.appendChild(err);
		return;
	}

	const blocks = data.blocks ?? [];
	if (blocks.length === 0) {
		const empty = document.createElement("div");
		empty.className = "sr-empty";
		empty.textContent = "no block matches";
		host.appendChild(empty);
		return;
	}

	const head = document.createElement("div");
	head.className = "sr-head";
	head.textContent = `${blocks.length} block match${blocks.length === 1 ? "" : "es"}`;
	host.appendChild(head);

	for (const hit of blocks) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = `sr-row ${hit.inContext ? "live" : "compacted"}`;
		const title = document.createElement("div");
		title.className = "sr-title";
		title.innerHTML = `<span class="sr-kind ${hit.kind}">${escapeHtml(hit.kind)}</span> · <span class="sr-agent">${escapeHtml(hit.agentName ?? hit.agentId.slice(0, 8))}</span> · <span class="sr-ctx">${hit.inContext ? "live" : "compacted"}</span>`;
		const snip = document.createElement("div");
		snip.className = "sr-snip";
		snip.textContent = hit.snippet;
		row.appendChild(title);
		row.appendChild(snip);
		row.addEventListener("click", () => navigateToBlock(hit.agentId, hit.blockId));
		host.appendChild(row);
	}
}

// Navigate to a specific block: select the owning agent, enter agent view,
// and show the block in the inspector. The recall button (if applicable)
// renders automatically for out-of-context blocks.
async function navigateToBlock(agentId, blockId) {
	select(agentId, { focus: true });
	await featureAgent(agentId);
	// Wait a tick for the stellar view to finish building, then try to find the
	// block's classified object and show its inspector. The loaded conversation
	// is on agentCtx; we look up the block by id in the block meshes.
	setTimeout(() => {
		if (!agentCtx) return;
		for (const child of agentCtx.group.children) {
			const ud = child.userData;
			if (ud?.kind === "block" && ud.block?.id === blockId) {
				showBlockInInspector(ud.block, ud.agentId);
				return;
			}
		}
	}, 300);
}
// ── Search / filter ───────────────────────────────────────────────

function findBestMatch(q) {
	if (!q) return null;
	const matches = snapshot.objects.filter((o) => matchesQuery(o, q));
	if (matches.length === 0) return null;
	return matches[0];
}

function matchesQuery(obj, q) {
	if (obj.id.toLowerCase().includes(q)) return true;
	if (obj.typeKey.toLowerCase().includes(q)) return true;
	if (obj.name && obj.name.toLowerCase().includes(q)) return true;
	for (const v of Object.values(obj.scalars)) {
		if (String(v).toLowerCase().includes(q)) return true;
	}
	return false;
}

function highlightMatches(q) {
	for (const [id, node] of cosmosCtx.nodes) {
		const obj = node.mesh.userData.obj;
		const match = !q || matchesQuery(obj, q);
		node.mesh.visible = match;
		if (node.halo) node.halo.visible = match;
	}
}

const mutedTypes = new Set();
function toggleTypeMute(type, row) {
	if (mutedTypes.has(type)) {
		mutedTypes.delete(type);
		row.classList.remove("muted-type");
	} else {
		mutedTypes.add(type);
		row.classList.add("muted-type");
	}
	for (const [id, node] of cosmosCtx.nodes) {
		const hide = mutedTypes.has(node.mesh.userData.obj.typeKey);
		node.mesh.visible = !hide;
		if (node.halo) node.halo.visible = !hide;
	}
}

// ── Time filter ───────────────────────────────────────────────────

function applyTimeFilter() {
	// Hide objects created after the filter; dim their change count
	// visually. Simple approach: visibility toggle.
	for (const [id, node] of cosmosCtx.nodes) {
		const obj = node.mesh.userData.obj;
		const hidden = timeFilter != null && obj.createdAt > timeFilter;
		const muted = mutedTypes.has(obj.typeKey);
		node.mesh.visible = !hidden && !muted;
		if (node.halo) node.halo.visible = !hidden && !muted;
	}
	applyAgentBlockVisibility();
}

// Agent-block visibility composes time filter + per-state chips. A
// block is shown iff its time is within the filter AND at least one
// matching state chip is on (memory-surfaced blocks survive whenever
// the memory chip is on, regardless of their in/out-of-context state).
function applyAgentBlockVisibility() {
	if (!agentCtx) return;
	const show = (ud) => {
		if (timeFilter != null && ud.block.timestamp > timeFilter) return false;
		const hasMemory = (ud.memoryRefs?.length ?? 0) > 0;
		if (hasMemory && blockFilters.memory) return true;
		if (ud.inContext && blockFilters.inContext) return true;
		if (!ud.inContext && blockFilters.compacted) return true;
		return false;
	};
	const haloShow = new Map(); // blockId → visible
	for (const child of agentCtx.group.children) {
		const ud = child.userData;
		if (ud?.kind === "block" && ud.block) {
			const v = show(ud);
			child.visible = v;
			haloShow.set(ud.block.id, v);
		}
	}
	for (const child of agentCtx.group.children) {
		const ud = child.userData;
		if (ud?.kind === "block-halo") {
			child.visible = haloShow.get(ud.blockId) ?? true;
		}
	}
}

// ── Frame loop ────────────────────────────────────────────────────

let lastFrame = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();

function animate() {
	requestAnimationFrame(animate);
	const now = performance.now();
	const dt = (now - lastFrame) / 1000;
	lastFrame = now;

	if (activeTween) activeTween(now);

	// (intentionally no auto-rotation on the cosmos — picking stability wins)

	// Pulse agent corona.
	if (agentCtx) {
		const pulse = 1 + Math.sin(now * 0.002) * 0.05;
		agentCtx.corona.scale.setScalar(4.2 * pulse);
		agentCtx.star.rotation.y += dt * 0.15;
	}

	controls.update();
	renderer.render(scene, camera);
	drawLabels();

	frameCount++;
	if (now - lastFpsUpdate > 500) {
		const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
		document.getElementById("fps").textContent = `${fps} fps`;
		frameCount = 0;
		lastFpsUpdate = now;
	}
}

// ── Labels (2D canvas overlay) ────────────────────────────────────

function drawLabels() {
	labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
	labelCtx.font = "12px ui-monospace, 'SF Mono', Menlo, monospace";
	labelCtx.textBaseline = "top";

	const screen = new THREE.Vector3();

	if (mode === "cosmos") {
		// Label only featured types and the selected object to reduce clutter.
		for (const [id, node] of cosmosCtx.nodes) {
			const obj = node.mesh.userData.obj;
			const isFeatured = obj.typeKey === "agent" || obj.typeKey === "peer" || id === selectedId || id === hoverId;
			if (!isFeatured) continue;
			if (!node.mesh.visible) continue;
			screen.copy(node.mesh.position);
			screen.project(camera);
			if (screen.z > 1) continue;
			const x = (screen.x * 0.5 + 0.5) * labelCanvas.width / (window.devicePixelRatio || 1);
			const y = (-screen.y * 0.5 + 0.5) * labelCanvas.height / (window.devicePixelRatio || 1);

			const { hex } = colorForType(obj.typeKey);
			const label = obj.name ?? shortId(obj.id);
			labelCtx.fillStyle = "rgba(5,6,10,.75)";
			const metrics = labelCtx.measureText(label);
			const padX = 6, padY = 3;
			labelCtx.fillRect(x + 12, y - 8, metrics.width + padX * 2, 18);
			labelCtx.fillStyle = hex;
			labelCtx.fillText(label, x + 12 + padX, y - 8 + padY);
		}
	}

	if (mode === "agent" && agentCtx) {
		// Star label
		screen.copy(agentCtx.star.position);
		screen.project(camera);
		const x = (screen.x * 0.5 + 0.5) * labelCanvas.width / (window.devicePixelRatio || 1);
		const y = (-screen.y * 0.5 + 0.5) * labelCanvas.height / (window.devicePixelRatio || 1);
		const name = agentConv?.agent?.name ?? "agent";
		labelCtx.fillStyle = "rgba(5,6,10,.75)";
		const label = name.toUpperCase();
		const metrics = labelCtx.measureText(label);
		labelCtx.fillRect(x + 18, y - 10, metrics.width + 12, 22);
		labelCtx.fillStyle = "#5eead4";
		labelCtx.font = "bold 13px ui-monospace, 'SF Mono', Menlo, monospace";
		labelCtx.fillText(label, x + 24, y - 7);
		labelCtx.font = "12px ui-monospace, 'SF Mono', Menlo, monospace";

		// Tool labels
		for (const child of agentCtx.group.children) {
			if (child.userData?.kind !== "tool") continue;
			screen.copy(child.position);
			screen.project(camera);
			const tx = (screen.x * 0.5 + 0.5) * labelCanvas.width / (window.devicePixelRatio || 1);
			const ty = (-screen.y * 0.5 + 0.5) * labelCanvas.height / (window.devicePixelRatio || 1);
			labelCtx.fillStyle = "#ffc857";
			labelCtx.fillText(child.userData.tool.name, tx + 10, ty - 6);
		}
	}
}

// ── Stars ─────────────────────────────────────────────────────────

function makeStarfield(count, radius) {
	const geom = new THREE.BufferGeometry();
	const positions = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		// Uniform points on a sphere shell.
		const u = Math.random();
		const v = Math.random();
		const theta = 2 * Math.PI * u;
		const phi = Math.acos(2 * v - 1);
		const r = radius * (0.7 + Math.random() * 0.3);
		positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
		positions[i * 3 + 2] = r * Math.cos(phi);
	}
	geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	const mat = new THREE.PointsMaterial({
		size: 0.6,
		color: 0xaab3c6,
		transparent: true,
		opacity: 0.6,
		sizeAttenuation: true,
	});
	return new THREE.Points(geom, mat);
}

// ── Utilities ─────────────────────────────────────────────────────

function onResize() {
	const w = window.innerWidth;
	const h = window.innerHeight;
	const dpr = window.devicePixelRatio || 1;
	renderer.setSize(w, h);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	labelCanvas.width = w * dpr;
	labelCanvas.height = h * dpr;
	labelCanvas.style.width = w + "px";
	labelCanvas.style.height = h + "px";
	labelCtx.scale(dpr, dpr);
}

function shortId(id) {
	if (!id) return "";
	return id.length > 14 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function formatNumber(n) {
	if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
	return String(n);
}

function isTyping(e) {
	const t = e.target;
	return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
}

init().catch((err) => {
	console.error(err);
	document.body.innerHTML = `<div style="padding:40px;color:#ff6b7a;font:14px ui-monospace,monospace">${String(err)}</div>`;
});
