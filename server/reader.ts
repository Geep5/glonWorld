/**
 * reader — derive a visualization-friendly model of a glon environment
 * by reading `.pb` change files directly from disk.
 *
 * glon's data model on disk:
 *   ~/.glon/changes/<object-id>/<sha256-hex>.pb    — one Change per file
 *
 * We reuse glon's decode + state-computation code verbatim. The graph
 * produced here is purely derived: re-running this against the same
 * disk state yields the same output.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { decodeChange, unwrapValue, type Change, type Value, type ObjectLink, type Block } from "../../Graice/src/proto.js";
import { computeState, type ObjectState } from "../../Graice/src/dag/dag.js";
import { hexEncode } from "../../Graice/src/crypto.js";

const GLON_ROOT = process.env.GLON_DATA ?? join(homedir(), ".glon");
const CHANGES_DIR = join(GLON_ROOT, "changes");

// ── Public types ────────────────────────────────────────────────

export interface VizLink {
	sourceId: string;
	targetId: string;
	relationKey: string;
	fieldPath: string;
}

export interface VizObject {
	id: string;
	typeKey: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	deleted: boolean;
	changeCount: number;
	headIds: string[];
	// Preview-only: scalar fields displayed in the panel (strings, numbers, bools).
	scalars: Record<string, string | number | boolean>;
	// Counts, so the cosmos view can size things without shipping full data.
	blockCount: number;
	linkOutCount: number;
	// Agent-specific derived stats, present only when typeKey === "agent".
	agentStats?: AgentStats;
}

export interface AgentStats {
	model?: string;
	system?: string;
	toolCount: number;
	userTurns: number;
	assistantTurns: number;
	toolUses: number;
	toolResults: number;
	compactions: number;
	effectiveTokens: number;
	lastActivity: number;
	// Compaction-driving budget. effectiveTokens / contextWindow is the
	// 'how full is this conversation' progress, useful as a job indicator.
	contextWindow: number;
}

export interface VizChange {
	id: string;
	parentIds: string[];
	timestamp: number;
	author: string;
	opSummary: string[];
}

export interface VizBlock {
	id: string;
	kind: "user_text" | "assistant_text" | "tool_use" | "tool_result" | "compaction" | "other";
	timestamp: number;
	author: string;
	text?: string;
	toolUseId?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	isError?: boolean;
	summary?: string;
	firstKeptBlockId?: string;
	tokensBefore?: number;
	turnCount?: number;
	priorSummaryId?: string;
	// Classification injected by getAgentConversation for the host agent.
	inContext?: boolean;
	memoryRefs?: MemoryRef[];
}

export interface MemoryRef {
	id: string;
	typeKey: "pinned_fact" | "milestone";
	label: string; // fact key or milestone title
}

export interface VizTool {
	name: string;
	description: string;
	targetPrefix: string;
	targetAction: string;
}

export interface GraphSnapshot {
	rootPath: string;
	takenAt: number;
	objects: VizObject[];
	links: VizLink[];
	byType: Record<string, number>;
	// Lightweight histogram over all changes across the environment.
	timeline: { bucket: number; count: number }[];
}

// ── Block kinds (mirrors agent.ts) ──────────────────────────────

const BLOCK_TOOL_USE = "tool_use";
const BLOCK_TOOL_RESULT = "tool_result";
const BLOCK_COMPACTION_SUMMARY = "compaction_summary";
const STYLE_ASSISTANT = 1;

// ── Disk scan ───────────────────────────────────────────────────

function listObjectDirs(): string[] {
	if (!existsSync(CHANGES_DIR)) return [];
	const entries = readdirSync(CHANGES_DIR, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function readChangesForObject(objectId: string): Change[] {
	const dir = join(CHANGES_DIR, objectId);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".pb"));
	const changes: Change[] = [];
	for (const file of files) {
		try {
			const bytes = readFileSync(join(dir, file));
			changes.push(decodeChange(new Uint8Array(bytes)));
		} catch {
			// Corrupt file — skip.
		}
	}
	return changes;
}

// ── Value helpers ───────────────────────────────────────────────

function extractString(v: Value | undefined): string | undefined {
	if (!v) return undefined;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

function extractScalar(v: Value): string | number | boolean | undefined {
	if (v.stringValue !== undefined) return v.stringValue;
	if (v.intValue !== undefined) return v.intValue;
	if (v.floatValue !== undefined) return v.floatValue;
	if (v.boolValue !== undefined) return v.boolValue;
	return undefined;
}

function collectLinks(fieldKey: string, v: Value, out: { targetId: string; relationKey: string; fieldPath: string }[]) {
	if (v.linkValue) {
		out.push({ targetId: v.linkValue.targetId, relationKey: v.linkValue.relationKey, fieldPath: fieldKey });
		return;
	}
	if (v.valuesValue) {
		for (let i = 0; i < v.valuesValue.items.length; i++) {
			collectLinks(`${fieldKey}[${i}]`, v.valuesValue.items[i], out);
		}
	}
	if (v.mapValue) {
		for (const [k, inner] of Object.entries(v.mapValue.entries)) {
			collectLinks(`${fieldKey}.${k}`, inner, out);
		}
	}
}

function extractToolsField(v: Value | undefined): VizTool[] {
	if (!v?.mapValue?.entries) return [];
	const out: VizTool[] = [];
	for (const [name, raw] of Object.entries(v.mapValue.entries)) {
		const inner = raw.mapValue?.entries;
		if (!inner) continue;
		out.push({
			name,
			description: extractString(inner.description) ?? "",
			targetPrefix: extractString(inner.target_prefix) ?? "",
			targetAction: extractString(inner.target_action) ?? "",
		});
	}
	return out;
}

// ── Block classification ────────────────────────────────────────

function classifyBlock(
	block: Block,
	provenance: { author: string; timestamp: number } | undefined,
): VizBlock {
	const timestamp = provenance?.timestamp ?? 0;
	const author = provenance?.author ?? "";
	const textContent = (block.content as any)?.text;
	if (textContent?.text !== undefined) {
		const kind: VizBlock["kind"] = textContent.style === STYLE_ASSISTANT ? "assistant_text" : "user_text";
		return { id: block.id, kind, timestamp, author, text: textContent.text };
	}
	const custom = (block.content as any)?.custom;
	if (custom) {
		const contentType = custom.contentType ?? custom.content_type;
		const meta: Record<string, string> = custom.meta ?? {};
		if (contentType === BLOCK_TOOL_USE) {
			let toolInput: Record<string, unknown> = {};
			try {
				toolInput = JSON.parse(meta.input ?? "{}");
			} catch { /* keep default */ }
			return {
				id: block.id,
				kind: "tool_use",
				timestamp,
				author,
				toolUseId: meta.tool_use_id ?? "",
				toolName: meta.tool_name ?? "",
				toolInput,
			};
		}
		if (contentType === BLOCK_TOOL_RESULT) {
			return {
				id: block.id,
				kind: "tool_result",
				timestamp,
				author,
				toolUseId: meta.tool_use_id ?? "",
				text: meta.content ?? "",
				isError: meta.is_error === "true",
			};
		}
		if (contentType === BLOCK_COMPACTION_SUMMARY) {
			return {
				id: block.id,
				kind: "compaction",
				timestamp,
				author,
				summary: meta.summary ?? "",
				firstKeptBlockId: meta.first_kept_block_id ?? "",
				tokensBefore: parseInt(meta.tokens_before ?? "0", 10) || 0,
				turnCount: parseInt(meta.turn_count ?? "0", 10) || 0,
				priorSummaryId: meta.prior_summary_id,
			};
		}
	}
	return { id: block.id, kind: "other", timestamp, author };
}

