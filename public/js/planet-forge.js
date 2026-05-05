/**
 * Planet Forge — standalone AI chat for designing Three.js planet renders.
 *
 * Floating panel with:
 *   - OpenAI API key input (persisted in localStorage)
 *   - Guidelines / helper info toggle
 *   - Chat to generate Three.js scene code
 *   - One-click apply to the selected planet
 */

const LS_KEY = "glonAstrolabe.planetForge";
const API_KEY_LS = "glonAstrolabe.openaiKey";

let zCounter = 9000;
let currentTargetId = null;
let currentTargetName = "none";
let lastAssistantText = "";

// ── System prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are PlanetForge, an expert Three.js procedural graphics designer.
Your job: write JavaScript code that creates stunning 3D planet visuals.

You write code inside a function body that receives these arguments:
  THREE   — the three.js module (use new THREE.SphereGeometry, etc.)
  parent  — a THREE.Group attached to the planet mesh. Add your meshes here.
  seed    — a seeded random function: seed() returns 0..1
  time    — elapsed seconds, for animation

RULES:
1. Only create objects on the FIRST call. Check \`parent.children.length === 0\` or store flags on \`parent.userData\`.
2. Use \`parent.add(mesh)\` to attach everything.
3. Animation happens every frame: rotate, pulse, orbit children, etc.
4. Keep geometry detail reasonable: SphereGeometry(1, 32, 16) is fine, don't go above 64 segments.
5. You can create: child meshes, particle systems, custom ShaderMaterial, glowing atmospheres, rings, moons, orbital debris, etc.
6. The planet's base sphere already exists. You are adding decorations, effects, and materials to it.
7. Return NOTHING. Just add to \`parent\`.

AVAILABLE MATERIALS / GEOMETRIES:
- THREE.SphereGeometry, THREE.RingGeometry, THREE.TorusGeometry, THREE.ConeGeometry, THREE.IcosahedronGeometry
- THREE.MeshStandardMaterial, THREE.MeshBasicMaterial, THREE.MeshPhongMaterial, THREE.ShaderMaterial
- For ShaderMaterial: provide \`vertexShader\` and \`fragmentShader\` strings.
- Use THREE.AdditiveBlending for glow effects.
- Use THREE.BackSide for atmosphere shells.

OUTPUT FORMAT:
Wrap your code in a fenced block like:
\`\`\`json
{
  "threejs": "// your JS code here as a single string",
  "color": "#ff4400",
  "emissive": "#ff2200"
}
\`\`\`

The \`threejs\` value is a single string containing the function body. Escape newlines as \\n.
Keep the code compact but readable.

Example — ringed gas giant:
\`\`\`json
{
  "threejs": "if (parent.children.length === 0) { const atmoGeo = new THREE.SphereGeometry(1.05, 32, 16); const atmoMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.15, side: THREE.BackSide }); const atmo = new THREE.Mesh(atmoGeo, atmoMat); parent.add(atmo); const ringGeo = new THREE.RingGeometry(1.4, 2.2, 64); const ringMat = new THREE.MeshStandardMaterial({ color: 0xccaa88, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }); const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2.3; parent.add(ring); parent.userData._init = true; } if (parent.userData.ring) parent.userData.ring.rotation.z = time * 0.1;",
  "color": "#e6d5b8",
  "emissive": "#221100"
}
\`\`\``;

const GUIDELINES_HTML = `
<h4>Planet Forge Guide</h4>
<p><b>What this does:</b> Chat with an AI to generate Three.js code that renders on top of your selected planet.</p>
<p><b>How to use:</b></p>
<ol>
<li>Select a planet in the 3D view (click it)</li>
<li>Describe what you want: "magma world with volcanic eruptions and ash clouds"</li>
<li>The AI responds with JSON containing Three.js code</li>
<li>Hit <b>Apply</b> to instantly preview it on the planet</li>
</ol>
<p><b>Tips for good results:</b></p>
<ul>
<li>Mention colors, atmosphere, rings, moons, particle effects</li>
<li>Ask for ShaderMaterial for exotic effects (nebula, plasma, crystalline)</li>
<li>Say "animated" if you want it to move/pulse/orbit</li>
<li>You can also ask for HTML/CSS overlay ( HUD elements, labels, status bars )</li>
</ul>
<p><b>API Key:</b> Enter your OpenAI key above, or set <code>OPENAI_API_KEY</code> on the server.</p>
`;

