/**
 * Token state replay and wallet reading for chain.token objects.
 * Self-contained; mirrors glon's token.ts logic but is read-only.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Block, Value } from "../../../3/glon/src/proto.js";
import { parseUint, addBounded, subChecked, U128_MAX, BIG_ZERO, bigToString } from "../../../3/glon/src/det/math.js";

const GLON_ROOT = process.env.GLON_DATA ?? join(homedir(), ".glon");

export const TOKEN_TYPE_KEY = "chain.token";
const OP_CONTENT_TYPE = "chain.token.op";
const FIELD_NAME = "name";
const FIELD_SYMBOL = "symbol";
const FIELD_DECIMALS = "decimals";
const FIELD_OWNER = "owner_pubkey";
const FIELD_INITIAL_SUPPLY = "initial_supply";
const FIELD_STORAGE_CREDIT = "storage_credit";

type TokenOpKind = "Mint" | "Transfer" | "Approve" | "TransferFrom" | "Burn" | "RenounceMint";
const ALL_OP_KINDS: readonly TokenOpKind[] = ["Mint", "Transfer", "Approve", "TransferFrom", "Burn", "RenounceMint"];

interface TokenOp {
	kind: TokenOpKind;
	to?: string;
	from?: string;
	spender?: string;
	amount?: string;
}

export interface TokenState {
	name: string;
	symbol: string;
	decimals: number;
	ownerPubkey: string;
	totalSupply: string;
	storageCredit: string;
	renounced: boolean;
	balances: Record<string, string>;
	allowances: Record<string, Record<string, string>>;
	ops: TokenOpRecord[];
}

export interface TokenOpRecord {
	kind: TokenOpKind;
	amount?: string;
	to?: string;
	from?: string;
	spender?: string;
	signer: string;
	blockId: string;
	timestamp: number;
}

function extractStr(v: any): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return "";
}

function extractInt(v: any, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) {
		const n = v.intValue;
		return typeof n === "number" ? n : Number(n) | 0;
	}
	return fallback;
}

function decodeTokenOp(meta: Record<string, string> | undefined): TokenOp | null {
	if (!meta || typeof meta !== "object") return null;
	const kind = meta.op as TokenOpKind | undefined;
	if (!kind || !ALL_OP_KINDS.includes(kind)) return null;
	const op: TokenOp = { kind };
	if (typeof meta.to === "string") op.to = meta.to;
	if (typeof meta.from === "string") op.from = meta.from;
	if (typeof meta.spender === "string") op.spender = meta.spender;
	if (typeof meta.amount === "string") op.amount = meta.amount;
	return op;
}

function inferSigner(block: Block): string {
	const meta = (block.content as any)?.custom?.meta as Record<string, string> | undefined;
	return meta?.signer ?? "";
}

interface TokenStateInternal {
	name: string;
	symbol: string;
	decimals: number;
	ownerPubkey: string;
	balances: Map<string, bigint>;
	allowances: Map<string, Map<string, bigint>>;
	totalSupply: bigint;
	storageCredit: bigint;
}

function getBal(balances: Map<string, bigint>, pubkey: string): bigint {
	return balances.get(pubkey) ?? BIG_ZERO;
}

function setBal(balances: Map<string, bigint>, pubkey: string, value: bigint): void {
	if (value === BIG_ZERO) balances.delete(pubkey);
	else balances.set(pubkey, value);
}

function getAllow(allowances: Map<string, Map<string, bigint>>, owner: string, spender: string): bigint {
	return allowances.get(owner)?.get(spender) ?? BIG_ZERO;
}

function setAllow(allowances: Map<string, Map<string, bigint>>, owner: string, spender: string, value: bigint): void {
	let m = allowances.get(owner);
	if (!m) { m = new Map(); allowances.set(owner, m); }
	if (value === BIG_ZERO) m.delete(spender);
	else m.set(spender, value);
	if (m.size === 0) allowances.delete(owner);
}

function applyOp(state: TokenStateInternal, op: TokenOp, signer: string): void {
	switch (op.kind) {
		case "Mint": {
			if (!signer) throw new Error("Mint: signer missing");
			if (!state.ownerPubkey) throw new Error("Mint: renounced");
			if (signer !== state.ownerPubkey) throw new Error("Mint: not owner");
			if (!op.to || !op.amount) throw new Error("Mint: to+amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("Mint: amount > 0");
			state.totalSupply = addBounded(state.totalSupply, amount, U128_MAX);
			setBal(state.balances, op.to, addBounded(getBal(state.balances, op.to), amount, U128_MAX));
			return;
		}
		case "Transfer": {
			if (!signer) throw new Error("Transfer: signer missing");
			if (!op.to || !op.amount) throw new Error("Transfer: to+amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("Transfer: amount > 0");
			const bal = getBal(state.balances, signer);
			setBal(state.balances, signer, subChecked(bal, amount));
			setBal(state.balances, op.to, addBounded(getBal(state.balances, op.to), amount, U128_MAX));
			return;
		}
		case "Approve": {
			if (!signer) throw new Error("Approve: signer missing");
			if (!op.spender || op.amount === undefined) throw new Error("Approve: spender+amount required");
			const amount = parseUint(op.amount);
			setAllow(state.allowances, signer, op.spender, amount);
			return;
		}
		case "TransferFrom": {
			if (!signer) throw new Error("TransferFrom: signer missing");
			if (!op.from || !op.to || !op.amount) throw new Error("TransferFrom: from+to+amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("TransferFrom: amount > 0");
			const allowance = getAllow(state.allowances, op.from, signer);
			const newAllowance = subChecked(allowance, amount);
			const bal = getBal(state.balances, op.from);
			setBal(state.balances, op.from, subChecked(bal, amount));
			setBal(state.balances, op.to, addBounded(getBal(state.balances, op.to), amount, U128_MAX));
			setAllow(state.allowances, op.from, signer, newAllowance);
			return;
		}
		case "Burn": {
			if (!signer) throw new Error("Burn: signer missing");
			if (!op.amount) throw new Error("Burn: amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("Burn: amount > 0");
			const bal = getBal(state.balances, signer);
			setBal(state.balances, signer, subChecked(bal, amount));
			state.totalSupply = subChecked(state.totalSupply, amount);
			return;
		}
		case "RenounceMint": {
			if (!signer) throw new Error("RenounceMint: signer missing");
			if (!state.ownerPubkey) throw new Error("RenounceMint: already renounced");
			if (signer !== state.ownerPubkey) throw new Error("RenounceMint: not owner");
			state.ownerPubkey = "";
			return;
		}
	}
}

export function replayTokenState(fields: Map<string, Value>, blocks: Block[]): TokenState | null {
	const state: TokenStateInternal = {
		name: extractStr(fields.get(FIELD_NAME)),
		symbol: extractStr(fields.get(FIELD_SYMBOL)),
		decimals: extractInt(fields.get(FIELD_DECIMALS), 0),
		ownerPubkey: extractStr(fields.get(FIELD_OWNER)),
		balances: new Map(),
		allowances: new Map(),
		totalSupply: BIG_ZERO,
		storageCredit: BIG_ZERO,
	};
	const initialSupplyStr = extractStr(fields.get(FIELD_INITIAL_SUPPLY));
	if (initialSupplyStr) {
		state.totalSupply = parseUint(initialSupplyStr);
		if (state.ownerPubkey) state.balances.set(state.ownerPubkey, state.totalSupply);
	}
	const storageCreditStr = extractStr(fields.get(FIELD_STORAGE_CREDIT));
	if (storageCreditStr) {
		state.storageCredit = parseUint(storageCreditStr);
	}
	const ops: TokenOpRecord[] = [];
	for (const block of blocks) {
		const meta = (block.content as any)?.custom?.meta as Record<string, string> | undefined;
		const contentType = (block.content as any)?.custom?.contentType ?? (block.content as any)?.custom?.content_type;
		if (contentType !== OP_CONTENT_TYPE) continue;
		const op = decodeTokenOp(meta);
		if (!op) continue;
		const signer = inferSigner(block);
		ops.push({
			kind: op.kind,
			amount: op.amount,
			to: op.to,
			from: op.from,
			spender: op.spender,
			signer,
			blockId: block.id,
			timestamp: 0,
		});
		try {
			applyOp(state, op, signer);
		} catch {
			// Invalid op — state stays as-is for visibility.
		}
	}
	const balances: Record<string, string> = {};
	for (const [k, v] of state.balances) balances[k] = bigToString(v);
	const allowances: Record<string, Record<string, string>> = {};
	for (const [owner, m] of state.allowances) {
		const inner: Record<string, string> = {};
		for (const [spender, v] of m) inner[spender] = bigToString(v);
		allowances[owner] = inner;
	}
	return {
		name: state.name,
		symbol: state.symbol,
		decimals: state.decimals,
		ownerPubkey: state.ownerPubkey,
		totalSupply: bigToString(state.totalSupply),
		storageCredit: bigToString(state.storageCredit),
		renounced: state.ownerPubkey === "",
		balances,
		allowances,
		ops,
	};
}

// ── Wallet reader ────────────────────────────────────────────────

let walletPubkeys: Set<string> | null = null;
let walletMtime = 0;

export function getWalletPubkeys(): Set<string> {
	const path = join(GLON_ROOT, "wallet.json");
	if (!existsSync(path)) return new Set();
	const mtime = statSync(path).mtimeMs;
	if (walletPubkeys && walletMtime === mtime) return walletPubkeys;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const keys = raw?.keys ?? {};
		const set = new Set<string>();
		for (const entry of Object.values(keys) as any[]) {
			if (typeof entry?.pubkey === "string") set.add(entry.pubkey);
		}
		walletPubkeys = set;
		walletMtime = mtime;
		return set;
	} catch {
		return new Set();
	}
}
