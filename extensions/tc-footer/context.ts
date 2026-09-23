/**
 * The 上下文用量 segment (see CONTEXT.md): cwd shortening, the effective
 * window math behind the context bar, its pressure thresholds, and the bar
 * itself. Pure functions — the footer composes them into its line.
 */
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"

/** Shorten cwd for display: ~-relative inside $HOME, otherwise the last two path segments. */
export function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE
	if (home) {
		const rel = relative(resolve(home), resolve(cwd))
		const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
		if (inside) return rel === "" ? "~" : `~${sep}${rel}`
	}
	const segments = resolve(cwd).split(sep).filter(Boolean)
	return segments.slice(-2).join(sep) || sep
}

/**
 * Effective-context ceiling (tokens). Context-rot research (Chroma, 18
 * frontier models) shows quality degrades long before large windows fill,
 * while compaction studies land the sweet spot well under 1M: LangWatch's
 * real-trace cost model optimizes around 220k–450k and calls >600k an
 * "unjustified premium". 650k caps the bar at roughly that boundary —
 * usable context, not the marketing number. Full evidence and the red-line
 * reasoning: docs/research/effective-context-window.md.
 */
export const EFFECTIVE_CONTEXT_TOKENS = 650_000

/** pi's default compaction reserve (settings.json: compaction.reserveTokens). */
const RESERVE_TOKENS = 16_384

/**
 * Color thresholds relative to the effective window. Small windows track
 * pi's auto-compaction trigger (tokens > window - RESERVE_TOKENS): red
 * right at it, yellow halfway below. When the window is capped by
 * EFFECTIVE_CONTEXT_TOKENS (e.g. a 1M model treated as 650k), there is no
 * quality cliff at the cap — agent loops tolerate high fill (Claude Code
 * compacts a 1M session at 96.7%, pi at 98.4%) — so red is a late warning
 * at 85% of the effective window, yellow at half that.
 */
export function thresholds(effectiveWindow: number): { red: number; yellow: number } {
	const capped = effectiveWindow >= EFFECTIVE_CONTEXT_TOKENS
	const red = capped ? 85 : ((effectiveWindow - RESERVE_TOKENS) / effectiveWindow) * 100
	return { red, yellow: red / 2 }
}

/** Percent of the effective window (0–100), or null when unknown. */
export function effectivePercent(tokens: number, contextWindow: number): number | null {
	const eff = Math.min(contextWindow, EFFECTIVE_CONTEXT_TOKENS)
	if (eff <= 0) return null
	return (tokens / eff) * 100
}

/** 20-cell bar (5% per cell), color by context pressure against the given thresholds. */
export function contextBar(pct: number, th: { red: number; yellow: number }, theme: Theme): string {
	const filled = Math.round((Math.min(100, pct) / 100) * 20)
	const color = pct >= th.red ? "error" : pct >= th.yellow ? "warning" : "success"
	return theme.fg(color, "█".repeat(filled) + "░".repeat(20 - filled))
}
