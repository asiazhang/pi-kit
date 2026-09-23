/**
 * Coding-plan quota access (see the Coding plan entry in CONTEXT.md): polls
 * the active provider's quota endpoint every 5 minutes with the stored
 * credential, publishes snapshots through ./state, and mirrors the quota
 * segment into UIs that have no footer (pi-web's extension-status shelf).
 * Endpoint parsing lives in ./sources, gauge rendering in ./render; the
 * tc-footer extension composes the same strings into its line — see
 * docs/adr/0004-coding-plan-independent-extension.md.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { planAnsi, quotaBars } from "./render"
import { QUOTA_POLL_MS, QUOTA_SOURCES, QUOTA_TIMEOUT_MS } from "./sources"
import { activeSnapshot, getQuotaSnapshot, setQuotaSnapshot } from "./state"

/** Status key of the quota segment in UIs without a footer (pi-web status shelf). */
const PLAN_STATUS_KEY = "coding-plan"

export default function (pi: ExtensionAPI) {
	// Resolved credentials per provider, single in-flight guard, and the
	// 5-minute refresh timer (session-scoped).
	let quotaKeys: Record<string, string | undefined> = {}
	let quotaInFlight = false
	let quotaTimer: ReturnType<typeof setInterval> | undefined
	// Last text published to the pi-web status shelf, so an unchanged segment is
	// not re-emitted (each setStatus pushes an update to the browser).
	let planStatus: string | undefined

	/**
	 * Mirror the quota segment into UIs that have no footer (pi-web over RPC,
	 * where `setFooter` is a no-op): its extension-status shelf renders
	 * `setStatus` text, ANSI included. TUI keeps footer-only rendering, and a
	 * non-source provider clears the shelf.
	 */
	const syncPlanStatus = (ctx: ExtensionContext): void => {
		if (ctx.mode === "tui" || !ctx.hasUI) return
		const snapshot = activeSnapshot(ctx.model?.provider ?? "")
		const next = snapshot ? quotaBars(snapshot, Date.now(), planAnsi).join(" ") : undefined
		if (next === planStatus) return
		planStatus = next
		ctx.ui.setStatus(PLAN_STATUS_KEY, next)
	}

	// Poll the active provider's quota endpoint. Best-effort: failures keep the
	// last snapshot (which then renders dim). Keys resolve through pi's auth
	// system (getApiKeyForProvider) and are retried while absent, so /login
	// mid-session is picked up without a restart.
	const pollQuota = async (ctx: ExtensionContext): Promise<void> => {
		const provider = ctx.model?.provider ?? ""
		const source = QUOTA_SOURCES[provider]
		if (!source || quotaInFlight) return
		quotaInFlight = true
		try {
			quotaKeys[provider] ||= (await ctx.modelRegistry.getApiKeyForProvider(provider)) || undefined
			const key = quotaKeys[provider]
			if (!key) return
			const res = await fetch(source.url, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
			})
			if (!res.ok) return
			const gauges = source.parse(await res.json())
			if (gauges) {
				setQuotaSnapshot({ provider, gauges, capturedAt: Date.now() })
				syncPlanStatus(ctx)
			}
		} catch {
			// Network/parse errors: keep rendering the previous snapshot.
		} finally {
			quotaInFlight = false
		}
	}

	/** Lazy refresh hook for event-driven primes (timer owns the regular cadence). */
	const maybePollQuota = (ctx: ExtensionContext): void => {
		const provider = ctx.model?.provider ?? ""
		if (!QUOTA_SOURCES[provider]) return
		const snapshot = getQuotaSnapshot()
		if (snapshot?.provider === provider && Date.now() - snapshot.capturedAt < QUOTA_POLL_MS) return
		void pollQuota(ctx)
	}

	const stopQuotaTimer = (): void => {
		if (quotaTimer) {
			clearInterval(quotaTimer)
			quotaTimer = undefined
		}
	}

	// Quota state resets with the session; the timer runs while a UI is
	// attached (footer plus pi-web status shelf) and ticks pollQuota, which
	// no-ops while a non-source provider is active.
	pi.on("session_start", async (_event, ctx) => {
		setQuotaSnapshot(undefined)
		quotaKeys = {}
		stopQuotaTimer()
		if (ctx.hasUI) {
			quotaTimer = setInterval(() => void pollQuota(ctx), QUOTA_POLL_MS)
			// pi-web never renders the footer, so its status shelf is the only
			// quota surface: sync it and fetch the first snapshot up front.
			syncPlanStatus(ctx)
			maybePollQuota(ctx)
		}
	})

	// Re-render on model switch is the footer's business; here we sync the
	// shelf and prime the quota segment when switching providers (it reads
	// ctx.model at poll time).
	pi.on("model_select", async (_event, ctx) => {
		syncPlanStatus(ctx)
		maybePollQuota(ctx)
	})

	pi.on("session_shutdown", async () => {
		stopQuotaTimer()
	})
}
