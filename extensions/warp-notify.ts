/**
 * Native Warp terminal notifications over OSC 777.
 *
 * Ported from @juicesharp/rpiv-warp (MIT, juicesharp/rpiv-mono), which
 * itself follows Warp's reference plugins (warpdotdev/opencode-warp).
 * Warp renders what we write: the OSC 777 cli-agent sequence becomes a
 * system toast + tab badge; a continuously rewritten OSC 0 title drives
 * the per-tab braille spinner (the animation is a terminal-side side
 * effect of title churn, not part of the 777 protocol).
 *
 * Outside Warp this registers zero handlers and writes zero bytes —
 * detection gates the whole feature on env vars only Warp sets.
 *
 * State machine — the one deliberate divergence from upstream:
 *
 *   Upstream keys the spinner/heartbeat to `agent_start`/`agent_end`
 *   booleans. Subagents break that: a child session binds the same
 *   extension (pi-subagents default `extensions: true`), ESM caching
 *   shares this module's state across both instances, and the child's
 *   `agent_end` stops the parent's spinner mid-run. Nothing restarts it
 *   until the user's next prompt (only `agent_start` and blocking
 *   `tool_execution_end` call `startSpinner`).
 *
 *   Here the shared state is refcounted instead. Runs and outstanding
 *   blocking-tool calls are counted; the spinner runs while any run is
 *   live (parked while a blocking call waits); toasts and heartbeat
 *   belong to the OUTERMOST run — a settable role, not just the 0→1
 *   transition, because background subagents can outlive the run that
 *   spawned them (see the Registration section). Concurrent runs compose
 *   for free: the tab spins until the last run ends, and a child's
 *   spurious `stop` toast and `idle_prompt` are gone.
 *
 * Sequences written to the controlling terminal (/dev/tty; Windows
 * best-effort via stdout + ConPTY), all errors swallowed — a failed
 * notification must never reach the agent loop:
 *
 *   OSC 777      ESC ] 777 ; notify ; <title> ; <json> BEL   structured event
 *   OSC 0        ESC ] 0 ; <title> BEL                       tab title (spinner)
 *   CSI 22;0t    push title stack   ┐ spinner start/stop
 *   CSI 23;0t    pop title stack    ┘ restores Pi's own tab title
 */

import { closeSync, openSync, writeSync } from "node:fs"
import { basename } from "node:path"
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { parseSkillBlock } from "@earendil-works/pi-coding-agent"

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Warp routes `CLIAgent::pi` to its default session listener. */
const AGENT_ID = "pi"
/** Highest protocol version we speak; clamped against Warp's advertised value. */
const PLUGIN_MAX_PROTOCOL_VERSION = 1
/** Last broken Warp build per channel — advertises the protocol, never renders. */
const BROKEN_VERSION_TUPLE = [2026, 3, 25, 8, 24, 5, 5] as const
/** Toast text / query fields are truncated here. */
const TRUNCATE_LIMIT = 200
/** Re-announce the running prompt so Warp doesn't flip the tab to idle. */
const HEARTBEAT_MS = 15_000
/** Delay before idle_prompt after the outermost run ends. */
const IDLE_DELAY_MS = 300
/** Braille spinner: 3-dot cluster with a clockwise rotating gap, equal width. */
const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"] as const
/** ~1.5 Hz — reads as ambient activity, not urgency. */
const SPINNER_INTERVAL_MS = 160
/** Tools that park the run on a question (Blocked badge while outstanding). */
const BLOCKING_TOOLS = new Set(["ask_user_question"])

// ---------------------------------------------------------------------------
// Warp detection — env vars Warp sets itself, read fresh every call
// ---------------------------------------------------------------------------

const VERSION_RE =
	/^v0\.(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(\d{1,2})\.(stable|preview|dev)_(\d+)$/

function isWarpTerminal(): boolean {
	return process.env.TERM_PROGRAM === "WarpTerminal"
}

/** min(WARP_CLI_AGENT_PROTOCOL_VERSION, ours); falls back to ours when absent/unparseable. */
function negotiateProtocolVersion(): number {
	const parsed = Number.parseInt(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION ?? "", 10)
	return Number.isNaN(parsed)
		? PLUGIN_MAX_PROTOCOL_VERSION
		: Math.min(parsed, PLUGIN_MAX_PROTOCOL_VERSION)
}

/** Element-wise ≤ over the 7-component version tuples. */
function tupleLeq(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) return true
		if (a[i] > b[i]) return false
	}
	return true
}

