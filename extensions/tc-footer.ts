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
 *   long before large windows fill, so a 1M-token model is treated as 650k
 *   (evidence: docs/research/effective-context-window.md).
 *   Capped windows label the bar with a dim ` Smart Zone` (the layout example
 *   shows one): percent and bar describe the Smart Zone — the quality-holding
 *   effective window — not the spec-sheet window; uncapped windows skip the
 *   label, their denominator is the nominal window anyway. See the Smart Zone
 *   entry in CONTEXT.md.
 *   Color thresholds track pi's auto-compaction trigger
 *   (tokens > window - RESERVE_TOKENS): red at the trigger point of the
 *   effective window, yellow halfway below it. Windows capped by the
 *   650k ceiling relax red to 85% of the effective window: agent loops
 *   tolerate high fill (Claude Code compacts a 1M session at 96.7%, pi at
 *   98.4%), so the red line is a late warning, not a quality cliff.
 * - Coding plan quota windows (⏳5h 42% █████████░░░░░░░░ ↻2h15m  ⏳7d 92% ███████████████████░ ↻3d): *   20-cell bars (5% per cell), polled every 5 minutes from the provider's quota
 *   API with the stored credential (resolved via
 *   modelRegistry.getApiKeyForProvider — no direct auth.json reads). Two
 *   sources: GLM coding plan (`zai-coding-cn`, bigmodel.cn quota API — unit 3
 *   = 5h rolling throttle, unit 6 = 7-day weekly hard ceiling) and OpenCode Go
 *   (`opencode-go`, /zen/go/v1/usage — rolling 5h, weekly, monthly ⏳30d).
 *   Every gauge gets its own healthy baseline so they read as separate
 *   instruments (GLM: 5h mdLink blue, 7d thinkingHigh purple; OpenCode Go: 5h
 *   accent teal, 7d mdLink blue, 30d thinkingHigh purple — a different color
 *   than GLM at each shared label, so the two plans are tellable apart);
 *   warning ≥70%, error ≥90% — alarm colors win over distinctiveness when a
 *   window runs low. Shown only while a source provider is active; other
 *   providers see nothing. Data older than 10 minutes renders dim. pi-web has
 *   no footer (`setFooter` is a no-op over RPC), so the same segment is
 *   mirrored into its extension-status shelf through `ctx.ui.setStatus`; the
 *   RPC extension theme is a no-op stub there (fg() returns the text
 *   unchanged), so that copy carries ANSI SGR colors instead of theme colors.
 * - Git branch re-renders reactively via footerData.onBranchChange().
 * - Token speed (⚡42.3 tok/s): live tok/s while an agent runs — one run =
 *   agent_start → agent_end; tool execution pauses the clock, text and
 *   thinking deltas are counted with a word-boundary estimate, and each
 *   message_end swaps the estimate for provider usage so the whole-run
 *   average frozen after agent_end is exact. Colored by the 速度等级 tiers
 *   (<50 error, 50–100 warning, 100–200 success, ≥200 accent; the anchor is
 *   a 300 tok/s ceiling). Hidden until the first run; refreshes at most
 *   every second while streaming (trailing flush).
 * - Thinking level (✦high) shown when the model supports reasoning;
 *   re-renders reactively via the thinking_level_select event. The plan
 *   segment re-renders via model_select. ⚡ belongs to the token-speed
 *   segment — the two icons never swap.
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
 * Effective-context ceiling (tokens). Context-rot research (Chroma, 18
 * frontier models) shows quality degrades long before large windows fill,
 * while compaction studies land the sweet spot well under 1M: LangWatch's
 * real-trace cost model optimizes around 220k–450k and calls >600k an
 * "unjustified premium". 650k caps the bar at roughly that boundary —
 * usable context, not the marketing number. Full evidence and the red-line
 * reasoning: docs/research/effective-context-window.md.
 */
const EFFECTIVE_CONTEXT_TOKENS = 650_000

/** pi's default compaction reserve (settings.json: compaction.reserveTokens). */
const RESERVE_TOKENS = 16_384

/**
 * Color thresholds relative to the effective window. Small windows track
 * pi's auto-compaction trigger (tokens > window - RESERVE_TOKENS): red
 * right at it, yellow halfway below. When the window is capped by
 * EFFECTIVE_CONTEXT_TOKENS (e.g. a 1M model treated as 650k), there is no
 * quality cliff at the cap — agent loops tolerate high fill (Claude Code
 * compacts a 1M session at 96.7%, pi at 98.4%) — so red is a late warning
 * at 85% of the effective window, yellow at half that.
 */
