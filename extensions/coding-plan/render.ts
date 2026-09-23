/**
 * Quota gauge rendering: snapshot → the shared strings used by both display
 * surfaces. The TUI footer passes its live theme as the painter; pi-web's
 * status shelf passes ANSI SGR (see planAnsi). Color rules: warning ≥70%,
 * error ≥90%, alarm colors win over each gauge's healthy baseline, and
 * snapshots older than QUOTA_DIM_MS render dim as a whole.
 */
import type { PlanColor, QuotaGauge, QuotaSnapshot } from "./state"

/**
 * Colors one span of the quota segment. The TUI footer passes the live theme
 * (theme.fg); the status path (pi-web) passes ANSI SGR, because the RPC
 * extension theme is a no-op stub whose `fg()` returns the text unchanged.
 */
export type PlanPainter = (color: PlanColor, text: string) => string

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
export const planAnsi: PlanPainter = (color, text) => `${PLAN_ANSI[color]}${text}\x1b[0m`

/** Snapshots older than this render dim (possibly inaccurate, e.g. offline). */
export const QUOTA_DIM_MS = 10 * 60_000

/** Countdown to a reset instant: "2h15m", "3d4h", "now". */
export function formatCountdown(resetAt: number, now: number): string {
	const ms = resetAt - now
	if (ms <= 0) return "now"
	const days = Math.floor(ms / 86_400_000)
	if (days >= 1) return `${days}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`
	const hours = Math.floor(ms / 3_600_000)
	const minutes = Math.floor((ms % 3_600_000) / 60_000)
	return hours >= 1 ? `${hours}h${minutes}m` : `${minutes}m`
}

/** One full-width quota gauge: label + used percent + 20-cell bar + reset countdown. */
export function quotaBar(g: QuotaGauge, stale: boolean, now: number, paint: PlanPainter): string {
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
export function quotaBars(snapshot: QuotaSnapshot, now: number, paint: PlanPainter): string[] {
	const stale = now - snapshot.capturedAt > QUOTA_DIM_MS
	return snapshot.gauges.map((g) => quotaBar(g, stale, now, paint))
}
