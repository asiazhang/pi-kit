/**
 * pi-web mirror tests for the tc-footer extension (bun test).
 *
 * pi-web has no footer (`setFooter` is a no-op over RPC), so the plan segment
 * has to reach its extension-status shelf through `setStatus`. These tests
 * drive the extension with a fake ctx and a stubbed quota endpoint:
 *
 *   - a successful poll publishes the segment as ANSI text (the RPC theme is a
 *     no-op stub, so pressure colors must come from the painter);
 *   - switching to a non-plan provider clears the shelf;
 *   - an unchanged segment is not re-published (each setStatus pushes a browser
 *     update, so polls must not spam identical text);
 *   - TUI mode publishes nothing — the footer owns the segment there.
 *
 * Regression guard for docs/adr/0002-pi-web-plan-status.md.
 */
import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import registerFooter, { parseGlmQuotas, parseGoQuotas, speedColor } from "./tc-footer"

/** Quota response shape verified live 2026-08-28 (unit 3 = 5h window, unit 6 = weekly). */
const quotaPayload = {
	data: {
		limits: [
			{
				type: "CREDIT_LIMIT",
				unit: 3,
				number: 5,
				percentage: 42,
				nextResetTime: Date.now() + 135 * 60_000,
			},
			{
				type: "CREDIT_LIMIT",
				unit: 6,
				number: 7,
				percentage: 92,
				nextResetTime: Date.now() + 3 * 86_400_000,
			},
		],
	},
}

globalThis.fetch = (async () => ({
	ok: true,
	json: async () => quotaPayload,
})) as unknown as typeof fetch

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>

interface StatusCall {
	key: string
	text: string | undefined
}

/** A captured footer factory, as handed to ctx.ui.setFooter(). */
type FooterFactory = (
	tui: unknown,
	theme: unknown,
	footerData: unknown,
) => { render: (width: number) => string[] }

function register(): Map<string, Handler> {
	const handlers = new Map<string, Handler>()
	registerFooter({
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler)
		},
	} as unknown as ExtensionAPI)
	return handlers
}

function fire(handlers: Map<string, Handler>, name: string, ctx: ExtensionContext): Promise<void> {
	const handler = handlers.get(name)
	if (handler === undefined) throw new Error(`no handler registered for ${name}`)
	return handler({}, ctx)
}

