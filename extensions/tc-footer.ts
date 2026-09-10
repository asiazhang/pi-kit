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
 *   ~/proj  42% ████████░░░░░░░░░░░░░░  ⏳5h 12% █████████░░░░░░░░ ↻2h15m  ⏳7d 92% ███████████████████░ ↻3d  model-id ⚡high (git-branch)
 *   └─ cwd ─┘  └──── context bar ────┘  └────── plan windows (5h + 7d) ──────┘  └─ right-aligned ─┘
 *
 * - Model-id brand colors by provider: tencent-copilot (CodeBuddy gateway)
 *   renders accent teal; the GLM coding plan (`zai-coding-cn`) renders
 *   thinkingXhigh purple (zhipu brand family, one step deeper than the 7-day
 *   gauge's thinkingHigh so they don't collide). Other providers keep the
 *   default text color.
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
 * - Coding plan windows (⏳5h 42% █████████░░░░░░░░ ↻2h15m  ⏳7d 92% ███████████████████░ ↻3d): GLM
 *   coding plan (provider `zai-coding-cn`) quota windows as 20-cell bars (5% per cell),
 *   polled every 5 minutes from the bigmodel.cn quota API with the stored credential
 *   (resolved via modelRegistry.getApiKeyForProvider — no direct auth.json
 *   reads). Two independent gauges: the 5-hour window (unit 3, rolling throttle) and the
 *   7-day window (unit 6, weekly hard ceiling). Healthy-state baseline colors differ
 *   (5h = mdLink blue, 7d = thinkingHigh purple) so they read as separate gauges; warning
 *   ≥70%, error ≥90% — alarm colors win over distinctiveness when a window runs low.
 *   Shown only while that provider is active; other providers see nothing. Data older
 *   than 10 minutes renders dim. pi-web has no footer (`setFooter` is a no-op over
 *   RPC), so the same segment is mirrored into its extension-status shelf through
 *   `ctx.ui.setStatus`; the RPC extension theme is a no-op stub there (fg() returns
 *   the text unchanged), so that copy carries ANSI SGR colors instead of theme colors.
 * - Git branch re-renders reactively via footerData.onBranchChange().
 * - Thinking level (⚡high) shown when the model supports reasoning;
 *   re-renders reactively via the thinking_level_select event. The plan
 *   segment re-renders via model_select.
 * - Re-applied on session_start so the footer closure always captures a
 *   live ctx (session replacement invalidates the old one).
 */

import { isAbsolute, relative, resolve, sep } from "node:path"
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent"
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

/** 20-cell bar (5% per cell), color by context pressure against the given thresholds. */
function contextBar(pct: number, th: { red: number; yellow: number }, theme: Theme): string {
	const filled = Math.round((Math.min(100, pct) / 100) * 20)
	const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
	return theme.fg(color, "█".repeat(filled) + "░".repeat(20 - filled))
}

// ============================================================================
// Model-id brand colors (by provider)
// ============================================================================

/**
 * Model-id brand colors by provider. tencent-copilot (CodeBuddy gateway)
 * reads as accent teal; the GLM coding plan (`zai-coding-cn`) as thinkingXhigh
 * purple — same family as the 7-day quota gauge's thinkingHigh, one step
 * deeper so the two read as separate things. Providers not listed keep the
 * default text color.
 */
const MODEL_COLORS: Partial<Record<string, ThemeColor>> = {
	"tencent-copilot": "accent",
	"zai-coding-cn": "thinkingXhigh",
}

// ============================================================================
// Coding plan window (GLM coding plan, provider `zai-coding-cn`)
// ============================================================================

/** pi provider id of the GLM coding plan. */
const PLAN_PROVIDER = "zai-coding-cn"

/** Status key of the plan segment in UIs without a footer (pi-web status shelf). */
const PLAN_STATUS_KEY = "coding-plan"

/** Quota endpoint — same credential as chat, different host than the gateway. */
const PLAN_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"

/** Poll cadence; also the snapshot age that triggers a lazy re-poll. */
const PLAN_POLL_MS = 5 * 60_000

/** Snapshots older than this render dim (possibly inaccurate, e.g. offline). */
const PLAN_DIM_MS = 10 * 60_000

