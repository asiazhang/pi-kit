/**
 * Warp notifications — registration + run/block state machine.
 *
 * Warp renders what we write: the OSC 777 cli-agent sequence becomes a
 * system toast + tab badge; the per-tab braille spinner is driven by
 * title-spinner.ts through OSC 0 title churn. Outside Warp this registers
 * zero handlers and writes zero bytes — detection gates the whole feature
 * on env vars only Warp sets.
 *
 * State machine — the one deliberate divergence from upstream rpiv-warp:
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
 *   Runs are also attributed per session (`runsBySession`) so a child's
 *   `session_shutdown` releases only the child's own share. The child
 *   session is torn down right after its `agent_end` while the parent's
 *   run is still live — an unconditional cleanup there stopped the
 *   parent's spinner mid-run with nothing left to restart it (no
 *   `agent_start` fires until the parent's run ends).
 *
 * File layout mirrors upstream rpiv-warp (packages/rpiv-warp):
 * protocol.ts (detection/negotiation), payload.ts (builders), this file
 * (registration + state machine), plus the transport/spinner/config
 * modules.
 */

import { basename } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BLOCKING_TOOLS, DEFAULT_HEARTBEAT_MS } from "./config"
import {
	buildIdlePromptPayload,
	buildPromptSubmitPayload,
	buildQuestionAskedPayload,
	buildSessionStartPayload,
	buildStopPayload,
	buildToolCompletePayload,
	lastAssistantText,
	serializePayload,
	type WarpPayload,
} from "./payload"
import { isWarpTerminal, supportsStructured } from "./protocol"
import { startSpinner, stopSpinner } from "./title-spinner"
import { writeOSC777 } from "./warp-notify"

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * OSC 777 title field: this URI is what makes Warp route the body to its
 * cli-agent listener and parse it as a structured event. Any other value
 * falls back to a generic `<title>: <body>` toast with the raw JSON
 * showing (rpiv-warp index.ts).
 */
const TITLE = "warp://cli-agent"

function emit(payload: WarpPayload): void {
	writeOSC777(TITLE, serializePayload(payload))
}

/** Mirror Pi's startup tab title `<mascot> - <repo>`; push/pop restores it verbatim. */
function titleSuffix(ctx: ExtensionContext): string {
	return ` - ${basename(ctx.cwd)}`
}

// ---------------------------------------------------------------------------
// Run/block state — refcounted, shared across parent + subagent extension
// instances (one module, one process)
// ---------------------------------------------------------------------------

/** Delay before idle_prompt after the outermost run ends. */
const IDLE_DELAY_MS = 300

let activeRuns = 0
let blockedCalls = 0
let outerSettled = false
let pendingQuery = ""
let runCtx: ExtensionContext | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined

/** Live runs per session id — `session_shutdown` releases only the torn-down session's share. */
const runsBySession = new Map<string, number>()

interface PendingBlockingCall {
	readonly toolName: string
	readonly sessionId: string
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
		if (runCtx) emit(buildPromptSubmitPayload(runCtx, pendingQuery))
	}, DEFAULT_HEARTBEAT_MS)
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
		if (runCtx) startSpinner(titleSuffix(runCtx))
	} else {
		stopSpinner()
	}
}

/** Drop one live run for `ctx`'s session. No-op when `session_shutdown` already
 *  released it — the shared counter must never be undercut by a stale `agent_end`. */
function releaseRun(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId()
	const owned = runsBySession.get(sessionId) ?? 0
	if (owned <= 0) return
	if (owned === 1) runsBySession.delete(sessionId)
	else runsBySession.set(sessionId, owned - 1)
	if (activeRuns > 0) activeRuns--
}

/** A session went away (subagent teardown, session switch, exit). Release only
 *  what IT owned — never reset shared state while other runs are still live. */
