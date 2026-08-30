/**
 * Warp structured-payload composition.
 *
 * Pure data transforms: branch → text extraction → envelope → JSON.
 * No I/O — one small named builder per event, serialized by `serializePayload`
 * and written by `index.ts`.
 */

import { basename } from "node:path"
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { parseSkillBlock } from "@earendil-works/pi-coding-agent"
import { negotiateProtocolVersion, type WarpEvent } from "./protocol"

/**
 * Warp routes `CLIAgent::pi` to its default session listener. Lives in the
 * JSON envelope — the OSC 777 title field is the `warp://cli-agent` URI
 * (see index.ts), not the agent id.
 */
export const AGENT_ID = "pi"

/** Toast text / query fields are truncated here. */
export const TRUNCATE_LIMIT = 200

// ---------------------------------------------------------------------------
// Types — base envelope + per-event extras
// ---------------------------------------------------------------------------

export interface WarpPayloadBase {
	readonly v: number
	readonly agent: string
	readonly event: WarpEvent
	readonly session_id: string
	readonly cwd: string
	readonly project: string
}

export interface StopExtras {
	readonly query: string
	readonly response: string
}
export interface IdlePromptExtras {
	readonly summary: string
}
export interface PromptSubmitExtras {
	readonly query: string
}
export interface ToolCompleteExtras {
	readonly tool_name: string
	readonly tool_input?: Record<string, unknown>
}

export type WarpPayload = WarpPayloadBase &
	Partial<StopExtras & IdlePromptExtras & PromptSubmitExtras & ToolCompleteExtras>

// ---------------------------------------------------------------------------
// Text helpers — small, single-purpose, composable
// ---------------------------------------------------------------------------

export function truncate(s: string): string {
	if (s.length <= TRUNCATE_LIMIT) return s
	return `${s.slice(0, TRUNCATE_LIMIT - 3)}...`
}

/** Extract plain text from message content, filtered to TextContent entries. */
export function extractMessageText(
	content: UserMessage["content"] | AssistantMessage["content"],
): string {
	if (typeof content === "string") return content
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
}

/**
 * Collapse a `<skill name="…" location="…">…</skill>` wrapper (emitted by
 * Pi's built-in skill expander) back to the user-facing `/skill:<name> <args>`
 * shorthand. Non-skill input passes through verbatim.
 *
 * Why: Warp surfaces this string in the `question_asked` toast. The wrapper
 * is a load-bearing LLM-input format, not something the human typed —
 * showing it raw leaks `<skill name="…" location="/abs/path">` into the
 * notification.
 */
export function summarizeSkillBlock(text: string): string {
	const parsed = parseSkillBlock(text)
	if (!parsed) return text
	const args = unwrapSkillInput(parsed.userMessage)
	return args ? `/skill:${parsed.name} ${args}` : `/skill:${parsed.name}`
}

/** Pi's parseSkillBlock surfaces rpiv-args' raw argument string verbatim as
 *  userMessage, labeled `Skill input:` after `</skill>`. Strip the label so
 *  the toast shows what the human typed. */
function unwrapSkillInput(userMessage: string | undefined): string | undefined {
	const m = userMessage?.match(/^Skill input: ([\s\S]*)$/)
	return m ? m[1] : userMessage
}

// ---------------------------------------------------------------------------
// Branch traversal — reverse-scan filtered branch for last user/assistant text
// ---------------------------------------------------------------------------

function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { type: "message" } {
	return entry.type === "message"
}

function findLastMessageText(branch: SessionEntry[], role: "user" | "assistant"): string {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (!isMessageEntry(entry)) continue
		const message = (entry as { message: UserMessage | AssistantMessage }).message
		if (message.role !== role) continue
		const text = summarizeSkillBlock(extractMessageText(message.content))
		if (text.length > 0) return truncate(text)
	}
	return ""
}

export function lastUserText(branch: SessionEntry[]): string {
	return findLastMessageText(branch, "user")
}

export function lastAssistantText(branch: SessionEntry[]): string {
	return findLastMessageText(branch, "assistant")
}

// ---------------------------------------------------------------------------
// Envelope — common fields for every Warp event
// ---------------------------------------------------------------------------

function baseEnvelope(event: WarpEvent, ctx: ExtensionContext): WarpPayloadBase {
	return {
		v: negotiateProtocolVersion(),
		agent: AGENT_ID,
		event,
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		project: basename(ctx.cwd),
	}
}

// ---------------------------------------------------------------------------
// Builders — one per Warp event; composition is linear and named
// ---------------------------------------------------------------------------

export function buildSessionStartPayload(ctx: ExtensionContext): WarpPayload {
	return baseEnvelope("session_start", ctx)
}

export function buildPromptSubmitPayload(ctx: ExtensionContext, query: string): WarpPayload {
	return {
		...baseEnvelope("prompt_submit", ctx),
		query: summarizeSkillBlock(query),
	}
}

export function buildQuestionAskedPayload(ctx: ExtensionContext): WarpPayload {
	return baseEnvelope("question_asked", ctx)
}

export function buildStopPayload(ctx: ExtensionContext, branch: SessionEntry[]): WarpPayload {
	return {
		...baseEnvelope("stop", ctx),
		query: lastUserText(branch),
		response: lastAssistantText(branch),
	}
}

export function buildIdlePromptPayload(ctx: ExtensionContext, summary: string): WarpPayload {
	return {
		...baseEnvelope("idle_prompt", ctx),
		summary,
	}
}

export function buildToolCompletePayload(
	ctx: ExtensionContext,
	toolName: string,
	toolInput?: Record<string, unknown>,
): WarpPayload {
	return {
		...baseEnvelope("tool_complete", ctx),
		tool_name: toolName,
		...(toolInput !== undefined ? { tool_input: toolInput } : {}),
	}
}

// ---------------------------------------------------------------------------
// Serializer — single source of truth for the JSON shape
// ---------------------------------------------------------------------------

export function serializePayload(payload: WarpPayload): string {
	return JSON.stringify(payload)
}
