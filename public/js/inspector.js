/**
 * Inspector panel — renders object detail, change DAG, link list,
 * and agent summary into the right-side panel. Pure DOM builder:
 * nothing here knows about three.js.
 */

import { colorForType } from "./colors.js";

const els = {
	empty: document.getElementById("inspector-empty"),
	content: document.getElementById("inspector-content"),
	typeBadge: document.getElementById("insp-type"),
	title: document.getElementById("insp-title"),
	subtitle: document.getElementById("insp-subtitle"),
	agentSection: document.getElementById("insp-agent-section"),
	agentStats: document.getElementById("insp-agent-stats"),
	enterAgent: document.getElementById("btn-enter-agent"),
	scalarsSection: document.getElementById("insp-scalars-section"),
	scalars: document.getElementById("insp-scalars"),
	linksSection: document.getElementById("insp-links-section"),
	links: document.getElementById("insp-links"),
	contentSection: document.getElementById("insp-content-section"),
	contentTitle: document.getElementById("insp-content-title"),
	contentBody: document.getElementById("insp-content"),
	changes: document.getElementById("insp-changes"),
	changeCount: document.getElementById("insp-change-count"),
	// Landing placeholder stats
	stats: document.getElementById("stats"),
};

let handlers = {};

export function bindInspector({ onNavigate, onEnterAgent }) {
	handlers = { onNavigate, onEnterAgent };
	els.enterAgent.addEventListener("click", () => {
		if (handlers.onEnterAgent && currentId) handlers.onEnterAgent(currentId);
	});
}

let currentId = null;

export function setLanding(state) {
	const agent = state.objects.find((o) => o.typeKey === "agent");
	els.stats.innerHTML = "";
	const rows = [
		["objects", state.objects.length],
		["links", state.links.length],
		["types", Object.keys(state.byType).length],
		["agents", state.objects.filter((o) => o.typeKey === "agent").length],
		["programs", state.objects.filter((o) => o.typeKey === "program").length],
	];
	if (agent?.agentStats) {
		rows.push(["agent turns", `${agent.agentStats.userTurns}u / ${agent.agentStats.assistantTurns}a`]);
		rows.push(["agent tool calls", agent.agentStats.toolUses]);
		rows.push(["agent tokens", `≈${formatNumber(agent.agentStats.effectiveTokens)}`]);
	}
	for (const [k, v] of rows) {
		els.stats.appendChild(row(k, v));
	}
	if (agent) {
		const hint = document.createElement("p");
		hint.style.marginTop = "14px";
		hint.style.fontSize = "12px";
		hint.style.color = "var(--accent)";
		hint.textContent = `Tip: click "Agent" in the top-right or double-click the bright node to enter ${agent.name ?? "the agent"}.`;
		els.empty.appendChild(hint);
	}
}

export async function showObject(id) {
	currentId = id;
	const [detail, changes] = await Promise.all([
		fetch(`/api/objects/${id}`).then((r) => r.json()),
		fetch(`/api/objects/${id}/changes`).then((r) => r.json()),
	]);
	render(detail, changes);
}

export function clear() {
	currentId = null;
	els.empty.hidden = false;
	els.content.hidden = true;
}