function thresholds(effectiveWindow: number): { red: number; yellow: number } {
	const capped = effectiveWindow >= EFFECTIVE_CONTEXT_TOKENS
	const red = capped ? 85 : ((effectiveWindow - RESERVE_TOKENS) / effectiveWindow) * 100
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
// Token speed (live tok/s during an agent run)
// ============================================================================

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
const SPEED_THROTTLE_MS = 1_000

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
interface SpeedState {
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

const freshSpeed = (): SpeedState => ({
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

// ============================================================================
// Coding plan quota windows (per provider)
// ============================================================================

/** Status key of the quota segment in UIs without a footer (pi-web status shelf). */
const PLAN_STATUS_KEY = "coding-plan"

/** Healthy-state label + baseline color of one quota gauge. */
interface QuotaSpec {
	/** Gauge label, e.g. "⏳5h". */
	label: string
	/** Baseline color while healthy; warning ≥70% / error ≥90% win over it. */
	baseline: PlanColor
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

/**
 * Colors one span of the quota segment. The TUI footer passes the live theme;
 * the status path (pi-web) passes ANSI SGR, because the RPC extension theme is
 * a no-op stub whose `fg()` returns the text unchanged.
 */
type PlanColor = "accent" | "mdLink" | "thinkingHigh" | "warning" | "error" | "dim"
type PlanPainter = (color: PlanColor, text: string) => string

/**
 * ANSI 256-color SGR per quota color: the dark theme's gauge baselines
 * (accent teal, mdLink blue, thinkingHigh purple) and pi's warning/error
 * hues, at mid-tone values that stay legible on the web UI's dark and light
 * themes.
 */
const PLAN_ANSI: Record<PlanColor, string> = {
	accent: "\x1b[38;5;109m",
	mdLink: "\x1b[38;5;110m",
	thinkingHigh: "\x1b[38;5;139m",
	warning: "\x1b[38;5;214m",
	error: "\x1b[38;5;203m",
	dim: "\x1b[38;5;245m",
}

/** Painter for the pi-web status line (ANSI SGR, reset after each span). */
const planAnsi: PlanPainter = (color, text) => `${PLAN_ANSI[color]}${text}\x1b[0m`

/** One full-width quota gauge: label + used percent + 20-cell bar + reset countdown. */
function quotaBar(g: QuotaGauge, stale: boolean, now: number, paint: PlanPainter): string {
	const pct = Math.max(0, Math.min(100, Math.round(g.usedPercent)))
	// 20 cells (5% each), ceil: any nonzero usage must light ≥1 cell (a few
	// percent would round to zero and look untouched; for a quota bar
	// over-reporting is the safe direction — it warns slightly early).
	const filled = Math.ceil((pct / 100) * 20)
	const bar = "█".repeat(filled) + "░".repeat(20 - filled)
	const countdown = g.resetAt !== undefined ? ` ↻${formatCountdown(g.resetAt, now)}` : ""
	if (stale) return paint("dim", `${g.label} ${pct}% ${bar}${countdown}`)
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : g.baseline
	return paint(color, `${g.label} ${pct}% ${bar}`) + (countdown ? paint("dim", countdown) : "")
}

/**
 * All gauges of one snapshot as strings, in render order. A shared snapshot
 * means all turn dim together when stale; each reset countdown is dim.
 */
function quotaBars(snapshot: QuotaSnapshot, now: number, paint: PlanPainter): string[] {
	const stale = now - snapshot.capturedAt > QUOTA_DIM_MS
	return snapshot.gauges.map((g) => quotaBar(g, stale, now, paint))
}

export default function (pi: ExtensionAPI) {
	const enabled = true
	// Latest render-request callback for the active footer (if any).
	// pi.on subscriptions cannot be removed, so the handler stays for the
	// extension lifetime and only forwards to the current footer.
	let requestFooterRender: (() => void) | null = null

	// Coding-plan quota state: latest snapshot (per source provider), resolved
	// credentials, single in-flight guard, and the 5-minute refresh timer
	// (session-scoped).
	let quota: QuotaSnapshot | undefined
	let quotaKeys: Record<string, string | undefined> = {}
	let quotaInFlight = false
	let quotaTimer: ReturnType<typeof setInterval> | undefined
	// Last text published to the pi-web status shelf, so an unchanged segment is
	// not re-emitted (each setStatus pushes an update to the browser).
	let planStatus: string | undefined

	// Token-speed state for the current/last agent run, plus the streaming
	// refresh throttle (session-scoped, like the plan state above).
	let speed: SpeedState = freshSpeed()
	let speedTimer: ReturnType<typeof setTimeout> | undefined
	let speedLastRender = 0

	/**
	 * Latest snapshot of the provider in front, if any: a snapshot fetched
	 * under another provider never renders or publishes.
	 */
	const activeSnapshot = (ctx: ExtensionContext): QuotaSnapshot | undefined => {
		const provider = ctx.model?.provider ?? ""
		return quota?.provider === provider ? quota : undefined
	}

	/**
	 * Mirror the quota segment into UIs that have no footer (pi-web over RPC,
	 * where `setFooter` is a no-op): its extension-status shelf renders
	 * `setStatus` text, ANSI included. TUI keeps footer-only rendering, and a
	 * non-source provider clears the shelf.
	 */
	const syncPlanStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode === "tui" || !ctx.hasUI) return
		const snapshot = activeSnapshot(ctx)
		const next = snapshot ? quotaBars(snapshot, Date.now(), planAnsi).join(" ") : undefined
		if (next === planStatus) return
		planStatus = next
		ctx.ui.setStatus(PLAN_STATUS_KEY, next)
	}

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
				syncPlanStatus(ctx)
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

	/**
	 * One streaming delta (text or thinking): count estimated tokens, refresh
	 * the sliding-window reading, schedule a throttled redraw. A delta means
	 * generation is live, so it also closes any open tool pause.
	 */
	const recordSpeedDelta = (delta: string): void => {
		if (!speed.running) return
		if (speed.pausedAt !== undefined) {
			speed.pausedMs += Date.now() - speed.pausedAt
			speed.pausedAt = undefined
		}
		const matches = delta.match(TOKEN_REGEX)
		if (!matches) return
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
		scheduleSpeedRender()
	}

	/**
	 * message_end: swap this message's estimate for the provider's cumulative
	 * output count (usage arrives only with the completed message), so the
	 * frozen run average is exact rather than estimated.
	 */
	const reconcileSpeed = (message: { role?: unknown; usage?: { output?: unknown } }): void => {
		if (message.role !== "assistant" || !speed.running) return
		const actual = message.usage?.output
		if (typeof actual === "number" && actual > 0) speed.tokens += actual - speed.msgTokens
		speed.msgTokens = 0
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
			const paint: PlanPainter = (color, text) => theme.fg(color, text)
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

					// Live tok/s while a run streams; the frozen whole-run average
					// after agent_end; nothing before the first run.
					const tps = speed.running ? speed.live : speed.final
					const speedSeg =
						tps !== null ? ` ${theme.fg(speedColor(tps), `⚡${tps.toFixed(1)} tok/s`)}` : ""

					const branch = footerData.getGitBranch()
					const provider = ctx.model?.provider ?? ""
					const modelId = ctx.model?.id ?? "no-model"
					const modelColor = MODEL_COLORS[provider]
					const model = modelColor ? theme.fg(modelColor, modelId) : modelId
					// Quota segment only while a source provider is active; a
					// snapshot fetched under another provider never renders.
					const snapshot = activeSnapshot(ctx)
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
	// generation. Deltas drive the live reading, message_end reconciles the
	// total with provider usage, agent_end freezes the whole-run average and
	// flushes a final render.
	pi.on("agent_start", async () => {
		speed = freshSpeed()
		speed.running = true
		speed.startAt = Date.now()
	})

	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent
		if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
			recordSpeedDelta(streamEvent.delta)
		}
	})

	pi.on("message_end", async (event) => {
		reconcileSpeed(event.message)
	})

	pi.on("tool_execution_start", async () => {
		if (speed.running && speed.pausedAt === undefined) speed.pausedAt = Date.now()
	})

	pi.on("tool_execution_end", async () => {
		if (speed.pausedAt !== undefined) {
			speed.pausedMs += Date.now() - speed.pausedAt
			speed.pausedAt = undefined
		}
	})

	pi.on("agent_end", async () => {
		if (!speed.running) return
		if (speed.pausedAt !== undefined) {
			speed.pausedMs += Date.now() - speed.pausedAt
			speed.pausedAt = undefined
		}
		speed.running = false
		const elapsedMs = Date.now() - speed.startAt - speed.pausedMs
		// No tokens or no elapsed time — no segment (rather than a misleading 0).
		speed.final = speed.tokens > 0 && elapsedMs > 0 ? speed.tokens / (elapsedMs / 1000) : null
		flushSpeedRender()
	})

	// Re-render on model switch and prime the quota segment when switching to
	// a source provider (it reads ctx.model at render time).
	pi.on("model_select", async (_event, ctx) => {
		requestFooterRender?.()
		syncPlanStatus(ctx)
		maybePollQuota(ctx)
	})

	// Re-apply on startup and after session switches/reloads with a fresh ctx.
	// Quota state resets with the session; the timer runs while a UI is
	// attached (footer plus pi-web status shelf) and ticks pollQuota, which
	// no-ops while a non-source provider is active.
	pi.on("session_start", async (_event, ctx) => {
		quota = undefined
		quotaKeys = {}
		stopQuotaTimer()
		// Token speed does not survive session switches/resumes: the segment
		// hides until the first agent run of the new session.
		speed = freshSpeed()
		stopSpeedTimer()
		speedLastRender = 0
		if (enabled && ctx.hasUI) {
			apply(ctx)
			quotaTimer = setInterval(() => void pollQuota(ctx), QUOTA_POLL_MS)
			// pi-web never renders the footer, so its status shelf is the only
			// quota surface: sync it and fetch the first snapshot up front.
			syncPlanStatus(ctx)
			maybePollQuota(ctx)
		}
	})

	pi.on("session_shutdown", async () => {
		stopQuotaTimer()
		stopSpeedTimer()
	})
}