function classifyBlocks(state: ObjectState): VizBlock[] {
	const blocks: VizBlock[] = [];
	for (const b of state.blocks) {
		const prov = state.blockProvenance.get(b.id);
		blocks.push(classifyBlock(b, prov));
	}
	blocks.sort((a, b) => a.timestamp - b.timestamp);
	return blocks;
}

function estimateTextTokens(s: string): number {
	return Math.ceil(s.length / 3.5);
}

function extractInt(v: Value | undefined, fallback: number): number {
	if (!v) return fallback;
	if (v.intValue !== undefined) return v.intValue;
	if (v.floatValue !== undefined) return Math.round(v.floatValue);
	if (v.stringValue !== undefined) {
		const n = parseInt(v.stringValue, 10);
		return Number.isFinite(n) ? n : fallback;
	}
	return fallback;
}

function computeAgentStats(state: ObjectState): AgentStats {
	const blocks = classifyBlocks(state);
	let userTurns = 0, assistantTurns = 0, toolUses = 0, toolResults = 0, compactions = 0;
	let lastActivity = 0;
	let effectiveTokens = 0;
	let latestCompaction: VizBlock | undefined;
	for (const b of blocks) {
		if (b.timestamp > lastActivity) lastActivity = b.timestamp;
		if (b.kind === "user_text") userTurns++;
		if (b.kind === "assistant_text") assistantTurns++;
		if (b.kind === "tool_use") toolUses++;
		if (b.kind === "tool_result") toolResults++;
		if (b.kind === "compaction") {
			compactions++;
			if (!latestCompaction || b.timestamp > latestCompaction.timestamp) latestCompaction = b;
		}
	}
	const cutId = latestCompaction?.firstKeptBlockId;
	let inKept = !cutId;
	for (const b of blocks) {
		if (!inKept && b.id === cutId) inKept = true;
		if (!inKept) continue;
		if (b.kind === "compaction") continue;
		if (b.text) effectiveTokens += estimateTextTokens(b.text);
		else if (b.kind === "tool_use") effectiveTokens += estimateTextTokens((b.toolName ?? "") + JSON.stringify(b.toolInput ?? {}));
	}
	if (latestCompaction?.summary) effectiveTokens += estimateTextTokens(latestCompaction.summary);

	const tools = extractToolsField(state.fields.get("tools"));
	return {
		model: extractString(state.fields.get("model")),
		system: extractString(state.fields.get("system")),
		toolCount: tools.length,
		userTurns,
		assistantTurns,
		toolUses,
		toolResults,
		compactions,
		effectiveTokens,
		lastActivity,
		contextWindow: extractInt(state.fields.get("compaction_context_window"), 200_000),
	};
}

