/**
 * events — live tail over ~/.glon/changes.
 *
 * Watches the changes directory for new `.pb` files, decodes each one, and
 * pushes a structured event onto a 200-entry ring buffer. The SSE endpoint
 * replays the last ~50 entries on connect and then streams new events as
 * they arrive. This is the lightweight "console" view of glon: every tool
 * call, message, and field write surfaces as an event line.
 *
 * Recursive fs.watch requires Node ≥ 20; on Linux it's stable since 22.
 */

import { EventEmitter } from "node:events";
import { watch, type FSWatcher, readFileSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import type { Response } from "express";
import { decodeChange, type Change, type Block } from "../../Graice/src/proto.js";
import { hexEncode } from "../../Graice/src/crypto.js";
import { getObjectDetail, allObjectIds } from "./reader.js";

const GLON_ROOT = process.env.GLON_DATA ?? join(homedir(), ".glon");
const CHANGES_DIR = join(GLON_ROOT, "changes");

const RING_SIZE = 200;
const REPLAY_ON_CONNECT = 50;
const PREVIEW_CHARS = 100;

const STYLE_ASSISTANT = 1;
const BLOCK_TOOL_USE = "tool_use";
const BLOCK_TOOL_RESULT = "tool_result";
const BLOCK_COMPACTION_SUMMARY = "compaction_summary";

export type EventOp =
	| { kind: "create"; typeKey: string }
	| { kind: "delete" }
	| { kind: "field"; key: string; preview?: string }
	| { kind: "field_delete"; key: string }
	| { kind: "content"; bytes: number }
	| {
		kind: "block";
		blockKind: "user_text" | "assistant_text" | "tool_use" | "tool_result" | "compaction" | "other";
		preview?: string;
		toolName?: string;
		toolUseId?: string;
		isError?: boolean;
		tokensBefore?: number;
	}
	| { kind: "block_remove"; blockId: string }
	| { kind: "block_update"; blockId: string }
	| { kind: "block_move"; blockId: string };

export interface LiveEvent {
	ts: number;
	changeId: string;
	objectId: string;
	objectName?: string;
	typeKey?: string;
	author: string;
	ops: EventOp[];
	// Object ids referenced by tool inputs/outputs in this change. The client
	// bumps heat on every entry so a search/list/get tool call lights up the
	// cosmos balls it touched, not just the agent.
	referencedObjects?: string[];
	// True for events sent during the replay-on-connect prefix; live events
	// omit it. Stamped at send time, not stored on the ring.
	replay?: boolean;
}

const ring: LiveEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(64);

// Track which files we've already processed. fs.watch fires multiple times
// for the same write on some platforms; the per-file dedupe keeps the ring
// honest.
const seen = new Set<string>();

let watcher: FSWatcher | null = null;

export function startWatcher(): void {
	if (watcher) return;
	if (!existsSync(CHANGES_DIR)) {
		console.warn(`  events: ${CHANGES_DIR} does not exist; watcher disabled`);
		return;
	}
	watcher = watch(CHANGES_DIR, { recursive: true }, (evtType, filename) => {
		if (!filename) return;
		const rel = filename.toString();
		if (!rel.endsWith(".pb")) return;
		if (evtType !== "rename" && evtType !== "change") return;
		if (seen.has(rel)) return;
		const fullPath = join(CHANGES_DIR, rel);
		let bytes: Buffer;
		try {
			bytes = readFileSync(fullPath);
		} catch {
			return; // file was renamed away or deleted before read
		}
		if (bytes.length === 0) return;
		let change: Change;
		try {
			change = decodeChange(new Uint8Array(bytes));
		} catch {
			return; // partial write; we'll see the next 'change' event
		}
		seen.add(rel);
		// Cap the seen set so it doesn't grow without bound.
		if (seen.size > RING_SIZE * 4) {
			const half = Math.floor(seen.size / 2);
			let i = 0;
			for (const k of seen) {
				if (i++ >= half) break;
				seen.delete(k);
			}
		}
		const ev = buildEvent(change, rel);
		ring.push(ev);
		if (ring.length > RING_SIZE) ring.shift();
		bus.emit("event", ev);
	});
	watcher.on("error", (err) => {
		console.warn(`  events: watcher error — ${err.message}`);
	});
	console.log(`  events: watching ${CHANGES_DIR}`);
}

function buildEvent(change: Change, relPath: string): LiveEvent {
	// `relPath` looks like "<object-id>/<sha>.pb"; the on-disk parent dir is
	// the canonical objectId, but change.objectId is the source of truth.
	const objectId = change.objectId || relPath.split(sep)[0] || "";
	const ops: EventOp[] = [];
	const refs = new Set<string>();
	const known = allObjectIds();
	for (const op of change.ops as any[]) {
		const eo = summarizeOp(op);
		if (eo) ops.push(eo);
		extractRefsFromOp(op, known, refs);
	}
	refs.delete(objectId); // the change's own object is implicit
	// Resolve the object's name + typeKey from the cached reader. The reader
	// has a 3s TTL but new objects appear in this code path before the cache
	// rebuilds, so we tolerate undefined fields.
	const detail = getObjectDetail(objectId);
	return {
		ts: change.timestamp,
		changeId: hexEncode(change.id),
		objectId,
		objectName: detail?.object.name,
		typeKey: detail?.object.typeKey,
		author: change.author,
		ops,
		referencedObjects: refs.size > 0 ? [...refs] : undefined,
	};
}

// UUIDs follow the canonical 8-4-4-4-12 hex pattern; we surface every match
// that resolves to a known object so the client can fan heat out across the
// objects a tool call read or wrote.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function extractRefsFromOp(op: any, known: Set<string>, out: Set<string>): void {
	const block = op.blockAdd?.block;
	if (!block) {
		if (op.fieldSet?.value?.linkValue?.targetId) {
			const t = op.fieldSet.value.linkValue.targetId.toLowerCase();
			if (known.has(t)) out.add(t);
		}
		return;
	}
	const content: any = block.content;
	const hay: string[] = [];
	if (content?.text?.text) hay.push(content.text.text);
	const meta: Record<string, string> = content?.custom?.meta ?? {};
	if (meta.input)   hay.push(meta.input);
	if (meta.content) hay.push(meta.content);
	if (meta.summary) hay.push(meta.summary);
	for (const s of hay) {
		const matches = s.match(UUID_RE);
		if (!matches) continue;
		for (const m of matches) {
			const lc = m.toLowerCase();
			if (known.has(lc)) out.add(lc);
		}
	}
}

