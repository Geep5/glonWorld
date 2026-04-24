/**
 * glonWorld — HTTP server.
 *
 * Routes:
 *   GET /api/state                       graph snapshot (objects + links + types + timeline)
 *   GET /api/objects/:id                 full detail + outbound/inbound links + raw fields
 *   GET /api/objects/:id/changes         the object's change DAG
 *   GET /api/agents/:id/conversation     classified blocks + registered tools
 *   GET /api/meta                        host/data root info
 *   static /                             frontend from public/
 *   static /vendor/*                     mapped to node_modules/three/* for bare ES imports
 */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { snapshot, getObjectDetail, getObjectChanges, getAgentConversation, getRoot } from "./reader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const app = express();
app.disable("x-powered-by");

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
	console.log(`glonWorld → http://${HOST}:${PORT}`);
	console.log(`  source: ${snap.rootPath}`);
	console.log(`  loaded: ${objCount} objects (${programCount} programs, ${agentCount} agents) with ${snap.links.length} links`);
});
