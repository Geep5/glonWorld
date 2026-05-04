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
	scalarsSection: document.getElementById("insp-scalars-section"),
	scalars: document.getElementById("insp-scalars"),
	linksSection: document.getElementById("insp-links-section"),
	links: document.getElementById("insp-links"),
	contentSection: document.getElementById("insp-content-section"),
	contentTitle: document.getElementById("insp-content-title"),
	contentBody: document.getElementById("insp-content"),
	changes: document.getElementById("insp-changes"),
	changeCount: document.getElementById("insp-change-count"),
	tokenSection: document.getElementById("insp-token-section"),
	tokenHeader: document.getElementById("insp-token-header"),
	tokenBalances: document.getElementById("insp-token-balances"),
	tokenOps: document.getElementById("insp-token-ops"),
	coinSection: document.getElementById("insp-coin-section"),
	coinHeader: document.getElementById("insp-coin-header"),
	coinList: document.getElementById("insp-coin-list"),
	// Landing placeholder stats
	stats: document.getElementById("stats"),
};

let handlers = {};

export function bindInspector({ onNavigate, onInject }) {
	handlers = { onNavigate, onInject };
}

let contextState = { agentId: null, contextIds: new Set() };
// Called by main.js whenever the in-context set is refreshed so the inspect
// button can flip between 'inject' and 'already in context'.
export function setContextState(next) {
	contextState = next;
	if (currentId) renderInjectSection();
}

