/**
 * reader — derive a visualization-friendly model of a Glon environment
 * by reading `.pb` change files directly from disk.
 *
 * Glon's data model on disk:
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
	const result = new Map<string, PerObject>();
	for (const oid of listObjectDirs()) {
		const changes = readChangesForObject(oid);
		const po = buildPerObject(oid, changes);
		if (po) result.set(oid, po);
	}
	return result;
}

function getCache(): Cache {
	const mtime = changesDirMtime();
	const now = Date.now();
	if (cache && now - cache.takenAt < CACHE_TTL_MS && cache.dirMtime === mtime) return cache;
	cache = {
		takenAt: now,
		dirMtime: mtime,
		perObject: loadAll(),
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
	return { agent: po.object, blocks: po.blocks, tools: po.tools };
}

export function getRoot(): string {
	return GLON_ROOT;
}
