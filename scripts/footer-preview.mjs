/**
 * Preview the tc-footer layout in the terminal without a live session.
 *
 * Usage:
 *   node scripts/footer-preview.mjs [columns]
 *
 * Renders the exact same logic as extensions/tc-footer/ (cwd shortening,
 * effective-window percent, dynamic color thresholds, colors, token-speed
 * tiers) for a few representative states, using the real pi theme (dark by
 * default, PI_THEME to override).
 */

import { isAbsolute, relative, resolve, sep } from "node:path"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

const themeMod = await import(
	"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
)
const theme = themeMod.getThemeByName(process.env.PI_THEME || "dark")
if (!theme) throw new Error(`theme "${process.env.PI_THEME || "dark"}" not found`)

/** Mirror of EFFECTIVE_CONTEXT_TOKENS in extensions/tc-footer/context.ts — keep in sync. */
const EFFECTIVE_CONTEXT_TOKENS = 650_000

/** Mirror of RESERVE_TOKENS in extensions/tc-footer/context.ts — keep in sync. */
const RESERVE_TOKENS = 16_384

/** Mirror of formatCwd() in extensions/tc-footer/context.ts — keep in sync. */
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

/** Mirror of thresholds() in extensions/tc-footer/context.ts — keep in sync. */
function thresholds(effectiveWindow) {
	const capped = effectiveWindow >= EFFECTIVE_CONTEXT_TOKENS
	const red = capped ? 85 : ((effectiveWindow - RESERVE_TOKENS) / effectiveWindow) * 100
	return { red, yellow: red / 2 }
}

/** Mirror of effectivePercent() in extensions/tc-footer/context.ts — keep in sync. */
function effectivePercent(tokens, contextWindow) {
	const eff = Math.min(contextWindow, EFFECTIVE_CONTEXT_TOKENS)
	if (eff <= 0) return null
	return (tokens / eff) * 100
}

/** Mirror of contextBar() in extensions/tc-footer/context.ts — keep in sync. */
function contextBar(pct, th) {
	const filled = Math.round((Math.min(100, pct) / 100) * 20)
	const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
	return theme.fg(color, "█".repeat(filled) + "░".repeat(20 - filled))
}

/** Mirror of MODEL_COLORS in extensions/tc-footer/index.ts — keep in sync. */
const MODEL_COLORS = {
	"tencent-copilot": "accent",
	"zai-coding-cn": "thinkingXhigh",
}

/** Mirror of SPEED_TIERS in extensions/tc-footer/speed.ts — keep in sync. */
const SPEED_TIERS = { warn: 50, good: 100, top: 200 }

/** Mirror of speedColor() in extensions/tc-footer/speed.ts — keep in sync. */
function speedColor(tps) {
	if (tps >= SPEED_TIERS.top) return "accent"
	if (tps >= SPEED_TIERS.good) return "success"
	if (tps >= SPEED_TIERS.warn) return "warning"
	return "error"
}

/** Mirror of QUOTA_DIM_MS in extensions/coding-plan/render.ts — keep in sync. */
const QUOTA_DIM_MS = 10 * 60_000

/** Mirror of formatCountdown() in extensions/coding-plan/render.ts — keep in sync. */
function formatCountdown(resetAt, now) {
	const ms = resetAt - now
	if (ms <= 0) return "now"
	const days = Math.floor(ms / 86_400_000)
	if (days >= 1) return `${days}d${Math.floor((ms % 86_400_000) / 3_600_000)}h`
	const hours = Math.floor(ms / 3_600_000)
	const minutes = Math.floor((ms % 3_600_000) / 60_000)
	return hours >= 1 ? `${hours}h${minutes}m` : `${minutes}m`
}

/** Mirror of GLM_GAUGES in extensions/coding-plan/sources.ts — keep in sync. */
const GLM_GAUGES = [
	{ label: "⏳5h", baseline: "mdLink" },
	{ label: "⏳7d", baseline: "thinkingHigh" },
]

