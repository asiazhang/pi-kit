/**
 * Warp terminal detection + protocol negotiation.
 *
 * Pure functions only, no module-level mutable state. Env vars consulted
 * (read fresh on every call — no cache):
 *
 *   TERM_PROGRAM                    — must be "WarpTerminal"
 *   WARP_CLI_AGENT_PROTOCOL_VERSION — required for structured emission
 *   WARP_CLIENT_VERSION             — per-channel broken-version gating
 */

/** Structured event names carried in the OSC 777 payload's `event` field. */
export type WarpEvent =
	| "session_start"
	| "prompt_submit"
	| "stop"
	| "question_asked"
	| "tool_complete"
	| "idle_prompt"

/** Warp release channel — present in every `WARP_CLIENT_VERSION` literal. */
type Channel = "stable" | "preview" | "dev"

/** Parsed version components: [year, month, day, hour, minute, rev, seq]. */
type VersionTuple = readonly [number, number, number, number, number, number, number]

/** Highest protocol version we speak; clamped against Warp's advertised value. */
export const PLUGIN_MAX_PROTOCOL_VERSION = 1

/**
 * Last broken Warp build per channel (dev has none). Builds at or below the
 * threshold advertise structured-protocol support but render notifications
 * behind a feature flag — gate them off rather than animate a tab that
 * never toasts.
 */
const BROKEN_VERSIONS: Record<Channel, VersionTuple | null> = {
	stable: [2026, 3, 25, 8, 24, 5, 5],
	preview: [2026, 3, 25, 8, 24, 5, 5],
	dev: null,
}

const VERSION_RE =
	/^v0\.(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(stable|preview|dev)_(\d+)$/

export function isWarpTerminal(): boolean {
	return process.env.TERM_PROGRAM === "WarpTerminal"
}

/** min(WARP_CLI_AGENT_PROTOCOL_VERSION, ours); falls back to ours when absent/unparseable. */
export function negotiateProtocolVersion(): number {
	const raw = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION
	const warpVersion = raw ? Number.parseInt(raw, 10) : Number.NaN
	if (Number.isNaN(warpVersion)) return PLUGIN_MAX_PROTOCOL_VERSION
	return Math.min(warpVersion, PLUGIN_MAX_PROTOCOL_VERSION)
}

function parseWarpVersion(
	raw: string | undefined,
): { tuple: VersionTuple; channel: Channel } | null {
	if (!raw) return null
	const m = VERSION_RE.exec(raw)
	if (!m) return null
	const tuple: VersionTuple = [
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		Number(m[4]),
		Number(m[5]),
		Number(m[7]),
		Number(m[7]),
	]
	return { tuple, channel: m[6] as Channel }
}

/** Element-wise ≤ over the fixed-length tuples; true on equal. */
function tupleLeq(a: VersionTuple, b: VersionTuple): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) return true
		if (a[i] > b[i]) return false
	}
	return true
}

function isBrokenVersion(raw: string | undefined): boolean {
	const parsed = parseWarpVersion(raw)
	if (!parsed) return false
	const threshold = BROKEN_VERSIONS[parsed.channel]
	if (threshold === null) return false
	return tupleLeq(parsed.tuple, threshold)
}

/**
 * Structured mode: Warp must advertise the protocol env var and not sit at
 * or below the broken threshold.
 */
export function supportsStructured(): boolean {
	if ((process.env.WARP_CLI_AGENT_PROTOCOL_VERSION?.length ?? 0) === 0) return false
	return !isBrokenVersion(process.env.WARP_CLIENT_VERSION)
}