/**
 * Builds at or below the broken threshold advertise structured-protocol
 * support but render notifications behind a feature flag — gate them off
 * rather than animate a tab that never toasts.
 */
function isBrokenBuild(): boolean {
	const raw = process.env.WARP_CLIENT_VERSION
	if (!raw) return false
	const m = VERSION_RE.exec(raw)
	if (!m) return false
	// dev channel has no broken threshold
	if (m[6] === "dev") return false
	const tuple = [
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		Number(m[4]),
		Number(m[5]),
		Number(m[7]),
		Number(m[7]),
	]
	return tupleLeq(tuple, BROKEN_VERSION_TUPLE)
}

function supportsStructured(): boolean {
	return (process.env.WARP_CLI_AGENT_PROTOCOL_VERSION?.length ?? 0) > 0 && !isBrokenBuild()
}

// ---------------------------------------------------------------------------
// OSC transport
// ---------------------------------------------------------------------------

const OSC = "\x1b]"
const BEL = "\x07"
const CSI = "\x1b["
const TTY_PATH = "/dev/tty"

function writeRaw(bytes: string): void {
	try {
		if (process.platform === "win32") {
			// No /dev/tty on Windows; ConPTY forwards unrecognized OSCs to Warp.
			if (process.stdout.isTTY) process.stdout.write(bytes)
			return
		}
		const fd = openSync(TTY_PATH, "w")
		try {
			writeSync(fd, bytes)
		} finally {
			try {
				closeSync(fd)
			} catch {
				// already closed — nothing to do
			}
		}
	} catch {
		// silent skip: a notification must never break the agent loop
	}
}

function writeOSC777(payloadJson: string): void {
	writeRaw(`${OSC}777;notify;${AGENT_ID};${payloadJson}${BEL}`)
}

function writeTitle(title: string): void {
	writeRaw(`${OSC}0;${title}${BEL}`)
}

function pushTitleStack(): void {
	writeRaw(`${CSI}22;0t`)
}

function popTitleStack(): void {
	writeRaw(`${CSI}23;0t`)
}

// ---------------------------------------------------------------------------
// Payloads — branch → text extraction → envelope → JSON
// ---------------------------------------------------------------------------

type WarpEvent =
	| "session_start"
	| "prompt_submit"
	| "stop"
	| "question_asked"
	| "tool_complete"
	| "idle_prompt"

interface WarpPayload {
	readonly v: number
	readonly agent: string
	readonly event: WarpEvent
	readonly session_id: string
	readonly cwd: string
	readonly project: string
	readonly query?: string
	readonly response?: string
	readonly summary?: string
	readonly tool_name?: string
}

function truncate(s: string): string {
	return s.length <= TRUNCATE_LIMIT ? s : `${s.slice(0, TRUNCATE_LIMIT - 3)}...`
}

/** Collapse a `<skill name="…" location="…">…</skill>` wrapper back to `/skill:<name> <args>`. */
function summarizeSkillBlock(text: string): string {
	const parsed = parseSkillBlock(text)
	if (!parsed) return text
	const args = parsed.userMessage?.match(/^Skill input: ([\s\S]*)$/)?.[1] ?? parsed.userMessage
	return args ? `/skill:${parsed.name} ${args}` : `/skill:${parsed.name}`
}

function extractText(content: UserMessage["content"] | AssistantMessage["content"]): string {
	if (typeof content === "string") return content
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
}

/** Reverse-scan the branch for the most recent text of the given role. */
function lastMessageText(branch: SessionEntry[], role: "user" | "assistant"): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry: SessionEntry = branch[i]
		if (entry.type !== "message") continue
		const message = (entry as { message: UserMessage | AssistantMessage }).message
		if (message.role !== role) continue
		const text = summarizeSkillBlock(extractText(message.content))
		if (text.length > 0) return truncate(text)
	}
	return ""
}

