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
 * - Coding plan quota windows (⏳5h 42% █████████░░░░░░░░ ↻2h15m  ⏳7d 92% ███████████████████░ ↻3d): 20-cell bars (5% per cell), polled every 5 minutes from the provider's quota
 *   API with the stored credential (resolved via
 *   modelRegistry.getApiKeyForProvider — no direct auth.json reads). Two sources:
 *   GLM coding plan (`zai-coding-cn`, bigmodel.cn quota API — unit 3 = 5h
 *   rolling throttle, unit 6 = 7-day weekly hard ceiling) and OpenCode Go
 *   (`opencode-go`, /zen/go/v1/usage — rolling 5h, weekly, monthly ⏳30d).
 *   Every gauge gets its own healthy baseline so they read as separate
 *   instruments (GLM: 5h mdLink blue, 7d thinkingHigh purple; OpenCode Go: 5h
 *   accent teal, 7d mdLink blue, 30d thinkingHigh purple — a different color
 *   than GLM at each shared label); warning ≥70%, error ≥90% — alarm colors win
 *   over distinctiveness when a window runs low. Shown only while a source
 *   provider is active; other providers see nothing. Data older than 10 minutes
 *   renders dim.
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
// Coding plan quota windows (per provider)
// ============================================================================

/** Healthy-state label + baseline color of one quota gauge. */
interface QuotaSpec {
	/** Gauge label, e.g. "⏳5h". */
	label: string
	/** Baseline color while healthy; warning ≥70% / error ≥90% win over it. */
	baseline: ThemeColor
}

/** One gauge reading: spec + used percent + window reset instant. */
interface QuotaGauge extends QuotaSpec {
	/** Used percent 0–100. */
	usedPercent: number
	/** Window reset instant (epoch ms). */
	resetAt?: number
}

/** One quota snapshot: the reading's provider + when it was fetched. */
interface QuotaSnapshot {
	/** pi provider id this reading belongs to (stale cross-provider guard). */
	provider: string
	/** Gauges in render order; the last is dropped first on narrow terminals. */
	gauges: QuotaGauge[]
	/** When this snapshot was fetched (Date.now()). */
	capturedAt: number
}

/** Quota endpoint + response parser for one coding-plan provider. */
interface QuotaSource {
	/** Quota endpoint — same credential as chat. */
	url: string
	/** Response → gauges, or undefined when nothing parses. */
	parse: (json: unknown) => QuotaGauge[] | undefined
}

/**
 * Gauge layout per provider, in render order. Every gauge gets its own healthy
 * baseline so the windows read as separate instruments, and at each shared
 * label the two providers differ (GLM 5h blue vs OpenCode Go 5h teal, GLM 7d
 * purple vs Go 7d blue) so switching plans looks like a different instrument
 * set. Alarm colors (warning ≥70%, error ≥90%) always win over distinctiveness.
 */
const GLM_GAUGES: readonly QuotaSpec[] = [
	{ label: "⏳5h", baseline: "mdLink" },
	{ label: "⏳7d", baseline: "thinkingHigh" },
]

/** OpenCode Go windows: rolling 5h, weekly, monthly (billing anniversary). */
const GO_GAUGES: readonly QuotaSpec[] = [
	{ label: "⏳5h", baseline: "accent" },
	{ label: "⏳7d", baseline: "mdLink" },
	{ label: "⏳30d", baseline: "thinkingHigh" },
]

/** GLM quota endpoint — same credential as chat, different host than the gateway. */
const GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"

/** OpenCode Go usage endpoint — Bearer-authenticated with the key's own API key. */
const GO_QUOTA_URL = "https://opencode.ai/zen/go/v1/usage"

/** Poll cadence; also the snapshot age that triggers a lazy re-poll. */
const QUOTA_POLL_MS = 5 * 60_000

/** Snapshots older than this render dim (possibly inaccurate, e.g. offline). */
const QUOTA_DIM_MS = 10 * 60_000

/** Quota fetch timeout. */
const QUOTA_TIMEOUT_MS = 10_000

