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
 *   ~/proj  42% █████░░░░░  ⏳5h 42% ██░░░ ↻2h15m  model-id ⚡high (git-branch)
 *   └─ cwd ─┘  └ context bar ─┘  └─ plan window ─┘  └─── right-aligned ───┘
 *
 * - Working directory: ~-relative inside $HOME, otherwise the last two
 *   path segments; from ctx.sessionManager.getCwd().
 * - Context bar uses ctx.getContextUsage(). Percent is computed against the
 *   EFFECTIVE window min(contextWindow, EFFECTIVE_CONTEXT_TOKENS): research
 *   (Chroma "context rot", LangWatch compaction study) shows quality degrades
 *   long before large windows fill, so a 1M-token model is treated as 450k.
 *   Color thresholds track pi's auto-compaction trigger
 *   (tokens > window - RESERVE_TOKENS): red at the trigger point of the
 *   effective window, yellow halfway below it. Windows capped by the
 *   450k ceiling relax red to 65% of the effective window.
 * - Coding plan window (⏳5h 42% ██░░░ ↻2h15m): GLM coding plan (provider
 *   `zai-coding-cn`) 5-hour quota window as a 5-cell bar, polled every 5
 *   minutes from the bigmodel.cn quota API with the stored credential
 *   (resolved via modelRegistry.getApiKeyForProvider — no direct auth.json
 *   reads). The bar renders in the mdLink blue family to stand apart from
 *   the green context bar; warning ≥70%, error ≥90% — alarm colors win over
 *   distinctiveness when the window runs low. Shown only while that
 *   provider is active; other providers see nothing. Data older than 10
 *   minutes renders dim. Narrow terminals drop it before the model id.
 * - Git branch re-renders reactively via footerData.onBranchChange().
 * - Thinking level (⚡high) shown when the model supports reasoning;
 *   re-renders reactively via the thinking_level_select event. The plan
 *   segment re-renders via model_select.
 * - Re-applied on session_start so the footer closure always captures a
 *   live ctx (session replacement invalidates the old one).
 */

import { isAbsolute, relative, resolve, sep } from "node:path"
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

/** Shorten cwd for display: ~-relative inside $HOME, otherwise the last two path segments. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE
	if (home) {
		const rel = relative(resolve(home), resolve(cwd))
		const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
		if (inside) return rel === "" ? "~" : `~${sep}${rel}`
	}
	const segments = resolve(cwd).split(sep).filter(Boolean)
	return segments.slice(-2).join(sep) || sep
}

/**
 * Effective-context ceiling (tokens). Research on context rot (Chroma, 18
 * frontier models) and real-world Claude Code traces (LangWatch) shows model
 * quality degrades measurably long before large windows fill; recommended
 * compaction ranges land in 200k–450k. Windows larger than this are capped
 * so the bar reflects usable context, not the marketing number.
 */
const EFFECTIVE_CONTEXT_TOKENS = 450_000

/** pi's default compaction reserve (settings.json: compaction.reserveTokens). */
const RESERVE_TOKENS = 16_384

/**
 * Color thresholds relative to the effective window. Small windows track
 * pi's auto-compaction trigger (tokens > window - RESERVE_TOKENS): red
 * right at it, yellow halfway below. When the window is capped by
 * EFFECTIVE_CONTEXT_TOKENS (e.g. a 1M model treated as 450k), the cap is
 * already conservative, so red relaxes to 65% of the effective window.
 */
function thresholds(effectiveWindow: number): { red: number; yellow: number } {
	const capped = effectiveWindow >= EFFECTIVE_CONTEXT_TOKENS
	const red = capped ? 65 : ((effectiveWindow - RESERVE_TOKENS) / effectiveWindow) * 100
	return { red, yellow: red / 2 }
}

/** Percent of the effective window (0–100), or null when unknown. */
function effectivePercent(tokens: number, contextWindow: number): number | null {
	const eff = Math.min(contextWindow, EFFECTIVE_CONTEXT_TOKENS)
	if (eff <= 0) return null
	return (tokens / eff) * 100
}

