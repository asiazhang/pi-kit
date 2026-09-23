/**
 * Custom status footer for pi (developed alongside the tencent-copilot
 * provider, but provider-agnostic — works with any model).
 *
 * Enabled by default; applied on session_start (startup, new, resume,
 * fork, reload) so the footer closure always captures a live ctx
 * (session replacement invalidates the old one). The built-in footer
 * is replaced for the whole session.
 *
 * Layout (single line, ANSI-safe truncation on narrow terminals):
 *
 *   ~/proj  67% █████████████░░░░░░░░ Smart Zone  ⏳5h 12% █████████░░░░░░░░ ↻2h15m  ⏳7d 92% ███████████████████░ ↻3d  ⚡42.3 tok/s model-id ✦high (git-branch)
 *   └─ cwd ─┘  └────────── context bar ──────────┘  └────── plan windows (5h + 7d) ──────┘  └────── right-aligned ──────┘
 *
 * This file owns composition and wiring only; the segments live in their own
 * modules: context.ts (cwd + 上下文用量, see CONTEXT.md), speed.ts (token
 * 速度), and the coding-plan quota segment renders from the snapshot
 * published by ../coding-plan (see docs/adr/0004-coding-plan-independent-extension.md).
 *
 * - Model-id brand colors by provider: tencent-copilot (CodeBuddy gateway)
 *   renders accent teal; the GLM coding plan (`zai-coding-cn`) renders
 *   thinkingXhigh purple (zhipu brand family, one step deeper than the 7-day
 *   gauge's thinkingHigh so they don't collide). Other providers keep the
 *   default text color.
 * - Thinking level (✦high) shown when the model supports reasoning;
 *   re-renders reactively via the thinking_level_select event. ⚡ belongs to
 *   the token-speed segment — the two icons never swap.
 * - Tool execution pauses the speed clock and dims the segment with a ⏸ marker:
 *   the live reading is frozen while a tool runs (subagent streams are
 *   invisible to the parent session), so the tier color must not imply motion.
 * - The OpenCode Go plan's model id (`opencode-go`) renders syntaxVariable
 *   blue — one step deeper than its 7d gauge's mdLink baseline, mirroring the
 *   GLM purple pattern, so plan-backed providers never read as plain text.
 * - Narrow terminals drop segments in order: quota gauges (the last,
 *   slowest window first) → the whole quota segment → token speed → branch;
 *   the model id and context bar always survive, and the whole line
 *   truncates only as a last resort.
 * - The quota segment re-renders via onQuotaChange when a fresh snapshot
 *   arrives (the coding-plan extension polls; this render path never
 *   triggers fetching).
 * - Re-applied on session_start so the footer closure always captures a
 *   live ctx (session replacement invalidates the old one).
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { type PlanPainter, quotaBars } from "../coding-plan/render"
import { activeSnapshot, onQuotaChange } from "../coding-plan/state"
import {
	contextBar,
	EFFECTIVE_CONTEXT_TOKENS,
	effectivePercent,
	formatCwd,
	thresholds,
} from "./context"
import {
	closePause,
	finalizeRun,
	freshSpeed,
	reconcileSpeed,
	recordSpeedDelta,
	recordSpeedEnd,
	SPEED_THROTTLE_MS,
	type SpeedState,
	speedColor,
} from "./speed"

// ============================================================================
// Model-id brand colors (by provider)
// ============================================================================

/**
/**
 * Model-id brand colors by provider. tencent-copilot (CodeBuddy gateway)
 * reads as accent teal; the GLM coding plan (`zai-coding-cn`) as thinkingXhigh
 * purple — same family as the 7-day quota gauge's thinkingHigh, one step
 * deeper so the two read as separate things. The OpenCode Go plan
 * (`opencode-go`) as syntaxVariable blue — same pattern: its 7-day gauge
 * baseline is mdLink, so the model id sits one step deeper in the same blue
 * family (clear of the accent teal its 5h gauge shares with tencent-copilot).
 * Providers not listed keep the default text color.
 */
const MODEL_COLORS: Partial<Record<string, ThemeColor>> = {
	"tencent-copilot": "accent",
	"zai-coding-cn": "thinkingXhigh",
	"opencode-go": "syntaxVariable",
}