function renderInjectSection() {
	const host = document.getElementById("insp-inject");
	if (!host) return;
	host.innerHTML = "";
	if (!currentId || !contextState.agentId) return;
	if (currentId === contextState.agentId) return;       // the agent itself
	const inContext = contextState.contextIds.has(currentId);
	if (inContext) {
		const note = document.createElement("div");
		note.className = "insp-context-note";
		note.textContent = "\u2713 currently in agent context";
		host.appendChild(note);
		return;
	}
	const btn = document.createElement("button");
	btn.className = "recall-btn";
	btn.textContent = "\u2192 Inject into context";
	btn.title = "Post a user_text describing this object so the agent's next turn sees it.";
	btn.addEventListener("click", async () => {
		btn.disabled = true;
		btn.textContent = "Injecting\u2026";
		try {
			const objectId = currentId;
			const r = await fetch(`/api/agents/${encodeURIComponent(contextState.agentId)}/inject/${encodeURIComponent(objectId)}`, { method: "POST" });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
			btn.textContent = "Injected \u2713 (agent will reply on next turn)";
			btn.classList.add("ok");
			handlers.onInject?.(objectId);
		} catch (err) {
			btn.textContent = `Inject failed: ${err?.message ?? err}`;
			btn.classList.add("err");
		}
	});
	host.appendChild(btn);
	const note = document.createElement("div");
	note.className = "recall-note";
	note.textContent = "This object isn't in the agent's current context. Inject posts a user_text reference so the next assistant turn can see it.";
	host.appendChild(note);
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
		hint.textContent = `Tip: click ${agent.name ?? "the agent"} (the bright glowing node) to inspect, or click any other ball to see what it is. Activity heat fades over a minute.`;
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

	// Token section ------------------------------------------------
	if (detail.tokenState) {
		els.tokenSection.hidden = false;
		els.scalarsSection.hidden = true;
		els.linksSection.hidden = true;
		renderTokenSection(detail.tokenState, detail.walletPubkeys ?? []);
	} else {
		els.tokenSection.hidden = true;
	}

	// Coin bucket section ----------------------------------------
	if (detail.coinState) {
		els.coinSection.hidden = false;
		els.scalarsSection.hidden = true;
		els.linksSection.hidden = true;
		renderCoinSection(detail.coinState);
	} else {
		els.coinSection.hidden = true;
	}

	// Content preview -------------------------------------------
	if (detail.contentPreview) {
		els.contentSection.hidden = false;
		els.contentTitle.textContent = guessContentTitle(obj.typeKey);
		els.contentBody.textContent = detail.contentPreview;
	} else {
		els.contentSection.hidden = true;
	}

	renderInjectSection();

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

function renderTokenSection(ts, walletPubkeys) {
	const walletSet = new Set(walletPubkeys);
	els.tokenHeader.innerHTML = "";
	append(els.tokenHeader, row("name", `${ts.name} (${ts.symbol})`));
	append(els.tokenHeader, row("decimals", String(ts.decimals)));
	append(els.tokenHeader, row("total supply", formatTokenAmount(ts.totalSupply, ts.decimals)));
	const owner = ts.ownerPubkey ? shortId(ts.ownerPubkey) : "renounced";
	append(els.tokenHeader, row("owner", owner + (ts.renounced ? " (renounced)" : "")));

	els.tokenBalances.innerHTML = "";
	const entries = Object.entries(ts.balances).sort(([, a], [, b]) => Number(BigInt(b) - BigInt(a)));
	if (entries.length === 0) {
		els.tokenBalances.textContent = "No holders yet.";
	} else {
		for (const [pubkey, balance] of entries) {
			const d = document.createElement("div");
			d.className = "token-balance-row";
			const isWallet = walletSet.has(pubkey);
			const walletBadge = isWallet ? '<span class="token-balance-wallet">your wallet</span>' : "";
			d.innerHTML = `<span class="token-balance-pubkey">${shortId(pubkey)}${walletBadge}</span><span class="token-balance-value">${formatTokenAmount(balance, ts.decimals)}</span>`;
			els.tokenBalances.appendChild(d);
		}
	}

	els.tokenOps.innerHTML = "";
	const ops = ts.ops.slice().reverse().slice(0, 20);
	if (ops.length === 0) {
		els.tokenOps.textContent = "No operations yet.";
	} else {
		for (const op of ops) {
			const d = document.createElement("div");
			d.className = "token-op-row";
			let detail = "";
			if (op.amount) detail += formatTokenAmount(op.amount, ts.decimals);
			if (op.from) detail += ` from ${shortId(op.from)}`;
			if (op.to) detail += ` to ${shortId(op.to)}`;
			if (op.spender) detail += ` spender ${shortId(op.spender)}`;
			d.innerHTML = `<span class="token-op-kind">${op.kind}</span><span class="token-op-detail">${detail}</span><span class="token-op-time">${shortId(op.signer)}</span>`;
			els.tokenOps.appendChild(d);
		}
	}
}

function renderCoinSection(cs) {
	els.coinHeader.innerHTML = "";
	append(els.coinHeader, row("token", shortId(cs.tokenId)));
	append(els.coinHeader, row("coins", `${cs.unspentCount} unspent / ${cs.coinCount} total`));
	append(els.coinHeader, row("supply", cs.totalAmount));

	els.coinList.innerHTML = "";
	const entries = Object.entries(cs.coins);
	if (entries.length === 0) {
		els.coinList.textContent = "No coins yet.";
	} else {
		for (const [coinId, coin] of entries) {
			const d = document.createElement("div");
			d.className = "token-balance-row";
			const status = coin.spent ? "spent" : "unspent";
			d.innerHTML = `<span class="token-balance-pubkey">${shortId(coinId)}</span><span class="token-balance-value">${coin.amount} ${status}</span>`;
			els.coinList.appendChild(d);
		}
	}
}

function formatTokenAmount(raw, decimals) {
	if (!raw) return "0";
	try {
		const n = BigInt(raw);
		if (decimals === 0) return n.toString();
		const s = n.toString().padStart(decimals + 1, "0");
		const intPart = s.slice(0, -decimals) || "0";
		const fracPart = s.slice(-decimals).replace(/0+$/, "");
		return fracPart ? `${intPart}.${fracPart}` : intPart;
	} catch {
		return raw;
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
