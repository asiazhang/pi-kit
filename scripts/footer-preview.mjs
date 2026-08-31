/**
 * Preview the tc-footer layout in the terminal without a live session.
 *
 * Usage:
 *   node scripts/footer-preview.mjs [columns]
 *
 * Renders the exact same logic as extensions/tc-footer.ts (cwd shortening,
 * effective-window percent, dynamic color thresholds, colors) for a few
 * representative states, using the real pi theme (dark by default,
 * PI_THEME to override).
 */

import { isAbsolute, relative, resolve, sep } from "node:path"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

const themeMod = await import(
	"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
)
const theme = themeMod.getThemeByName(process.env.PI_THEME || "dark")
if (!theme) throw new Error(`theme "${process.env.PI_THEME || "dark"}" not found`)

/** Mirror of EFFECTIVE_CONTEXT_TOKENS in extensions/tc-footer.ts — keep in sync. */
const EFFECTIVE_CONTEXT_TOKENS = 450_000

/** Mirror of RESERVE_TOKENS in extensions/tc-footer.ts — keep in sync. */
const RESERVE_TOKENS = 16_384

/** Mirror of formatCwd() in extensions/tc-footer.ts — keep in sync. */
function formatCwd(cwd) {
	const home = process.env.HOME || process.env.USERPROFILE
	if (home) {
		const rel = relative(resolve(home), resolve(cwd))
		const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
		if (inside) return rel === "" ? "~" : `~${sep}${rel}`
	}
	const segments = resolve(cwd).split(sep).filter(Boolean)
	return segments.slice(-2).join(sep) || sep
}

/** Mirror of thresholds() in extensions/tc-footer.ts — keep in sync. */
function thresholds(effectiveWindow) {
	const capped = effectiveWindow >= EFFECTIVE_CONTEXT_TOKENS
	const red = capped ? 65 : ((effectiveWindow - RESERVE_TOKENS) / effectiveWindow) * 100
	return { red, yellow: red / 2 }
}

/** Mirror of effectivePercent() in extensions/tc-footer.ts — keep in sync. */
function effectivePercent(tokens, contextWindow) {
	const eff = Math.min(contextWindow, EFFECTIVE_CONTEXT_TOKENS)
	if (eff <= 0) return null
	return (tokens / eff) * 100
}

/** Mirror of contextBar() in extensions/tc-footer.ts — keep in sync. */
function contextBar(pct, th) {
	const filled = Math.round((Math.min(100, pct) / 100) * 20)
	const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
	return theme.fg(color, "█".repeat(filled) + "░".repeat(20 - filled))
}

/** Mirror of MODEL_COLORS in extensions/tc-footer.ts — keep in sync. */
const MODEL_COLORS = {
	"tencent-copilot": "accent",
	"zai-coding-cn": "thinkingXhigh",
}

/** Mirror of PLAN_DIM_MS in extensions/tc-footer.ts — keep in sync. */
const PLAN_DIM_MS = 10 * 60_000

/** Mirror of formatCountdown() in extensions/tc-footer.ts — keep in sync. */
function formatCountdown(resetAt, now) {
	const ms = resetAt - now
	if (ms <= 0) return "now"
	const days = Math.floor(ms / 86_400_000)
	if (days >= 1) return `${days}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`
	const hours = Math.floor(ms / 3_600_000)
	const minutes = Math.floor((ms % 3_600_000) / 60_000)
	return hours >= 1 ? `${hours}h${minutes}m` : `${minutes}m`
}

/** Mirror of quotaBar() in extensions/tc-footer.ts — keep in sync. */
function quotaBar(label, w, baseline, stale, now) {
	if (!w) return ""
	const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
	// 20 cells (5% each), ceil: any nonzero usage must light ≥1 cell (a few
	// percent would round to zero and look untouched; for a quota bar
	// over-reporting is the safe direction — it warns slightly early).
	const filled = Math.ceil((pct / 100) * 20)
	const bar = "█".repeat(filled) + "░".repeat(20 - filled)
	const countdown = w.resetAt !== undefined ? ` ↻${formatCountdown(w.resetAt, now)}` : ""
	if (stale) return theme.fg("dim", `${label} ${pct}% ${bar}${countdown}`)
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : baseline
	return theme.fg(color, `${label} ${pct}% ${bar}`) + (countdown ? theme.fg("dim", countdown) : "")
}

/** Mirror of planSegment() in extensions/tc-footer.ts — keep in sync. */
function planSegment(ws, now) {
	const stale = now - ws.capturedAt > PLAN_DIM_MS
	const parts = [
		quotaBar("⏳5h", ws.fiveHour, "mdLink", stale, now),
		quotaBar("⏳7d", ws.weekly, "thinkingHigh", stale, now),
	].filter(Boolean)
	return parts.join(" ")
}

