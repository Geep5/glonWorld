/**
 * Planet Forge — AI chat for designing Three.js planet renders.
 *
 * Embedded in the inspector panel. Manages chat state and API calls.
 * UI elements are passed in from inspector.js.
 */

const API_KEY_LS = "glonAstrolabe.openaiKey";

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
\`\``;

// ── State ────────────────────────────────────────────────────────

const messageHistory = []; // { role, content }
let lastAssistantText = "";
let currentTargetId = null;

// ── Exported API ─────────────────────────────────────────────────

/**
 * Wire up the forge UI inside the inspector.
 * Call once when the inspector initializes.
 */
export function init({
	historyEl,
	statusEl,
	inputEl,
	sendBtn,
	applyBtn,
	keyInput,
	keySaveBtn,
}) {
	// Load saved key
	keyInput.value = localStorage.getItem(API_KEY_LS) || "";

	keySaveBtn.addEventListener("click", () => {
		localStorage.setItem(API_KEY_LS, keyInput.value.trim());
		statusEl.textContent = "Key saved.";
	});

	sendBtn.addEventListener("click", () => doSend({ historyEl, statusEl, inputEl, applyBtn, keyInput }));
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter") doSend({ historyEl, statusEl, inputEl, applyBtn, keyInput });
	});

	applyBtn.addEventListener("click", () => {
		if (!lastAssistantText || !currentTargetId) return;
		const render = parseForgeResponse(lastAssistantText);
		if (render) {
			window.dispatchEvent(new CustomEvent("planet-render-changed", {
				detail: { objectId: currentTargetId, render }
			}));
			statusEl.textContent = "Applied.";
			statusEl.className = "forge-status ok";
		} else {
			statusEl.textContent = "No valid render JSON found.";
			statusEl.className = "forge-status err";
		}
	});
}

export function setTarget(objectId) {
	currentTargetId = objectId;
}

export function clearHistory(historyEl) {
	messageHistory.length = 0;
	lastAssistantText = "";
	historyEl.innerHTML = "";
}

// ── Chat logic ───────────────────────────────────────────────────

async function doSend({ historyEl, statusEl, inputEl, applyBtn, keyInput }) {
	const text = inputEl.value.trim();
	if (!text) return;

	const apiKey = keyInput.value.trim() || localStorage.getItem(API_KEY_LS) || "";
	if (!apiKey) {
		statusEl.textContent = "Enter an OpenAI API key.";
		statusEl.className = "forge-status err";
		return;
	}

	messageHistory.push({ role: "user", content: text });
	appendMessage(historyEl, "user", text);
	inputEl.value = "";
	statusEl.textContent = "Thinking...";
	statusEl.className = "forge-status";
	applyBtn.disabled = true;

	try {
		const res = await fetch("/api/planet-forge", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					...messageHistory.slice(-10),
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
		appendMessage(historyEl, "assistant", assistantText);
		lastAssistantText = assistantText;

		// Auto-apply if valid JSON found and target selected
		if (currentTargetId) {
			const render = parseForgeResponse(assistantText);
			if (render) {
				window.dispatchEvent(new CustomEvent("planet-render-changed", {
					detail: { objectId: currentTargetId, render }
				}));
				statusEl.textContent = "Auto-applied.";
				statusEl.className = "forge-status ok";
				applyBtn.disabled = false;
				return;
			}
		}

		statusEl.textContent = "Response received. Click Apply to use it.";
		statusEl.className = "forge-status ok";
		applyBtn.disabled = false;
	} catch (err) {
		statusEl.textContent = "Error: " + err.message;
		statusEl.className = "forge-status err";
	}
}

function appendMessage(historyEl, role, text) {
	const div = document.createElement("div");
	div.className = "forge-msg " + role;
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
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1].trim());
			if (isValidRender(parsed)) return parsed;
		} catch { /* not JSON */ }
	}
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