/** Quota fetch timeout. */
const PLAN_TIMEOUT_MS = 10_000

/** One quota-window reading: used percent + reset instant. */
interface PlanWindow {
	/** Used percent 0–100 (response `percentage`). */
	usedPercent: number
	/** Window reset instant (epoch ms, response `nextResetTime`). */
	resetAt?: number
}

/** Combined quota snapshot: the rolling 5h window and the weekly 7-day window. */
interface PlanWindows {
	/** 5h window (unit 3) — rolling throttle. */
	fiveHour?: PlanWindow
	/** 7-day window (unit 6) — weekly hard ceiling. */
	weekly?: PlanWindow
	/** When this snapshot was fetched (Date.now()). */
	capturedAt: number
}

/** Extract one window (by unit) from the quota limits array. */
function toPlanWindow(
	limits: Array<Record<string, unknown>>,
	unit: number,
): PlanWindow | undefined {
	for (const limit of limits) {
		if (!limit || typeof limit !== "object") continue
		const pct = limit.percentage
		if (limit.unit !== unit || typeof pct !== "number") continue
		const reset = limit.nextResetTime
		return {
			usedPercent: pct,
			resetAt: typeof reset === "number" && reset > 0 ? reset : undefined,
		}
	}
	return undefined
}

/**
 * Extract both windows from the quota response. Verified live 2026-08-28 —
 * entries look like
 * `{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 17, nextResetTime: 1788012323908 }`
 * (`unit: 3` is the 5h window, `unit: 6` the weekly; `type` is "CREDIT_LIMIT", not
 * "TOKENS_LIMIT" as some older parsers assumed).
 */