function cleanupSession(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId()
	releaseRun(ctx)
	for (const [callId, call] of pendingBlocking) {
		if (call.sessionId !== sessionId) continue
		pendingBlocking.delete(callId)
		if (blockedCalls > 0) blockedCalls--
	}
	if (activeRuns > 0) {
		if (runCtx?.sessionManager.getSessionId() === sessionId) {
			// The torn-down session owned the announcements: hand back the outer
			// role (the next `agent_start` takes over) and keep children spinning.
			runCtx = undefined
			outerSettled = true
			stopHeartbeat()
			cancelIdleTimer()
		}
		return
	}
	cleanupAll()
}

function cleanupAll(): void {
	cancelIdleTimer()
	stopHeartbeat()
	stopSpinner()
	pendingQuery = ""
	runCtx = undefined
	activeRuns = 0
	blockedCalls = 0
	runsBySession.clear()
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
		emit(buildSessionStartPayload(ctx))
	})

	pi.on("before_agent_start", async (event) => {
		// Only capture the query of a run that will own the announcements: depth
		// zero, or a new outer taking over after the previous one settled. A
		// subagent's prompt must not overwrite the heartbeat's query.
		if (activeRuns === 0 || outerSettled) pendingQuery = event.prompt ?? ""
	})

	pi.on("agent_start", async (_event, ctx) => {
		activeRuns++
		const sessionId = ctx.sessionManager.getSessionId()
		runsBySession.set(sessionId, (runsBySession.get(sessionId) ?? 0) + 1)
		if (activeRuns === 1 || outerSettled) {
			// New outer run (fresh or takeover): announce and own the heartbeat.
			outerSettled = false
			runCtx = ctx
			emit(buildSessionStartPayload(ctx)) // defensive re-announce
			emit(buildPromptSubmitPayload(ctx, pendingQuery))
			cancelIdleTimer() // a previous turn's pending idle_prompt is obsolete
			startHeartbeat()
		}
		// Idempotent: nested runs leave the already-spinning ticker alone.
		startSpinner(titleSuffix(ctx))
	})

	pi.on("agent_end", async (_event, ctx) => {
		releaseRun(ctx)
		const isOuter = ctx.sessionManager.getSessionId() === runCtx?.sessionManager.getSessionId()
		// Nested run ended while the outer is still live (the original upstream
		// bug): decrement only — no spinner stop, no toast.
		if (!isOuter && activeRuns > 0) return

		// Settle point: the outer run ended, or the LAST run in flight ended.
		// ESC during a blocking tool never fires tool_execution_end — drain the
		// badge (and the park counter) before announcing the stop.
		for (const call of pendingBlocking.values()) {
			emit(buildToolCompletePayload(ctx, call.toolName, call.input))
		}
		pendingBlocking.clear()
		blockedCalls = 0
		if (isOuter) {
			const branch = ctx.sessionManager.getBranch()
			emit(buildStopPayload(ctx, branch))
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
				if (runCtx) {
					const summary = lastAssistantText(runCtx.sessionManager.getBranch())
					emit(buildIdlePromptPayload(runCtx, summary))
				}
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
			sessionId: ctx.sessionManager.getSessionId(),
			input:
				typeof event.input === "object" && event.input !== null
					? (event.input as Record<string, unknown>)
					: undefined,
		})
		blockedCalls++
		if (blockedCalls > 1) return // another question already parked the run
		emit(buildQuestionAskedPayload(ctx))
		syncSpinner() // park: stop animating while blocked
		stopHeartbeat()
	})

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!BLOCKING_TOOLS.has(event.toolName)) return
		const pending = pendingBlocking.get(event.toolCallId)
		pendingBlocking.delete(event.toolCallId)
		if (blockedCalls > 0) blockedCalls--
		if (blockedCalls > 0) return // more questions still outstanding
		emit(buildToolCompletePayload(ctx, event.toolName, pending?.input))
		if (activeRuns > 0 && !outerSettled) startHeartbeat() // aborted runs settle in agent_end
		syncSpinner()
	})

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanupSession(ctx)
	})
}
