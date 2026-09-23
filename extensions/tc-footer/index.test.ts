/**
 * Extension tests for the tc-footer status line (bun test): the Smart Zone
 * label on capped windows, the token-speed segment (tier colors, run
 * lifecycle, paused tool clock), and the narrow-terminal drop order
 * (plan → token speed → branch).
 *
 * The quota segment renders from the snapshot published by ../coding-plan;
 * these tests seed it directly through state.ts — polling is covered by the
 * coding-plan extension's own tests. See docs/adr/0004-coding-plan-independent-extension.md.
 */
import { expect, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { setQuotaSnapshot } from "../coding-plan/state"
import registerFooter from "./index"
import {
	finalizeRun,
	freshSpeed,
	reconcileSpeed,
	recordSpeedDelta,
	recordSpeedEnd,
	speedColor,
} from "./speed"

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

const PLAN = "zai-coding-cn"

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

// ---------------------------------------------------------------------------
// Token-speed segment (token 速度 / 速度等级 in CONTEXT.md): tier colors,
// run lifecycle (agent_start → agent_end), and the paused tool clock.
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

	// The displayed reading is throttled to the refresh beat: within
	// SPEED_THROTTLE_MS of the first recompute, further deltas keep the window
	// growing but must not change the displayed tok/s (the upstream TUI
	// re-renders per delta, so this is what stops the number flickering).
	await emit(handlers, "message_update", textDelta("tokens keep arriving"), ctx)
	await emit(handlers, "message_update", textDelta("more tokens still"), ctx)
	expect(parseTps(renderFooter(footers, 120))).toBe(parseTps(live))

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

	// The quota segment renders from the coding-plan extension's snapshot;
	// seed it directly — this test only needs the footer to see one for PLAN.
	setQuotaSnapshot({
		provider: PLAN,
		gauges: [
			{ label: "⏳5h", baseline: "mdLink", usedPercent: 42 },
			{ label: "⏳7d", baseline: "thinkingHigh", usedPercent: 92 },
		],
		capturedAt: Date.now(),
	})
	try {
		await fire(handlers, "session_start", ctx)
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
	} finally {
		// Leave no snapshot behind for other files in the shared bun process.
		setQuotaSnapshot(undefined)
		await fire(handlers, "session_shutdown", ctx)
	}
})

// ---------------------------------------------------------------------------
// Responses-protocol catch-up (openai-responses, e.g. muse-spark): the
// upstream parser may drop output_text.delta events, while output_item.done
// always yields a text_end / thinking_end with the full block. recordSpeedEnd
// reconciles per block so the speed segment still works with zero deltas.
// ---------------------------------------------------------------------------

test("block end reconciles without double counting", () => {
	const speed = freshSpeed()
	speed.running = true
	speed.startAt = Date.now()
	// Deltas flowed normally: 3 estimated tokens on block 0.
	expect(recordSpeedDelta(speed, "hello world hi", 0)).toBe(true)
	expect(speed.tokens).toBe(3)
	// The authoritative end text matches the deltas — nothing added.
	expect(recordSpeedEnd(speed, 0, "hello world hi")).toBe(true)
	expect(speed.tokens).toBe(3)
	expect(speed.msgTokens).toBe(3)
	// A block whose deltas were dropped upstream counts whole.
	expect(recordSpeedEnd(speed, 1, "one two three four")).toBe(true)
	expect(speed.tokens).toBe(7)
	expect(speed.msgTokens).toBe(7)
	// Empty blocks and idle runs schedule nothing.
	expect(recordSpeedEnd(speed, 2, "   ")).toBe(false)
	expect(recordSpeedEnd(freshSpeed(), 0, "hello")).toBe(false)
	// Whole-run average over the reconciled total (deterministic clock).
	speed.startAt = 1_000
	expect(finalizeRun(speed, 2_000)).toBe(7)
})

test("block estimates reset per message", () => {
	const speed = freshSpeed()
	speed.running = true
	speed.startAt = Date.now()
	expect(recordSpeedEnd(speed, 0, "one two three")).toBe(true)
	expect(speed.tokens).toBe(3)
	// Next assistant message reuses contentIndex 0 — the old estimate must not
	// leak, or the identical block would count zero.
	reconcileSpeed(speed, { role: "assistant", usage: {} })
	expect(recordSpeedEnd(speed, 0, "one two three")).toBe(true)
	expect(speed.tokens).toBe(6)
})

test("token speed: end-only Responses-style stream still shows live then final", async () => {
	const handlers = register()
	const calls: StatusCall[] = []
	const footers: FooterFactory[] = []
	const ctx = makeCtx("meta", "tui", calls, { footers })

	await fire(handlers, "session_start", ctx)
	await emit(handlers, "agent_start", { type: "agent_start" }, ctx)
	const end = (index: number, content: string): unknown => ({
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_end", contentIndex: index, content },
	})
	// Zero deltas — the Responses-protocol shape when output_text.delta events
	// are dropped upstream. A single chunk has no span to divide by.
	await emit(handlers, "message_update", end(0, Array(60).fill("token").join(" ")), ctx)
	expect(renderFooter(footers, 120)).not.toContain("tok/s")
	await sleep(150)
	// Two chunks 150ms apart: a live reading exists despite zero deltas.
	await emit(handlers, "message_update", end(1, Array(60).fill("token").join(" ")), ctx)
	expect(renderFooter(footers, 120)).toMatch(/⚡\d+\.\d tok\/s/)
	// Frozen whole-run average after agent_end, with no usage to reconcile from.
	await emit(handlers, "message_end", { type: "message_end", message: { role: "assistant" } }, ctx)
	await emit(handlers, "agent_end", { type: "agent_end", messages: [] }, ctx)
	expect(renderFooter(footers, 120)).toMatch(/⚡\d+\.\d tok\/s/)
	await fire(handlers, "session_shutdown", ctx)
})