type WarpExtras = Partial<Pick<WarpPayload, "query" | "response" | "summary" | "tool_name">>

function envelope(event: WarpEvent, ctx: ExtensionContext): WarpPayload {
	return {
		v: negotiateProtocolVersion(),
		agent: AGENT_ID,
		event,
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		project: basename(ctx.cwd),
	}
}

function emit(event: WarpEvent, ctx: ExtensionContext, extras?: WarpExtras): void {
	writeOSC777(JSON.stringify({ ...envelope(event, ctx), ...extras }))
}

// ---------------------------------------------------------------------------
// Spinner — single idempotent ticker; only the mascot glyph is swapped
// ---------------------------------------------------------------------------

interface Ticker {
	timer: ReturnType<typeof setInterval>
	frame: number
	suffix: string
}

let ticker: Ticker | undefined

function spinnerTitle(frame: number, suffix: string): string {
	return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${suffix}`
}

function tick(): void {
	if (!ticker) return
	writeTitle(spinnerTitle(ticker.frame, ticker.suffix))
	ticker.frame = (ticker.frame + 1) % SPINNER_FRAMES.length
}

function startSpinner(ctx: ExtensionContext): void {
	if (ticker) return
	// Mirror Pi's startup tab title `<mascot> - <repo>`; push/pop restores it verbatim.
	const suffix = ` - ${basename(ctx.cwd)}`
	pushTitleStack()
	const timer = setInterval(tick, SPINNER_INTERVAL_MS)
	timer.unref?.()
	ticker = { timer, frame: 0, suffix }
}

function stopSpinner(): void {
	if (!ticker) return
	clearInterval(ticker.timer)
	ticker = undefined
	popTitleStack()
}

// ---------------------------------------------------------------------------
// Run/block state machine — refcounted, shared across parent + subagent
// extension instances (one module, one process)
// ---------------------------------------------------------------------------

let activeRuns = 0
let blockedCalls = 0
let outerSettled = false
let pendingQuery = ""
let runCtx: ExtensionContext | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined

interface PendingBlockingCall {
	readonly toolName: string
	readonly input?: Record<string, unknown>
}

/** Outstanding blocking calls keyed by toolCallId. An ESC abort never fires
 *  `tool_execution_end`, so entries drain at the outermost `agent_end` —
 *  that drain is what clears Warp's stale "Blocked" badge. */
const pendingBlocking = new Map<string, PendingBlockingCall>()

function stopHeartbeat(): void {
	if (heartbeat !== undefined) {
		clearInterval(heartbeat)
		heartbeat = undefined
	}
}

function startHeartbeat(): void {
	stopHeartbeat()
	heartbeat = setInterval(() => {
		if (runCtx) emit("prompt_submit", runCtx, { query: pendingQuery })
	}, HEARTBEAT_MS)
	heartbeat.unref?.()
}

function cancelIdleTimer(): void {
	if (idleTimer !== undefined) {
		clearTimeout(idleTimer)
		idleTimer = undefined
	}
}

/** Spinner runs while any run is live and no blocking call parks it. */
function syncSpinner(): void {
	if (activeRuns > 0 && blockedCalls === 0) {
		if (runCtx) startSpinner(runCtx)
	} else {
		stopSpinner()
	}
}

function cleanupAll(): void {
	cancelIdleTimer()
	stopHeartbeat()
	stopSpinner()
	pendingQuery = ""
	runCtx = undefined
	activeRuns = 0
	blockedCalls = 0
	outerSettled = false
	pendingBlocking.clear()
}

// ---------------------------------------------------------------------------
// Registration
//
// "Outermost" is a SETTLABLE role, not just the 0→1 transition. Background
// subagents (`run_in_background`) can outlive the run that spawned them, so
// after the outer run settles (stop toast emitted) the counter may still be
// positive and the spinner legitimately keeps spinning. Two consequences:
//
//   - the next `agent_start` while `outerSettled` is a NEW outer run: it
//     re-announces and takes over the heartbeat even though the counter
//     never reached zero (a late background child holds it up);
//   - a non-outer `agent_end` that drops the counter to zero is the LAST
//     run finishing: stop the spinner and fire idle, but emit no stop
//     toast — the outer run already reported.
// ---------------------------------------------------------------------------

export default function registerWarpNotify(pi: ExtensionAPI): void {
	if (!isWarpTerminal() || !supportsStructured()) return

	pi.on("session_start", async (event, ctx) => {
		// Startup only, and only when no run is live — subagent sessions also
		// fire session_start when their extensions bind (mid our run).
		if (event.reason !== "startup" || activeRuns > 0) return
		emit("session_start", ctx)
	})

	pi.on("before_agent_start", async (event) => {
		// Only capture the query of a run that will own the announcements: depth
		// zero, or a new outer taking over after the previous one settled. A
		// subagent's prompt must not overwrite the heartbeat's query.
		if (activeRuns === 0 || outerSettled) pendingQuery = event.prompt ?? ""
	})

	pi.on("agent_start", async (_event, ctx) => {
		activeRuns++
		if (activeRuns === 1 || outerSettled) {
			// New outer run (fresh or takeover): announce and own the heartbeat.
			outerSettled = false
			runCtx = ctx
			emit("session_start", ctx) // defensive re-announce
			emit("prompt_submit", ctx, { query: pendingQuery })
			cancelIdleTimer() // a previous turn's pending idle_prompt is obsolete
			startHeartbeat()
		}
		// Idempotent: nested runs leave the already-spinning ticker alone.
		startSpinner(ctx)
	})

	pi.on("agent_end", async (_event, ctx) => {
		if (activeRuns > 0) activeRuns--
		const isOuter = ctx.sessionManager.getSessionId() === runCtx?.sessionManager.getSessionId()
		// Nested run ended while the outer is still live (the original upstream
		// bug): decrement only — no spinner stop, no toast.
		if (!isOuter && activeRuns > 0) return

		// Settle point: the outer run ended, or the LAST run in flight ended.
		// ESC during a blocking tool never fires tool_execution_end — drain the
		// badge (and the park counter) before announcing the stop.
		for (const call of pendingBlocking.values()) {
			emit("tool_complete", ctx, { tool_name: call.toolName })
		}
		pendingBlocking.clear()
		blockedCalls = 0
		if (isOuter) {
			emit("stop", ctx, {
				query: lastMessageText(ctx.sessionManager.getBranch(), "user"),
				response: lastMessageText(ctx.sessionManager.getBranch(), "assistant"),
			})
			outerSettled = true
		} // else: the outer run already reported; this is just the last child finishing.
		stopHeartbeat()
		cancelIdleTimer()
		if (activeRuns === 0) {
			stopSpinner()
			// runCtx stays live for the idle timer below; the next outer start
			// or a shutdown replaces/clears it.
			idleTimer = setTimeout(() => {
				idleTimer = undefined
				if (runCtx)
					emit("idle_prompt", runCtx, {
						summary: lastMessageText(runCtx.sessionManager.getBranch(), "assistant"),
					})
			}, IDLE_DELAY_MS)
			idleTimer.unref?.()
		}
		// else: background children still running — spinner keeps spinning, idle
		// fires when the last of them ends (branch above).
	})

	pi.on("tool_call", async (event, ctx) => {
		if (!BLOCKING_TOOLS.has(event.toolName)) return
		pendingBlocking.set(event.toolCallId, {
			toolName: event.toolName,
			input:
				typeof event.input === "object" && event.input !== null
					? (event.input as Record<string, unknown>)
					: undefined,
		})
		blockedCalls++
		if (blockedCalls > 1) return // another question already parked the run
		emit("question_asked", ctx)
		syncSpinner() // park: stop animating while blocked
		stopHeartbeat()
	})

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!BLOCKING_TOOLS.has(event.toolName)) return
		pendingBlocking.delete(event.toolCallId)
		if (blockedCalls > 0) blockedCalls--
		if (blockedCalls > 0) return // more questions still outstanding
		emit("tool_complete", ctx, { tool_name: event.toolName })
		if (activeRuns > 0 && !outerSettled) startHeartbeat() // aborted runs settle in agent_end
		syncSpinner()
	})

	pi.on("session_shutdown", async () => {
		cleanupAll()
	})
}
