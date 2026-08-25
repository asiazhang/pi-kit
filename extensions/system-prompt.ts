/**
 * System prompt customization for pi.
 *
 * Injects user-preference instructions into the system prompt every turn via
 * `before_agent_start` (chained across extensions in load order).
 *
 * The Git section mirrors the user's global `~/.pi/agent/AGENTS.md` conventions
 * — keep both in sync when either changes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// User preferences injected into the system prompt every turn.
// Loads on every turn — kept minimal, positively phrased, and checkable.
const USER_INSTRUCTIONS = [
	"",
	"## Language",
	"Reply in Simplified Chinese unless the user writes in another language.",
	"",
	"## Bash search",
	"Use `rg` (respects .gitignore); add `--hidden` only when you must include hidden files.",
	"",
	"## Git: non-interactive",
	"- Set `GIT_EDITOR=true` so editor prompts are no-ops",
	"- Pull with `git pull --ff-only`; merge with `--no-edit`",
].join("\n")

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + USER_INSTRUCTIONS,
		}
	})
}