/** Mirror of GO_GAUGES in extensions/coding-plan/sources.ts — keep in sync. */
const GO_GAUGES = [
	{ label: "⏳5h", baseline: "accent" },
	{ label: "⏳7d", baseline: "mdLink" },
	{ label: "⏳30d", baseline: "thinkingHigh" },
]

/** Mirror of quotaBar() in extensions/coding-plan/render.ts — keep in sync. */
function quotaBar(g, stale, now, paint) {
	const pct = Math.max(0, Math.min(100, Math.round(g.usedPercent)))
	// 20 cells (5% each), ceil: any nonzero usage must light ≥1 cell (a few
	// percent would round to zero and look untouched; for a quota bar
	// over-reporting is the safe direction — it warns slightly early).
	const filled = Math.ceil((pct / 100) * 20)
	const bar = "█".repeat(filled) + "░".repeat(20 - filled)
	const countdown = g.resetAt !== undefined ? ` ↻${formatCountdown(g.resetAt, now)}` : ""
	if (stale) return paint("dim", `${g.label} ${pct}% ${bar}${countdown}`)
	const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : g.baseline
	return paint(color, `${g.label} ${pct}% ${bar}`) + (countdown ? paint("dim", countdown) : "")
}

/** Mirror of quotaBars() in extensions/coding-plan/render.ts — keep in sync. */
function quotaBars(snapshot, now, paint) {
	const stale = now - snapshot.capturedAt > QUOTA_DIM_MS
	return snapshot.gauges.map((g) => quotaBar(g, stale, now, paint))
}

/** Mirror of PLAN_ANSI in extensions/coding-plan/render.ts — keep in sync. */
const PLAN_ANSI = {
	accent: "\x1b[38;5;109m",
	mdLink: "\x1b[38;5;110m",
	thinkingHigh: "\x1b[38;5;139m",
	warning: "\x1b[38;5;214m",
	error: "\x1b[38;5;203m",
	dim: "\x1b[38;5;245m",
}

/** Mirror of planAnsi in extensions/coding-plan/render.ts — keep in sync. */
const planAnsi = (color, text) => `${PLAN_ANSI[color]}${text}\x1b[0m`

/** Mirror of render() in extensions/tc-footer/index.ts — keep in sync. */
function renderLine(
	cwd,
	tokens,
	contextWindow,
	model,
	thinking,
	branch,
	snapshot,
	width,
	provider = "",
	speedTps = null,
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
			// Capped windows: label the Smart Zone (mirror of tc-footer.ts).
			const capNote = contextWindow > EFFECTIVE_CONTEXT_TOKENS ? theme.fg("dim", " Smart Zone") : ""
			context = ` ${theme.fg(color, `${shown}%`)} ${contextBar(pct, th)}${capNote}`
		}
	}
	const think = thinking ? ` ${theme.fg("accent", `✦${thinking}`)}` : ""
	const modelColor = MODEL_COLORS[provider]
	const modelPart = modelColor ? theme.fg(modelColor, model) : model
	const bars = snapshot
		? quotaBars(snapshot, Date.now(), (color, text) => theme.fg(color, text))
		: []
	// Mirror of the token-speed segment in tc-footer.ts: null until the first
	// run finishes; the same tiers (速度等级 in CONTEXT.md) color it.
	const speedSeg =
		speedTps === null ? "" : ` ${theme.fg(speedColor(speedTps), `⚡${speedTps.toFixed(1)} tok/s`)}`
	const branchPart = branch ? theme.fg("dim", ` (${branch})`) : ""
	// Narrow terminals drop quota gauges (the last, slowest window first) →
	// the whole quota segment → token speed → branch; the model id and context
	// bar always survive (mirrors tc-footer.ts).
	const build = (gaugeCount, keepSpeed, keepBranch) => {
		const right = [
			bars.slice(0, gaugeCount).join(" "),
			keepSpeed ? speedSeg : "",
			modelPart + think,
			keepBranch && branchPart ? branchPart : "",
		]
			.filter(Boolean)
			.join(" ")
		const pad = " ".repeat(
			Math.max(1, width - visibleWidth(left) - visibleWidth(context) - visibleWidth(right)),
		)
		return left + context + pad + right
	}
	const candidates = []
	for (let n = bars.length; n >= 0; n--) candidates.push([n, true, true])
	candidates.push([0, false, true], [0, false, false])
	let chosen = ""
	for (const [n, keepSpeed, keepBranch] of candidates) {
		const candidate = build(n, keepSpeed, keepBranch)
		if (visibleWidth(candidate) <= width) {
			chosen = candidate
			break
		}
	}
	return truncateToWidth(chosen || build(bars.length, true, true), width)
}

