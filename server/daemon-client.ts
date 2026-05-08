/**
 * Thin HTTP client for glon's daemon dispatch endpoint.
 *
 * Falls back gracefully when the daemon is offline. Used by the visualizer
 * to delegate expensive replay operations to glon rather than maintaining
 * a parallel implementation.
 */

const DAEMON_PORT = Number(process.env.GLON_DAEMON_PORT ?? 6430);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}/dispatch`;

interface DispatchRequest {
	prefix: string;
	action: string;
	args: unknown[];
}

/** Dispatch an action to the daemon. Returns null if the daemon is unreachable. */
export async function dispatchToDaemon(
	prefix: string,
	action: string,
	args: unknown[],
): Promise<unknown | null> {
	try {
		const res = await fetch(DAEMON_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prefix, action, args } satisfies DispatchRequest),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}
