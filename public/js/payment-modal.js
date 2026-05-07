/**
 * Payment modal for x402 authorizations in glonAstrolabe.
 */

const els = {
	overlay: document.getElementById("pay-modal"),
	closeBtn: document.getElementById("pay-modal-close"),
	cancelBtn: document.getElementById("pay-cancel"),
	submitBtn: document.getElementById("pay-submit"),
	amount: document.getElementById("pay-amount"),
	token: document.getElementById("pay-token"),
	recipient: document.getElementById("pay-recipient"),
	validFor: document.getElementById("pay-valid-for"),
	key: document.getElementById("pay-key"),
	status: document.getElementById("pay-status"),
};

let onSuccess = null;

function showStatus(text, type = "") {
	els.status.textContent = text;
	els.status.className = "pay-status " + type;
}

function close() {
	els.overlay.hidden = true;
	showStatus("");
	onSuccess = null;
}

function open(opts = {}) {
	els.amount.value = opts.amount ?? "10";
	tokenInput = opts.tokenId ?? "";
	els.token.value = tokenInput;
	els.recipient.value = opts.recipient ?? "";
	els.validFor.value = opts.validForSec ?? 60;
	els.key.value = opts.keyName ?? "default";
	showStatus("");
	onSuccess = opts.onSuccess ?? null;
	els.overlay.hidden = false;
}

async function submit() {
	const amount = els.amount.value.trim();
	const tokenId = els.token.value.trim();
	const recipient = els.recipient.value.trim();
	const validForSec = parseInt(els.validFor.value, 10) || 60;
	const keyName = els.key.value.trim() || "default";

	if (!tokenId) { showStatus("Token ID is required", "err"); return; }
	if (!recipient) { showStatus("Recipient is required", "err"); return; }
	if (!/^[0-9a-f]{64}$/i.test(recipient)) { showStatus("Recipient must be 64 hex chars", "err"); return; }

	els.submitBtn.disabled = true;
	showStatus("Authorizing...", "ok");

	try {
		// Step 1: create authorization
		const authRes = await fetch("/api/pay/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tokenId, amount, recipient, validForSec, keyName }),
		});
		const authData = await authRes.json();
		if (!authData.ok && !authData.authorization) {
			showStatus("Auth failed: " + (authData.error ?? "unknown"), "err");
			els.submitBtn.disabled = false;
			return;
		}

		showStatus("Settling...", "ok");

		// Step 2: settle
		const settleRes = await fetch("/api/pay/settle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				authorization: authData.authorization,
				signature: authData.signature,
				keyName,
			}),
		});
		const settleData = await settleRes.json();
		if (settleData.ok || settleData.settled) {
			showStatus("Payment sent!", "ok");
			if (onSuccess) onSuccess();
			setTimeout(close, 800);
		} else {
			showStatus("Settle failed: " + (settleData.error ?? "unknown"), "err");
		}
	} catch (err) {
		showStatus("Error: " + err.message, "err");
	} finally {
		els.submitBtn.disabled = false;
	}
}

els.closeBtn.addEventListener("click", close);
els.cancelBtn.addEventListener("click", close);
els.submitBtn.addEventListener("click", submit);

// Close on overlay click
els.overlay.addEventListener("click", (e) => {
	if (e.target === els.overlay) close();
});

// Close on Escape
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !els.overlay.hidden) close();
});

let tokenInput = "";

export function showPaymentModal(opts = {}) {
	open(opts);
}

export function initPlanetForgePayButton(sendBtn) {
	const payBtn = document.createElement("button");
	payBtn.textContent = "Pay & Style";
	payBtn.className = "primary";
	payBtn.title = "Pay 10 TT to style with Planet Forge";
	payBtn.style.marginLeft = "6px";
	payBtn.addEventListener("click", () => {
		open({
			amount: "10",
			tokenId: tokenInput,
			recipient: "",
			validForSec: 60,
			keyName: "default",
			onSuccess: () => sendBtn.click(),
		});
	});
	sendBtn.parentNode.insertBefore(payBtn, sendBtn.nextSibling);
}

export function setTokenInput(value) {
	tokenInput = value;
}