function makeCtx(
	provider: string,
	mode: "tui" | "rpc",
	calls: StatusCall[],
	opts: {
		/** Context-usage reading; defaults to null (bar hidden). */
		usage?: { tokens: number | null; contextWindow: number } | null
		/** When given, captured footer factories are pushed here. */
		footers?: FooterFactory[]
	} = {},
): ExtensionContext {
	return {
		mode,
		hasUI: true,
		model: { provider, id: "glm-5.3", reasoning: true },
		thinkingLevel: "high",
		getContextUsage: () => (opts.usage === undefined ? null : opts.usage),
		sessionManager: { getCwd: () => "/tmp/tc-footer-test" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		ui: {
			setFooter: (factory: FooterFactory) => opts.footers?.push(factory),
			setStatus: (key: string, text: string | undefined) => {
				calls.push({ key, text })
			},
		},
	} as unknown as ExtensionContext
}

/** Render one footer line through the last captured footer factory. */
function renderFooter(footers: FooterFactory[], width: number): string {
	const themeStub = { fg: (_color: string, text: string) => text }
	// Streaming refreshes call requestRender on the captured tui — must not throw.
	const tuiStub = { requestRender() {} }
	const dataStub = { onBranchChange: () => () => {}, getGitBranch: () => "main" }
	const view = footers[footers.length - 1](tuiStub, themeStub, dataStub)
	return view.render(width)[0]
}

/** Let the fire-and-forget poll (`void pollPlan`) reach its setStatus call. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const PLAN = "zai-coding-cn"

test("rpc mode publishes the polled plan segment to the status shelf", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const ctx = makeCtx(PLAN, "rpc", calls)

	await fire(handlers, "session_start", ctx)
	await settle()

	expect(calls.length).toBe(1)
	expect(calls[0].key).toBe("coding-plan")
	// Both windows of the shared snapshot, each in its ANSI pressure color:
	// 42% keeps the 5h blue baseline, 92% trips the 7d error red.
	expect(calls[0].text).toContain("⏳5h 42%")
	expect(calls[0].text).toContain("⏳7d 92%")
	expect(calls[0].text).toContain("\x1b[38;5;110m")
	expect(calls[0].text).toContain("\x1b[38;5;203m")
	// Each reset countdown is dim, and every span is reset before the next one.
	expect(calls[0].text).toContain("\x1b[38;5;245m ↻")
	expect(calls[0].text?.endsWith("\x1b[0m")).toBe(true)

	await fire(handlers, "session_shutdown", ctx)
})

test("switching to a non-plan provider clears the shelf", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const ctx = makeCtx(PLAN, "rpc", calls)

	await fire(handlers, "session_start", ctx)
	await settle()
	await fire(handlers, "model_select", makeCtx("tencent-copilot", "rpc", calls))

	expect(calls.length).toBe(2)
	expect(calls[1]).toEqual({ key: "coding-plan", text: undefined })

	await fire(handlers, "session_shutdown", ctx)
})

test("an unchanged segment is not re-published", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const ctx = makeCtx(PLAN, "rpc", calls)

	await fire(handlers, "session_start", ctx)
	await settle()
	await fire(handlers, "model_select", makeCtx(PLAN, "rpc", calls))

	expect(calls.length).toBe(1)

	await fire(handlers, "session_shutdown", ctx)
})

test("capped windows label the bar Smart Zone", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const footers: FooterFactory[] = []
	// 600k on a 1M-window model: the percent is 600k/650k = 92% of the Smart
	// Zone — the bar must label it, not leave the percent unexplained.
	const big = makeCtx(PLAN, "tui", calls, {
		footers,
		usage: { tokens: 600_000, contextWindow: 1_048_576 },
	})

	await fire(handlers, "session_start", big)
	await settle()
	const capped = renderFooter(footers, 120)
	expect(capped).toContain("92%")
	expect(capped).toContain("Smart Zone")

	// Uncapped window: the denominator is the nominal one — no label.
	const small = makeCtx(PLAN, "tui", calls, {
		footers,
		usage: { tokens: 30_000, contextWindow: 131_072 },
	})
	await fire(handlers, "session_start", small)
	expect(renderFooter(footers, 120)).not.toContain("Smart Zone")

	await fire(handlers, "session_shutdown", small)
	await fire(handlers, "session_shutdown", big)
})

test("tui mode never publishes a status", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const ctx = makeCtx(PLAN, "tui", calls)

	await fire(handlers, "session_start", ctx)
	await settle()
	await fire(handlers, "model_select", makeCtx(PLAN, "tui", calls))

	expect(calls).toEqual([])

	await fire(handlers, "session_shutdown", ctx)
})

// ---------------------------------------------------------------------------
// Token-speed segment (token 速度 / 速度等级 in CONTEXT.md): tier colors,
// run lifecycle (agent_start → agent_end), the paused tool clock, and the
// narrow-terminal drop order (plan → token speed → branch).
// ---------------------------------------------------------------------------

/** Fire a handler with a real event payload (fire() above only passes {}). */
function emit(
	handlers: Map<string, Handler>,
	name: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const handler = handlers.get(name)
	if (handler === undefined) throw new Error(`no handler registered for ${name}`)
	return handler(event, ctx)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const textDelta = (delta: string): unknown => ({
	type: "message_update",
	message: { role: "assistant" },
	assistantMessageEvent: { type: "text_delta", delta },
})

/** Extract the tok/s value from a rendered line (throws when the segment is absent). */
const parseTps = (line: string): number => {
	const match = /⚡([\d.]+) tok\/s/.exec(line)
	if (match === null) throw new Error(`no speed segment in footer line: ${line}`)
	return Number(match[1])
}

test("speed tiers map to the four footer colors", () => {
	expect(speedColor(0)).toBe("error")
	expect(speedColor(49.9)).toBe("error")
	expect(speedColor(50)).toBe("warning")
	expect(speedColor(99.9)).toBe("warning")
	expect(speedColor(100)).toBe("success")
	expect(speedColor(199.9)).toBe("success")
	expect(speedColor(200)).toBe("accent")
	expect(speedColor(300)).toBe("accent")
})

test("token speed: hidden before the first run, live while streaming, exact average after", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const footers: FooterFactory[] = []
	const ctx = makeCtx("tencent-copilot", "tui", calls, { footers })

	await fire(handlers, "session_start", ctx)
	await settle()
	// Before the first run there is no data — no segment.
	expect(renderFooter(footers, 120)).not.toContain("tok/s")

	await emit(handlers, "agent_start", { type: "agent_start" }, ctx)
	// Running, but no deltas yet — still nothing to show.
	expect(renderFooter(footers, 120)).not.toContain("tok/s")

	await emit(handlers, "message_update", textDelta("hello streaming world"), ctx)
	// The first instant is too short to divide by; the previous reading is kept.
	expect(renderFooter(footers, 120)).not.toContain("tok/s")
	await sleep(150)
	await emit(handlers, "message_update", textDelta("more tokens keep arriving here"), ctx)
	const live = renderFooter(footers, 120)
	expect(live).toMatch(/⚡\d+\.\d tok\/s/)
	// ⚡ now means token speed; the thinking level wears ✦ instead.
	expect(live).toContain("✦high")
	expect(live).not.toContain("⚡high")

	// Provider usage arrives with the completed message and replaces the estimate.
	await emit(
		handlers,
		"message_end",
		{ type: "message_end", message: { role: "assistant", usage: { output: 300 } } },
		ctx,
	)
	await sleep(60)
	await emit(handlers, "agent_end", { type: "agent_end", messages: [] }, ctx)
	// 300 tokens over the run's active time — the estimate alone (~13 tokens)
	// could never reach this rate, so the assertion proves the reconcile.
	expect(parseTps(renderFooter(footers, 120))).toBeGreaterThan(400)
	// Frozen after the run: the segment stays until the next agent_start.
	expect(renderFooter(footers, 120)).toContain("tok/s")

	await fire(handlers, "session_shutdown", ctx)
})

test("tool execution pauses the run clock", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const footers: FooterFactory[] = []
	const ctx = makeCtx("tencent-copilot", "tui", calls, { footers })

	await fire(handlers, "session_start", ctx)
	await settle()
	await emit(handlers, "agent_start", { type: "agent_start" }, ctx)
	// ~1000 estimated tokens, generated in ~50ms of active time (the sleep
	// keeps the active span well above Date.now()'s 1ms granularity).
	await emit(handlers, "message_update", textDelta(Array(1000).fill("token").join(" ")), ctx)
	await sleep(50)
	await emit(handlers, "tool_execution_start", { type: "tool_execution_start" }, ctx)
	await sleep(500)
	await emit(handlers, "tool_execution_end", { type: "tool_execution_end" }, ctx)
	await emit(handlers, "agent_end", { type: "agent_end", messages: [] }, ctx)
	// Excluding the 500ms tool pause: ~1000 tokens / ~50ms ≈ 20000 tok/s.
	// Counting the pause would yield ~1800 — below the assertion.
	expect(parseTps(renderFooter(footers, 120))).toBeGreaterThan(4000)

	await fire(handlers, "session_shutdown", ctx)
})