function render(detail, changesResponse) {
	const obj = detail.object;
	els.empty.hidden = true;
	els.content.hidden = false;

	// Header ------------------------------------------------------
	const { hex } = colorForType(obj.typeKey);
	els.typeBadge.textContent = obj.typeKey;
	els.typeBadge.style.background = `color-mix(in oklab, ${hex} 65%, #000)`;
	els.title.textContent = obj.name ?? shortId(obj.id);
	const pieces = [obj.id];
	if (obj.createdAt) pieces.push(`created ${formatTime(obj.createdAt)}`);
	if (obj.updatedAt && obj.updatedAt !== obj.createdAt) pieces.push(`updated ${formatTime(obj.updatedAt)}`);
	els.subtitle.textContent = pieces.join(" · ");

	// Agent section ----------------------------------------------
	if (obj.agentStats) {
		els.agentSection.hidden = false;
		els.agentStats.innerHTML = "";
		const s = obj.agentStats;
		append(els.agentStats, row("model", s.model ?? "—"));
		append(els.agentStats, row("turns", `${s.userTurns} user · ${s.assistantTurns} assistant`));
		append(els.agentStats, row("tool calls", `${s.toolUses} (${s.toolResults} results)`));
		append(els.agentStats, row("compactions", String(s.compactions)));
		append(els.agentStats, row("effective tokens", `≈${formatNumber(s.effectiveTokens)}`));
		append(els.agentStats, row("tools registered", String(s.toolCount)));
		if (s.system) {
			const r = row("system", "");
			const v = r.querySelector(".v");
			v.classList.add("long");
			v.textContent = s.system;
			append(els.agentStats, r);
		}
	} else {
		els.agentSection.hidden = true;
	}

	// Scalars ----------------------------------------------------
	const scalars = Object.entries(detail.rawFields).filter(([, v]) => {
		return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
	});
	if (scalars.length > 0) {
		els.scalarsSection.hidden = false;
		els.scalars.innerHTML = "";
		for (const [k, v] of scalars) {
			const r = row(k, String(v));
			const el = r.querySelector(".v");
			if (typeof v === "string" && v.length > 60) el.classList.add("long");
			append(els.scalars, r);
		}
	} else {
		els.scalarsSection.hidden = true;
	}

	// Links ------------------------------------------------------
	const hasLinks = detail.outLinks.length + detail.inLinks.length > 0;
	if (hasLinks) {
		els.linksSection.hidden = false;
		els.links.innerHTML = "";
		for (const l of detail.outLinks) {
			els.links.appendChild(linkRow("→", l.relationKey, l.targetId, l.fieldPath));
		}
		for (const l of detail.inLinks) {
			els.links.appendChild(linkRow("←", l.relationKey, l.sourceId, l.fieldPath));
		}
	} else {
		els.linksSection.hidden = true;
	}

	// Content preview -------------------------------------------
	if (detail.contentPreview) {
		els.contentSection.hidden = false;
		els.contentTitle.textContent = guessContentTitle(obj.typeKey);
		els.contentBody.textContent = detail.contentPreview;
	} else {
		els.contentSection.hidden = true;
	}

	// Changes DAG (mini) ----------------------------------------
	const changes = changesResponse.changes ?? [];
	els.changes.innerHTML = "";
	els.changeCount.textContent = `${changes.length} change${changes.length === 1 ? "" : "s"}`;
	// Sort newest first
	const sorted = [...changes].sort((a, b) => b.timestamp - a.timestamp);
	const headSet = new Set(obj.headIds);
	for (const ch of sorted) {
		const row = document.createElement("div");
		row.className = "change-row" + (headSet.has(ch.id) ? " head" : "");
		const dot = document.createElement("span"); dot.className = "dot";
		const hash = document.createElement("span"); hash.className = "hash"; hash.textContent = ch.id.slice(0, 10);
		const ops = document.createElement("span"); ops.className = "ops";
		ops.textContent = ch.opSummary.join(" ");
		ops.title = ch.opSummary.join("\n");
		row.appendChild(dot); row.appendChild(hash); row.appendChild(ops);
		els.changes.appendChild(row);
	}
}

// ── DOM helpers ────────────────────────────────────────────────

function row(k, v) {
	const d = document.createElement("div");
	d.className = "k";
	d.textContent = k;
	const v2 = document.createElement("div");
	v2.className = "v";
	v2.textContent = v;
	const wrap = document.createDocumentFragment();
	wrap.appendChild(d);
	wrap.appendChild(v2);
	const container = document.createElement("div");
	container.style.display = "contents";
	container.appendChild(wrap);
	return container;
}

function append(parent, frag) {
	for (const node of [...frag.children]) parent.appendChild(node);
}

function linkRow(arrow, relation, targetId, fieldPath) {
	const d = document.createElement("div");
	d.className = "link-row";
	d.innerHTML = `<span class="dir">${arrow}</span><span class="rel">${escapeHtml(relation)}</span><span class="id">${shortId(targetId)}</span>`;
	d.title = fieldPath;
	d.addEventListener("click", () => handlers.onNavigate?.(targetId));
	return d;
}

function guessContentTitle(typeKey) {
	if (typeKey === "typescript") return "TypeScript source";
	if (typeKey === "javascript") return "JavaScript source";
	if (typeKey === "proto") return "Proto definition";
	if (typeKey === "json") return "JSON content";
	return "Content";
}

function shortId(id) {
	if (!id) return "";
	return id.length > 14 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function formatTime(ms) {
	if (!ms) return "";
	const d = new Date(ms);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatNumber(n) {
	if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
	return String(n);
}

function escapeHtml(s) {
	return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[c]));
}