/** Mirror of render() in extensions/tc-footer.ts — keep in sync. */
function renderLine(
	cwd,
	tokens,
	contextWindow,
	model,
	thinking,
	branch,
	planWindow,
	width,
	provider = "",
) {
	const left = theme.fg("dim", formatCwd(cwd))
	let context = ""
	if (tokens !== null && contextWindow > 0) {
		const effWindow = Math.min(contextWindow, EFFECTIVE_CONTEXT_TOKENS)
		const th = thresholds(effWindow)
		const pct = effectivePercent(tokens, contextWindow)
		if (pct !== null) {
			const shown = Math.min(100, Math.round(pct))
			const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
			context = ` ${theme.fg(color, `${shown}%`)} ${contextBar(pct, th)}`
		}
	}
	const think = thinking ? ` ${theme.fg("accent", `⚡${thinking}`)}` : ""
	const modelColor = MODEL_COLORS[provider]
	const modelPart = modelColor ? theme.fg(modelColor, model) : model
	const plan = planWindow ? planSegment(planWindow, Date.now()) : ""
	const branchPart = branch ? theme.fg("dim", ` (${branch})`) : ""
	// Narrow terminals drop the plan segment before the model id.
	const build = (withPlan) => {
		const right = [withPlan ? plan : "", modelPart + think, branchPart].filter(Boolean).join(" ")
		const pad = " ".repeat(
			Math.max(1, width - visibleWidth(left) - visibleWidth(context) - visibleWidth(right)),
		)
		return truncateToWidth(left + context + pad + right, width)
	}
	return plan && visibleWidth(build(true)) > width ? build(false) : build(true)
}

const width = Number(process.argv[2]) || 80
const cwd = process.cwd()

// Plan-window mock: 5h + 7d windows (usedPercent, reset+ageMin for the 5h, weeklyPct/resetMs for the 7d).
const plan = (fiveHourPct, ageMin = 0, weeklyPct = null) => {
	const ws = {
		capturedAt: Date.now() - ageMin * 60_000,
		fiveHour: { usedPercent: fiveHourPct, resetAt: Date.now() + 135 * 60_000 },
	}
	if (weeklyPct !== null) {
		ws.weekly = { usedPercent: weeklyPct, resetAt: Date.now() + 3 * 86_400_000 }
	}
	return ws
}

// [label, tokens, contextWindow, model, thinking, branch, planWindow, provider]
const cases = [
	[
		"128k window @ 30k (green)",
		30_000,
		131_072,
		"hunyuan-t1-latest",
		"high",
		"master",
		null,
		"tencent-copilot",
	],
	[
		"128k window @ 30k + plan 8% (blue, 2 lit cells)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(8),
		"zai-coding-cn",
	],
	[
		"128k window @ 30k + plan 42% (green + blue)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(42),
		"zai-coding-cn",
	],
	[
		"128k window @ 70k + plan 75% (yellow + yellow)",
		70_000,
		131_072,
		"glm-5.3",
		"high",
		"feature/footer",
		plan(75),
		"zai-coding-cn",
	],
	[
		"128k window @ 116k + plan 95% (red + red, near compaction)",
		116_000,
		131_072,
		"glm-5.3",
		"off",
		"master",
		plan(95),
		"zai-coding-cn",
	],
	[
		"200k window @ 100k (yellow)",
		100_000,
		204_800,
		"hunyuan-t1-latest",
		"high",
		"master",
		null,
		"tencent-copilot",
	],
	[
		"1M window @ 200k (yellow — red is 65% of effective window)",
		200_000,
		1_048_576,
		"gpt-5",
		null,
		"main",
		null,
		"anthropic",
	],
	[
		"1M window @ 300k (yellow — red is 65% of effective window)",
		300_000,
		1_048_576,
		"gpt-5",
		"low",
		"main",
		null,
		"openai",
	],
	[
		"1M window @ 440k (red — effective window nearly full)",
		440_000,
		1_048_576,
		"gpt-5",
		"high",
		"main",
		null,
		"openai",
	],
	["non-reasoning model, usage unknown", null, 131_072, "gpt-4o", null, "main", null, "openai"],
	[
		"5h 12% + weekly 92% (dual window — weekly ceiling hidden by a healthy 5h)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(12, 0, 92),
		"zai-coding-cn",
	],
	[
		"5h 42% + weekly 30% (dual window, both healthy)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(42, 0, 30),
		"zai-coding-cn",
	],
	[
		"5h 8% + weekly 85% (dual window, weekly warning)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(8, 0, 85),
		"zai-coding-cn",
	],
	[
		"plan stale >10min (whole segment dim)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(42, 15),
		"zai-coding-cn",
	],
	[
		"tencent-copilot model id in accent teal (no plan segment)",
		30_000,
		131_072,
		"hunyuan-t1-latest",
		"high",
		"master",
		null,
		"tencent-copilot",
	],
]

for (const [label, tokens, contextWindow, model, thinking, branch, planWindow, provider] of cases) {
	console.log(`${label}:`)
	console.log(
		renderLine(cwd, tokens, contextWindow, model, thinking, branch, planWindow, width, provider),
	)
	console.log()
}
console.log(`narrow (50 cols) — plan segment dropped before the model id:`)
console.log(
	renderLine(cwd, 116_000, 131_072, "glm-5.3", "high", "master", plan(42), 50, "zai-coding-cn"),
)
