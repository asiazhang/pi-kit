/**
 * Direct tests for the quota gauge renderer (bun test): alarm colors win over
 * each gauge's healthy baseline (warning ≥70%, error ≥90%), stale snapshots
 * go dim as a whole, reset countdowns are always dim, and any nonzero usage
 * lights at least one cell. Regression guard for the color rules the pi-web
 * status shelf relies on (docs/adr/0002-pi-web-plan-status.md).
 */
import { expect, test } from "bun:test"
import { formatCountdown, type PlanPainter, QUOTA_DIM_MS, quotaBar, quotaBars } from "./render"
import type { QuotaGauge, QuotaSnapshot } from "./state"

const paint: PlanPainter = (color, text) => `[${color}]${text}`

const gauge = (usedPercent: number, resetAt?: number): QuotaGauge => ({
	label: "⏳5h",
	baseline: "mdLink",
	usedPercent,
	resetAt,
})

const NOW = 1_000_000_000_000

/** 20-cell bar, filled = ceil(pct/5). */
const bar = (filled: number): string => "█".repeat(filled) + "░".repeat(20 - filled)

test("alarm colors win over the healthy baseline (warning ≥70%, error ≥90%)", () => {
	expect(quotaBar(gauge(69), false, NOW, paint)).toContain(`[mdLink]⏳5h 69% ${bar(14)}`)
	expect(quotaBar(gauge(70), false, NOW, paint)).toContain(`[warning]⏳5h 70% ${bar(14)}`)
	expect(quotaBar(gauge(89), false, NOW, paint)).toContain("[warning]")
	expect(quotaBar(gauge(90), false, NOW, paint)).toContain(`[error]⏳5h 90% ${bar(18)}`)
})

test("any nonzero usage lights ≥1 cell (ceil, never zero)", () => {
	expect(quotaBar(gauge(0), false, NOW, paint)).toContain(bar(0))
	expect(quotaBar(gauge(1), false, NOW, paint)).toContain("█░░░░░░░░░░░░░░░░░░░")
	expect(quotaBar(gauge(100), false, NOW, paint)).toContain(bar(20))
})

test("a healthy gauge renders its countdown dim, the rest in baseline", () => {
	const rendered = quotaBar(gauge(42, NOW + 135 * 60_000), false, NOW, paint)
	// 42% → ceil(8.4) = 9 filled cells; the countdown is a separate dim span.
	expect(rendered).toBe(`[mdLink]⏳5h 42% ${bar(9)}[dim] ↻2h15m`)
})

test("stale snapshots render dim as a whole, countdown inside the span", () => {
	const rendered = quotaBar(gauge(42, NOW + 135 * 60_000), true, NOW, paint)
	expect(rendered).toBe(`[dim]⏳5h 42% ${bar(9)} ↻2h15m`)
})

test("quotaBars dims every gauge of an old snapshot together", () => {
	const snapshot: QuotaSnapshot = {
		provider: "zai-coding-cn",
		gauges: [gauge(10), { label: "⏳7d", baseline: "thinkingHigh", usedPercent: 20 }],
		capturedAt: NOW - QUOTA_DIM_MS - 1,
	}
	expect(quotaBars(snapshot, NOW, paint)).toEqual([
		`[dim]⏳5h 10% ${bar(2)}`,
		`[dim]⏳7d 20% ${bar(4)}`,
	])
})

test("formatCountdown reads as a duration, 'now' once past the reset", () => {
	expect(formatCountdown(NOW + 135 * 60_000, NOW)).toBe("2h15m")
	expect(formatCountdown(NOW + 3 * 86_400_000 + 2 * 3_600_000, NOW)).toBe("3d2h")
	expect(formatCountdown(NOW + 45 * 60_000, NOW)).toBe("45m")
	expect(formatCountdown(NOW - 1, NOW)).toBe("now")
})