// Default matches a typical Mac terminal (120 cols); pass columns explicitly
// to preview narrow layouts.
const width = Number(process.argv[2]) || 120
const cwd = process.cwd()

// Quota-window mock: gauges in render order (usedPercent, reset+ageMin for the 5h, weeklyPct/resetMs for the 7d).
const plan = (fiveHourPct, ageMin = 0, weeklyPct = null) => {
	const snapshot = {
		capturedAt: Date.now() - ageMin * 60_000,
		gauges: [{ ...GLM_GAUGES[0], usedPercent: fiveHourPct, resetAt: Date.now() + 135 * 60_000 }],
	}
	if (weeklyPct !== null) {
		snapshot.gauges.push({
			...GLM_GAUGES[1],
			usedPercent: weeklyPct,
			resetAt: Date.now() + 3 * 86_400_000,
		})
	}
	return snapshot
}

// OpenCode Go trio mock: rolling 5h + weekly + monthly gauges.
const go = (rollingPct, ageMin = 0, weeklyPct = 12, monthlyPct = 34) => ({
	capturedAt: Date.now() - ageMin * 60_000,
	gauges: [
		{ ...GO_GAUGES[0], usedPercent: rollingPct, resetAt: Date.now() + 85 * 60_000 },
		{ ...GO_GAUGES[1], usedPercent: weeklyPct, resetAt: Date.now() + 3 * 86_400_000 },
		{ ...GO_GAUGES[2], usedPercent: monthlyPct, resetAt: Date.now() + 19 * 86_400_000 },
	],
})

// [label, tokens, contextWindow, model, thinking, branch, planWindow, provider, speedTps]
const cases = [
	[
		"128k window @ 30k (green) + speed 42.7 red (dropped when narrow)",
		30_000,
		131_072,
		"hunyuan-t1-latest",
		"high",
		"master",
		null,
		"tencent-copilot",
		42.7,
	],
	[
		"128k window @ 30k + plan 8% (blue, 2 lit cells) + speed 152.4 green (dropped when narrow)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(8),
		"zai-coding-cn",
		152.4,
	],
	[
		"128k window @ 30k + plan 42% (green + blue) + speed 280 cyan, near the 300 ceiling (dropped when narrow)",
		30_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(42),
		"zai-coding-cn",
		280,
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
		"1M window @ 200k (green — well inside the Smart Zone)",
		200_000,
		1_048_576,
		"gpt-5",
		null,
		"main",
		null,
		"anthropic",
	],
	[
		"1M window @ 300k (yellow — 46% of the Smart Zone, past the 42.5% yellow line)",
		300_000,
		1_048_576,
		"gpt-5",
		"low",
		"main",
		null,
		"openai",
	],
	[
		"1M window @ 600k (red — 92% of the Smart Zone, past the 85% red line)",
		600_000,
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
		"tencent-copilot model id in accent teal (no quota segment)",
		30_000,
		131_072,
		"hunyuan-t1-latest",
		"high",
		"master",
		null,
		"tencent-copilot",
	],
	[
		"OpenCode Go 4% / 3% / 1% (teal + blue + purple; ⏳7d/⏳30d dropped when narrow)",
		30_000,
		131_072,
		"mimo-v2.6-flash",
		"high",
		"main",
		go(4, 0, 3, 1),
		"opencode-go",
	],
	[
		"OpenCode Go 5h 72% + monthly 75% (warnings override the baselines)",
		30_000,
		131_072,
		"mimo-v2.6-flash",
		"high",
		"main",
		go(72, 0, 40, 75),
		"opencode-go",
	],
	[
		"OpenCode Go quota stale >10min (whole segment dim)",
		30_000,
		131_072,
		"mimo-v2.6-flash",
		"high",
		"main",
		go(42, 15, 30, 20),
		"opencode-go",
	],
]

