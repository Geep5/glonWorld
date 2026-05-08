/**
 * glonAstrolabe — HTTP server.
 *
 * Routes:
 *   GET /api/state                       graph snapshot (objects + links + types + timeline)
 *   GET /api/objects/:id                 full detail + outbound/inbound links + raw fields
 *   GET /api/objects/:id/changes         the object's change DAG
 *   GET /api/agents/:id/conversation     classified blocks + registered tools
 *   GET /api/events                      live SSE stream of glon changes (tool calls, blocks, fields)
 *   GET /api/events/recent               last ≤200 events as JSON
 *   GET /api/meta                        host/data root info
 *   static /                             frontend from public/
 *   static /vendor/*                     mapped to node_modules/three/* for bare ES imports
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { snapshot, getObjectDetail, getObjectChanges, getAgentConversation, getAgentContextRefs, getRoot, search, getWalletPubkeys } from "./reader.js";
	import { getCoinOverview } from "./reader.js";
	import { getGlobalCoinStatsViaDaemon } from "./coins.js";
	import { getPrograms, DAEMON_URL } from "./daemon-client.js";
	import { startWatcher, streamEvents, recentEvents } from "./events.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// ── API ────────────────────────────────────────────────────────────

app.get("/api/meta", (_req, res) => {
	res.json({
		root: getRoot(),
		now: Date.now(),
	});
});

app.get("/api/state", (_req, res) => {
	res.json(snapshot());
});

app.get("/api/objects/:id", (req, res) => {
	const detail = getObjectDetail(req.params.id);
	if (!detail) return res.status(404).json({ error: "not found" });
	res.json(detail);
});

app.get("/api/objects/:id/changes", (req, res) => {
	const changes = getObjectChanges(req.params.id);
	if (!changes) return res.status(404).json({ error: "not found" });
	res.json({ id: req.params.id, changes });
});

app.get("/api/agents/:id/conversation", (req, res) => {
	const conv = getAgentConversation(req.params.id);
	if (!conv) return res.status(404).json({ error: "agent not found" });
	res.json(conv);
});

// Object ids referenced by any in-context block of this agent. Used by the
// cosmos to render context-active balls with a persistent halo and to gate
// the inject button.
app.get("/api/agents/:id/context", (req, res) => {
	const c = getAgentContextRefs(req.params.id);
	if (!c) return res.status(404).json({ error: "agent not found" });
	res.json({ agentId: req.params.id, agentName: c.agent.name, objectIds: c.objectIds });
});

	// Send a message to an agent. Proxies to the glon daemon at GLON_DISPATCH_URL.
	app.post("/api/agents/:id/chat", async (req, res) => {
		const { id } = req.params;
		const { message } = req.body;
		if (!message || typeof message !== "string") {
			return res.status(400).json({ error: "message required" });
		}
		const dispatchUrl = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;
		try {
			const r = await fetch(dispatchUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prefix: "/agent", action: "ask", args: [id, message] }),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ error: `glon daemon dispatch failed (${r.status})`, body });
			}
			const data = await r.json();
			res.json({ ok: true, agentId: id, message, result: data.result ?? data });
		} catch (err: any) {
			res.status(503).json({ error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});
// Inject an object into an agent's context: post a user_text via /agent ask
// describing the object. Triggers one assistant turn but the reference stays
// in context for every subsequent turn until the next compaction.
app.post("/api/agents/:agentId/inject/:objectId", async (req, res) => {
	const { agentId, objectId } = req.params;
	const detail = getObjectDetail(objectId);
	if (!detail) return res.status(404).json({ error: "object not found" });
	const summary = injectSummary(detail);
	const dispatchUrl = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;
	try {
		const r = await fetch(dispatchUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prefix: "/agent", action: "ask", args: [agentId, summary] }),
		});
		if (!r.ok) {
			const body = await r.text();
			return res.status(502).json({ error: `glon daemon dispatch failed (${r.status})`, body });
		}
		res.json({ ok: true, agentId, objectId, summary });
	} catch (err: any) {
		res.status(503).json({ error: "could not reach glon daemon", detail: err?.message ?? String(err) });
	}
});

function injectSummary(detail: { object: { id: string; typeKey: string; name?: string }; rawFields: Record<string, unknown>; contentPreview?: string }): string {
	const { object: obj, rawFields, contentPreview } = detail;
	const lines: string[] = [];
	const label = obj.name ? `"${obj.name}"` : obj.id.slice(0, 8);
	lines.push(`(glonAstrolabe inject) Reference \u2014 the user wants you aware of this object:`);
	lines.push(`  type: ${obj.typeKey}`);
	lines.push(`  name: ${label}`);
	lines.push(`  id:   ${obj.id}`);
	const scalars = Object.entries(rawFields)
		.filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
		.slice(0, 6);
	if (scalars.length > 0) {
		lines.push(`  fields: ${scalars.map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`).join(", ")}`);
	}
	if (contentPreview) {
		const preview = contentPreview.slice(0, 240).replace(/\s+/g, " ");
		lines.push(`  content: ${preview}${contentPreview.length > 240 ? "\u2026" : ""}`);
	}
	lines.push(`Please acknowledge briefly so I know you got it; no further action needed unless I follow up.`);
	return lines.join("\n");
}

// Free-text search across object metadata + agent block content. Used by the
// frontend search box to surface compacted turns the user can recall.
app.get("/api/search", (req, res) => {
	const q = String(req.query.q ?? "");
	const limit = Number(req.query.limit ?? 20);
	res.json(search(q, Number.isFinite(limit) && limit > 0 ? limit : 20));
});

// Live event stream (SSE) of new glon changes — tool calls, messages,
// field writes — as they land on disk. Replays the last ≤200 entries on
// connect so a freshly-opened tab has context.
app.get("/api/events", (req, res) => {
	streamEvents(res);
});

app.get("/api/events/recent", (_req, res) => {
	res.json({ events: recentEvents() });
});

	// Re-inject a compacted block into an agent's live context. Proxies to the
	// glon daemon at $GLON_DISPATCH_URL (default port 6420), which
	// owns the actor that mutates the DAG. Returns the new block id so the
	// frontend can re-fetch the conversation and highlight it.
app.post("/api/agents/:id/recall/:blockId", async (req, res) => {
	const { id, blockId } = req.params;
	const dispatchUrl = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;
	try {
		const r = await fetch(dispatchUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prefix: "/agent", action: "recall", args: [id, blockId] }),
		});
		if (!r.ok) {
			const body = await r.text();
			return res.status(502).json({ error: `glon daemon dispatch failed (${r.status})`, body });
		}
		const data = await r.json() as { result?: { newBlockId: string; sourceKind: string; truncated: boolean } };
		res.json({ ok: true, ...(data.result ?? data) });
	} catch (err: any) {
		res.status(503).json({ error: "could not reach glon daemon", detail: err?.message ?? String(err) });
	}
});


	// Planet Forge — AI-assisted planet styling. Proxies to OpenAI.
	app.post("/api/planet-forge", async (req, res) => {
		const { messages, apiKey } = req.body;
		if (!Array.isArray(messages) || messages.length === 0) {
			return res.status(400).json({ error: "messages array required" });
		}
		const key = apiKey || process.env.OPENAI_API_KEY;
		if (!key) {
			return res.status(400).json({ error: "OpenAI API key required. Set OPENAI_API_KEY env var or pass apiKey in request." });
		}
		try {
			const r = await fetch("https://api.openai.com/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${key}`,
				},
				body: JSON.stringify({
					model: "gpt-4o",
					messages,
					temperature: 0.8,
					max_tokens: 2048,
				}),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ error: `OpenAI API error (${r.status})`, body });
			}
			const data = await r.json();
			res.json(data);
		} catch (err: any) {
			res.status(503).json({ error: "could not reach OpenAI", detail: err?.message ?? String(err) });
		}
	});
// Wallet pubkeys (local-only, read-only)
app.get("/api/wallet", (_req, res) => {
	res.json({ pubkeys: [...getWalletPubkeys()] });
});


	// Coin overview: all chain.coin.bucket objects with derived state
	app.get("/api/coins", (_req, res) => {
		res.json(getCoinOverview());
	});

	// Global coin stats from SQLite index (daemon)
	app.get("/api/coins/stats", async (_req, res) => {
		const stats = await getGlobalCoinStatsViaDaemon();
		if (stats) {
			res.json({ ok: true, source: "sqlite", stats });
		} else {
			res.status(503).json({ ok: false, error: "daemon offline — coin stats require daemon" });
		}
	});


	// Program registry: auto-discover what programs glon is running.
	app.get("/api/programs", async (_req, res) => {
		const programs = await getPrograms();
		if (programs) {
			res.json({ ok: true, programs });
		} else {
			res.status(503).json({ ok: false, error: "daemon offline" });
		}
	});

	// ── Tasks: merged daemon tasks + glon reminders ──────────────────

	const DAEMON_TASKS_URL = DAEMON_URL.replace("/dispatch", "/tasks");
	const GLON_DISPATCH_URL = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;

	app.get("/api/tasks", async (_req, res) => {
		try {
			const [daemonRes, snap] = await Promise.all([
				fetch(DAEMON_TASKS_URL).then(r => r.ok ? r.json() : { tasks: [] }).catch(() => ({ tasks: [] })),
				Promise.resolve(snapshot()),
			]);
			const daemonTasks = (daemonRes.tasks ?? []).map((t: any) => ({ ...t, source: "daemon" }));
			const reminders = (snap.objects ?? [])
				.filter((o) => o.typeKey === "reminder" && !o.deleted)
				.map((o) => {
					const sc = (o as any).rawFields ?? {};
					const status = String(sc.status ?? "pending");
					const fireAt = Number(sc.fire_at_ms ?? 0);
					const now = Date.now();
					return {
						id: o.id,
						name: String(sc.note ?? o.name ?? o.id),
						type: "reminder",
						enabled: status === "pending" || status === "sending",
						status,
						fireAt,
						channel: String(sc.channel ?? "-"),
						target: String(sc.target ?? "-"),
						payload: sc.payload,
						overdue: fireAt <= now && status === "pending",
						source: "glon",
					};
				});
			res.json({ ok: true, tasks: [...daemonTasks, ...reminders] });
		} catch (err: any) {
			res.status(500).json({ ok: false, error: err?.message ?? String(err) });
		}
	});

	app.post("/api/tasks/reminders", async (req, res) => {
		const { channel, target, fireAt, payload, note, createdBy } = req.body;
		if (!channel || !fireAt || !payload) {
			return res.status(400).json({ ok: false, error: "channel, fireAt, and payload are required" });
		}
		try {
			const r = await fetch(GLON_DISPATCH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prefix: "/remind",
					action: "schedule",
					args: [{ channel, target, fire_at: fireAt, payload, note, created_by: createdBy }],
				}),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ ok: false, error: `daemon dispatch failed (${r.status})`, body });
			}
			const data = await r.json();
			res.json({ ok: true, ...(data.result ?? data) });
		} catch (err: any) {
			res.status(503).json({ ok: false, error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});

	app.post("/api/tasks/reminders/:id/cancel", async (req, res) => {
		try {
			const r = await fetch(GLON_DISPATCH_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prefix: "/remind",
					action: "cancel",
					args: [req.params.id],
				}),
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(502).json({ ok: false, error: `daemon dispatch failed (${r.status})`, body });
			}
			const data = await r.json();
			res.json({ ok: true, ...(data.result ?? data) });
		} catch (err: any) {
			res.status(503).json({ ok: false, error: "could not reach glon daemon", detail: err?.message ?? String(err) });
		}
	});

	// Payment modal: authorize + settle
app.post("/api/pay/authorize", async (req, res) => {
	const { tokenId, amount, recipient, validForSec, keyName } = req.body;
	const dispatchUrl = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;
	try {
		const r = await fetch(dispatchUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prefix: "/coin", action: "authorizePayment", args: [{ tokenId, amount, recipient, validForSec, keyName }] }),
		});
		const data = await r.json();
		res.status(r.status).json(data);
	} catch (err: any) {
		res.status(500).json({ ok: false, error: err?.message ?? String(err) });
	}
});

app.post("/api/pay/settle", async (req, res) => {
	const { authorization, signature, keyName } = req.body;
	const dispatchUrl = process.env.GLON_DISPATCH_URL ?? DAEMON_URL;
	try {
		const r = await fetch(dispatchUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prefix: "/coin", action: "settlePayment", args: [{ authorization, signature, keyName }] }),
		});
		const data = await r.json();
		res.status(r.status).json(data);
	} catch (err: any) {
		res.status(500).json({ ok: false, error: err?.message ?? String(err) });
	}
});
// ── Static: three.js + frontend ────────────────────────────────────
//
// Serve three's ESM bundle from node_modules so the browser can resolve
// bare `three` imports via an importmap (see public/index.html).

	app.use("/vendor/three", express.static(join(ROOT, "node_modules", "three")));
	app.use("/vendor/rapier", express.static(join(ROOT, "node_modules", "@dimforge", "rapier3d-compat")));
	app.use(express.static(join(ROOT, "public"), { extensions: ["html"] }));

// ── Bootstrap ──────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

app.listen(PORT, HOST, () => {
	const snap = snapshot();
	const objCount = snap.objects.length;
	const agentCount = snap.objects.filter((o) => o.typeKey === "agent").length;
	const programCount = snap.objects.filter((o) => o.typeKey === "program").length;
	console.log(`glonAstrolabe → http://${HOST}:${PORT}`);
	console.log(`  source: ${snap.rootPath}`);
	console.log(`  loaded: ${objCount} objects (${programCount} programs, ${agentCount} agents) with ${snap.links.length} links`);
	startWatcher();
});
