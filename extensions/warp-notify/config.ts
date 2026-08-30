/**
 * Tunables — upstream reads per-user overrides from @juicesharp/rpiv-config;
 * this package ships no config infra, so these defaults are the single
 * definition site.
 */

/** Re-announce the running prompt so Warp doesn't flip the tab to idle. */
export const DEFAULT_HEARTBEAT_MS = 15_000

/** Tools that park the run on a question (Blocked badge while outstanding). */
export const BLOCKING_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"])