/** 10-cell bar, color by context pressure against the given thresholds. */
function contextBar(pct: number, th: { red: number; yellow: number }, theme: Theme): string {
	const filled = Math.round((Math.min(100, pct) / 100) * 10)
	const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
	return theme.fg(color, "█".repeat(filled) + "░".repeat(10 - filled))
}

// ============================================================================
// Coding plan window (GLM coding plan, provider `zai-coding-cn`)
// ============================================================================

/** pi provider id of the GLM coding plan. */
const PLAN_PROVIDER = "zai-coding-cn"

/** Quota endpoint — same credential as chat, different host than the gateway. */
const PLAN_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"

/** Poll cadence; also the snapshot age that triggers a lazy re-poll. */
const PLAN_POLL_MS = 5 * 60_000

/** Snapshots older than this render dim (possibly inaccurate, e.g. offline). */
const PLAN_DIM_MS = 10 * 60_000

/** Quota fetch timeout. */
const PLAN_TIMEOUT_MS = 10_000

/** One quota-window snapshot. */
interface PlanWindow {
	/** Used percent 0–100 (response `percentage`). */
	usedPercent: number
	/** Window reset instant (epoch ms, response `nextResetTime`). */
	resetAt?: number
	/** When this snapshot was fetched (Date.now()). */
	capturedAt: number
}

/**
 * Extract the 5h window (unit 3) from the quota response. Verified live
 * 2026-08-28 — entries look like
 * `{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 17, nextResetTime: 1788012323908 }`
 * (`unit: 6` is the weekly window, not shown; `type` is "CREDIT_LIMIT", not
 * "TOKENS_LIMIT" as some older parsers assumed).
 */
function parsePlanWindow(json: unknown): PlanWindow | undefined {
	const limits = (json as { data?: { limits?: Array<Record<string, unknown>> } } | null)?.data
		?.limits
	if (!Array.isArray(limits)) return undefined
	for (const limit of limits) {
		if (!limit || typeof limit !== "object") continue
		const pct = limit.percentage
		if (limit.unit !== 3 || typeof pct !== "number") continue
		const reset = limit.nextResetTime
		return {
			usedPercent: pct,
			resetAt: typeof reset === "number" && reset > 0 ? reset : undefined,
			capturedAt: Date.now(),
		}
	}
	return undefined
}

/** Countdown to a reset instant: "2h15m", "3d4h", "now". */
function formatCountdown(resetAt: number, now: number): string {
	const ms = resetAt - now
	if (ms <= 0) return "now"
	const days = Math.floor(ms / 86_400_000)
	if (days >= 1) return `${days}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`
	const hours = Math.floor(ms / 3_600_000)
	const minutes = Math.floor((ms % 3_600_000) / 60_000)
	return hours >= 1 ? `${hours}h${minutes}m` : `${minutes}m`
}

/**
 * "⏳5h 42% ██░░░ ↻2h15m" segment: 5-cell bar in the mdLink blue family to
 * stand apart from the green context bar; warning ≥70%, error ≥90% (alarm colors
 * win over distinctiveness when the window runs low). Stale snapshots
 * render wholly dim; the countdown is always dim.
 */
function planSegment(w: PlanWindow, now: number, theme: Theme): string {
	const stale = now - w.capturedAt > PLAN_DIM_MS
	const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
	const filled = Math.round((pct / 100) * 5)
	const bar = "█".repeat(filled) + "░".repeat(5 - filled)
	const countdown = w.resetAt !== undefined ? ` ↻${formatCountdown(w.resetAt, now)}` : ""
	if (stale) return theme.fg("dim", `⏳5h ${pct}% ${bar}${countdown}`)
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "mdLink"
	return theme.fg(color, `⏳5h ${pct}% ${bar}`) + (countdown ? theme.fg("dim", countdown) : "")
}