function summarizeOp(op: any): EventOp | null {
	if (op.objectCreate) return { kind: "create", typeKey: op.objectCreate.typeKey };
	if (op.objectDelete) return { kind: "delete" };
	if (op.fieldSet) return { kind: "field", key: op.fieldSet.key, preview: previewValue(op.fieldSet.value) };
	if (op.fieldDelete) return { kind: "field_delete", key: op.fieldDelete.key };
	if (op.contentSet) return { kind: "content", bytes: op.contentSet.content?.byteLength ?? 0 };
	if (op.blockAdd?.block) return summarizeBlock(op.blockAdd.block);
	if (op.blockRemove) return { kind: "block_remove", blockId: op.blockRemove.blockId };
	if (op.blockUpdate) return { kind: "block_update", blockId: op.blockUpdate.blockId };
	if (op.blockMove) return { kind: "block_move", blockId: op.blockMove.blockId };
	return null;
}

function summarizeBlock(block: Block): EventOp {
	const content: any = block.content;
	const text = content?.text;
	if (text && typeof text.text === "string") {
		const blockKind = text.style === STYLE_ASSISTANT ? "assistant_text" : "user_text";
		return { kind: "block", blockKind, preview: clip(text.text) };
	}
	const custom = content?.custom;
	if (custom) {
		const contentType = custom.contentType ?? custom.content_type;
		const meta: Record<string, string> = custom.meta ?? {};
		if (contentType === BLOCK_TOOL_USE) {
			let preview: string | undefined;
			try {
				const input = JSON.parse(meta.input ?? "{}");
				preview = clip(stringifyToolInput(input));
			} catch { /* keep undefined */ }
			return {
				kind: "block",
				blockKind: "tool_use",
				toolName: meta.tool_name ?? "",
				toolUseId: meta.tool_use_id ?? "",
				preview,
			};
		}
		if (contentType === BLOCK_TOOL_RESULT) {
			return {
				kind: "block",
				blockKind: "tool_result",
				toolUseId: meta.tool_use_id ?? "",
				isError: meta.is_error === "true",
				preview: clip(meta.content ?? ""),
			};
		}
		if (contentType === BLOCK_COMPACTION_SUMMARY) {
			return {
				kind: "block",
				blockKind: "compaction",
				preview: clip(meta.summary ?? ""),
				tokensBefore: parseInt(meta.tokens_before ?? "0", 10) || 0,
			};
		}
	}
	return { kind: "block", blockKind: "other" };
}

function previewValue(v: any): string | undefined {
	if (!v) return undefined;
	if (typeof v.stringValue === "string") return clip(v.stringValue);
	if (typeof v.intValue === "number") return String(v.intValue);
	if (typeof v.floatValue === "number") return String(v.floatValue);
	if (typeof v.boolValue === "boolean") return String(v.boolValue);
	if (v.linkValue) return `→${shortId(v.linkValue.targetId)}`;
	return undefined;
}

function stringifyToolInput(input: unknown): string {
	if (input == null) return "";
	if (typeof input === "string") return input;
	// Show the most informative single field if it's a one-arg call (common
	// pattern: bash{command}, edit{path}, grep{pattern}).
	if (typeof input === "object") {
		const obj = input as Record<string, unknown>;
		const keys = Object.keys(obj);
		if (keys.length === 1) {
			const k = keys[0];
			return `${k}: ${typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k])}`;
		}
		return JSON.stringify(obj);
	}
	return JSON.stringify(input);
}

function clip(s: string, n: number = PREVIEW_CHARS): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= n) return flat;
	return flat.slice(0, n - 1) + "…";
}

function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

export function recentEvents(): LiveEvent[] {
	return [...ring];
}

export function streamEvents(res: Response): void {
	res.set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		"Connection": "keep-alive",
		// Disable buffering on reverse proxies; harmless when served directly.
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders();
	// Replay recent events so a fresh connect has context. Tag them so the
	// client can render them muted and skip side-effects (heat bumps,
	// context-set refresh) that only make sense for live activity.
	const replay = ring.slice(-REPLAY_ON_CONNECT);
	for (const ev of replay) {
		res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
	}
	const onEvent = (ev: LiveEvent) => {
		// `res.write` returns false when the kernel buffer is full; SSE
		// browsers reconnect automatically so we tolerate the rare drop.
		res.write(`data: ${JSON.stringify(ev)}\n\n`);
	};
	bus.on("event", onEvent);
	// Heartbeat keeps proxies and idle connections alive.
	const hb = setInterval(() => {
		res.write(`: hb ${Date.now()}\n\n`);
	}, 15_000);
	res.on("close", () => {
		bus.off("event", onEvent);
		clearInterval(hb);
	});
}
