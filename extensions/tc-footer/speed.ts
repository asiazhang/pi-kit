/**
 * The token 速度 segment (see the token 速度 / 速度等级 entries in
 * CONTEXT.md): the per-run SpeedState, the sliding-window live reading, the
 * usage reconcile at message_end, and the tier colors. Pure state + update
 * functions — the footer owns the state instances, the render throttle, and
 * the pi event wiring.
 */

/**
 * Speed-tier lower bounds (tok/s): below `warn` is unacceptable (error red),
 * then warning yellow, success green, and accent cyan from `top` up — the
 * anchor is a ~300 tok/s ceiling (fastest observed model), so the top tier
 * starts at two-thirds of it. See the 速度等级 entry in CONTEXT.md.
 */
const SPEED_TIERS = { warn: 50, good: 100, top: 200 }

/** Sliding-window length behind the live tok/s reading. */
const SPEED_WINDOW_MS = 1_000

/**
 * Don't replace the live reading until the fresh window spans this long:
 * dividing the first delta by ~0ms would spike to an absurd rate.
 */
const SPEED_MIN_SPAN_MS = 100

/** Footer refresh cadence while streaming: ≤1 render per interval, plus a trailing flush. */
export const SPEED_THROTTLE_MS = 1_000

/** Word/punctuation token estimate applied to one streaming delta (`estimate` counting). */
const TOKEN_REGEX = /\w+|[^\s\w]/g

/** Tier color for a tok/s value — see SPEED_TIERS. */
export function speedColor(tps: number): "error" | "warning" | "success" | "accent" {
	if (tps >= SPEED_TIERS.top) return "accent"
	if (tps >= SPEED_TIERS.good) return "success"
	if (tps >= SPEED_TIERS.warn) return "warning"
	return "error"
}

/** Token-speed state for one agent run (fresh per run and per session). */
export interface SpeedState {
	/** True from agent_start until agent_end. */
	running: boolean
	/** Run start instant (epoch ms). */
	startAt: number
	/** Tool-execution pause onset, while paused. */
	pausedAt?: number
	/** Accumulated paused milliseconds — excluded from the run average. */
	pausedMs: number
	/** Estimated total tokens, reconciled with usage.output at each message_end. */
	tokens: number
	/** Estimated tokens in the assistant message currently streaming. */
	msgTokens: number
	/** Timestamped token counts inside SPEED_WINDOW_MS. */
	window: { t: number; n: number }[]
	/** Latest sliding-window tok/s; kept until a fresh window spans enough time. */
	live: number | null
	/** Frozen whole-run average after agent_end, until the next run. */
	final: number | null
}

export const freshSpeed = (): SpeedState => ({
	running: false,
	startAt: 0,
	pausedAt: undefined,
	pausedMs: 0,
	tokens: 0,
	msgTokens: 0,
	window: [],
	live: null,
	final: null,
})

/** Close an open tool pause, accumulating its duration into pausedMs. */
export function closePause(speed: SpeedState): void {
	if (speed.pausedAt !== undefined) {
		speed.pausedMs += Date.now() - speed.pausedAt
		speed.pausedAt = undefined
	}
}

/**
 * One streaming delta (text or thinking): count estimated tokens, refresh
 * the sliding-window reading. A delta means generation is live, so it also
 * closes any open tool pause. Returns true when the delta counted — the
 * caller schedules the throttled redraw only then.
 */
export function recordSpeedDelta(speed: SpeedState, delta: string): boolean {
	if (!speed.running) return false
	closePause(speed)
	const matches = delta.match(TOKEN_REGEX)
	if (!matches) return false
	const now = Date.now()
	speed.tokens += matches.length
	speed.msgTokens += matches.length
	speed.window.push({ t: now, n: matches.length })
	// Slide the window; keep the previous reading until the fresh span is
	// long enough to divide by.
	const cutoff = now - SPEED_WINDOW_MS
	while (speed.window.length > 0 && speed.window[0].t <= cutoff) speed.window.shift()
	const spanMs = speed.window.length > 0 ? now - speed.window[0].t : 0
	if (spanMs >= SPEED_MIN_SPAN_MS) {
		let sum = 0
		for (const entry of speed.window) sum += entry.n
		speed.live = sum / (spanMs / 1000)
	}
	return true
}

/**
 * message_end: swap this message's estimate for the provider's cumulative
 * output count (usage arrives only with the completed message), so the
 * frozen run average is exact rather than estimated.
 */
export function reconcileSpeed(
	speed: SpeedState,
	message: { role?: unknown; usage?: { output?: unknown } },
): void {
	if (message.role !== "assistant" || !speed.running) return
	const actual = message.usage?.output
	if (typeof actual === "number" && actual > 0) speed.tokens += actual - speed.msgTokens
	speed.msgTokens = 0
}

/**
 * agent_end: freeze the whole-run average. Elapsed active time excludes tool
 * pauses; no tokens or no elapsed time — no segment (rather than a
 * misleading 0).
 */
export function finalizeRun(speed: SpeedState, now: number): number | null {
	closePause(speed)
	speed.running = false
	const elapsedMs = now - speed.startAt - speed.pausedMs
	return speed.tokens > 0 && elapsedMs > 0 ? speed.tokens / (elapsedMs / 1000) : null
}