function parsePlanWindows(json: unknown): PlanWindows | undefined {
	const limits = (json as { data?: { limits?: Array<Record<string, unknown>> } } | null)?.data
		?.limits
	if (!Array.isArray(limits)) return undefined
	const fiveHour = toPlanWindow(limits, 3)
	const weekly = toPlanWindow(limits, 6)
	if (!fiveHour && !weekly) return undefined
	return { fiveHour, weekly, capturedAt: Date.now() }
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
 * Colors one span of the plan segment. The TUI footer passes the live theme;
 * the status path (pi-web) passes ANSI SGR, because the RPC extension theme is
 * a no-op stub whose `fg()` returns the text unchanged.
 */
type PlanColor = "mdLink" | "thinkingHigh" | "warning" | "error" | "dim"
type PlanPainter = (color: PlanColor, text: string) => string

/**
 * ANSI 256-color SGR per plan color: the dark theme's gauge baselines
 * (mdLink blue, thinkingHigh purple) and pi's warning/error hues, at mid-tone
 * values that stay legible on the web UI's dark and light themes.
 */
const PLAN_ANSI: Record<PlanColor, string> = {
	mdLink: "\x1b[38;5;110m",
	thinkingHigh: "\x1b[38;5;139m",
	warning: "\x1b[38;5;214m",
	error: "\x1b[38;5;203m",
	dim: "\x1b[38;5;245m",
}

/** Painter for the pi-web status line (ANSI SGR, reset after each span). */
const planAnsi: PlanPainter = (color, text) => `${PLAN_ANSI[color]}${text}\x1b[0m`

/** One full-width quota bar: prefix label + 20-cell bar (5% per cell) + reset countdown. */
function quotaBar(
	label: string,
	w: PlanWindow | undefined,
	baseline: PlanColor,
	stale: boolean,
	now: number,
	paint: PlanPainter,
): string {
	if (!w) return ""
	const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
	// 20 cells (5% each), ceil: any nonzero usage must light ≥1 cell (a few
	// percent would round to zero and look untouched; for a quota bar
	// over-reporting is the safe direction — it warns slightly early).
	const filled = Math.ceil((pct / 100) * 20)
	const bar = "█".repeat(filled) + "░".repeat(20 - filled)
	const countdown = w.resetAt !== undefined ? ` ↻${formatCountdown(w.resetAt, now)}` : ""
	if (stale) return paint("dim", `${label} ${pct}% ${bar}${countdown}`)
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : baseline
	return paint(color, `${label} ${pct}% ${bar}`) + (countdown ? paint("dim", countdown) : "")
}

/**
 * "⏳5h 42% █████████░░░░░░░░ ↻2h15m  ⏳7d 92% ███████████████████░ ↻3d": two independent
 * 20-cell bars (5% per cell). Healthy-state baselines differ (5h = mdLink blue,
 * 7d = thinkingHigh purple) so they read as separate gauges; warning ≥70%, error
 * ≥90% — alarm colors win over distinctiveness when a window runs low. A shared
 * snapshot means both turn dim together when stale; each reset countdown is dim.
 */
function planSegment(ws: PlanWindows, now: number, paint: PlanPainter): string {
	const stale = now - ws.capturedAt > PLAN_DIM_MS
	const parts = [
		quotaBar("⏳5h", ws.fiveHour, "mdLink", stale, now, paint),
		quotaBar("⏳7d", ws.weekly, "thinkingHigh", stale, now, paint),
	].filter(Boolean)
	return parts.join(" ")
}

export default function (pi: ExtensionAPI) {
	const enabled = true
	// Latest render-request callback for the active footer (if any).
	// pi.on subscriptions cannot be removed, so the handler stays for the
	// extension lifetime and only forwards to the current footer.
	let requestFooterRender: (() => void) | null = null

	// GLM coding plan state: latest window snapshot (5h + weekly), resolved
	// credential, single in-flight guard, and the 5-minute refresh timer
	// (session-scoped).
	let planWindow: PlanWindows | undefined
	let planKey: string | undefined
	let planInFlight = false
	let planTimer: ReturnType<typeof setInterval> | undefined
	// Last text published to the pi-web status shelf, so an unchanged segment is
	// not re-emitted (each setStatus pushes an update to the browser).
	let planStatus: string | undefined

	const planActive = (ctx: ExtensionContext): boolean => ctx.model?.provider === PLAN_PROVIDER

	/**
	 * Mirror the plan segment into UIs that have no footer (pi-web over RPC,
	 * where `setFooter` is a no-op): its extension-status shelf renders
	 * `setStatus` text, ANSI included. TUI keeps footer-only rendering, and a
	 * non-plan provider clears the shelf.
	 */
	const syncPlanStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode === "tui" || !ctx.hasUI) return
		const next =
			planActive(ctx) && planWindow ? planSegment(planWindow, Date.now(), planAnsi) : undefined
		if (next === planStatus) return
		planStatus = next
		ctx.ui.setStatus(PLAN_STATUS_KEY, next)
	}

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
			const next = parsePlanWindows(await res.json())
			if (next) {
				planWindow = next
				requestFooterRender?.()
				syncPlanStatus(ctx)
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
			const paint: PlanPainter = (color, text) => theme.fg(color, text)
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
					const provider = ctx.model?.provider ?? ""
					const modelId = ctx.model?.id ?? "no-model"
					const modelColor = MODEL_COLORS[provider]
					const model = modelColor ? theme.fg(modelColor, modelId) : modelId
					// Plan segment only while the plan provider is active.
					const plan =
						ctx.model?.provider === PLAN_PROVIDER && planWindow
							? planSegment(planWindow, Date.now(), paint)
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
		syncPlanStatus(ctx)
		maybePollPlan(ctx)
	})

	// Re-apply on startup and after session switches/reloads with a fresh ctx.
	// Plan state resets with the session; the timer runs while a UI is
	// attached (footer plus pi-web status shelf) and ticks pollPlan, which
	// no-ops while another provider is active.
	pi.on("session_start", async (_event, ctx) => {
		planWindow = undefined
		planKey = undefined
		stopPlanTimer()
		if (enabled && ctx.hasUI) {
			apply(ctx)
			planTimer = setInterval(() => void pollPlan(ctx), PLAN_POLL_MS)
			// pi-web never renders the footer, so its status shelf is the only
			// plan surface: sync it and fetch the first snapshot up front.
			syncPlanStatus(ctx)
			maybePollPlan(ctx)
		}
	})

	pi.on("session_shutdown", async () => {
		stopPlanTimer()
	})
}