export default function (pi: ExtensionAPI) {
	const enabled = true
	// Latest render-request callback for the active footer (if any).
	// pi.on subscriptions cannot be removed, so the handler stays for the
	// extension lifetime and only forwards to the current footer.
	let requestFooterRender: (() => void) | null = null

	// Token-speed state for the current/last agent run, plus the streaming
	// refresh throttle (session-scoped).
	let speed: SpeedState = freshSpeed()
	let speedTimer: ReturnType<typeof setTimeout> | undefined
	let speedLastRender = 0

	// Footer refresh while streaming: at most one render per SPEED_THROTTLE_MS
	// plus a trailing flush, so the line doesn't redraw on every delta.
	const flushSpeedRender = (): void => {
		if (speedTimer !== undefined) {
			clearTimeout(speedTimer)
			speedTimer = undefined
		}
		speedLastRender = Date.now()
		requestFooterRender?.()
	}

	const scheduleSpeedRender = (): void => {
		const wait = SPEED_THROTTLE_MS - (Date.now() - speedLastRender)
		if (wait <= 0) flushSpeedRender()
		else if (speedTimer === undefined) speedTimer = setTimeout(flushSpeedRender, wait)
	}

	const stopSpeedTimer = (): void => {
		if (speedTimer !== undefined) {
			clearTimeout(speedTimer)
			speedTimer = undefined
		}
	}

	const apply = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const disposeBranch = footerData.onBranchChange(() => tui.requestRender())
			// Fresh quota snapshots arrive from the coding-plan extension's poll;
			// redraw so they show up mid-idle (same shape as onBranchChange).
			const disposeQuota = onQuotaChange(() => tui.requestRender())
			const paint: PlanPainter = (color, text) => theme.fg(color, text)
			requestFooterRender = () => tui.requestRender()
			return {
				dispose() {
					disposeBranch()
					disposeQuota()
					requestFooterRender = null
				},
				invalidate() {},
				render(width: number): string[] {
					const cwd = formatCwd(ctx.sessionManager.getCwd())
					const left = theme.fg("dim", cwd)

					let context = ""
					const usage = ctx.getContextUsage()
					if (usage && usage.tokens !== null && usage.contextWindow > 0) {
						const effWindow = Math.min(usage.contextWindow, EFFECTIVE_CONTEXT_TOKENS)
						const th = thresholds(effWindow)
						const pct = effectivePercent(usage.tokens, usage.contextWindow)
						if (pct !== null) {
							const shown = Math.min(100, Math.round(pct))
							const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
							// When the nominal window is capped, percent and bar describe the
							// effective window, not the spec-sheet one — label the Smart Zone,
							// or "67%" on a 1M model reads as a miscalculation. Uncapped
							// windows are self-explanatory and stay clean.
							const capNote =
								usage.contextWindow > EFFECTIVE_CONTEXT_TOKENS ? theme.fg("dim", " Smart Zone") : ""
							context = ` ${theme.fg(color, `${shown}%`)} ${contextBar(pct, th, theme)}${capNote}`
						}
					}

					const thinking =
						ctx.thinkingLevel && ctx.model?.reasoning
							? ` ${theme.fg("accent", `✦${ctx.thinkingLevel}`)}`
							: ""

					// Live tok/s while a run streams; dimmed with a ⏸ marker while a tool
					// executes (the reading is frozen and stale, so the tier color must
					// not pretend it's still moving); the frozen whole-run average after
					// agent_end; nothing before the first run.
					const paused = speed.running && speed.pausedAt !== undefined
					const tps = speed.running ? speed.live : speed.final
					const speedSeg =
						tps !== null
							? paused
								? ` ${theme.fg("dim", `⚡⏸${tps.toFixed(1)} tok/s`)}`
								: ` ${theme.fg(speedColor(tps), `⚡${tps.toFixed(1)} tok/s`)}`
							: ""
					const branch = footerData.getGitBranch()
					const provider = ctx.model?.provider ?? ""
					const modelId = ctx.model?.id ?? "no-model"
					const modelColor = MODEL_COLORS[provider]
					const model = modelColor ? theme.fg(modelColor, modelId) : modelId
					// Quota segment only while a source provider is active; a
					// snapshot fetched under another provider never renders.
					const snapshot = activeSnapshot(provider)
					const bars = snapshot ? quotaBars(snapshot, Date.now(), paint) : []
					// Narrow terminals drop segments in order: quota gauges (the last,
					// slowest window first) → the whole quota segment → token speed →
					// branch; the model id and context bar always survive, and the
					// whole line truncates only as a last resort. (Comparing the
					// UNTRUNCATED candidate widths is what makes dropping possible —
					// a pre-truncated string never exceeds the width.)
					const build = (gaugeCount: number, keepSpeed: boolean, keepBranch: boolean): string => {
						const right = [
							bars.slice(0, gaugeCount).join(" "),
							keepSpeed ? speedSeg : "",
							model + thinking,
							keepBranch && branch ? theme.fg("dim", ` (${branch})`) : "",
						]
							.filter(Boolean)
							.join(" ")
						const pad = " ".repeat(
							Math.max(1, width - visibleWidth(left) - visibleWidth(context) - visibleWidth(right)),
						)
						return left + context + pad + right
					}
					const candidates: Array<[number, boolean, boolean]> = []
					for (let n = bars.length; n >= 0; n--) candidates.push([n, true, true])
					candidates.push([0, false, true], [0, false, false])
					let chosen = ""
					for (const [n, keepSpeed, keepBranch] of candidates) {
						const candidate = build(n, keepSpeed, keepBranch)
						if (visibleWidth(candidate) <= width) {
							chosen = candidate
							break
						}
					}
					return [truncateToWidth(chosen || build(bars.length, true, true), width)]
				},
			}
		})
	}

	// Re-render the footer when the thinking level changes (Tab, /thinking, model switch).
	pi.on("thinking_level_select", async () => {
		requestFooterRender?.()
	})

	// Streaming lifecycle: one run spans agent_start → agent_end (across tool
	// calls); tool execution pauses the clock so wait time never reads as slow
	// generation — while paused the segment dims with a ⏸ marker, since the
	// live reading is frozen. Deltas drive the live reading; text_end /
	// thinking_end reconcile each block against its authoritative full text
	// (the Responses-protocol catch-up for dropped deltas — see speed.ts);
	// message_end reconciles the total with provider usage, agent_end freezes the
	// whole-run average and flushes a final render.
	pi.on("agent_start", async () => {
		speed = freshSpeed()
		speed.running = true
		speed.startAt = Date.now()
	})

	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent
		if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
			if (recordSpeedDelta(speed, streamEvent.delta, streamEvent.contentIndex))
				scheduleSpeedRender()
		} else if (streamEvent.type === "text_end" || streamEvent.type === "thinking_end") {
			// Responses-protocol catch-up (see speed.ts): end events carry the
			// authoritative block text even when its deltas were dropped upstream.
			if (recordSpeedEnd(speed, streamEvent.contentIndex, streamEvent.content))
				scheduleSpeedRender()
		}
	})

	pi.on("message_end", async (event) => {
		reconcileSpeed(speed, event.message)
	})

	pi.on("tool_execution_start", async () => {
		if (speed.running && speed.pausedAt === undefined) {
			speed.pausedAt = Date.now()
			// Swap to the dimmed ⏸ marker right away — there are no deltas while
			// a tool runs, so the next render would otherwise never come.
			flushSpeedRender()
		}
	})

	pi.on("tool_execution_end", async () => {
		closePause(speed)
		// Restore the tier-colored reading immediately, not at the next delta.
		flushSpeedRender()
	})

	pi.on("agent_end", async () => {
		if (!speed.running) return
		speed.final = finalizeRun(speed, Date.now())
		flushSpeedRender()
	})

	// Re-render on model switch (the quota segment's provider guard reads
	// ctx.model at render time; the coding-plan extension primes its own data).
	pi.on("model_select", async () => {
		requestFooterRender?.()
	})

	// Re-apply on startup and after session switches/reloads with a fresh ctx.
	// Token speed does not survive session switches/resumes: the segment
	// hides until the first agent run of the new session.
	pi.on("session_start", async (_event, ctx) => {
		speed = freshSpeed()
		stopSpeedTimer()
		speedLastRender = 0
		if (enabled && ctx.hasUI) apply(ctx)
	})

	pi.on("session_shutdown", async () => {
		stopSpeedTimer()
	})
}