export default function (pi: ExtensionAPI) {
	const enabled = true
	// Latest render-request callback for the active footer (if any).
	// pi.on subscriptions cannot be removed, so the handler stays for the
	// extension lifetime and only forwards to the current footer.
	let requestFooterRender: (() => void) | null = null

	// GLM coding plan 5h-window state: latest snapshot, resolved credential,
	// single in-flight guard, and the 5-minute refresh timer (session-scoped).
	let planWindow: PlanWindow | undefined
	let planKey: string | undefined
	let planInFlight = false
	let planTimer: ReturnType<typeof setInterval> | undefined

	const planActive = (ctx: ExtensionContext): boolean => ctx.model?.provider === PLAN_PROVIDER

	// Poll the bigmodel.cn quota endpoint. Best-effort: failures keep the last
	// snapshot (which then renders dim). The key resolves through pi's auth
	// system (getProviderAuth) and is retried while absent, so /login
	// mid-session is picked up without a restart.
	const pollPlan = async (ctx: ExtensionContext): Promise<void> => {
		if (planInFlight || !planActive(ctx)) return
		planInFlight = true
		try {
			planKey ||= (await ctx.modelRegistry.getApiKeyForProvider(PLAN_PROVIDER)) || undefined
			if (!planKey) return
			const res = await fetch(PLAN_QUOTA_URL, {
				headers: { Authorization: `Bearer ${planKey}` },
				signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
			})
			if (!res.ok) return
			const next = parsePlanWindow(await res.json())
			if (next) {
				planWindow = next
				requestFooterRender?.()
			}
		} catch {
			// Network/parse errors: keep rendering the previous snapshot.
		} finally {
			planInFlight = false
		}
	}

	/** Lazy refresh hook, cheap enough for every render frame. */
	const maybePollPlan = (ctx: ExtensionContext): void => {
		if (!planActive(ctx)) return
		if (planWindow && Date.now() - planWindow.capturedAt < PLAN_POLL_MS) return
		void pollPlan(ctx)
	}

	const stopPlanTimer = (): void => {
		if (planTimer) {
			clearInterval(planTimer)
			planTimer = undefined
		}
	}

	const apply = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender())
			requestFooterRender = () => tui.requestRender()
			return {
				dispose() {
					dispose()
					requestFooterRender = null
				},
				invalidate() {},
				render(width: number): string[] {
					maybePollPlan(ctx)
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
							context = ` ${theme.fg(color, `${shown}%`)} ${contextBar(pct, th, theme)}`
						}
					}

					const thinking =
						ctx.thinkingLevel && ctx.model?.reasoning
							? ` ${theme.fg("accent", `⚡${ctx.thinkingLevel}`)}`
							: ""

					const branch = footerData.getGitBranch()
					const model = ctx.model?.id ?? "no-model"
					// Plan segment only while the plan provider is active.
					const plan =
						ctx.model?.provider === PLAN_PROVIDER && planWindow
							? planSegment(planWindow, Date.now(), theme)
							: ""
					// Narrow terminals drop the plan segment before the model id.
					const build = (withPlan: boolean): string => {
						const right = [
							withPlan ? plan : "",
							model + thinking,
							branch ? theme.fg("dim", ` (${branch})`) : "",
						]
							.filter(Boolean)
							.join(" ")
						const pad = " ".repeat(
							Math.max(1, width - visibleWidth(left) - visibleWidth(context) - visibleWidth(right)),
						)
						return truncateToWidth(left + context + pad + right, width)
					}
					return [plan && visibleWidth(build(true)) > width ? build(false) : build(true)]
				},
			}
		})
	}

	// Re-render the footer when the thinking level changes (Tab, /thinking, model switch).
	pi.on("thinking_level_select", async () => {
		requestFooterRender?.()
	})

	// Re-render on model switch and prime the plan segment when switching to
	// the plan provider (it reads ctx.model at render time).
	pi.on("model_select", async (_event, ctx) => {
		requestFooterRender?.()
		maybePollPlan(ctx)
	})

	// Re-apply on startup and after session switches/reloads with a fresh ctx.
	// Plan state resets with the session; the timer runs while a UI is
	// attached (the segment is footer-only) and ticks pollPlan, which no-ops
	// while another provider is active.
	pi.on("session_start", async (_event, ctx) => {
		planWindow = undefined
		planKey = undefined
		stopPlanTimer()
		if (enabled && ctx.hasUI) {
			apply(ctx)
			planTimer = setInterval(() => void pollPlan(ctx), PLAN_POLL_MS)
		}
	})

	pi.on("session_shutdown", async () => {
		stopPlanTimer()
	})
}
