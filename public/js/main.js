/**
 * glonAstrolabe — bootstrap.
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
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }     from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { buildCosmos } from "./cosmos.js";
import { colorForType } from "./colors.js";
	import { bindInspector, setLanding, showObject, clear as clearInspector, setContextState } from "./inspector.js";
	import { setupLiveLog } from "./livelog.js";
	import { openAgentChat, initAgentChats } from "./chat.js";
	import { getRender, setRender, clearRender, applyToMesh, updateOverlays } from "./planet-styles.js";
	// ── State ──────────────────────────────────────────────────────────

let snapshot = null;

let scene, camera, renderer, composer, controls;
let cosmosCtx;
let pickables = [];         // meshes the raycaster considers
let selectedId = null;
let hoverId = null;
let labelCanvas, labelCtx;
let timeFilter = null;      // ms upper bound, or null for live
// Watched agent for in-context highlighting; picked by activity at init.
let contextAgentId = null;


	// WASD / Space pan state
	const keys = { w: false, a: false, s: false, d: false, space: false, shift: false, ctrl: false };


	// HUD grid dimensions (must match setupHudGrid call)
	const GRID_COLS = 8;
	const GRID_ROWS = 4;

	// Shared reusable geometries + materials.
const materials = {
	// Higher-poly spheres so the procedural surface texture and directional
	// sun lighting render smoothly without faceting on close-up balls.
	sphere:      new THREE.SphereGeometry(1, 48, 32),
	sphereSmall: new THREE.SphereGeometry(1, 14, 10),
	halo:        new THREE.SphereGeometry(1, 24, 18),
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
	const agents = snapshot.objects.filter((o) => o.typeKey === "agent");
	agents.sort((a, b) => (b.agentStats?.lastActivity ?? 0) - (a.agentStats?.lastActivity ?? 0));
	contextAgentId = agents[0]?.id ?? null;
	initAgentChats(agents);
	setupThree();
	setupHudGrid(8, 4);
	buildScenes();
	bindUI();
	setupLiveLog({
		onSelectObject: (id) => select(id, { focus: true }),
		onEachEvent: (ev) => {
			// Live events bump heat on the change's owning object plus every
			// id its tool input/result mentioned. Replay events (the ~50 sent
			// on connect for context) skip this — their decay would already
			// be invisible and they'd otherwise paint stale activity as live.
			if (!ev.replay) {
				cosmosCtx?.bumpHeat?.(ev.objectId, ev.ts);
				for (const id of ev.referencedObjects ?? []) {
					cosmosCtx?.bumpHeat?.(id, ev.ts);
				}
				// Any live change on the watched agent or one that references
				// objects can shift the in-context set; refresh it (debounced).
				const affectsContext =
					ev.objectId === contextAgentId ||
					(ev.referencedObjects ?? []).length > 0;
				if (affectsContext) scheduleContextRefresh();
			}
		},
	});
	refreshContextActive();
	setLanding(snapshot);

	animate();
}

// In-context object set: which cosmos balls are currently referenced by
// any in-context block of `contextAgentId`. Refreshed on init and whenever
// the SSE stream signals a change that could shift the set. We debounce so
// a burst of tool calls collapses into a single fetch.
let contextRefreshTimer = 0;
function scheduleContextRefresh() {
	clearTimeout(contextRefreshTimer);
	contextRefreshTimer = setTimeout(refreshContextActive, 500);
}
async function refreshContextActive() {
	if (!cosmosCtx?.setContextActive) return;
	if (!contextAgentId) { cosmosCtx.setContextActive(new Set()); return; }
	try {
		const r = await fetch(`/api/agents/${encodeURIComponent(contextAgentId)}/context`);
		if (!r.ok) return;
		const data = await r.json();
		contextActiveIds = new Set(data.objectIds ?? []);
		cosmosCtx.setContextActive(contextActiveIds);
		setContextState({ agentId: contextAgentId, contextIds: contextActiveIds });
	} catch (err) {
		console.warn("context refresh failed", err);
	}
}
let contextActiveIds = new Set();

function setupThree() {
	const canvas = document.getElementById("scene");
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", alpha: true });
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setClearColor(0x000000, 0);
	// Cinematic tone curve + sRGB output give the textured planets the same
	// rich falloff a real solar-system viewer has.
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.15;
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x000000, 40, 140);

	camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
	camera.position.set(0, 20, 45);

	controls = new OrbitControls(camera, canvas);
	controls.target.set(0, 0, 0);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 3;
	controls.maxDistance = 100;

	// (Spatial reference is provided by a screen-space HUD grid in
	// public/index.html, not a 3D helper \u2014 the HUD stays put while the
	// camera orbits, so "section A1" always means the same screen region.

	// Lighting model: Graice IS the sun. A single bright PointLight sits
	// where the agent ball lives (origin) and lights every other ball from
	// the inside-out, so the day/night terminator naturally points away from
	// Graice. Ambient is low so dark sides stay dark; no directional fill \u2014
	// the universe genuinely revolves around the agent.
	// Tiny ambient: just enough to keep terminator-side detail readable
	// without lifting the void. Pure black ambient = silhouettes disappear.
	scene.add(new THREE.AmbientLight(0x1a2030, 0.06));
	// Graice's surface stays brand-teal-green (emissive map), but the light
	// it CASTS on planets is warm \u2014 real suns are blackbody emitters around
	// 5000\u20136000K, which reads as a soft golden cream, not a clinical white.
	// Decoupling cast color from surface color is the same trick lensflares
	// use: a green star can still throw warm sunlight on its system.
	const graiceSun = new THREE.PointLight(0xffe0a8, 1.0, 220, 1.4);
	graiceSun.position.set(0, 0, 0);
	scene.add(graiceSun);

	// Bloom postprocessing: Graice's emissive surface punches above the
	// threshold so it actually glows beyond its geometry. Other balls stay
	// below the threshold (their emissive baseline is 0.05) unless they're
	// fresh-heated, at which point they momentarily flare \u2014 a deliberate
	// secondary cue for live activity.
	composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	const bloom = new UnrealBloomPass(
		new THREE.Vector2(window.innerWidth, window.innerHeight),
		0.55,   // strength  (was 1.1)
		0.55,   // radius    (was 0.7)
		0.95,   // threshold (was 0.85; raised so heat flashes stay calm)
	);
	composer.addPass(bloom);

	window.addEventListener("resize", onResize);
	// Planet render changes from inspector — update mesh immediately
	window.addEventListener("planet-render-changed", (e) => {
		const node = cosmosCtx?.nodes?.get(e.detail.objectId);
		if (e.detail.render === null) {
			// Reset: clear stored style and re-apply defaults
			clearRender(e.detail.objectId);
			if (node?.mesh) {
				const typeKey = node.mesh.userData.typeKey;
				const { hex } = colorForType(typeKey);
				node.mesh.material.color.set(hex);
				node.mesh.material.emissive.set(hex);
				// Remove any custom children added by Three.js renders
				const group = node.mesh.userData._planetGroup;
				if (group) {
					while (group.children.length > 0) {
						const child = group.children[0];
						if (child.geometry) child.geometry.dispose();
						if (child.material) {
							if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
							else child.material.dispose();
						}
						group.remove(child);
					}
				}
				// Remove canvas texture if present
				if (node.mesh.material.map) {
					node.mesh.material.map.dispose();
					node.mesh.material.map = null;
				}
				// Restore default emissive intensity based on type
				const isFeatured = typeKey === "agent" || typeKey === "trading_agent";
				node.mesh.material.emissiveIntensity = isFeatured ? 1.4 : 0.05;
				node.mesh.material.needsUpdate = true;
			}
		} else if (e.detail.render) {
			setRender(e.detail.objectId, e.detail.render);
			if (node?.mesh) applyToMesh(node.mesh, e.detail.render);
		}
	});
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("click", onClick);
	canvas.addEventListener("dblclick", onDoubleClick);
	canvas.addEventListener("pointerleave", () => { cursorActive = false; });

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
	renderJobs(snapshot.objects);
	renderCrypto(snapshot.objects);
	startJobsRefresh();
}

// Re-render the jobs panel from a fresh /api/state every JOBS_POLL_MS.
// Each row shows context-window fill (the bar that drives compaction),
// turn count, and a live/idle dot driven by lastActivity.
const JOBS_POLL_MS = 5000;
let jobsTimer = 0;
function startJobsRefresh() {
	clearInterval(jobsTimer);
	jobsTimer = setInterval(async () => {
		try {
			const s = await fetch("/api/state").then((r) => r.json());
			renderJobs(s.objects);
			renderCrypto(s.objects);
		} catch { /* keep last paint on transient error */ }
	}, JOBS_POLL_MS);
	// Smooth 1Hz tick to update reminder countdown bars between polls.
	setInterval(tickReminderBars, 1000);
}

