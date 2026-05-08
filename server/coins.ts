/**
 * Coin (UTXO) state replay for chain.coin.bucket objects.
 * Self-contained; mirrors glon's coin.ts logic but is read-only.
 */

	import { dispatchToDaemon } from "./daemon-client.js";
	import type { Block } from "glon/proto.js";

export const BUCKET_TYPE_KEY = "chain.coin.bucket";
export const OP_CONTENT_TYPE = "chain.coin.op";
export const MAX_COINS_PER_BUCKET = 1000;

export interface CoinOp {
	kind: "create" | "spend";
	coinId: string;
	ownerPubkey?: string;
	amount?: string;
}

export interface CoinRecord {
	owner: string;
	amount: string;
	spent: boolean;
}

	export interface CoinState {
		tokenId: string;
		tokenName?: string;
		tokenSymbol?: string;
		coinCount: number;
		unspentCount: number;
		spentCount: number;
		totalAmount: string;
		coins: Record<string, CoinRecord>;
	}

export function decodeCoinOp(block: Block): CoinOp | null {
	const custom = (block.content as any)?.custom;
	if (!custom || custom.contentType !== OP_CONTENT_TYPE) return null;
	const meta = custom.meta as Record<string, string> | undefined;
	if (!meta) return null;
	const kind = meta.op as "create" | "spend" | undefined;
	if (!kind || (kind !== "create" && kind !== "spend")) return null;
	const op: CoinOp = { kind, coinId: meta.coin_id ?? "" };
	if (kind === "create") {
		op.ownerPubkey = meta.owner_pubkey;
		op.amount = meta.amount;
	}
	return op;
}

export function replayBucket(blocks: Block[]): { tokenId: string; coins: Map<string, CoinRecord> } {
	const coins = new Map<string, CoinRecord>();
	for (const block of blocks) {
		const op = decodeCoinOp(block);
		if (!op) continue;
		if (op.kind === "create") {
			coins.set(op.coinId, {
				owner: op.ownerPubkey ?? "",
				amount: op.amount ?? "0",
				spent: false,
			});
		} else if (op.kind === "spend") {
			const existing = coins.get(op.coinId);
			if (existing) existing.spent = true;
		}
	}
	return { tokenId: "", coins };
}

	/** Try daemon dispatch first; fall back to local replay if daemon is offline. */
	export async function replayBucketWithFallback(blocks: Block[]): Promise<{ tokenId: string; coins: Map<string, CoinRecord> }> {
		const daemonResult = await dispatchToDaemon("/coin", "replayBucket", [blocks]);
		if (daemonResult) {
			// Daemon returns plain objects; revive Maps.
			const { tokenId, coins } = daemonResult as any;
			const revived = new Map<string, CoinRecord>();
			for (const [k, v] of Object.entries(coins)) {
				revived.set(k, v as CoinRecord);
			}
			return { tokenId, coins: revived };
		}
		return replayBucket(blocks);
	}

export function buildCoinState(blocks: Block[], fields: Map<string, any>): CoinState | null {
	const tokenField = fields.get("token_id");
	let tokenId = "";
	if (tokenField?.linkValue?.targetId) {
		tokenId = tokenField.linkValue.targetId;
	} else if (typeof tokenField === "string") {
		tokenId = tokenField;
	}
	const { coins } = replayBucket(blocks);
	let unspent = 0;
	let spent = 0;
	let total = 0n;
	const record: Record<string, CoinRecord> = {};
	for (const [id, c] of coins) {
		record[id] = c;
		if (c.spent) spent++;
		else unspent++;
		total += BigInt(c.amount);
	}
	return {
		tokenId,
		coinCount: coins.size,
		unspentCount: unspent,
		spentCount: spent,
		totalAmount: total.toString(),
		coins: record,
	};
}

export function getCoinHolders(blocks: Block[]): { pubkey: string; balance: string }[] {
	const { coins } = replayBucket(blocks);
	const balances = new Map<string, bigint>();
	for (const c of coins.values()) {
		if (c.spent) continue;
		const prev = balances.get(c.owner) ?? 0n;
		balances.set(c.owner, prev + BigInt(c.amount));
	}
	const result = Array.from(balances.entries()).map(([pubkey, balance]) => ({ pubkey, balance: balance.toString() }));
	result.sort((a, b) => {
		const na = BigInt(a.balance);
		const nb = BigInt(b.balance);
		if (na < nb) return 1;
		if (na > nb) return -1;
		return 0;
	});
	return result;
}

export function getCoinBalancesByToken(allObjects: { state: { typeKey: string; blocks: Block[] } }[]): Record<string, { pubkey: string; balance: string }[]> {
	const result: Record<string, { pubkey: string; balance: string }[]> = {};
	for (const obj of allObjects) {
		if (obj.state.typeKey !== BUCKET_TYPE_KEY) continue;
		const holders = getCoinHolders(obj.state.blocks);
		// Group by token — we'd need tokenId from fields, simplified here
		for (const h of holders) {
			// Just aggregate globally for now; caller can filter by token
		}
	}
	return result;
}

export function getBucketOverview(allObjects: Iterable<{ object: { id: string; typeKey: string; name?: string }; state: { fields: Map<string, any>; blocks: Block[] } }>): { buckets: (any & { coinState: CoinState })[] } {
	const buckets: (any & { coinState: CoinState })[] = [];
	for (const po of allObjects) {
		if (po.object.typeKey !== BUCKET_TYPE_KEY) continue;
		const coinState = buildCoinState(po.state.blocks, po.state.fields);
		if (!coinState) continue;
		buckets.push({ ...po.object, coinState });
	}
	return { buckets };
}

export function getGlobalCoinStats(allObjects: Iterable<{ state: { typeKey: string; fields: Map<string, any>; blocks: Block[] } }>): Record<string, { totalSupply: string; holders: number; buckets: number }> {
	const byToken = new Map<string, { totalSupply: bigint; holders: Set<string>; buckets: number }>();
	for (const po of allObjects) {
		if (po.state.typeKey !== BUCKET_TYPE_KEY) continue;
		const tokenField = po.state.fields.get("token_id");
		let tokenId = "";
		if (tokenField?.linkValue?.targetId) tokenId = tokenField.linkValue.targetId;
		else if (typeof tokenField === "string") tokenId = tokenField;
		if (!tokenId) continue;
		const { coins } = replayBucket(po.state.blocks);
		let entry = byToken.get(tokenId);
		if (!entry) {
			entry = { totalSupply: 0n, holders: new Set(), buckets: 0 };
			byToken.set(tokenId, entry);
		}
		entry.buckets++;
		for (const c of coins.values()) {
			if (c.spent) continue;
			entry.totalSupply += BigInt(c.amount);
			entry.holders.add(c.owner);
		}
	}
	const result: Record<string, { totalSupply: string; holders: number; buckets: number }> = {};
	for (const [tokenId, stat] of byToken) {
		result[tokenId] = { totalSupply: stat.totalSupply.toString(), holders: stat.holders.size, buckets: stat.buckets };
	}
	return result;
}
