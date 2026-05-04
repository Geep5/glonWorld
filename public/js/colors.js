/**
 * Type colors — stable hash → hue so new types always get a distinct color.
 * A few well-known types get hand-picked colors for brand consistency.
 */

import * as THREE from "three";

const FIXED = {
	agent:      "#5eead4",
	peer:       "#ffc857",
	program:    "#b197fc",
	typescript: "#7ab7ff",
	javascript: "#7ab7ff",
	proto:      "#4dd4ff",
	json:       "#9aa4b8",
	type:       "#ff9ad6",
	chat:       "#7ae582",
	ttt:        "#ffae4c",
	account:    "#ffb3c7",
	source:     "#8ba6cc",
	remind:     "#f0a04b",
	reminder:   "#f0a04b",
	discord:    "#b7bcf2",
	gc:         "#a3a3a3",
	unknown:    "#6b7488",
	"chain.token": "#ffd700",
	"chain.coin.bucket": "#c0c0c0",
};

function hashHue(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) % 360;
}

const cache = new Map();
export function colorForType(typeKey) {
	if (cache.has(typeKey)) return cache.get(typeKey);
	let hex;
	if (FIXED[typeKey]) hex = FIXED[typeKey];
	else hex = hslToHex(hashHue(typeKey), 65, 62);
	const c = new THREE.Color(hex);
	cache.set(typeKey, { hex, color: c });
	return { hex, color: c };
}

function hslToHex(h, s, l) {
	const c = new THREE.Color();
	c.setHSL(h / 360, s / 100, l / 100);
	return "#" + c.getHexString();
}

export const BLOCK_COLORS = {
	user_text:      new THREE.Color("#4dd4ff"),
	assistant_text: new THREE.Color("#ff7ad6"),
	tool_use:       new THREE.Color("#ffc857"),
	tool_result:    new THREE.Color("#7ae582"),
	tool_error:     new THREE.Color("#ff5b6b"),
	compaction:     new THREE.Color("#b197fc"),
	other:          new THREE.Color("#6b7488"),
};

export function blockColor(block) {
	if (block.kind === "tool_result" && block.isError) return BLOCK_COLORS.tool_error;
	return BLOCK_COLORS[block.kind] ?? BLOCK_COLORS.other;
}
