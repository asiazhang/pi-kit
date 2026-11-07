/**
 * Command Code (GOAT plan) provider for pi.
 *
 * Gateway: https://api.commandcode.ai/provider/v1/chat/completions
 * OpenAI Chat Completions compatible + SSE, auth via `Authorization: Bearer
 * <key>` (the same key the `cmd` CLI uses as `CMD_API_KEY`).
 *
 * Setup: run `/login` and select "Command Code (GOAT)" to store the key in
 * auth.json, or export `CMD_API_KEY` — the stored credential wins, the env var
 * is the fallback. Then select a `commandcode/<model>` entry via /model.
 *
 * Provider id is plain `commandcode` because this extension is the only
 * Command Code provider: the hand-written `commandcode` / `commandcode-claude`
 * blocks in ~/.pi/agent/models.json were removed (GOAT serves no Anthropic
 * model, and the gateway's `/provider/v1/models` covers the rest), so the id
 * is free and the key already stored under it is reused. If a models.json
 * provider with this id ever comes back it would be layered above this one and
 * its model definitions would replace ours.
 *
 * Model snapshot and gateway quirks verified against the live gateway on
 * 2026-11-07 with a GOAT key: `/provider/v1/models` is public and served the
 * context windows below, `reasoning_effort` accepted low|medium|high|xhigh|max
 * (rejected `minimal` outright, and `off` per model with
 * "does not support reasoning_effort off"), streaming usage chunks, tool calls,
 * image input, `reasoning_content` replay and tool-result roundtrips all
 * answered; max output ceilings come from the models.dev catalog (131072 /
 * 384000) and were accepted verbatim by the gateway.
 * Hot-reloadable via /reload after edits.
 */

import {
	type ApiKeyAuth,
	type AuthContext,
	createProvider,
	type Model,
	openAICompletionsApi,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const BASE_URL = "https://api.commandcode.ai/provider/v1"

/** Env fallback for the same key the stored credential holds (CMD CLI name). */
const KEY_ENV_VAR = "CMD_API_KEY"

// Gateway quirks vs standard OpenAI Chat Completions.
const COMPAT = {
	supportsStore: false, // `store` is not part of the gateway contract
	supportsDeveloperRole: false, // use "system" role
	supportsReasoningEffort: true, // `reasoning_effort` accepted
	supportsStrictMode: false, // `strict` passes today, but upstreams are mixed — don't rely on it
	maxTokensField: "max_tokens", // not `max_completion_tokens`
} as const

// Auth: the key stored via /login (auth.json) wins; `CMD_API_KEY` is the
// fallback so an existing `cmd` CLI setup works without logging in again.
const commandCodeApiKeyAuth: ApiKeyAuth = {
	name: "Command Code (GOAT) API key",
	login: async (interaction: ProviderAuthInteraction) => {
		interaction.signal.throwIfAborted()
		const key = await interaction.prompt({
			type: "secret",
			message: "Enter Command Code API key (studio → API keys)",
			placeholder: "user_...",
		})
		interaction.signal.throwIfAborted()
		return { type: "api_key", key }
	},
	resolve: async ({ ctx, credential }: { ctx: AuthContext; credential?: { key?: string } }) => {
		const stored = credential?.key
		if (stored) return { auth: { apiKey: stored }, source: "stored credential" }
		const fromEnv = await ctx.env(KEY_ENV_VAR)
		if (fromEnv) return { auth: { apiKey: fromEnv }, source: KEY_ENV_VAR }
		return undefined
	},
}

// Both models take the same effort ladder; the gateway's own value names are
// already pi's, so only the two levels the models cannot reach are dropped
// (`off` is rejected per model, `minimal` is not a gateway option at all).
const ALL_EFFORTS = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
}

// [id, name, contextWindow, maxTokens, supportsImages]
const SNAPSHOT: Array<[string, string, number, number, boolean]> = [
	["z-ai/glm-5.3-flash", "GLM-5.3 Flash", 1048576, 131072, true],
	["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1000000, 384000, true],
]

const models: Model<"openai-completions">[] = SNAPSHOT.map(
	([id, name, contextWindow, maxTokens, supportsImages]) => ({
		id,
		name,
		api: "openai-completions" as const,
		provider: "commandcode",
		baseUrl: BASE_URL,
		reasoning: true,
		thinkingLevelMap: ALL_EFFORTS,
		input: (supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		contextWindow,
		maxTokens,
		// GOAT is a flat-fee subscription whose credits track token cost, not a
		// per-token bill; keep usage tracking cost-free like the other plans.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: COMPAT,
	}),
)

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: "commandcode",
			name: "Command Code (GOAT)",
			baseUrl: BASE_URL,
			auth: {
				apiKey: commandCodeApiKeyAuth,
			},
			models,
			api: openAICompletionsApi(),
		}),
	)
}