test("narrow terminals drop plan → token speed → branch, model id last", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const footers: FooterFactory[] = []
	const ctx = makeCtx(PLAN, "tui", calls, { footers })

	await fire(handlers, "session_start", ctx)
	await settle() // the fetch stub fills the plan snapshot
	await emit(handlers, "agent_start", { type: "agent_start" }, ctx)
	await emit(handlers, "message_update", textDelta("streaming tokens for the width scan"), ctx)
	await sleep(150)
	await emit(handlers, "message_update", textDelta("and a second delta"), ctx)

	/** Smallest width at which the needle still appears in the rendered line. */
	const minWidthShowing = (needle: string): number => {
		for (let w = 40; w <= 240; w++) {
			if (renderFooter(footers, w).includes(needle)) return w
		}
		throw new Error(`never rendered ${JSON.stringify(needle)}`)
	}
	const withPlan = minWidthShowing("⏳5h")
	const withSpeed = minWidthShowing("tok/s")
	const withBranch = minWidthShowing("(main)")
	// Each segment needs strictly more width than the next one in drop order,
	// so narrowing sheds the plan first, then the token speed, then the branch.
	expect(withPlan).toBeGreaterThan(withSpeed)
	expect(withSpeed).toBeGreaterThan(withBranch)

	// At the speed threshold the plan is already gone, but the model id stays.
	const atSpeed = renderFooter(footers, withSpeed)
	expect(atSpeed).toContain("glm-5.3")
	expect(atSpeed).not.toContain("⏳5h")
	// At the branch threshold the speed is gone too — branch outlives it.
	const atBranch = renderFooter(footers, withBranch)
	expect(atBranch).not.toContain("tok/s")
	expect(atBranch).toContain("(main)")
	expect(atBranch).toContain("glm-5.3")

	await fire(handlers, "session_shutdown", ctx)
})

// ---------------------------------------------------------------------------
// Quota parsing (per provider): GLM's unit-based limits and OpenCode Go's
// defensive window parsing — see docs/adr/0003-opencode-go-quota-windows.md.
// Both parsers face third-party responses that changed underneath other tools
// before (the OpenCode Go endpoint reshaped its payload within an hour of
// launch — cc-switch#6433), so every window is read independently, unusable
// windows are skipped, and a payload with no usable window yields undefined
// (the footer then keeps the previous snapshot instead of rendering garbage).
// ---------------------------------------------------------------------------

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

test("OpenCode Go: three gauges in order with their own baseline colors", () => {
	const gauges = parseGoQuotas(GO_OK)
	expect(gauges).toBeDefined()
	expect(gauges?.map((g) => g.label)).toEqual(["⏳5h", "⏳7d", "⏳30d"])
	expect(gauges?.map((g) => g.baseline)).toEqual(["accent", "mdLink", "thinkingHigh"])
	expect(gauges?.map((g) => g.usedPercent)).toEqual([4, 3, 1])
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

test("OpenCode Go: skips windows without status ok / numeric percent / valid date", () => {
	const gauges = parseGoQuotas({
		usage: {
			rolling: { status: "exceeded", percent: 4, resetsAt: GO_RESET.rolling },
			weekly: { status: "ok", percent: "50", resetsAt: GO_RESET.weekly },
			monthly: { status: "ok", percent: 2, resetsAt: "not-a-date" },
		},
	})
	expect(gauges?.map((g) => g.label)).toEqual(["⏳30d"])
	expect(gauges?.[0].resetAt).toBeUndefined()
})

test("OpenCode Go: unusable payloads parse to undefined", () => {
	expect(parseGoQuotas(null)).toBeUndefined()
	expect(parseGoQuotas({})).toBeUndefined()
	expect(parseGoQuotas({ usage: { rolling: { status: "ok", percent: "4" } } })).toBeUndefined()
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
