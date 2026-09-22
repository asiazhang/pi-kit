/**
 * Tab-title activity spinner.
 *
 * Warp's per-tab "moving dots" animation is NOT part of the OSC 777
 * cli-agent protocol — it's a side effect of the foreground process
 * continuously rewriting its terminal title via OSC 0 (same mechanism
 * Claude Code uses). The animation plays in the terminal, not here.
 *
 * Title preservation: the tab title Pi sets at startup (`π - <repo>`)
 * must survive the animation round trip. On start the current title is
 * pushed onto xterm's title stack (CSI 22;0t); while running only the
 * FIRST character is swapped for the rotating glyph (the ` - <repo>`
 * suffix stays put); on stop the stack is popped (CSI 23;0t) and the
 * original title restored verbatim. Terminals without a title stack
 * ignore the CSI silently.
 *
 * Variants: one per tab-title animation, each with its own frame set and
 * cadence. The running variant is drawn ONCE at module load — a fresh pi
 * process (new session / restart) gets a random one, and it stays put for
 * that process. All frames are single-width cells (braille, block, or
 * geometric) so the title width never changes mid-animation.
 *
 * Module state: a single in-flight ticker; start/stop are idempotent —
 * overlapping calls within the refcounted run loop are safe (see index.ts).
 * The timer is `unref()`d so a stray interval cannot block process exit.
 */

import { popTitleStack, pushTitleStack, writeOSC0 } from "./warp-notify"

interface SpinnerVariant {
	/** Human label for previews and logs — never rendered to the terminal. */
	readonly kind: string
	/** Single-width glyph frames; the running index wraps mod frame count. */
	readonly frames: readonly string[]
	/** Milliseconds between frames — each variant picks its own cadence. */
	readonly intervalMs: number
}

/**
 * Candidate animations, one drawn per process at module load. Each cadence
 * is tuned to its own frame count so every variant reads as calm motion.
 */
const SPINNER_VARIANTS: readonly SpinnerVariant[] = [
	{
		kind: "dots10",
		frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		intervalMs: 80,
	},
	{
		kind: "breathe",
		frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
		intervalMs: 100,
	},
	{
		kind: "bounce",
		frames: ["⠁", "⠂", "⠄", "⠂"],
		intervalMs: 160,
	},
	{
		kind: "corner",
		frames: ["◢", "◣", "◤", "◥"],
		intervalMs: 180,
	},
	{
		kind: "box",
		frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█", "▉", "▊", "▋", "▌", "▍", "▎"],
		intervalMs: 100,
	},
	{
		kind: "pie",
		frames: ["◐", "◓", "◑", "◒"],
		intervalMs: 180,
	},
]

/** One random variant per pi process (a session restarts with a fresh pick). */
function pickVariant(): SpinnerVariant {
	const index = Math.floor(Math.random() * SPINNER_VARIANTS.length)
	return SPINNER_VARIANTS[index]
}

const { frames: SPINNER_FRAMES, intervalMs: SPINNER_INTERVAL_MS } = pickVariant()

/** Pure formatter — the mascot glyph is the only part that changes. */
function activeTitle(frame: number, suffix: string): string {
	return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}${suffix}`
}

interface Ticker {
	timer: ReturnType<typeof setInterval>
	frame: number
	suffix: string
}

let active: Ticker | undefined

function tick(): void {
	if (!active) return
	writeOSC0(activeTitle(active.frame, active.suffix))
	active.frame = (active.frame + 1) % SPINNER_FRAMES.length
}

export function startSpinner(suffix: string): void {
	if (active) return
	pushTitleStack()
	const timer = setInterval(tick, SPINNER_INTERVAL_MS)
	timer.unref?.()
	active = { timer, frame: 0, suffix }
}

export function stopSpinner(): void {
	if (!active) return
	clearInterval(active.timer)
	active = undefined
	popTitleStack()
}
