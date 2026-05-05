	/**
	 * Agent Chat Windows — standalone floating panels for each agent.
	 *
	 * Each window is draggable, minimizable, and closable.
	 * Position persists in localStorage per agent.
	 */

	import { parseRenderFromText, setRender, applyToMesh } from "./planet-styles.js";
const DOCK = document.createElement("div");
DOCK.id = "chat-dock";
document.body.appendChild(DOCK);

let zCounter = 100;
const openChats = new Map(); // agentId -> ChatWindow

class ChatWindow {
	constructor(agentId, agentName) {
		this.agentId = agentId;
		this.agentName = agentName || "Agent";
		this.polling = 0;
		this.minimized = false;

		this.panel = document.createElement("div");
		this.panel.className = "chat-window";
		this.panel.style.zIndex = ++zCounter;

		// Header
		const header = document.createElement("div");
		header.className = "chat-header";
		header.innerHTML = `
			<span class="chat-title">${escapeHtml(this.agentName)}</span>
			<div class="chat-controls">
				<button class="chat-min" title="Minimize">─</button>
				<button class="chat-close" title="Close">×</button>
			</div>
		`;
		this.panel.appendChild(header);

		// Body
		this.body = document.createElement("div");
		this.body.className = "chat-body";
		this.panel.appendChild(this.body);

		// History
		this.history = document.createElement("div");
		this.history.className = "chat-history";
		this.body.appendChild(this.history);

		// Input row
		const inputRow = document.createElement("div");
		inputRow.className = "chat-input-row";
		this.input = document.createElement("input");
		this.input.type = "text";
		this.input.placeholder = `Message ${escapeHtml(this.agentName)}…`;
		this.input.autocomplete = "off";
		const sendBtn = document.createElement("button");
		sendBtn.textContent = "Send";
		inputRow.appendChild(this.input);
		inputRow.appendChild(sendBtn);
		this.body.appendChild(inputRow);

		// Status
		this.status = document.createElement("div");
		this.status.className = "chat-status";
		this.body.appendChild(this.status);

		DOCK.appendChild(this.panel);

		// Events
		header.querySelector(".chat-min").addEventListener("click", () => this.toggleMinimize());
		header.querySelector(".chat-close").addEventListener("click", () => this.close());
		sendBtn.addEventListener("click", () => this.send());
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.send();
			}
		});

		// Bring to front on click
		this.panel.addEventListener("pointerdown", () => {
			this.panel.style.zIndex = ++zCounter;
		});

		// Draggable header
		this.makeDraggable(header);

		// Restore position
		this.restorePosition();

		// Load history
		this.loadHistory();
	}

	makeDraggable(handle) {
		let pid = null;
		let ox = 0;
		let oy = 0;

		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			const rect = this.panel.getBoundingClientRect();
			ox = e.clientX - rect.left;
			oy = e.clientY - rect.top;
			this.panel.style.left = rect.left + "px";
			this.panel.style.top = rect.top + "px";
			this.panel.style.right = "auto";
			this.panel.style.bottom = "auto";
			pid = e.pointerId;
			handle.setPointerCapture(pid);
			e.preventDefault();
		});

		handle.addEventListener("pointermove", (e) => {
			if (e.pointerId !== pid) return;
			const x = e.clientX - ox;
			const y = e.clientY - oy;
			const maxX = window.innerWidth - this.panel.offsetWidth;
			const maxY = window.innerHeight - this.panel.offsetHeight;
			this.panel.style.left = Math.max(0, Math.min(maxX, x)) + "px";
			this.panel.style.top = Math.max(0, Math.min(maxY, y)) + "px";
		});

		const end = (e) => {
			if (e.pointerId !== pid) return;
			if (handle.hasPointerCapture(pid)) handle.releasePointerCapture(pid);
			pid = null;
			this.savePosition();
		};
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	}

	savePosition() {
		try {
			localStorage.setItem(
				`glonAstrolabe.chatPos.${this.agentId}`,
				JSON.stringify({ left: this.panel.style.left, top: this.panel.style.top })
			);
		} catch { /* ignore */ }
	}

	restorePosition() {
		try {
			const raw = localStorage.getItem(`glonAstrolabe.chatPos.${this.agentId}`);
			if (raw) {
				const pos = JSON.parse(raw);
				this.panel.style.left = pos.left;
				this.panel.style.top = pos.top;
				this.panel.style.right = "auto";
				this.panel.style.bottom = "auto";
				return;
			}
		} catch { /* ignore */ }
		// Default: cascade from top-right
		const idx = openChats.size;
		this.panel.style.right = (20 + idx * 20) + "px";
		this.panel.style.top = (60 + idx * 20) + "px";
	}

	toggleMinimize() {
		this.minimized = !this.minimized;
		this.panel.classList.toggle("minimized", this.minimized);
	}

	close() {
		clearInterval(this.polling);
		this.panel.remove();
		openChats.delete(this.agentId);
	}

	async loadHistory() {
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(this.agentId)}/conversation`);
			if (!r.ok) return;
			const data = await r.json();
			this.renderMessages(data.blocks ?? []);
		} catch (err) {
			console.warn("chat history load failed", err);
		}
	}

	renderMessages(blocks) {
		const chatBlocks = blocks.filter((b) => b.kind === "user_text" || b.kind === "assistant_text");
		const visible = chatBlocks.slice(-50);

		this.history.innerHTML = "";
		for (const b of visible) {
			const msg = document.createElement("div");
			msg.className = `chat-msg ${b.kind === "user_text" ? "user" : "assistant"}`;

			const label = document.createElement("div");
			label.className = "chat-label";
			label.textContent = b.kind === "user_text" ? "You" : this.agentName;

			const text = document.createElement("div");
			let displayText = b.text ?? "";
			if (b.kind === "user_text") {
				const m = displayText.match(/^\[from .+? on .+?\]\s*/);
				if (m) displayText = displayText.slice(m[0].length);
			}
			text.textContent = displayText;

			msg.appendChild(label);
			msg.appendChild(text);
			this.history.appendChild(msg);
		}

		// Check last assistant message for planet render JSON
		const lastAssistant = visible.filter((b) => b.kind === "assistant_text").pop();
		if (lastAssistant?.text) {
			const render = parseRenderFromText(lastAssistant.text);
			if (render) {
				setRender(this.agentId, render);
				// Try to apply immediately if mesh exists
				window.dispatchEvent(new CustomEvent("planet-render-changed", { detail: { objectId: this.agentId } }));
				this.status.textContent = "Planet render applied from agent response!";
				this.status.className = "chat-status ok";
			}
		}

		this.history.scrollTop = this.history.scrollHeight;
	}

	async send() {
		const text = this.input.value.trim();
		if (!text) return;

		this.input.value = "";
		this.input.disabled = true;
		this.status.textContent = "Sending…";
		this.status.className = "chat-status sending";

		// Optimistic user message
		const msg = document.createElement("div");
		msg.className = "chat-msg user";
		msg.innerHTML = `<div class="chat-label">You</div><div>${escapeHtml(text)}</div>`;
		this.history.appendChild(msg);
		this.history.scrollTop = this.history.scrollHeight;

		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(this.agentId)}/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: text }),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);

			this.status.textContent = `${this.agentName} is thinking…`;
			this.status.className = "chat-status ok";
			this.startPolling();
		} catch (err) {
			this.status.textContent = `Send failed: ${err?.message ?? err}`;
			this.status.className = "chat-status err";
			this.input.disabled = false;
		}
	}

	startPolling() {
		clearInterval(this.polling);
		let attempts = 0;
		const maxAttempts = 60;
		const prevCount = this.history.children.length;

		this.polling = setInterval(async () => {
			attempts++;
			if (attempts > maxAttempts) {
				clearInterval(this.polling);
				this.status.textContent = "No response yet — agent may still be processing.";
				this.input.disabled = false;
				return;
			}
			try {
				const r = await fetch(`/api/agents/${encodeURIComponent(this.agentId)}/conversation`);
				if (!r.ok) return;
				const data = await r.json();
				const blocks = data.blocks ?? [];
				const chatBlocks = blocks.filter((b) => b.kind === "user_text" || b.kind === "assistant_text");
				const visible = chatBlocks.slice(-50);
				const last = visible[visible.length - 1];
				if (last?.kind === "assistant_text" && visible.length > prevCount) {
					this.renderMessages(blocks);
					clearInterval(this.polling);
					this.status.textContent = "";
					this.input.disabled = false;
				}
			} catch { /* ignore */ }
		}, 1000);
	}
	}

	export function initAgentChats(agents) {
		for (const agent of agents) {
			openAgentChat(agent.id, agent.name);
		}
	}

	// Periodically check for new agents (e.g. spawned subagents)
	setInterval(async () => {
		try {
			const r = await fetch("/api/state");
			if (!r.ok) return;
			const data = await r.json();
			const agents = (data.objects ?? []).filter((o) => o.typeKey === "agent");
			for (const agent of agents) {
				if (!openChats.has(agent.id)) {
					openAgentChat(agent.id, agent.name);
				}
			}
		} catch { /* ignore */ }
	}, 10000);

	export function openAgentChat(agentId, agentName) {
		if (openChats.has(agentId)) {
			const chat = openChats.get(agentId);
			chat.panel.classList.remove("minimized");
			chat.panel.style.zIndex = ++zCounter;
			return;
		}
		const chat = new ChatWindow(agentId, agentName);
		openChats.set(agentId, chat);
	}

	export function closeAgentChat(agentId) {
		openChats.get(agentId)?.close();
	}

	function escapeHtml(s) {
		if (!s) return "";
		return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
	}
