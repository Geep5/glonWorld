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
import { snapshot, getObjectDetail, getObjectChanges, getAgentConversation, getAgentContextRefs, getRoot, search } from "./reader.js";
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

// Inject an object into an agent's context: post a user_text via /agent ask
// describing the object. Triggers one assistant turn but the reference stays
// in context for every subsequent turn until the next compaction.
app.post("/api/agents/:agentId/inject/:objectId", async (req, res) => {
	const { agentId, objectId } = req.params;
	const detail = getObjectDetail(objectId);
	if (!detail) return res.status(404).json({ error: "object not found" });
	const summary = injectSummary(detail);
	const dispatchUrl = process.env.GLON_DISPATCH_URL ?? "http://127.0.0.1:6430/dispatch";
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
// glon daemon at $GLON_DISPATCH_URL (default http://127.0.0.1:6430), which
// owns the actor that mutates the DAG. Returns the new block id so the
// frontend can re-fetch the conversation and highlight it.
app.post("/api/agents/:id/recall/:blockId", async (req, res) => {
	const { id, blockId } = req.params;
	const dispatchUrl = process.env.GLON_DISPATCH_URL ?? "http://127.0.0.1:6430/dispatch";
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
// ── Static: three.js + frontend ────────────────────────────────────
//
// Serve three's ESM bundle from node_modules so the browser can resolve
// bare `three` imports via an importmap (see public/index.html).

app.use("/vendor/three", express.static(join(ROOT, "node_modules", "three")));
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