// ── Build a single object's viz record ──────────────────────────

interface PerObject {
	object: VizObject;
	state: ObjectState;
	changes: Change[];
	blocks: VizBlock[];
	tools: VizTool[];
	outLinks: { targetId: string; relationKey: string; fieldPath: string }[];
}

function buildPerObject(objectId: string, changes: Change[]): PerObject | null {
	if (changes.length === 0) return null;
	let state: ObjectState;
	try {
		state = computeState(changes);
	} catch {
		return null;
	}

	const scalars: Record<string, string | number | boolean> = {};
	const outLinks: { targetId: string; relationKey: string; fieldPath: string }[] = [];
	for (const [key, value] of state.fields) {
		const scalar = extractScalar(value);
		if (scalar !== undefined && typeof scalar !== "object") scalars[key] = scalar;
		collectLinks(key, value, outLinks);
	}

	const tools = state.typeKey === "agent" ? extractToolsField(state.fields.get("tools")) : [];
	const blocks = state.typeKey === "agent" ? classifyBlocks(state) : [];

	const object: VizObject = {
		id: state.id,
		typeKey: state.typeKey || "unknown",
		name: extractString(state.fields.get("name"))
			?? extractString(state.fields.get("display_name"))
			?? extractString(state.fields.get("prefix"))
			?? extractString(state.fields.get("title")),
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		deleted: state.deleted,
		changeCount: changes.length,
		headIds: state.heads.map((h) => hexEncode(h)),
		scalars,
		blockCount: state.blocks.length,
		linkOutCount: outLinks.length,
		agentStats: state.typeKey === "agent" ? computeAgentStats(state) : undefined,
	};

	return { object, state, changes, blocks, tools, outLinks };
}

// ── Cache layer ─────────────────────────────────────────────────
//
// Reading 45 objects with ~5 changes each is cheap, but refreshing per
// request would still be wasteful. We cache the full scan for a few
// seconds and invalidate on directory mtime changes.

