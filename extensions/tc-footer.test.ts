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
import registerFooter from "./tc-footer"

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

function makeCtx(provider: string, mode: "tui" | "rpc", calls: StatusCall[]): ExtensionContext {
	return {
		mode,
		hasUI: true,
		model: { provider, id: "glm-5.3", reasoning: true },
		thinkingLevel: "high",
		getContextUsage: () => null,
		sessionManager: { getCwd: () => "/tmp/tc-footer-test" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		ui: {
			setFooter: () => {},
			setStatus: (key: string, text: string | undefined) => {
				calls.push({ key, text })
			},
		},
	} as unknown as ExtensionContext
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