for (const [
	label,
	tokens,
	contextWindow,
	model,
	thinking,
	branch,
	snapshot,
	provider,
	speedTps,
] of cases) {
	console.log(`${label}:`)
	console.log(
		renderLine(
			cwd,
			tokens,
			contextWindow,
			model,
			thinking,
			branch,
			snapshot,
			width,
			provider,
			speedTps ?? null,
		),
	)
	console.log()
}
// The tier ladder runs at ≥110 cols so the speed segment survives the long
// preview cwd; the requested width still governs everything else.
const ladderWidth = Math.max(width, 110)
console.log(
	`speed tiers at ${ladderWidth} cols (anchor: 300 tok/s ceiling) — red <50, yellow 50–100, green 100–200, cyan ≥200:`,
)
for (const tps of [42.7, 75, 152.4, 280]) {
	console.log(
		renderLine(
			cwd,
			30_000,
			131_072,
			"deepseek-v4.1-flash-ioa",
			"high",
			"master",
			null,
			ladderWidth,
			"tencent-copilot",
			tps,
		),
	)
}
console.log()
console.log(`narrow (100 cols) — plan segment dropped before the token speed:`)
console.log(
	renderLine(
		cwd,
		116_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(42),
		100,
		"zai-coding-cn",
		152.4,
	),
)
console.log()
console.log(`narrower (80 cols) — token speed dropped before the branch:`)
console.log(
	renderLine(
		cwd,
		116_000,
		131_072,
		"glm-5.3",
		"high",
		"master",
		plan(42),
		80,
		"zai-coding-cn",
		152.4,
	),
)
console.log()
console.log(`160 cols — OpenCode Go drops the ⏳30d gauge first:`)
console.log(
	renderLine(
		cwd,
		30_000,
		131_072,
		"mimo-v2.6-flash",
		"high",
		"main",
		go(42, 0, 30, 75),
		160,
		"opencode-go",
	),
)
console.log()
console.log(`200 cols — all three OpenCode Go gauges fit:`)
console.log(
	renderLine(
		cwd,
		30_000,
		131_072,
		"mimo-v2.6-flash",
		"high",
		"main",
		go(42, 0, 30, 75),
		200,
		"opencode-go",
	),
)

// pi-web status shelf: same segment, ANSI colors (the web theme is a no-op stub).
console.log()
console.log(`pi-web extension-status shelf (quota segment only, ANSI):`)
for (const [label, ws] of [
	["5h 42% + weekly 30%", plan(42, 0, 30)],
	["5h 8% + weekly 85%", plan(8, 0, 85)],
	["5h 95% (red)", plan(95, 0, 92)],
	["stale >10min (dim)", plan(42, 15)],
	["OpenCode Go trio 42 / 30 / 75", go(42, 0, 30, 75)],
]) {
	console.log(`${label}:`)
	console.log(quotaBars(ws, Date.now(), planAnsi).join(" "))
}
console.log()
console.log(
	`pi-web clear (non-plan provider / no snapshot): setStatus(${JSON.stringify("coding-plan")}, undefined)`,
)