interface Cache {
	takenAt: number;
	dirMtime: number;
	perObject: Map<string, PerObject>;
	// For each (ownerAgentId, blockId) pair, the memory objects whose
	// `sourced_from_block(_id|s)` field points at that block. Precomputed
	// once per cache rebuild; O(memory-objects), keyed for O(1) lookup.
	memoryIndex: Map<string, MemoryRef[]>;
}

let cache: Cache | null = null;
const CACHE_TTL_MS = 3000;

function changesDirMtime(): number {
	if (!existsSync(CHANGES_DIR)) return 0;
	let latest = statSync(CHANGES_DIR).mtimeMs;
	for (const entry of readdirSync(CHANGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const m = statSync(join(CHANGES_DIR, entry.name)).mtimeMs;
		if (m > latest) latest = m;
	}
	return latest;
}

function loadAll(): Map<string, PerObject> {
	const all = new Map<string, PerObject>();
	for (const oid of listObjectDirs()) {
		const changes = readChangesForObject(oid);
		const po = buildPerObject(oid, changes);
		if (po) all.set(oid, po);
	}
	const filtered = JUNK_ENABLED ? filterJunk(all) : all;
	return DEDUPE_ENABLED ? dedupePerObject(filtered) : filtered;
}

// ── Junk filter ────────────────────────────────────────────────────────
//
// Drop objects that are clearly malformed test artifacts:
//
//   1. Missing typeKey — the object has changes but no `objectCreate` op,
//      meaning it was never completed. Nothing downstream can make sense
//      of it.
//   2. Agents with a `system` field present but shorter than 10 chars —
//      the signature of `/agent new X --system "..."` being misparsed by
//      the shell, which also leaves the system prompt bleeding into the
//      `name` field.
//
// Set GLON_ASTROLABE_JUNK_FILTER=0 to disable.

const JUNK_ENABLED = process.env.GLON_ASTROLABE_JUNK_FILTER !== "0";

function junkReason(po: PerObject): string | null {
	const { state } = po;
	if (!state.typeKey) return "no typeKey";
	if (state.typeKey === "agent") {
		const system = extractString(state.fields.get("system"));
		if (system !== undefined && system.trim().length < 10) {
			return `truncated system field (${JSON.stringify(system)})`;
		}
	}
	return null;
}

function filterJunk(all: Map<string, PerObject>): Map<string, PerObject> {
	const result = new Map<string, PerObject>();
	let dropped = 0;
	for (const po of all.values()) {
		const reason = junkReason(po);
		if (reason) {
			dropped++;
			console.log(`  junk: dropped ${po.object.typeKey || "<no-type>"}:${po.object.id.slice(0, 8)} — ${reason}`);
			continue;
		}
		result.set(po.object.id, po);
	}
	if (dropped > 0) console.log(`  junk: filtered ${dropped} malformed object(s); set GLON_ASTROLABE_JUNK_FILTER=0 to disable`);
	return result;
}

// ── Identity-based dedup ────────────────────────────────────────
//
// Re-running `/holdfast setup` (or any harness setup) creates a second
// peer:self and a second agent with byte-identical identity fields. The
// DAG stores them as distinct objects (glon identifies by object-id, not by content). For
// the viz, we collapse groups with matching identity signatures and
// keep the most-active member (max changeCount, tie-break on updatedAt).
// Set GLON_ASTROLABE_DEDUPE=0 to disable.

const DEDUPE_ENABLED = process.env.GLON_ASTROLABE_DEDUPE !== "0";

function dedupeSignature(po: PerObject): string | null {
	const { state } = po;
	if (state.deleted) return null;
	switch (state.typeKey) {
		case "peer": {
			const name = extractString(state.fields.get("display_name")) ?? "";
			if (!name) return null;
			const kind = extractString(state.fields.get("kind")) ?? "";
			const email = extractString(state.fields.get("email")) ?? "";
			const discord = extractString(state.fields.get("discord_id")) ?? "";
			return `peer|${name}|${kind}|${email}|${discord}`;
		}
		case "agent": {
			const name = extractString(state.fields.get("name")) ?? "";
			if (!name) return null;
			return `agent|${name}`;
		}
		default:
			return null;
	}
}

function pickWinner(group: PerObject[]): PerObject {
	return group.reduce((best, cur) => {
		if (cur.object.changeCount > best.object.changeCount) return cur;
		if (cur.object.changeCount === best.object.changeCount && cur.object.updatedAt > best.object.updatedAt) return cur;
		return best;
	});
}

function dedupePerObject(all: Map<string, PerObject>): Map<string, PerObject> {
	const bySig = new Map<string, PerObject[]>();
	const passthrough: PerObject[] = [];
	for (const po of all.values()) {
		const sig = dedupeSignature(po);
		if (!sig) { passthrough.push(po); continue; }
		const bucket = bySig.get(sig);
		if (bucket) bucket.push(po); else bySig.set(sig, [po]);
	}
	const result = new Map<string, PerObject>();
	for (const po of passthrough) result.set(po.object.id, po);
	let dropped = 0;
	for (const group of bySig.values()) {
		const winner = pickWinner(group);
		result.set(winner.object.id, winner);
		if (group.length > 1) {
			dropped += group.length - 1;
			const losers = group.filter((p) => p !== winner).map((p) => `${p.object.typeKey}:${p.object.id.slice(0, 8)} (changes=${p.object.changeCount})`);
			console.log(`  dedupe: kept ${winner.object.typeKey}:${winner.object.id.slice(0, 8)} (changes=${winner.object.changeCount}), dropped ${losers.join(", ")}`);
		}
	}
	if (dropped > 0) console.log(`  dedupe: filtered ${dropped} duplicate object(s); set GLON_ASTROLABE_DEDUPE=0 to disable`);
	return result;
}

function memoryIndexKey(ownerAgentId: string, blockId: string): string {
	return `${ownerAgentId}\x00${blockId}`;
}

function buildMemoryIndex(perObject: Map<string, PerObject>): Map<string, MemoryRef[]> {
	const index = new Map<string, MemoryRef[]>();
	const push = (ownerAgentId: string, blockId: string, ref: MemoryRef) => {
		if (!ownerAgentId || !blockId) return;
		const k = memoryIndexKey(ownerAgentId, blockId);
		const existing = index.get(k);
		if (existing) existing.push(ref); else index.set(k, [ref]);
	};
	for (const po of perObject.values()) {
		const fields = po.state.fields;
		const ownerRaw = fields.get("owner");
		const ownerId = ownerRaw?.linkValue?.targetId;
		if (!ownerId) continue;
		if (po.object.typeKey === "pinned_fact") {
			const blockId = extractString(fields.get("sourced_from_block_id"));
			if (!blockId) continue;
			const label = extractString(fields.get("key")) ?? po.object.id.slice(0, 8);
			push(ownerId, blockId, { id: po.object.id, typeKey: "pinned_fact", label });
		} else if (po.object.typeKey === "milestone") {
			const list = fields.get("sourced_from_blocks");
			const items = list?.valuesValue?.items ?? [];
			const label = extractString(fields.get("title")) ?? po.object.id.slice(0, 8);
			for (const item of items) {
				const blockId = extractString(item);
				if (blockId) push(ownerId, blockId, { id: po.object.id, typeKey: "milestone", label });
			}
		}
	}
	return index;
}

function getCache(): Cache {
	const mtime = changesDirMtime();
	const now = Date.now();
	if (cache && now - cache.takenAt < CACHE_TTL_MS && cache.dirMtime === mtime) return cache;
	const perObject = loadAll();
	cache = {
		takenAt: now,
		dirMtime: mtime,
		perObject,
		memoryIndex: buildMemoryIndex(perObject),
	};
	return cache;
}

// ── Public API ──────────────────────────────────────────────────

export function snapshot(): GraphSnapshot {
	const c = getCache();
	const objects: VizObject[] = [];
	const links: VizLink[] = [];
	const byType: Record<string, number> = {};
	const buckets: Map<number, number> = new Map();

	const ids = new Set<string>();
	for (const po of c.perObject.values()) ids.add(po.object.id);

	for (const po of c.perObject.values()) {
		objects.push(po.object);
		byType[po.object.typeKey] = (byType[po.object.typeKey] ?? 0) + 1;
		for (const l of po.outLinks) {
			// Only keep links whose target exists — avoids dangling edges after deletes.
			if (!ids.has(l.targetId)) continue;
			links.push({
				sourceId: po.object.id,
				targetId: l.targetId,
				relationKey: l.relationKey,
				fieldPath: l.fieldPath,
			});
		}
		for (const change of po.changes) {
			const bucket = Math.floor(change.timestamp / (60 * 1000)) * 60 * 1000;
			buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
		}
	}

	const timeline = [...buckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([bucket, count]) => ({ bucket, count }));

	return {
		rootPath: GLON_ROOT,
		takenAt: c.takenAt,
		objects,
		links,
		byType,
		timeline,
	};
}

export function getObjectDetail(id: string): {
	object: VizObject;
	outLinks: VizLink[];
	inLinks: VizLink[];
	rawFields: Record<string, unknown>;
	contentPreview?: string;
} | null {
	const c = getCache();
	const po = c.perObject.get(id);
	if (!po) return null;

	const outLinks: VizLink[] = po.outLinks.map((l) => ({
		sourceId: id,
		targetId: l.targetId,
		relationKey: l.relationKey,
		fieldPath: l.fieldPath,
	}));
	const inLinks: VizLink[] = [];
	for (const other of c.perObject.values()) {
		if (other.object.id === id) continue;
		for (const l of other.outLinks) {
			if (l.targetId !== id) continue;
			inLinks.push({
				sourceId: other.object.id,
				targetId: id,
				relationKey: l.relationKey,
				fieldPath: l.fieldPath,
			});
		}
	}

	const rawFields: Record<string, unknown> = {};
	for (const [key, value] of po.state.fields) {
		rawFields[key] = normalizeValue(value);
	}

	let contentPreview: string | undefined;
	if (po.state.content.byteLength > 0) {
		const limit = 2000;
		const bytes = po.state.content.byteLength > limit ? po.state.content.slice(0, limit) : po.state.content;
		try {
			contentPreview = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			if (po.state.content.byteLength > limit) contentPreview += `\n…[${po.state.content.byteLength - limit} more bytes]`;
		} catch {
			contentPreview = `<${po.state.content.byteLength} bytes binary>`;
		}
	}

	return { object: po.object, outLinks, inLinks, rawFields, contentPreview };
}

function normalizeValue(v: Value): unknown {
	if (v.linkValue) return { kind: "link", targetId: v.linkValue.targetId, relationKey: v.linkValue.relationKey };
	if (v.mapValue) {
		const out: Record<string, unknown> = {};
		for (const [k, inner] of Object.entries(v.mapValue.entries)) out[k] = normalizeValue(inner);
		return out;
	}
	if (v.valuesValue) return v.valuesValue.items.map((i) => normalizeValue(i));
	if (v.listValue) return v.listValue.values;
	if (v.bytesValue) return { kind: "bytes", length: v.bytesValue.byteLength };
	const raw = unwrapValue(v);
	return raw;
}

export function getObjectChanges(id: string): VizChange[] | null {
	const c = getCache();
	const po = c.perObject.get(id);
	if (!po) return null;
	return po.changes.map((ch) => ({
		id: hexEncode(ch.id),
		parentIds: ch.parentIds.map((p) => hexEncode(p)),
		timestamp: ch.timestamp,
		author: ch.author,
		opSummary: ch.ops.map(opSummary),
	}));
}

function opSummary(op: any): string {
	if (op.objectCreate) return `create:${op.objectCreate.typeKey}`;
	if (op.objectDelete) return "delete";
	if (op.fieldSet) return `field:${op.fieldSet.key}`;
	if (op.fieldDelete) return `-field:${op.fieldDelete.key}`;
	if (op.contentSet) return `content:${op.contentSet.content?.byteLength ?? 0}B`;
	if (op.blockAdd) {
		const kind = op.blockAdd.block?.content?.custom?.contentType ?? op.blockAdd.block?.content?.custom?.content_type ?? (op.blockAdd.block?.content?.text ? "text" : "block");
		return `+block:${kind}`;
	}
	if (op.blockRemove) return `-block:${op.blockRemove.blockId.slice(0, 6)}`;
	if (op.blockUpdate) return `~block:${op.blockUpdate.blockId.slice(0, 6)}`;
	if (op.blockMove) return `→block:${op.blockMove.blockId.slice(0, 6)}`;
	return "?";
}

export function getAgentConversation(id: string): {
	agent: VizObject;
	blocks: VizBlock[];
	tools: VizTool[];
} | null {
	const c = getCache();
	const po = c.perObject.get(id);
	if (!po) return null;
	if (po.object.typeKey !== "agent") return null;

	// Find the latest compaction's firstKeptBlockId. Blocks before that
	// boundary are compacted (skipped by the model on the next ask), the
	// rest are still in the live context window. No compaction → everything
	// is in context.
	let latestCompactionTs = -Infinity;
	let firstKeptBlockId: string | undefined;
	for (const b of po.blocks) {
		if (b.kind === "compaction" && b.timestamp > latestCompactionTs) {
			latestCompactionTs = b.timestamp;
			firstKeptBlockId = b.firstKeptBlockId;
		}
	}
	let inContext = !firstKeptBlockId;
	const blocks: VizBlock[] = po.blocks.map((b) => {
		if (firstKeptBlockId && b.id === firstKeptBlockId) inContext = true;
		const memoryRefs = c.memoryIndex.get(memoryIndexKey(id, b.id));
		// Compaction blocks sit on the boundary — they are themselves part
		// of the live system prompt (their summary is injected), so classify
		// them as in-context regardless of position.
		const blockInContext = b.kind === "compaction" ? true : inContext;
		return { ...b, inContext: blockInContext, memoryRefs };
	});
	return { agent: po.object, blocks, tools: po.tools };
}

export function getRoot(): string {
	return GLON_ROOT;
}

// Set of every known object id, refreshed via the reader cache. Used by the
// SSE stream to resolve which on-disk objects a tool call touched.
export function allObjectIds(): Set<string> {
	const c = getCache();
	return new Set(c.perObject.keys());
}

// All in-context object ids for an agent: scan every block currently in the
// agent's live context window for UUIDs that match a known object. Used by
// the cosmos to render context-active balls with a persistent halo.
export function getAgentContextRefs(agentId: string): { agent: VizObject; objectIds: string[] } | null {
	const c = getCache();
	const po = c.perObject.get(agentId);
	if (!po || po.object.typeKey !== "agent") return null;
	const classified = classifyAgentBlocks(po);
	const known = new Set(c.perObject.keys());
	const refs = new Set<string>();
	for (const { block, inContext } of classified) {
		if (!inContext) continue;
		collectIdsFromBlock(block, known, refs);
	}
	// The agent itself is implicitly always in context.
	refs.delete(agentId);
	return { agent: po.object, objectIds: [...refs] };
}

// UUIDs follow the canonical 8-4-4-4-12 hex pattern; this regex matches the
// shape so we don't have to substring-search every known id in every block.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function collectIdsFromBlock(block: VizBlock, known: Set<string>, out: Set<string>): void {
	const hay: string[] = [];
	if (block.text) hay.push(block.text);
	if (block.summary) hay.push(block.summary);
	if (block.toolName) hay.push(block.toolName);
	if (block.toolInput) hay.push(JSON.stringify(block.toolInput));
	for (const s of hay) {
		const matches = s.match(UUID_RE);
		if (!matches) continue;
		for (const m of matches) {
			const lc = m.toLowerCase();
			if (known.has(lc)) out.add(lc);
		}
	}
}


