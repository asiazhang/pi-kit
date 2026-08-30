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
 * Module state: a single in-flight ticker; start/stop are idempotent —
 * overlapping calls within the refcounted run loop are safe (see index.ts).
 * The timer is `unref()`d so a stray interval cannot block process exit.
 */

import { popTitleStack, pushTitleStack, writeOSC0 } from "./warp-notify"

/** Braille spinner: 3-dot cluster with a clockwise rotating gap, equal width. */
const SPINNER_FRAMES = ["⠴", "⠦", "⠖", "⠲"] as const

/** ~1.5 Hz — reads as ambient activity, not urgency. */
const SPINNER_INTERVAL_MS = 160

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