function tickReminderBars() {
	const now = Date.now();
	document.querySelectorAll("#jobs-list .job-row.reminder").forEach((row) => {
		const fire = Number(row.dataset.fire ?? 0);
		const created = Number(row.dataset.created ?? 0);
		if (!fire) return;
		const total = Math.max(1, fire - created);
		const elapsed = Math.max(0, Math.min(total, now - created));
		const pct = Math.round((elapsed / total) * 100);
		const fillEl = row.querySelector(".job-bar-fill");
		if (fillEl) fillEl.style.width = pct + "%";
		// Refresh the meta countdown only if the row is pending; static rows don't need updates.
		if (row.classList.contains("pending")) {
			const metaEl = row.querySelector(".job-meta");
			if (metaEl) metaEl.textContent = `reminder \u00b7 fires in ${formatDuration(fire - now)}`;
		}
	});
}

// AI jobs = every running agent + every reminder. Reminders carry a
// fire_at_ms field so we can render a live countdown; agents render a
// context-window fill bar.
function renderJobs(objects) {
	const host = document.getElementById("jobs-list");
	const countEl = document.getElementById("jobs-count");
	if (!host) return;
	const agents = (objects ?? []).filter((o) => o.typeKey === "agent" && o.agentStats);
	// Reminders: pending or fired/failed/cancelled within the last 24h. Older
	// ones are noise (e.g. a long-dead cancelled scheduler from months ago).
	const now = Date.now();
	const REMINDER_HISTORY_MS = 24 * 3600_000;
	const reminders = (objects ?? []).filter((o) => {
		if (o.typeKey !== "reminder" || o.deleted) return false;
		const sc = o.scalars ?? {};
		const fire = Number(sc.fire_at_ms ?? 0);
		const status = String(sc.status ?? "pending");
		const pending = fire > now && status !== "sent" && status !== "cancelled" && status !== "failed";
		return pending || (now - fire) <= REMINDER_HISTORY_MS;
	});
	jobsRows = [
		...agents.map((a) => ({ kind: "agent", obj: a })),
		...reminders.map((r) => ({ kind: "reminder", obj: r })),
	];
	for (const row of jobsRows) row.key = jobsSortKey(row, now);
	// Two-stage sort: tier first (pending \u2192 agents \u2192 past), then within tier
	// by `sub` ascending. `sub` is `fire` for pending reminders so the next-
	// to-trigger lands at the very top; for agents and past reminders it's
	// negated so the most-recently-active surfaces above older ones.
	jobsRows.sort((x, y) => (x.key.tier - y.key.tier) || (x.key.sub - y.key.sub));
	countEl.textContent = String(jobsRows.length);
	host.innerHTML = "";
	for (const row of jobsRows) {
		const el = row.kind === "agent" ? renderAgentRow(row.obj) : renderReminderRow(row.obj);
		host.appendChild(el);
	}
	if (jobsRows.length === 0) {
		const li = document.createElement("li");
		li.className = "job-row empty";
		li.textContent = "no agents or reminders";
		host.appendChild(li);
	}
}

