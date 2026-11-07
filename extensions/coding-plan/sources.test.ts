/**
 * Parser tests for the per-provider quota sources (bun test) — GLM's
 * unit-based limits, OpenCode Go's defensive window parsing, and Command
 * Code's credit-ratio windows — see docs/adr/0003-opencode-go-quota-windows.md
 * and docs/adr/0005-commandcode-quota-windows.md. Every parser faces
 * third-party responses that changed underneath other tools before (the
 * OpenCode Go endpoint reshaped its payload within an hour of launch —
 * cc-switch#6433, and Command Code's surface sits under an `/alpha` prefix),
 * so every window is read independently, unusable windows are skipped, and a
 * payload with no usable window yields undefined (the poll then keeps the
 * previous snapshot instead of publishing garbage).
 */
import { expect, test } from "bun:test"
import { parseCommandCodeQuotas, parseGlmQuotas, parseGoQuotas } from "./sources"

const GO_RESET = {
	rolling: "2026-09-23T06:53:53.904Z",
	weekly: "2026-09-28T00:00:00.000Z",
	monthly: "2026-10-23T01:45:27.000Z",
}

const GO_OK = {
	usage: {
		rolling: { status: "ok", percent: 4, resetsAt: GO_RESET.rolling },
		weekly: { status: "ok", percent: 3, resetsAt: GO_RESET.weekly },
		monthly: { status: "ok", percent: 1, resetsAt: GO_RESET.monthly },
	},
}

test("OpenCode Go: two gauges in order with their own baseline colors (monthly payload ignored)", () => {
	const gauges = parseGoQuotas(GO_OK)
	expect(gauges).toBeDefined()
	expect(gauges?.map((g) => g.label)).toEqual(["⏳5h", "⏳7d"])
	expect(gauges?.map((g) => g.baseline)).toEqual(["accent", "mdLink"])
	expect(gauges?.map((g) => g.usedPercent)).toEqual([4, 3])
	expect(gauges?.[0].resetAt).toBe(Date.parse(GO_RESET.rolling))
})

test("OpenCode Go: 0% drops the now-plus-window placeholder countdown", () => {
	const gauges = parseGoQuotas({
		usage: {
			rolling: { status: "ok", percent: 0, resetsAt: GO_RESET.rolling },
			weekly: { status: "ok", percent: 12, resetsAt: GO_RESET.weekly },
			monthly: { status: "ok", percent: 34, resetsAt: GO_RESET.monthly },
		},
	})
	expect(gauges?.[0].resetAt).toBeUndefined()
	expect(gauges?.[1].resetAt).toBe(Date.parse(GO_RESET.weekly))
})

test("OpenCode Go: skips unusable windows and never surfaces the monthly one", () => {
	const gauges = parseGoQuotas({
		usage: {
			rolling: { status: "exceeded", percent: 4, resetsAt: GO_RESET.rolling },
			weekly: { status: "ok", percent: 12, resetsAt: "not-a-date" },
			monthly: { status: "ok", percent: 34, resetsAt: GO_RESET.monthly },
		},
	})
	expect(gauges?.map((g) => g.label)).toEqual(["⏳7d"])
	expect(gauges?.[0].resetAt).toBeUndefined()
})

test("OpenCode Go: unusable payloads parse to undefined", () => {
	expect(parseGoQuotas(null)).toBeUndefined()
	expect(parseGoQuotas({})).toBeUndefined()
	expect(parseGoQuotas({ usage: { rolling: { status: "ok", percent: "4" } } })).toBeUndefined()
	// The monthly window alone is not enough: it is deliberately not tracked.
	expect(parseGoQuotas({ usage: { monthly: { status: "ok", percent: 50 } } })).toBeUndefined()
})