// ── Build UI ─────────────────────────────────────────────────────

function build() {
	const panel = document.createElement("div");
	panel.className = "forge-panel";
	panel.id = "planet-forge";
	panel.style.display = "none";

	// Header
	const header = document.createElement("div");
	header.className = "forge-header";
	header.innerHTML = `<span class="forge-title">Planet Forge</span><div class="forge-btns"><button class="forge-help" title="Guide">?</button><button class="forge-min">─</button><button class="forge-close">×</button></div>`;

	// API key row
	const keyRow = document.createElement("div");
	keyRow.className = "forge-keyrow";
	keyRow.innerHTML = `<input type="password" class="forge-key" placeholder="OpenAI API key" /><button class="forge-key-save">Save</button>`;

	// Target label
	const targetRow = document.createElement("div");
	targetRow.className = "forge-target";
	targetRow.textContent = "Target: (none selected)";

	// Guidelines panel (collapsible)
	const guidePanel = document.createElement("div");
	guidePanel.className = "forge-guide";
	guidePanel.innerHTML = GUIDELINES_HTML;
	guidePanel.style.display = "none";

	// Chat history
	const history = document.createElement("div");
	history.className = "forge-history";

	// Status
	const status = document.createElement("div");
	status.className = "forge-status";

	// Input row
	const inputRow = document.createElement("div");
	inputRow.className = "forge-inputrow";
	inputRow.innerHTML = `<input type="text" class="forge-input" placeholder="Describe your planet..." /><button class="forge-send">Send</button><button class="forge-apply" disabled>Apply</button>`;

	panel.append(header, keyRow, targetRow, guidePanel, history, status, inputRow);
	document.body.appendChild(panel);

	// Elements
	const els = {
		panel, header, keyRow, keyInput: keyRow.querySelector(".forge-key"),
		keySave: keyRow.querySelector(".forge-key-save"),
		targetRow, guidePanel, history, status,
		input: inputRow.querySelector(".forge-input"),
		send: inputRow.querySelector(".forge-send"),
		apply: inputRow.querySelector(".forge-apply"),
		help: header.querySelector(".forge-help"),
		min: header.querySelector(".forge-min"),
		close: header.querySelector(".forge-close"),
	};

	// Load saved key
	els.keyInput.value = localStorage.getItem(API_KEY_LS) || "";

	// Drag
	makeDraggable(panel, header);

	// Events
	els.keySave.addEventListener("click", () => {
		localStorage.setItem(API_KEY_LS, els.keyInput.value.trim());
		els.status.textContent = "Key saved.";
	});

	els.help.addEventListener("click", () => {
		els.guidePanel.style.display = els.guidePanel.style.display === "none" ? "block" : "none";
	});

	els.close.addEventListener("click", () => hide());

	let minimized = false;
	els.min.addEventListener("click", () => {
		minimized = !minimized;
		els.guidePanel.style.display = "none";
		els.history.style.display = minimized ? "none" : "block";
		els.status.style.display = minimized ? "none" : "block";
		els.inputRow.style.display = minimized ? "none" : "flex";
		els.keyRow.style.display = minimized ? "none" : "flex";
		els.targetRow.style.display = minimized ? "none" : "block";
	});

	els.send.addEventListener("click", () => doSend(els));
	els.input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(els); });

	els.apply.addEventListener("click", () => {
		if (!lastAssistantText || !currentTargetId) return;
		const render = parseForgeResponse(lastAssistantText);
		if (render) {
			window.dispatchEvent(new CustomEvent("planet-render-changed", {
				detail: { objectId: currentTargetId, render }
			}));
			els.status.textContent = "Applied to " + currentTargetName;
			els.status.className = "forge-status ok";
		} else {
			els.status.textContent = "No valid render JSON found in last response.";
			els.status.className = "forge-status err";
		}
	});

	// Bring to front on click
	panel.addEventListener("pointerdown", () => {
		panel.style.zIndex = ++zCounter;
	});

	return els;
}

let ui = null;