// Crypto panel: coins + recent chain ops
async function renderCrypto(objects) {
  const host = document.getElementById("crypto-list");
  const countEl = document.getElementById("crypto-count");
  if (!host) return;
  try {
    const [{ buckets }, recent] = await Promise.all([
      fetch("/api/coins").then((r) => r.json()),
      fetch("/api/events/recent").then((r) => r.json()),
    ]);
    countEl.textContent = String(buckets.length);
    host.innerHTML = "";

	for (const b of buckets) {
		const cs = b.coinState;
		const tokenLabel = cs.tokenName
			? (cs.tokenSymbol ? `${cs.tokenName} (${cs.tokenSymbol})` : cs.tokenName)
			: (cs.tokenSymbol || "Coin Bucket");
		const li = document.createElement("li");
		li.className = "crypto-row";
		li.innerHTML = `
			<span class="crypto-dot" style="background:#c0c0c0"></span>
			<span class="crypto-name">${tokenLabel}</span>
			<span class="crypto-meta">${shortId(b.id)} · ${cs.unspentCount} coins · supply ${cs.totalAmount}</span>
		`;
		li.addEventListener("click", () => select(b.id, { focus: true }));
		host.appendChild(li);
	}

    const chainEvents = (recent.events ?? [])
      .filter((ev) => ev.typeKey === "chain.coin.bucket" || (ev.ops ?? []).some((op) => op.preview?.includes("chain.coin.op")))
      .slice(-10)
      .reverse();

    if (chainEvents.length > 0) {
      const section = document.createElement("div");
      section.className = "crypto-section";
      section.innerHTML = "<h4>Recent ops</h4>";
      for (const ev of chainEvents) {
        const op = ev.ops?.find((o) => o.preview);
        const d = document.createElement("div");
        d.className = "crypto-op";
        const preview = op?.preview ?? "chain op";
        d.innerHTML = `<span class="crypto-op-kind">${shortId(ev.objectId)}</span><span class="crypto-op-amount">${preview}</span>`;
        section.appendChild(d);
      }
      host.appendChild(section);
    }

    if (buckets.length === 0) {
      const li = document.createElement("li");
      li.className = "crypto-row empty";
      li.textContent = "no coins";
      host.appendChild(li);
    }
  } catch {
    // keep last paint on transient error
  }
}