// ── Search ──────────────────────────────────────────────────────────────
//
// Two scopes:
//   1. objects — typeKey + name + id-prefix + scalar field values
//   2. blocks  — raw text content across every agent's blocks (user, assistant,
//                  tool_result, compaction summary, plus tool_use name+input)
//
// Block hits include the host agent's id and an in-context flag so the UI can
// distinguish 'click to focus a live turn' from 'click to recall a compacted
// turn back into context'.

export interface SearchHitObject {
	id: string;
	typeKey: string;
	name?: string;
	score: number;
	matchedField: string;
}

export interface SearchHitBlock {
	agentId: string;
	agentName?: string;
	blockId: string;
	kind: string;
	timestamp: number;
	inContext: boolean;
	snippet: string;
	score: number;
}

export interface SearchResults {
	query: string;
	objects: SearchHitObject[];
	blocks: SearchHitBlock[];
}

function makeSnippet(haystack: string, needle: string, radius: number = 60): string {
	const lower = haystack.toLowerCase();
	const i = lower.indexOf(needle);
	if (i < 0) return haystack.slice(0, radius * 2);
	const start = Math.max(0, i - radius);
	const end = Math.min(haystack.length, i + needle.length + radius);
	const pre = start > 0 ? "…" : "";
	const post = end < haystack.length ? "…" : "";
	return (pre + haystack.slice(start, end) + post).replace(/\s+/g, " ").trim();
}