/** Extract one GLM window (by unit) from the quota limits array. */
function toGlmWindow(
	limits: Array<Record<string, unknown>>,
	unit: number,
): { usedPercent: number; resetAt?: number } | undefined {
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
 * GLM quota response → gauges (unit 3 = 5h window, unit 6 = weekly). Verified
 * live 2026-08-28 — entries look like
 * `{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 17, nextResetTime: 1788012323908 }`
 * (`type` is "CREDIT_LIMIT", not "TOKENS_LIMIT" as some older parsers assumed).
 */
export function parseGlmQuotas(json: unknown): QuotaGauge[] | undefined {
	const limits = (json as { data?: { limits?: Array<Record<string, unknown>> } } | null)?.data
		?.limits
	if (!Array.isArray(limits)) return undefined
	const units = [3, 6]
	const gauges: QuotaGauge[] = []
	for (let i = 0; i < GLM_GAUGES.length; i++) {
		const window = toGlmWindow(limits, units[i])
		if (window) gauges.push({ ...GLM_GAUGES[i], ...window })
	}
	return gauges.length ? gauges : undefined
}

/**
 * OpenCode Go usage response → gauges (rolling 5h / weekly / monthly).
 * Verified live 2026-09-23 —
 * `{ usage: { rolling: { status: "ok", percent: 4, resetsAt: "…Z" }, weekly: …, monthly: … } }`.
 * Each window is parsed defensively (the endpoint reshaped its response within
 * an hour of launch, cc-switch#6433): windows without `status: "ok"` or a
 * numeric `percent` are skipped. At 0% the upstream `resetsAt` is a
 * now-plus-window placeholder rather than a real reset, so the countdown is
 * dropped in that case (same finding, verified against a live key).
 */
export function parseGoQuotas(json: unknown): QuotaGauge[] | undefined {
	const usage = (json as { usage?: Record<string, unknown> } | null)?.usage
	if (!usage || typeof usage !== "object") return undefined
	const windows = ["rolling", "weekly", "monthly"]
	const gauges: QuotaGauge[] = []
	for (let i = 0; i < GO_GAUGES.length; i++) {
		const w = usage[windows[i]]
		if (!w || typeof w !== "object") continue
		const { status, percent, resetsAt } = w as {
			status?: unknown
			percent?: unknown
			resetsAt?: unknown
		}
		if (status !== "ok" || typeof percent !== "number") continue
		let resetAt: number | undefined
		if (percent > 0 && typeof resetsAt === "string") {
			const ms = Date.parse(resetsAt)
			if (Number.isFinite(ms)) resetAt = ms
		}
		gauges.push({ ...GO_GAUGES[i], usedPercent: percent, resetAt })
	}
	return gauges.length ? gauges : undefined
}

/** Registered coding-plan quota sources, by pi provider id. */
const QUOTA_SOURCES: Record<string, QuotaSource> = {
	"zai-coding-cn": { url: GLM_QUOTA_URL, parse: parseGlmQuotas },
	"opencode-go": { url: GO_QUOTA_URL, parse: parseGoQuotas },
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

/** One full-width quota gauge: label + used percent + 20-cell bar + reset countdown. */
function quotaBar(g: QuotaGauge, stale: boolean, now: number, theme: Theme): string {
	const pct = Math.max(0, Math.min(100, Math.round(g.usedPercent)))
	// 20 cells (5% each), ceil: any nonzero usage must light ≥1 cell (a few
	// percent would round to zero and look untouched; for a quota bar
	// over-reporting is the safe direction — it warns slightly early).
	const filled = Math.ceil((pct / 100) * 20)
	const bar = "█".repeat(filled) + "░".repeat(20 - filled)
	const countdown = g.resetAt !== undefined ? ` ↻${formatCountdown(g.resetAt, now)}` : ""
	if (stale) return theme.fg("dim", `${g.label} ${pct}% ${bar}${countdown}`)
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : g.baseline
	return (
		theme.fg(color, `${g.label} ${pct}% ${bar}`) + (countdown ? theme.fg("dim", countdown) : "")
	)
}

/**
 * All gauges of one snapshot as strings, in render order. A shared snapshot
 * means all turn dim together when stale; each reset countdown is dim.
 */
function quotaBars(snapshot: QuotaSnapshot, now: number, theme: Theme): string[] {
	const stale = now - snapshot.capturedAt > QUOTA_DIM_MS
	return snapshot.gauges.map((g) => quotaBar(g, stale, now, theme))
}

export default function (pi: ExtensionAPI) {
	const enabled = true
	// Latest render-request callback for the active footer (if any).
	// pi.on subscriptions cannot be removed, so the handler stays for the
	// extension lifetime and only forwards to the current footer.
	let requestFooterRender: (() => void) | null = null

	// Coding-plan quota state: latest snapshot, per-provider resolved
	// credentials, single in-flight guard, and the 5-minute refresh timer
	// (session-scoped).
	let quota: QuotaSnapshot | undefined
	const quotaKeys: Record<string, string | undefined> = {}
	let quotaInFlight = false
	let quotaTimer: ReturnType<typeof setInterval> | undefined

	// Poll the active provider's quota endpoint. Best-effort: failures keep the
	// last snapshot (which then renders dim). Keys resolve through pi's auth
	// system (getProviderAuth) and are retried while absent, so /login
	// mid-session is picked up without a restart.
	const pollQuota = async (ctx: ExtensionContext): Promise<void> => {
		const provider = ctx.model?.provider ?? ""
		const source = QUOTA_SOURCES[provider]
		if (!source || quotaInFlight) return
		quotaInFlight = true
		try {
			quotaKeys[provider] ||= (await ctx.modelRegistry.getApiKeyForProvider(provider)) || undefined
			const key = quotaKeys[provider]
			if (!key) return
			const res = await fetch(source.url, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
			})
			if (!res.ok) return
			const gauges = source.parse(await res.json())
			if (gauges) {
				quota = { provider, gauges, capturedAt: Date.now() }
				requestFooterRender?.()
			}
		} catch {
			// Network/parse errors: keep rendering the previous snapshot.
		} finally {
			quotaInFlight = false
		}
	}

	/** Lazy refresh hook, cheap enough for every render frame. */
	const maybePollQuota = (ctx: ExtensionContext): void => {
		const provider = ctx.model?.provider ?? ""
		if (!QUOTA_SOURCES[provider]) return
		if (quota?.provider === provider && Date.now() - quota.capturedAt < QUOTA_POLL_MS) return
		void pollQuota(ctx)
	}

	const stopQuotaTimer = (): void => {
		if (quotaTimer) {
			clearInterval(quotaTimer)
			quotaTimer = undefined
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
					maybePollQuota(ctx)
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
					// Quota segment only while a source provider is active; a
					// snapshot fetched under another provider never renders.
					const snapshot = quota?.provider === ctx.model?.provider ? quota : undefined
					const bars = snapshot ? quotaBars(snapshot, Date.now(), theme) : []
					// Narrow terminals drop gauges from the last (slowest) window
					// first, then the whole quota segment, before the model id.
					const build = (barCount: number): string => {
						const right = [
							bars.slice(0, barCount).join(" "),
							model + thinking,
							branch ? theme.fg("dim", ` (${branch})`) : "",
						]
							.filter(Boolean)
							.join(" ")
						const pad = " ".repeat(
							Math.max(1, width - visibleWidth(left) - visibleWidth(context) - visibleWidth(right)),
						)
						return left + context + pad + right
					}
					for (let n = bars.length; n >= 0; n--) {
						const line = build(n)
						if (visibleWidth(line) <= width) return [line]
					}
					// Even without the quota segment the line overflows: truncate.
					return [truncateToWidth(build(0), width)]
				},
			}
		})
	}

	// Re-render the footer when the thinking level changes (Tab, /thinking, model switch).
	pi.on("thinking_level_select", async () => {
		requestFooterRender?.()
	})

	// Re-render on model switch and prime the quota segment when switching to
	// a source provider (it reads ctx.model at render time).
	pi.on("model_select", async (_event, ctx) => {
		requestFooterRender?.()
		maybePollQuota(ctx)
	})

	// Re-apply on startup and after session switches/reloads with a fresh ctx.
	// Quota state resets with the session; the timer runs while a UI is
	// attached (the segment is footer-only) and ticks pollQuota, which no-ops
	// while a non-source provider is active.
	pi.on("session_start", async (_event, ctx) => {
		quota = undefined
		for (const k of Object.keys(quotaKeys)) delete quotaKeys[k]
		stopQuotaTimer()
		if (enabled && ctx.hasUI) {
			apply(ctx)
			quotaTimer = setInterval(() => void pollQuota(ctx), QUOTA_POLL_MS)
		}
	})

	pi.on("session_shutdown", async () => {
		stopQuotaTimer()
	})
}