// Cached so the 1Hz tick can recompute countdown bars without re-fetching.
let jobsRows = [];

function renderAgentRow(a) {
	const s = a.agentStats;
	const now = Date.now();
	const fill = Math.min(1, s.contextWindow > 0 ? s.effectiveTokens / s.contextWindow : 0);
	const pct = Math.round(fill * 100);
	const ageMs = now - (s.lastActivity ?? 0);
	const active = ageMs < 30_000;
	const li = document.createElement("li");
	li.className = "job-row" + (active ? " active" : "");
	li.title = `${s.userTurns} user / ${s.assistantTurns} assistant turns; ${s.toolUses} tool calls; ${formatNumber(s.effectiveTokens)} of ${formatNumber(s.contextWindow)} tokens (${pct}%)`;
	li.innerHTML = `
		<span class="job-dot"></span>
		<span class="job-name">${escapeHtml(a.name ?? shortId(a.id))}</span>
		<span class="job-meta">agent \u00b7 ${s.userTurns}u / ${s.assistantTurns}a \u00b7 ${formatTimeAgo(ageMs)} \u00b7 ${formatNumber(s.effectiveTokens)} / ${formatNumber(s.contextWindow)} (${pct}%)</span>
		<div class="job-bar"><div class="job-bar-fill" style="width:${pct}%"></div></div>
	`;
	li.addEventListener("click", () => select(a.id, { focus: true }));
	return li;
}

// Reminder lifecycle classes the row visually:
//   pending  (fire_at in future, status not sent/cancelled/failed)
//   live     (fire_at \u2264 now but not yet status=sent: actively firing)
//   sent / failed / cancelled = static, color-coded.
//
// Sort tiers, top to bottom:
//   0  pending reminders          \u2014 ascending fire_at_ms (next first)
//   1  agents                      \u2014 descending lastActivity
//   2  past/cancelled reminders    \u2014 descending fire_at_ms
// Within tier 0 the row at the very top is the next thing about to trigger.
function jobsSortKey(row, now) {
	if (row.kind === "reminder") {
		const sc = row.obj.scalars ?? {};
		const fire = Number(sc.fire_at_ms ?? 0);
		const status = String(sc.status ?? "pending");
		const pending = fire > now && status !== "sent" && status !== "cancelled" && status !== "failed";
		if (pending) return { tier: 0, sub: fire };
		return { tier: 2, sub: -fire };
	}
	const last = row.obj.agentStats?.lastActivity ?? 0;
	return { tier: 1, sub: -last };
}

function renderReminderRow(r) {
	const sc = r.scalars ?? {};
	const now = Date.now();
	const fire = Number(sc.fire_at_ms ?? 0);
	const created = Number(sc.created_at_ms ?? r.createdAt ?? 0);
	const status = String(sc.status ?? "pending");
	const note = String(sc.note ?? sc.channel ?? r.name ?? shortId(r.id));
	const prompt = extractReminderPrompt(sc.payload);
	// Title: prefer the actual task prompt over the category label \u2014 the user
	// has six "Auth-driven job scheduler" reminders that only differ in payload.
	const title = prompt || note;
	const pending = fire > now && status !== "sent" && status !== "cancelled" && status !== "failed";
	const total = Math.max(1, fire - created);
	const elapsed = Math.max(0, Math.min(total, now - created));
	const pct = Math.round((elapsed / total) * 100);
	let meta;
	if (pending) {
		meta = `reminder \u00b7 fires in ${formatDuration(fire - now)}`;
	} else if (status === "sent") {
		meta = `reminder \u00b7 fired ${formatTimeAgo(now - fire)}`;
	} else {
		meta = `reminder \u00b7 ${status} ${formatTimeAgo(now - fire)}`;
	}
	const li = document.createElement("li");
	li.className = `job-row reminder status-${status}` + (pending ? " pending" : "");
	const tooltipLines = [
		note && note !== title ? `${note}` : null,
		prompt && prompt !== title ? `prompt: ${prompt}` : null,
		`status: ${status}`,
		`fire_at: ${new Date(fire).toLocaleString()}`,
		`created: ${new Date(created).toLocaleString()}`,
	].filter(Boolean);
	li.title = tooltipLines.join("\n");
	li.dataset.kind = "reminder";
	li.dataset.fire = String(fire);
	li.dataset.created = String(created);
	li.innerHTML = `
		<span class="job-dot"></span>
		<span class="job-name">${escapeHtml(title)}</span>
		<span class="job-meta">${meta}</span>
		<div class="job-bar"><div class="job-bar-fill" style="width:${pct}%"></div></div>
	`;
	li.addEventListener("click", () => select(r.id, { focus: true }));
	return li;
}

