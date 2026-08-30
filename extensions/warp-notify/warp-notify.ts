/**
 * OSC transport — writes Warp's escape sequences to the controlling terminal.
 *
 * On Unix this is `/dev/tty`; on Windows there is no `/dev/tty`, so the same
 * OSC bytes go to `process.stdout` and ConPTY forwards unrecognized OSCs to
 * Warp. Each call opens, writes, and closes the fd — no fd cache. All errors
 * are swallowed: a failed notification must never reach the agent loop.
 *
 * Sequences:
 *
 *   OSC 777      ESC ] 777 ; notify ; <title> ; <json> BEL
 *                structured cli-agent event (toast + tab badge); the title
 *                field must be the `warp://cli-agent` URI — see index.ts
 *   OSC 0        ESC ] 0 ; <title> BEL
 *                tab title, rewritten every 160ms by title-spinner.ts — the
 *                per-tab braille animation is a terminal-side side effect of
 *                title churn, not part of the 777 protocol
 *   CSI 22;0t    push title stack   ┐ snapshot before the spinner starts,
 *   CSI 23;0t    pop title stack    ┘ restore Pi's own tab title on stop
 */

import { closeSync, openSync, writeSync } from "node:fs"

const OSC = "\x1b]"
const BEL = "\x07"
const CSI = "\x1b["
const TTY_PATH = "/dev/tty"

function writeRaw(bytes: string): void {
	try {
		if (process.platform === "win32") {
			// No /dev/tty on Windows; ConPTY forwards unrecognized OSCs to Warp.
			if (process.stdout.isTTY) process.stdout.write(bytes)
			return
		}
		const fd = openSync(TTY_PATH, "w")
		try {
			writeSync(fd, bytes)
		} finally {
			try {
				closeSync(fd)
			} catch {
				// already closed — nothing to do
			}
		}
	} catch {
		// silent skip: a notification must never break the agent loop
	}
}

export function writeOSC777(title: string, body: string): void {
	writeRaw(`${OSC}777;notify;${title};${body}${BEL}`)
}

export function writeOSC0(title: string): void {
	writeRaw(`${OSC}0;${title}${BEL}`)
}

export function pushTitleStack(): void {
	writeRaw(`${CSI}22;0t`)
}

export function popTitleStack(): void {
	writeRaw(`${CSI}23;0t`)
}
