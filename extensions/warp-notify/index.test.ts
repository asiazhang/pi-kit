/**
 * State-machine tests for the Warp notify extension (bun test).
 *
 * The OSC transport is replaced wholesale via mock.module, so OSC 777
 * emissions are recorded instead of written to /dev/tty. Events are fired at
 * the registered handlers in the order pi would emit them. Session ids are
 * unique per test, and each test ends with the main session's shutdown — at
 * zero runs that drives the shared module state through cleanupAll, so tests
 * stay order-independent.
 *
 * The invariants under guard (see the state-machine comment in index.ts):
 *
 *   - `stop` fires only when the last run ends, never when the outer run
 *     settles with background subagents still live (the early "done" badge);
 *   - subagent sessions never own announcements: they never re-announce the
 *     prompt and their completion never settles the outer role;
 *   - a held stop reports the OUTER run's snapshot, not the last child's;
 *   - a non-subagent agent_start while settled takes over and re-announces;
 *   - the plain single-run path is unchanged.
 */
import { beforeEach, expect, mock, test } from "bun:test"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"

process.env.TERM_PROGRAM = "WarpTerminal"
process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1"

interface Recorded {
	readonly event: string
	readonly query?: string
	readonly response?: string
}

const osc777: Recorded[] = []

mock.module("./warp-notify", () => ({
	writeOSC777: (_title: string, body: string) => {
		osc777.push(JSON.parse(body) as Recorded)
	},
	writeOSC0: () => {},
	pushTitleStack: () => {},
	popTitleStack: () => {},
}))

const { default: registerWarpNotify } = await import("./index")

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>
const handlers = new Map<string, Handler>()
registerWarpNotify({
	on: (name: string, handler: Handler) => {
		handlers.set(name, handler)
	},
} as unknown as ExtensionAPI)

function fire(name: string, event: unknown, ctx: ExtensionContext): Promise<void> {
	const handler = handlers.get(name)
	if (handler === undefined) throw new Error(`no handler registered for ${name}`)
	return handler(event, ctx)
}

function makeCtx(sessionId: string, user = "", assistant = ""): ExtensionContext {
	const branch = [
		...(user ? [{ type: "message", message: { role: "user", content: user } }] : []),
		...(assistant ? [{ type: "message", message: { role: "assistant", content: assistant } }] : []),
	] as unknown as SessionEntry[]
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		cwd: "/tmp/warp-notify-test",
	} as unknown as ExtensionContext
}

/** before_agent_start + agent_start, as pi fires them per run. */
async function startRun(ctx: ExtensionContext, query: string): Promise<void> {
	await fire("before_agent_start", { prompt: query }, ctx)
	await fire("agent_start", {}, ctx)
}

const count = (event: string): number => osc777.filter((e) => e.event === event).length

/** Outlast IDLE_DELAY_MS (300ms) so a scheduled idle_prompt has fired. */
const drainIdle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

/** Reset shared module state: at zero runs the shutdown path runs cleanupAll. */
async function teardown(main: ExtensionContext): Promise<void> {
	await fire("session_shutdown", {}, main)
}

beforeEach(() => {
	osc777.length = 0
})

test("outer settles with a background subagent live: stop waits for the last run", async () => {
	const main = makeCtx("t1-main", "fix the bug", "done")
	const child = makeCtx("t1-child")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "fix the bug")
	await fire("session_start", { reason: "startup" }, child) // child binds mid-run
	await startRun(child, "internal child prompt")
	await fire("agent_end", {}, main)
	expect(count("stop")).toBe(0) // no early "done" while work is live
	await fire("agent_end", {}, child)
	expect(count("stop")).toBe(1)
	await drainIdle()
	// One session_start: agent_start's announce, paired with prompt_submit.
	expect(osc777.map((e) => e.event)).toEqual([
		"session_start",
		"prompt_submit",
		"stop",
		"idle_prompt",
	])
	await teardown(main)
})

test("grandchild spawns while settled: subagent ends never stop; flush reports the outer answer", async () => {
	const main = makeCtx("t2-main", "q1", "outer answer")
	const child = makeCtx("t2-child")
	const grand = makeCtx("t2-grand")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "q1")
	await fire("session_start", { reason: "startup" }, child)
	await startRun(child, "child internal")
	await fire("agent_end", {}, main) // settle: hold the stop
	await fire("session_start", { reason: "startup" }, grand)
	await startRun(grand, "grandchild internal")
	await fire("agent_end", {}, grand)
	expect(count("stop")).toBe(0) // a subagent completing must not report done
	await fire("agent_end", {}, child) // last run ends: flush
	const stop = osc777.find((e) => e.event === "stop")
	expect(stop?.response).toBe("outer answer") // the outer's snapshot, not child text
	expect(count("prompt_submit")).toBe(1) // children never announce
	await teardown(main)
})

test("plain turn without subagents is unchanged", async () => {
	const main = makeCtx("t3-main", "hello", "hi")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "hello")
	await fire("agent_end", {}, main)
	await drainIdle()
	expect(osc777.map((e) => e.event)).toEqual([
		"session_start",
		"prompt_submit",
		"stop",
		"idle_prompt",
	])
	await teardown(main)
})

test("user's next prompt while children live: takeover re-announces, one stop total", async () => {
	const main = makeCtx("t4-main", "q2", "a2")
	const child = makeCtx("t4-child")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "q1")
	await fire("session_start", { reason: "startup" }, child)
	await startRun(child, "child internal")
	await fire("agent_end", {}, main) // settle: hold stop(q1)
	await startRun(main, "q2") // takeover: re-announce, drop the held stop
	await fire("agent_end", {}, main) // settle again: hold stop(q2)
	await fire("agent_end", {}, child) // last run: flush
	expect(count("stop")).toBe(1)
	const stop = osc777.find((e) => e.event === "stop")
	expect(stop?.query).toBe("q2")
	const submits = osc777.filter((e) => e.event === "prompt_submit")
	expect(submits).toHaveLength(2)
	expect(submits[1]?.query).toBe("q2")
	await teardown(main)
})

test("foreground subagent (the original upstream bug): child end leaves the outer alone", async () => {
	const main = makeCtx("t5-main", "q", "a")
	const child = makeCtx("t5-child")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "q")
	await fire("session_start", { reason: "startup" }, child)
	await startRun(child, "child")
	await fire("agent_end", {}, child)
	expect(count("stop")).toBe(0)
	await fire("agent_end", {}, main)
	expect(count("stop")).toBe(1)
	await teardown(main)
})

test("subagent torn down without agent_end: shutdown's zero-crossing flushes the held stop", async () => {
	const main = makeCtx("t6-main", "q", "a")
	const child = makeCtx("t6-child")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "q")
	await fire("session_start", { reason: "startup" }, child)
	await startRun(child, "child")
	await fire("agent_end", {}, main) // settle: hold
	await fire("session_shutdown", {}, child) // zero-crossing
	expect(count("stop")).toBe(1)
})

test("blocking question parks and drains: question_asked, tool_complete, then stop", async () => {
	const main = makeCtx("t7-main", "q", "a")
	await fire("session_start", { reason: "startup" }, main)
	await startRun(main, "q")
	await fire(
		"tool_call",
		{ toolName: "ask_user_question", toolCallId: "c1", input: { question: "?" } },
		main,
	)
	expect(count("question_asked")).toBe(1)
	await fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: "c1" }, main)
	expect(count("tool_complete")).toBe(1)
	await fire("agent_end", {}, main)
	expect(count("stop")).toBe(1)
	await teardown(main)
})
