/**
 * The token 速度 segment (see the token 速度 / 速度等级 entries in
 * CONTEXT.md): the per-run SpeedState, the sliding-window live reading, the
 * usage reconcile at message_end, and the tier colors. Pure state + update
 * functions — the footer owns the state instances, the render scheduling, and
 * the pi event wiring; the reading refresh beat itself lives here, since it
 * must gate the state the upstream TUI re-renders on every delta. Deltas are
 * best-effort under the Responses protocol (openai-responses): the upstream
 * parser drops an output_text.delta whose output item hasn't been announced,
 * while output_item.done always yields a text_end / thinking_end carrying the
 * full block content — recordSpeedEnd() reconciles per block against that
 * authoritative text, so Responses-protocol models (e.g. muse-spark) still
 * get a reading.
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
/**
 * Footer refresh cadence while streaming: the live reading recomputes at most
 * once per interval, and the extension's own render requests are throttled to
 * the same beat. (The upstream TUI re-renders the whole line on every delta,
 * so gating the reading itself is what keeps the displayed value stable.)
 */
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
	/** Estimated tokens per content block of the current assistant message,
	 *  keyed by contentIndex; cleared at each message_end (indices are per-message). */
	blockTokens: number[]
	/** Timestamped token counts inside SPEED_WINDOW_MS. */
	window: { t: number; n: number }[]
	/** Latest sliding-window tok/s; recomputed at most once per refresh beat. */
	live: number | null
	/** Epoch ms of the last live-reading recompute — the throttle clock. */
	liveAt: number
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
	blockTokens: [],
	window: [],
	live: null,
	liveAt: 0,
	final: null,
})

/** Accumulate n tokens at now into the sliding window, refreshing the live
 *  reading at most once per refresh beat (SPEED_THROTTLE_MS). The window keeps
 *  every chunk so each recompute sees the full trailing second; only the
 *  displayed reading is throttled. The span gate keeps a fresh window from
 *  dividing by ~0ms and spiking to an absurd rate. */
function pushWindow(speed: SpeedState, n: number, now: number): void {
	speed.window.push({ t: now, n })
	const cutoff = now - SPEED_WINDOW_MS
	while (speed.window.length > 0 && speed.window[0].t <= cutoff) speed.window.shift()
	const spanMs = speed.window.length > 0 ? now - speed.window[0].t : 0
	if (spanMs < SPEED_MIN_SPAN_MS) return
	if (now - speed.liveAt < SPEED_THROTTLE_MS) return
	let sum = 0
	for (const entry of speed.window) sum += entry.n
	speed.live = sum / (spanMs / 1000)
	speed.liveAt = now
}

/** Close an open tool pause, accumulating its duration into pausedMs. */
export function closePause(speed: SpeedState): void {
	if (speed.pausedAt !== undefined) {
		speed.pausedMs += Date.now() - speed.pausedAt
		speed.pausedAt = undefined
	}
}

/**
 * One streaming delta (text or thinking): count estimated tokens, refresh the
 * sliding-window reading — at most once per refresh beat (SPEED_THROTTLE_MS).
 * The window itself still accumulates every delta, so each recompute sees the
 * full trailing second; only the displayed reading is throttled. This matters
 * because the upstream TUI re-renders the whole line on every delta regardless
 * of the extension's own render throttle — gating the reading is what keeps
 * the displayed tok/s from flickering at the delta arrival rate. A delta means
 * generation is live, so it also closes any open tool pause. Returns true when
 * the delta counted — the caller schedules the throttled redraw only then.
 *
 * The per-block estimate feeds blockTokens, so the later text_end /
 * thinking_end reconciles against the authoritative block text instead of
 * double counting (see recordSpeedEnd).
 */
export function recordSpeedDelta(speed: SpeedState, delta: string, contentIndex: number): boolean {
	if (!speed.running) return false
	closePause(speed)
	const matches = delta.match(TOKEN_REGEX)
	if (!matches) return false
	const now = Date.now()
	speed.tokens += matches.length
	speed.msgTokens += matches.length
	speed.blockTokens[contentIndex] = (speed.blockTokens[contentIndex] ?? 0) + matches.length
	pushWindow(speed, matches.length, now)
	return true
}

/**
 * Block end (text_end / thinking_end): reconcile one content block against its
 * authoritative full text. Under the Responses protocol (openai-responses) the
 * upstream parser drops an output_text.delta whose output item hasn't been
 * announced yet, while output_item.done always yields an end event with the
 * complete block — so for Responses-protocol models (e.g. muse-spark) the end
 * events may be the ONLY token signal. Only the positive difference over the
 * delta estimates is counted, hence Completions-protocol streams (whose end
 * text matches the deltas) are unaffected. The catch-up chunk also feeds the
 * sliding window, so spaced-out blocks still produce a live reading while
 * streaming. Like a delta, an end means generation is live and closes any open
 * tool pause. Returns true when the block carried tokens.
 */
export function recordSpeedEnd(speed: SpeedState, contentIndex: number, content: string): boolean {
	if (!speed.running) return false
	closePause(speed)
	const prev = speed.blockTokens[contentIndex] ?? 0
	const endMatches = content.match(TOKEN_REGEX)
	const est = endMatches ? endMatches.length : 0
	if (est === 0 && prev === 0) return false
	speed.blockTokens[contentIndex] = Math.max(est, prev)
	const diff = est - prev
	if (diff > 0) {
		speed.tokens += diff
		speed.msgTokens += diff
		pushWindow(speed, diff, Date.now())
	}
	return true
}

/**
 * message_end: swap this message's estimate for the provider's cumulative
 * output count (usage arrives only with the completed message), so the
 * frozen run average is exact rather than estimated. Block estimates reset
 * alongside — content indices are per-message, not per-run.
 */
export function reconcileSpeed(
	speed: SpeedState,
	message: { role?: unknown; usage?: { output?: unknown } },
): void {
	if (message.role !== "assistant" || !speed.running) return
	const actual = message.usage?.output
	if (typeof actual === "number" && actual > 0) speed.tokens += actual - speed.msgTokens
	speed.msgTokens = 0
	speed.blockTokens = []
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