test("GLM: unit 3 → ⏳5h mdLink, unit 6 → ⏳7d thinkingHigh", () => {
	const reset5h = 1788012323908
	const resetWeekly = 1788912323908
	const gauges = parseGlmQuotas({
		data: {
			limits: [
				{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 17, nextResetTime: reset5h },
				{ type: "CREDIT_LIMIT", unit: 6, number: 7, percentage: 42, nextResetTime: resetWeekly },
			],
		},
	})
	expect(gauges).toEqual([
		{ label: "⏳5h", baseline: "mdLink", usedPercent: 17, resetAt: reset5h },
		{ label: "⏳7d", baseline: "thinkingHigh", usedPercent: 42, resetAt: resetWeekly },
	])
})

test("GLM: payload without any matching unit parses to undefined", () => {
	expect(parseGlmQuotas(null)).toBeUndefined()
	expect(parseGlmQuotas({ data: { limits: [{ unit: 9, percentage: 10 }] } })).toBeUndefined()
})

// Live shape, 2026-11-07: credits rather than a percent, resetAt in epoch ms.
const CC_RESET = { fiveHour: 1794069978117, weekly: 1794656778117 }

const CC_OK = {
	credits: { monthlyCredits: 69.7688869185, purchasedCredits: 0, freeCredits: 0 },
	windowLimits: {
		limited: true,
		exceeded: null,
		fiveHour: { used: 2.1, cap: 14, exceeded: false, resetAt: CC_RESET.fiveHour },
		weekly: { used: 7, cap: 35, exceeded: false, resetAt: CC_RESET.weekly },
	},
}

test("Command Code: credits scale to percent, same labels/baselines as OpenCode Go", () => {
	const gauges = parseCommandCodeQuotas(CC_OK)
	expect(gauges?.map((g) => g.label)).toEqual(["⏳5h", "⏳7d"])
	expect(gauges?.map((g) => g.baseline)).toEqual(["accent", "mdLink"])
	expect(gauges?.[0].usedPercent).toBeCloseTo(15, 10) // 2.1 / 14
	expect(gauges?.[1].usedPercent).toBeCloseTo(20, 10) // 7 / 35
	// Epoch MILLISECONDS go through untouched (the 429 body's reset is seconds).
	expect(gauges?.[0].resetAt).toBe(CC_RESET.fiveHour)
	expect(gauges?.[1].resetAt).toBe(CC_RESET.weekly)
})

test("Command Code: 0% drops the countdown, the other window keeps its own", () => {
	const gauges = parseCommandCodeQuotas({
		windowLimits: {
			fiveHour: { used: 0, cap: 14, resetAt: CC_RESET.fiveHour },
			weekly: { used: 3.5, cap: 35, resetAt: CC_RESET.weekly },
		},
	})
	expect(gauges?.[0].usedPercent).toBe(0)
	expect(gauges?.[0].resetAt).toBeUndefined()
	expect(gauges?.[1].resetAt).toBe(CC_RESET.weekly)
})

test("Command Code: skips unusable windows, undefined when nothing parses", () => {
	// A zero/absent cap would divide by zero; non-numeric `used` is not a reading.
	expect(
		parseCommandCodeQuotas({
			windowLimits: {
				fiveHour: { used: 2, cap: 0, resetAt: CC_RESET.fiveHour },
				weekly: { used: "3", cap: 35, resetAt: CC_RESET.weekly },
			},
		}),
	).toBeUndefined()
	expect(
		parseCommandCodeQuotas({
			windowLimits: {
				fiveHour: null,
				weekly: { used: 7, cap: 35, resetAt: null },
			},
		})?.map((g) => g.label),
	).toEqual(["⏳7d"])
	// A missing `resetAt` is not an error: the reading survives without a countdown.
	expect(
		parseCommandCodeQuotas({ windowLimits: { fiveHour: { used: 1, cap: 14 } } })?.[0].resetAt,
	).toBeUndefined()
	expect(parseCommandCodeQuotas(null)).toBeUndefined()
	expect(parseCommandCodeQuotas({})).toBeUndefined()
	expect(parseCommandCodeQuotas({ windowLimits: [] })).toBeUndefined()
})
