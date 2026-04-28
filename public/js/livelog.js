/**
 * livelog — bottom-left console that tails the SSE stream from /api/events.
 *
 * Lifecycle:
 *   1. EventSource connects on init; auto-reconnects on transient drops.
 *   2. Each `LiveEvent` is rendered as one row per op (a single change can
 *      include several blockAdds + field writes; we expand them so the user
 *      sees each effect on its own line).
 *   3. The header click toggles the panel open/closed; click on a row tries
 *      to focus the corresponding object in the cosmos via `onSelect`.
 *
 * The list keeps at most MAX_ROWS rows in the DOM; older rows are evicted
 * from the top so a long-running session doesn't bloat memory.
 */

const MAX_ROWS = 400;

let panel, header, list, statusEl, countEl, clearBtn;
let onSelect = null;
let onEvent = null;
let totalCount = 0;
let openOverride = null;   // null = follow default, true/false = user override
let source = null;
let reconnectTimer = null;

export function setupLiveLog({ onSelectObject, onEachEvent } = {}) {
	panel = document.getElementById("livelog");
	header = panel.querySelector(".livelog-header");
	list = document.getElementById("livelog-list");
	statusEl = document.getElementById("livelog-status");
	countEl = document.getElementById("livelog-count");
	clearBtn = document.getElementById("livelog-clear");
	onSelect = onSelectObject ?? null;
	onEvent  = onEachEvent ?? null;

	header.addEventListener("click", (e) => {
		// Avoid toggling when the clear button is the click target.
		if (e.target === clearBtn) return;
		toggle();
	});
	clearBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		clearRows();
	});

	connect();
	setStatus("connecting…");
}

function toggle() {
	const willOpen = panel.classList.contains("collapsed");
	openOverride = willOpen;
	panel.classList.toggle("collapsed", !willOpen);
	if (willOpen) list.scrollTop = list.scrollHeight;
}

function setStatus(text, cls) {
	statusEl.textContent = text;
	panel.classList.remove("connected", "error");
	if (cls) panel.classList.add(cls);
}

function connect() {
	if (source) source.close();
	source = new EventSource("/api/events");
	source.addEventListener("open", () => setStatus("live", "connected"));
	source.addEventListener("message", (e) => {
		try {
			const ev = JSON.parse(e.data);
			ingest(ev);
		} catch (err) {
			console.warn("livelog: bad event payload", err);
		}
	});
	source.addEventListener("error", () => {
		setStatus("reconnecting…", "error");
		// EventSource auto-reconnects; we just refresh status. If the server
		// is gone for >10s we hard-reconnect to reset backoff.
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			if (source.readyState === EventSource.CLOSED) connect();
		}, 10_000);
	});
}

function ingest(ev) {
	if (onEvent) {
		try { onEvent(ev); } catch (err) { console.warn("livelog: onEachEvent threw", err); }
	}
	for (const op of ev.ops) {
		appendRow(ev, op);
	}
}

function appendRow(ev, op) {
	totalCount++;
	countEl.textContent = totalCount > 999 ? `${(totalCount / 1000).toFixed(1)}k` : String(totalCount);

	const row = document.createElement("div");
	row.className = "livelog-row fresh";
	row.dataset.objectId = ev.objectId;
	row.title = formatTooltip(ev, op);

	const time = document.createElement("span");
	time.className = "livelog-time";
	time.textContent = formatTime(ev.ts);
	row.appendChild(time);

	const actor = document.createElement("span");
	actor.className = `livelog-actor ${ev.typeKey ?? ""}`;
	actor.textContent = displayActor(ev);
	row.appendChild(actor);

	const body = document.createElement("span");
	body.className = "livelog-body";
	body.appendChild(renderOp(op));
	row.appendChild(body);

	row.addEventListener("click", () => {
		if (onSelect && ev.objectId) onSelect(ev.objectId);
	});

	const wasAtBottom = isAtBottom();
	list.appendChild(row);
	while (list.children.length > MAX_ROWS) list.removeChild(list.firstChild);
	if (wasAtBottom) list.scrollTop = list.scrollHeight;

	// Auto-open on the first event so the user sees something live, unless
	// they've explicitly collapsed the panel.
	if (openOverride === null && totalCount === 1) {
		panel.classList.remove("collapsed");
	}
}

function renderOp(op) {
	const frag = document.createDocumentFragment();
	const kind = document.createElement("span");
	frag.appendChild(kind);
	switch (op.kind) {
		case "create":
			kind.className = "livelog-kind create";
			kind.textContent = `+${op.typeKey}`;
			break;
		case "delete":
			kind.className = "livelog-kind delete";
			kind.textContent = "delete";
			break;
		case "field":
			kind.className = "livelog-kind field";
			kind.textContent = `${op.key} =`;
			frag.appendChild(text(op.preview ?? "", "livelog-preview"));
			break;
		case "field_delete":
			kind.className = "livelog-kind field";
			kind.textContent = `-${op.key}`;
			break;
		case "content":
			kind.className = "livelog-kind field";
			kind.textContent = `content ${formatBytes(op.bytes)}`;
			break;
		case "block":
			return renderBlockOp(op);
		case "block_remove":
			kind.className = "livelog-kind delete";
			kind.textContent = `-block ${op.blockId.slice(0, 6)}`;
			break;
		case "block_update":
			kind.className = "livelog-kind field";
			kind.textContent = `~block ${op.blockId.slice(0, 6)}`;
			break;
		case "block_move":
			kind.className = "livelog-kind field";
			kind.textContent = `→block ${op.blockId.slice(0, 6)}`;
			break;
		default:
			kind.textContent = op.kind;
	}
	return frag;
}

function renderBlockOp(op) {
	const frag = document.createDocumentFragment();
	const kind = document.createElement("span");
	const isErr = op.blockKind === "tool_result" && op.isError;
	const cls = isErr ? "tool_error" : op.blockKind;
	kind.className = `livelog-kind ${cls}`;
	if (op.blockKind === "tool_use") {
		kind.textContent = `tool_use(${op.toolName ?? "?"})`;
	} else if (op.blockKind === "tool_result") {
		kind.textContent = isErr ? "tool_error" : "tool_result";
	} else if (op.blockKind === "compaction") {
		kind.textContent = `compaction(${op.tokensBefore ?? 0} tok)`;
	} else {
		kind.textContent = op.blockKind;
	}
	frag.appendChild(kind);
	if (op.preview) frag.appendChild(text(op.preview, "livelog-preview"));
	return frag;
}

function displayActor(ev) {
	if (ev.objectName) return ev.objectName;
	if (ev.typeKey) return `${ev.typeKey}:${ev.objectId.slice(0, 6)}`;
	return ev.objectId.slice(0, 6);
}

function formatTime(ts) {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function formatBytes(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTooltip(ev, op) {
	const lines = [
		`object: ${ev.objectName ?? ev.objectId}`,
		`type:   ${ev.typeKey ?? "?"}`,
		`change: ${ev.changeId.slice(0, 12)}`,
		`author: ${ev.author || "?"}`,
		`when:   ${new Date(ev.ts).toLocaleString()}`,
	];
	if (op.kind === "block" && op.blockKind === "tool_use") {
		lines.push(`tool:   ${op.toolName ?? "?"}`);
	}
	return lines.join("\n");
}

function text(s, cls) {
	const span = document.createElement("span");
	if (cls) span.className = cls;
	span.textContent = s;
	return span;
}

function clearRows() {
	list.innerHTML = "";
	totalCount = 0;
	countEl.textContent = "0";
}

function isAtBottom() {
	return list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
}