function ensureUI() {
	if (!ui) ui = build();
	return ui;
}

// ── Drag helper ──────────────────────────────────────────────────

function makeDraggable(el, handle) {
	let dragging = false, ox, oy;
	handle.addEventListener("pointerdown", (e) => {
		dragging = true;
		ox = e.clientX - el.offsetLeft;
		oy = e.clientY - el.offsetTop;
		handle.setPointerCapture(e.pointerId);
	});
	handle.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		el.style.left = (e.clientX - ox) + "px";
		el.style.top = (e.clientY - oy) + "px";
		el.style.right = "auto";
	});
	handle.addEventListener("pointerup", () => { dragging = false; });
}

// ── Public API ───────────────────────────────────────────────────

export function show() {
	const els = ensureUI();
	els.panel.style.display = "block";
	els.panel.style.zIndex = ++zCounter;
}

export function hide() {
	const els = ensureUI();
	els.panel.style.display = "none";
}

export function toggle() {
	const els = ensureUI();
	if (els.panel.style.display === "none") show();
	else hide();
}

export function setTarget(objectId, objectName) {
	currentTargetId = objectId;
	currentTargetName = objectName || objectId?.slice(0, 8) || "none";
	const els = ensureUI();
	els.targetRow.textContent = "Target: " + currentTargetName;
}

// ── Chat logic ───────────────────────────────────────────────────

const messageHistory = []; // { role, content }

async function doSend(els) {
	const text = els.input.value.trim();
	if (!text) return;

	const apiKey = els.keyInput.value.trim() || localStorage.getItem(API_KEY_LS) || "";
	if (!apiKey) {
		els.status.textContent = "Enter an OpenAI API key first.";
		els.status.className = "forge-status err";
		return;
	}

	// Add user message to history
	messageHistory.push({ role: "user", content: text });
	appendMessage(els.history, "user", text);
	els.input.value = "";
	els.status.textContent = "Thinking...";
	els.status.className = "forge-status";
	els.apply.disabled = true;

	try {
		const res = await fetch("/api/planet-forge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					...messageHistory.slice(-10), // keep last 10 for context
				],
				apiKey,
			}),
		});

		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.error || `HTTP ${res.status}`);
		}

		const data = await res.json();
		const assistantText = data.choices?.[0]?.message?.content || "";
		messageHistory.push({ role: "assistant", content: assistantText });
		appendMessage(els.history, "assistant", assistantText);
		lastAssistantText = assistantText;

		// Auto-apply if valid JSON found and target selected
		if (currentTargetId) {
			const render = parseForgeResponse(assistantText);
			if (render) {
				window.dispatchEvent(new CustomEvent("planet-render-changed", {
					detail: { objectId: currentTargetId, render }
				}));
				els.status.textContent = "Auto-applied to " + currentTargetName;
				els.status.className = "forge-status ok";
				els.apply.disabled = false;
				return;
			}
		}

		els.status.textContent = "Response received. Click Apply to use it.";
		els.status.className = "forge-status ok";
		els.apply.disabled = false;
	} catch (err) {
		els.status.textContent = "Error: " + err.message;
		els.status.className = "forge-status err";
	}
}

function appendMessage(historyEl, role, text) {
	const div = document.createElement("div");
	div.className = "forge-msg " + role;
	// Truncate for display
	const preview = text.length > 800 ? text.slice(0, 800) + "\n\n[...truncated]" : text;
	const pre = document.createElement("pre");
	pre.textContent = preview;
	div.appendChild(pre);
	historyEl.appendChild(div);
	historyEl.scrollTop = historyEl.scrollHeight;
}

// ── Parse AI response ────────────────────────────────────────────

export function parseForgeResponse(text) {
	if (!text) return null;
	// Look for fenced JSON
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1].trim());
			if (isValidRender(parsed)) return parsed;
		} catch { /* not JSON */ }
	}
	// Try raw JSON object
	try {
		const parsed = JSON.parse(text.trim());
		if (isValidRender(parsed)) return parsed;
	} catch { /* not JSON */ }
	return null;
}

function isValidRender(obj) {
	if (!obj || typeof obj !== "object") return false;
	return obj.threejs || obj.script || obj.css || obj.html || obj.color || obj.emissive;
}
