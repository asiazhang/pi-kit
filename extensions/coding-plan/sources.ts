/**
 * Quota endpoints + response parsers per coding-plan provider (see the
 * Coding plan entry in CONTEXT.md). The parsers are defensive: both
 * endpoints have reshaped their responses under tools that assumed a stable
 * payload, so every window is read independently, unusable windows are
 * skipped, and a payload with no usable window yields undefined (the poll
 * then keeps the previous snapshot instead of publishing garbage).
 */
import type { QuotaGauge, QuotaSpec } from "./state"

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
export const QUOTA_POLL_MS = 5 * 60_000

/** Quota fetch timeout. */
export const QUOTA_TIMEOUT_MS = 10_000

/** Quota endpoint + response parser for one coding-plan provider. */
export interface QuotaSource {
	/** Quota endpoint — same credential as chat. */
	url: string
	/** Response → gauges, or undefined when nothing parses. */
	parse: (json: unknown) => QuotaGauge[] | undefined
}

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
export const QUOTA_SOURCES: Record<string, QuotaSource> = {
	"zai-coding-cn": { url: GLM_QUOTA_URL, parse: parseGlmQuotas },
	"opencode-go": { url: GO_QUOTA_URL, parse: parseGoQuotas },
}
