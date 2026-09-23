/**
 * Shared contract of the coding-plan quota domain: gauge/snapshot types plus
 * the module-level snapshot singleton (ESM caching makes this one instance
 * per process across parent and subagent — same mechanism as warp-notify's
 * shared state). The tc-footer extension reads snapshots from here; the
 * coding-plan extension writes them. One-way: nothing here imports consumers.
 */

/**
 * Semantic colors of the quota display — theme keys for the TUI footer,
 * mapped to ANSI SGR for pi-web. Every gauge gets its own healthy baseline
 * so the windows read as separate instruments; alarm colors (warning, error)
 * always win over distinctiveness.
 */
export type PlanColor = "accent" | "mdLink" | "thinkingHigh" | "warning" | "error" | "dim"

/** Healthy-state label + baseline color of one quota gauge. */
export interface QuotaSpec {
	/** Gauge label, e.g. "⏳5h". */
	label: string
	/** Baseline color while healthy; warning ≥70% / error ≥90% win over it. */
	baseline: PlanColor
}

/** One gauge reading: spec + used percent + window reset instant. */
export interface QuotaGauge extends QuotaSpec {
	/** Used percent 0–100. */
	usedPercent: number
	/** Window reset instant (epoch ms). */
	resetAt?: number
}

/** One quota snapshot: the reading's provider + when it was fetched. */
export interface QuotaSnapshot {
	/** pi provider id this reading belongs to (stale cross-provider guard). */
	provider: string
	/** Gauges in render order; the last is dropped first on narrow terminals. */
	gauges: QuotaGauge[]
	/** When this snapshot was fetched (Date.now()). */
	capturedAt: number
}

let snapshot: QuotaSnapshot | undefined

/** Latest quota snapshot, whatever provider it was fetched under. */
export const getQuotaSnapshot = (): QuotaSnapshot | undefined => snapshot

/**
 * Publish a fresh snapshot (or clear it) and notify listeners — the footer
 * re-renders through onQuotaChange, the pi-web shelf is synced by the
 * publisher itself.
 */
export const setQuotaSnapshot = (next: QuotaSnapshot | undefined): void => {
	snapshot = next
	for (const listener of listeners) listener()
}

/**
 * The snapshot of the provider in front, if any: a snapshot fetched under
 * another provider never renders or publishes.
 */
export const activeSnapshot = (provider: string): QuotaSnapshot | undefined =>
	snapshot?.provider === provider ? snapshot : undefined

type Listener = () => void
const listeners = new Set<Listener>()

/**
 * Subscribe to snapshot changes; returns an unsubscribe fn. The footer uses
 * this to re-render when fresh data arrives mid-idle — the same shape as
 * pi's own footerData.onBranchChange.
 */
export const onQuotaChange = (listener: Listener): (() => void) => {
	listeners.add(listener)
	return () => listeners.delete(listener)
}