// Reminders carry their actual task description in `payload`, which is a
// JSON string whose value is itself a JSON object \u2014 typically `{"prompt":"..."}`.
// Two unwraps gets us the prompt; absence on either layer yields "".
function extractReminderPrompt(raw) {
	if (raw == null) return "";
	let v = raw;
	for (let i = 0; i < 2 && typeof v === "string"; i++) {
		try { v = JSON.parse(v); } catch { return ""; }
	}
	if (v && typeof v === "object" && typeof v.prompt === "string") return v.prompt;
	return "";
}

// Friendly forward-duration formatter used for fires-in countdowns.
function formatDuration(ms) {
	if (ms < 0) ms = 0;
	if (ms < 1000) return "<1s";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) {
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		return s > 0 ? `${m}m ${s}s` : `${m}m`;
	}
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	return `${h}h ${m}m`;
}

function formatTimeAgo(ms) {
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

function refreshPickables() {
	pickables = [];
	cosmosCtx.group.traverse((obj) => {
		if (obj.userData?.kind === "object") pickables.push(obj);
	});

}

function bindUI() {
	document.addEventListener("keydown", (e) => {
		// Esc clears the current selection.
		if (e.key === "Escape") {
			selectedId = null;
			clearInspector();
			highlightSelected();
			return;
		}
		// WASD / Space pan — ignore when typing in inputs.
		const tag = document.activeElement?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") return;
		const k = e.key.toLowerCase();
		if (k in keys) keys[k] = true;
		if (e.code === "Space") keys.space = true;
		if (e.key === "Shift") keys.shift = true;
		if (e.key === "Control") keys.ctrl = true;
	});
	document.addEventListener("keyup", (e) => {
		const k = e.key.toLowerCase();
		if (k in keys) keys[k] = false;
		if (e.code === "Space") keys.space = false;
		if (e.key === "Shift") keys.shift = false;
		if (e.key === "Control") keys.ctrl = false;
	});

	bindInspector({
		onNavigate: (id) => select(id, { focus: true }),
		onInject: () => scheduleContextRefresh(),
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

		// Draggable panels — whole top 36px is the grab area
		makeDraggable("legend",    null, "glonAstrolabe.panelPos.legend");
		makeDraggable("jobs",      null, "glonAstrolabe.panelPos.jobs");
		makeDraggable("inspector", null, "glonAstrolabe.panelPos.inspector");
		makeDraggable("crypto",    null, "glonAstrolabe.panelPos.crypto");
		makeDraggable("livelog",   null, "glonAstrolabe.panelPos.livelog");
		// Resizable panels — bottom-right corner handle
		makeResizable("legend",    "glonAstrolabe.panelSize.legend");
		makeResizable("jobs",      "glonAstrolabe.panelSize.jobs");
		makeResizable("inspector", "glonAstrolabe.panelSize.inspector");
		makeResizable("crypto",    "glonAstrolabe.panelSize.crypto");
		makeResizable("livelog",   "glonAstrolabe.panelSize.livelog");

		// Collapsible panels
		document.querySelectorAll(".panel-collapse").forEach((btn) => {
			const panelId = btn.dataset.panel;
			const panel = document.getElementById(panelId);
			if (!panel) return;
			btn.addEventListener("pointerdown", (e) => {
				e.stopPropagation(); // prevent panel drag from starting
			});
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const collapsed = panel.classList.toggle("collapsed");
				btn.textContent = collapsed ? "▲" : "─";
				btn.title = collapsed ? "Expand" : "Collapse";
			});
		});
	}



	let activeTween = null;
	function tweenCamera(targetPos, targetLookAt) {
		// Ghost camera: placed at the actual destination, looking at the target.
		// This produces the correct quaternion for an offset birds-eye position.
		const ghost = new THREE.PerspectiveCamera();
		ghost.position.copy(targetPos);
		ghost.lookAt(targetLookAt);

		const fromPos = camera.position.clone();
		const fromQuat = camera.quaternion.clone();
		const toPos = ghost.position.clone();
		const toQuat = ghost.quaternion.clone();

		const savedDamping = controls.enableDamping;
		controls.enabled = false;
		controls.enableDamping = false;

		const t0 = performance.now();
		const dur = 900;
		activeTween = (now) => {
			const t = Math.min(1, (now - t0) / dur);
			const k = easeInOut(t);
			camera.position.lerpVectors(fromPos, toPos, k);
			camera.quaternion.slerpQuaternions(fromQuat, toQuat, k);
			if (t >= 1) {
				activeTween = null;
				controls.target.copy(targetLookAt);
				camera.position.copy(toPos);
				camera.quaternion.copy(toQuat);
				const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
				controls._spherical.setFromVector3(offset);
				controls._spherical.makeSafe();
				controls._sphericalDelta.set(0, 0, 0);
				controls._panOffset.set(0, 0, 0);
				controls._scale = 1;
				controls.enabled = true;
				controls.enableDamping = savedDamping;
				controls.update();
			}
		};
	}

function easeInOut(t) {
	return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ── Interaction ───────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let pointer = { x: 0, y: 0 };

// Cursor magnet: the animate loop reads `cursorActive` to decide whether to
// pass the current cursor ray to per-view tick fns. Set false on mouseleave so
// balls relax back to their float position when the pointer isn't on the canvas.
let cursorActive = false;

	function onPointerMove(e) {
		pointer.x = e.clientX;
		pointer.y = e.clientY;
		mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
		mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
		cursorActive = e.target === renderer.domElement;
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
		if (ud.kind === "object") {
			select(ud.id);
		}
}

function onDoubleClick(e) {
	if (e.target !== renderer.domElement) return;
	raycaster.setFromCamera(mouse, camera);
	const hits = raycaster.intersectObjects(visiblePickables(), false);
	const first = hits[0]?.object;
	if (!first) return;
	const ud = first.userData;
	if (ud.kind === "object") {
		const target = first.position.clone();
		const birdsEyePos = new THREE.Vector3(target.x + 4, target.y + 35, target.z + 4);
		tweenCamera(birdsEyePos, target);
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
	cosmosCtx?.setSelected?.(selectedId);
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

// Navigate to a specific block: select the owning agent and surface the
// block content in the inspector. Out-of-context blocks render a recall
// button automatically.
async function navigateToBlock(agentId, blockId) {
	select(agentId, { focus: true });
	try {
		const conv = await fetch(`/api/agents/${encodeURIComponent(agentId)}/conversation`).then((r) => r.json());
		const block = (conv?.blocks ?? []).find((b) => b.id === blockId);
		if (block) showBlockInInspector(block, agentId);
	} catch (err) {
		console.warn("navigateToBlock failed", err);
	}
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

	const t = now / 1000;
	const ray = cursorActive ? raycaster.ray : null;
	// Cosmos: balls float gently and lean toward the cursor; tubes follow them.
	if (cosmosCtx?.tick && cosmosCtx.group.visible) cosmosCtx.tick(t, ray);
	updateOverlays(camera, renderer);
	if (!activeTween) {
		// WASD pan: move camera + target in the horizontal plane.
		const fwd = new THREE.Vector3();
		camera.getWorldDirection(fwd);
		fwd.y = 0;
		fwd.normalize();
		const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
		const pan = new THREE.Vector3();
		if (keys.w) pan.add(fwd);
		if (keys.s) pan.sub(fwd);
		if (keys.d) pan.add(right);
		if (keys.a) pan.sub(right);
		if (pan.lengthSq() > 0) {
			pan.normalize().multiplyScalar(PAN_SPEED * dt);
			camera.position.add(pan);
			controls.target.add(pan);
		}
		// Space = fly up, Shift+Space = fly down
		if (keys.space) {
			const up = keys.shift ? -1 : 1;
			const v = PAN_SPEED * dt * up;
			camera.position.y += v;
			controls.target.y += v;
		}
		controls.update();
	}
	composer.render();
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
		const dpr = window.devicePixelRatio || 1;
		// Show all labels when Ctrl is held, otherwise only pinned (selected/hovered).
		// Skip protobuf-like names — use shortId instead.
		for (const [id, node] of cosmosCtx.nodes) {
			const obj = node.mesh.userData.obj;
			const isPinned = id === selectedId || id === hoverId;
			if (!node.mesh.visible) continue;
			if (!isPinned && !keys.ctrl) continue;

			screen.copy(node.mesh.position);
			screen.project(camera);
			if (screen.z > 1) continue;

			const px = (screen.x * 0.5 + 0.5) * window.innerWidth;
			const py = (-screen.y * 0.5 + 0.5) * window.innerHeight;
			const x = px * dpr;
			const y = py * dpr;

			const { hex } = colorForType(obj.typeKey);
			const rawName = obj.name;
			const label = isProtobufName(rawName) ? shortId(obj.id) : (rawName ?? shortId(obj.id));
			labelCtx.fillStyle = "rgba(5,6,10,.75)";
			const metrics = labelCtx.measureText(label);
			const padX = 6, padY = 3;
			labelCtx.fillRect(x + 12, y - 8, metrics.width + padX * 2, 18);
			labelCtx.fillStyle = hex;
			labelCtx.fillText(label, x + 12 + padX, y - 8 + padY);
		}
	}

// \u2500\u2500 HUD reference grid \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Build a fixed cols\u00d7rows screen-space grid the user can use to point
// out cosmos balls without panning. Cells are addressed `<col><row>`,
// e.g. `A1` is top-left, `H4` is bottom-right at 8\u00d74. CSS handles the
// layout via custom properties so this stays the only source of truth
// for the cell count.
function setupHudGrid(cols, rows) {
	const host = document.getElementById("grid-overlay");
	if (!host) return;
	host.style.setProperty("--grid-cols", String(cols));
	host.style.setProperty("--grid-rows", String(rows));
	host.replaceChildren();
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const cell = document.createElement("div");
			cell.className = "grid-cell";
			if (c === cols - 1) cell.classList.add("col-last");
			if (r === rows - 1) cell.classList.add("row-last");
			const label = document.createElement("span");
			label.className = "grid-label";
			label.textContent = `${columnLabel(c)}${r + 1}`;
			cell.appendChild(label);
			host.appendChild(cell);
		}
	}
}

// Spreadsheet-style column label: 0\u2192A, 25\u2192Z, 26\u2192AA, 27\u2192AB.
function columnLabel(idx) {
	let s = "";
	let n = idx;
	for (;;) {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
		if (n < 0) break;
	}
	return s;
}

// \u2500\u2500 Draggable panels \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Wire pointer-based drag on `panel`, initiated only from `handle`. The
// panel keeps its CSS-defined initial position until the first drag, at
// which point it switches to absolute top/left so subsequent drags can
// move freely. Position is persisted to localStorage under `storageKey`
// and restored on next load. Reclamp on viewport resize keeps panels
// from disappearing when the window shrinks (see reclampDraggablePanels).
//
// Constraint: the panel never disappears entirely; we keep at least
// HANDLE_MARGIN px of the panel on every screen edge so the user can
// always grab the handle to drag it back.
const HANDLE_MARGIN = 40;
const draggablePanels = new Set();

	function makeDraggable(panelId, handleSelector, storageKey) {
		const panel = document.getElementById(panelId);
		if (!panel) return;
		draggablePanels.add(panel);

		// Restore saved position.
		try {
			const raw = localStorage.getItem(storageKey);
			if (raw) {
				const saved = JSON.parse(raw);
				if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
					requestAnimationFrame(() => applyClampedPosition(panel, saved.left, saved.top));
				}
			}
		} catch { /* ignore */ }

		let pointerId = null;
		let offsetX = 0;
		let offsetY = 0;

		// If a handle selector is provided, only that element starts the drag.
		// Otherwise the whole top 36px of the panel is the drag area.
		const target = handleSelector ? panel.querySelector(handleSelector) : panel;
		if (!target) return;

		target.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			const rect = panel.getBoundingClientRect();
			// When no handle selector, only respond to clicks in the top 36px
			if (!handleSelector) {
				const localY = e.clientY - rect.top;
				if (localY > 36) return;
			}
			offsetX = e.clientX - rect.left;
			offsetY = e.clientY - rect.top;
			applyAbsolutePosition(panel, rect.left, rect.top);
			pointerId = e.pointerId;
			target.setPointerCapture(pointerId);
			panel.classList.add("panel-dragging");
			e.preventDefault();
			e.stopPropagation();
		});

		target.addEventListener("pointermove", (e) => {
			if (e.pointerId !== pointerId) return;
			applyClampedPosition(panel, e.clientX - offsetX, e.clientY - offsetY);
		});

		const finish = (e) => {
			if (e.pointerId !== pointerId) return;
			if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
			pointerId = null;
			panel.classList.remove("panel-dragging");
			const left = parseFloat(panel.style.left);
			const top = parseFloat(panel.style.top);
			if (Number.isFinite(left) && Number.isFinite(top)) {
				try { localStorage.setItem(storageKey, JSON.stringify({ left, top })); }
				catch { /* ignore */ }
			}
		};
		target.addEventListener("pointerup", finish);
		target.addEventListener("pointercancel", finish);
	}