// Compute the in-context flag the same way getAgentConversation does, so the
// UI sees identical 'compacted vs live' classification when navigating from a
// search hit.
function classifyAgentBlocks(po: PerObject): { block: VizBlock; inContext: boolean }[] {
	let latestCompactionTs = -Infinity;
	let firstKeptBlockId: string | undefined;
	for (const b of po.blocks) {
		if (b.kind === "compaction" && b.timestamp > latestCompactionTs) {
			latestCompactionTs = b.timestamp;
			firstKeptBlockId = b.firstKeptBlockId;
		}
	}
	let inContext = !firstKeptBlockId;
	return po.blocks.map((b) => {
		if (firstKeptBlockId && b.id === firstKeptBlockId) inContext = true;
		const blockInContext = b.kind === "compaction" ? true : inContext;
		return { block: b, inContext: blockInContext };
	});
}

export function search(query: string, limit: number = 20): SearchResults {
	const q = query.trim().toLowerCase();
	if (!q) return { query, objects: [], blocks: [] };
	const c = getCache();
	const objects: SearchHitObject[] = [];
	const blocks: SearchHitBlock[] = [];

	for (const po of c.perObject.values()) {
		const obj = po.object;
		let matched: { field: string; score: number } | null = null;
		if ((obj.name ?? "").toLowerCase().includes(q)) matched = { field: "name", score: 100 };
		else if (obj.typeKey.toLowerCase().includes(q)) matched = { field: "type", score: 60 };
		else if (obj.id.startsWith(q)) matched = { field: "id", score: 80 };
		else for (const [k, v] of Object.entries(obj.scalars)) {
			const sv = String(v).toLowerCase();
			if (sv.includes(q)) { matched = { field: `scalar:${k}`, score: 40 }; break; }
		}
		if (matched) {
			objects.push({ id: obj.id, typeKey: obj.typeKey, name: obj.name, score: matched.score, matchedField: matched.field });
		}

		if (obj.typeKey === "agent") {
			const classified = classifyAgentBlocks(po);
			for (const { block, inContext } of classified) {
				let hay = "";
				let score = 0;
				if (block.text) { hay = block.text; score = 70; }
				else if (block.kind === "tool_use") {
					hay = `${block.toolName ?? ""} ${JSON.stringify(block.toolInput ?? {})}`;
					score = 50;
				} else if (block.kind === "compaction") {
					hay = block.summary ?? "";
					score = 65;
				}
				if (!hay) continue;
				if (!hay.toLowerCase().includes(q)) continue;
				// In-context hits rank slightly higher: live conversation should
				// surface above forgotten history when the same phrase appears in
				// both — reflects 'most likely what you wanted' UX.
				const boost = inContext ? 5 : 0;
				blocks.push({
					agentId: obj.id,
					agentName: obj.name,
					blockId: block.id,
					kind: block.kind,
					timestamp: block.timestamp,
					inContext,
					snippet: makeSnippet(hay, q),
					score: score + boost,
				});
			}
		}
	}

	objects.sort((a, b) => b.score - a.score);
	blocks.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
	return { query, objects: objects.slice(0, limit), blocks: blocks.slice(0, limit) };
}