function applyAbsolutePosition(panel, left, top) {
	panel.style.left   = left + "px";
	panel.style.top    = top  + "px";
	panel.style.right  = "auto";
	panel.style.bottom = "auto";
}

function applyClampedPosition(panel, left, top) {
	const w = panel.offsetWidth;
	const h = panel.offsetHeight;
	const clampedLeft = Math.max(HANDLE_MARGIN - w, Math.min(window.innerWidth  - HANDLE_MARGIN, left));
	// Keep at least HANDLE_MARGIN of the panel below the top edge so the
	// grip stays inside the viewport even after a drag-and-resize.
	const clampedTop  = Math.max(0,                 Math.min(window.innerHeight - HANDLE_MARGIN, top));
	applyAbsolutePosition(panel, clampedLeft, clampedTop);
	}

	// ── Resizable panels ─────────────────────────────────────────────

	function makeResizable(panelId, storageKey) {
		const panel = document.getElementById(panelId);
		if (!panel) return;

		// Create resize handle
		const handle = document.createElement("div");
		handle.className = "panel-resize-handle";
		handle.title = "drag to resize";
		panel.appendChild(handle);

		// Restore saved size
		try {
			const raw = localStorage.getItem(storageKey);
			if (raw) {
				const saved = JSON.parse(raw);
				if (Number.isFinite(saved?.width))  panel.style.width  = saved.width + "px";
				if (Number.isFinite(saved?.height)) panel.style.height = saved.height + "px";
			}
		} catch { /* ignore */ }

		let pointerId = null;
		let startX = 0;
		let startY = 0;
		let startW = 0;
		let startH = 0;

		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			const rect = panel.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			startW = rect.width;
			startH = rect.height;
			pointerId = e.pointerId;
			handle.setPointerCapture(pointerId);
			e.preventDefault();
			e.stopPropagation();
		});

		handle.addEventListener("pointermove", (e) => {
			if (e.pointerId !== pointerId) return;
			const minW = 160;
			const minH = 80;
			const newW = Math.max(minW, startW + (e.clientX - startX));
			const newH = Math.max(minH, startH + (e.clientY - startY));
			panel.style.width = newW + "px";
			panel.style.height = newH + "px";
		});

		const finish = (e) => {
			if (e.pointerId !== pointerId) return;
			if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
			pointerId = null;
			const w = parseFloat(panel.style.width);
			const h = parseFloat(panel.style.height);
			if (Number.isFinite(w) && Number.isFinite(h)) {
				try { localStorage.setItem(storageKey, JSON.stringify({ width: w, height: h })); }
				catch { /* ignore */ }
			}
		};
		handle.addEventListener("pointerup", finish);
		handle.addEventListener("pointercancel", finish);
	}

	// Re-clamp every panel after the viewport resizes so a wide-then-narrow
// browser doesn't strand a panel off-screen. Only panels that have been
// dragged at least once participate \u2014 untouched panels keep their CSS-
// anchored layout (which is itself responsive).
function reclampDraggablePanels() {
	for (const panel of draggablePanels) {
		if (!panel.style.left) continue;
		const left = parseFloat(panel.style.left);
		const top  = parseFloat(panel.style.top);
		if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
		applyClampedPosition(panel, left, top);
	}
}

// ── Utilities ─────────────────────────────────────────────────────

function onResize() {
	const w = window.innerWidth;
	const h = window.innerHeight;
	const dpr = window.devicePixelRatio || 1;
	renderer.setSize(w, h);
	composer?.setSize(w, h);
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

	function isProtobufName(name) {
		if (!name) return false;
		// Actual .pb filenames
		if (name.endsWith(".pb")) return true;
		// Hex hashes (sha256-like)
		if (/^[0-9a-f]{16,}$/i.test(name)) return true;
		// UUIDs
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return true;
		return false;
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
