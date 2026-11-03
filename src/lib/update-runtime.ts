import { checkForUpdates, isNewer, UPDATE_REPOSITORY, type UpdateStatus } from "./update-check"
import { loadUpdateCheckState, saveUpdateCheckState } from "./project-store"
import { useUpdateStore } from "@/stores/update-store"

export const UPDATE_RETRY_MS = 15 * 60_000
let hydration: Promise<void> | null = null
let check: Promise<UpdateStatus | null> | null = null

/** Local-time schedule, including the previous day's slot before today's 06:00. */
export function latestUpdateSlot(now: number): number {
  const day = new Date(now)
  day.setHours(6, 0, 0, 0)
  if (day.getTime() > now) day.setDate(day.getDate() - 1)
  return day.getTime()
}

export function isDailyUpdateDue(state: { enabled: boolean; lastSuccessAt: number | null; lastCheckedAt: number | null }, now: number): boolean {
  if (!state.enabled) return false
  const lastSuccess = state.lastSuccessAt
  if (lastSuccess !== null && lastSuccess >= latestUpdateSlot(now) && lastSuccess <= now) return false
  return state.lastCheckedAt === null || state.lastCheckedAt > now || now - state.lastCheckedAt >= UPDATE_RETRY_MS
}

export async function persistUpdateState(): Promise<void> {
  const s = useUpdateStore.getState()
  await saveUpdateCheckState({ enabled: s.enabled, lastCheckedAt: s.lastCheckedAt,
    lastSuccessAt: s.lastSuccessAt, dismissedVersion: s.dismissedVersion,
    lastResult: s.lastResult, lastCheckError: s.lastCheckError,
    repository: UPDATE_REPOSITORY, currentVersion: __APP_VERSION__ })
}

export function hydrateUpdateState(): Promise<void> {
  hydration ??= loadUpdateCheckState().then(saved => {
    if (!saved) return
    // Old builds stored only attempt time. They get one fresh check, then use the new daily slot.
    const sameBuild = saved.repository === UPDATE_REPOSITORY && saved.currentVersion === __APP_VERSION__
    const cached = sameBuild && saved.lastResult?.kind === "available" &&
      typeof saved.lastResult.remote === "string" &&
      isNewer(saved.lastResult.remote, __APP_VERSION__) &&
      typeof saved.lastResult.release?.html_url === "string" &&
      saved.lastResult.release.html_url.startsWith(`https://github.com/${UPDATE_REPOSITORY}/releases/`)
      ? saved.lastResult : sameBuild && saved.lastResult?.kind === "up-to-date" ? saved.lastResult : null
    useUpdateStore.getState().hydrate({ enabled: saved.enabled !== false,
      dismissedVersion: typeof saved.dismissedVersion === "string" ? saved.dismissedVersion : null,
      lastCheckedAt: typeof saved.lastCheckedAt === "number" ? saved.lastCheckedAt : null,
      lastSuccessAt: sameBuild && typeof saved.lastSuccessAt === "number" ? saved.lastSuccessAt : null,
      lastResult: cached, lastCheckError: saved.lastCheckError ?? null })
  }).catch(() => { hydration = null })
  return hydration
}

export function runUpdateCheck(manual = false, now = Date.now()): Promise<UpdateStatus | null> {
  if (check) return check
  const run = (async () => {
    await hydrateUpdateState()
    if (!manual && !isDailyUpdateDue(useUpdateStore.getState(), now)) return null
    useUpdateStore.getState().setChecking(true)
    try {
      const result = await checkForUpdates({ currentVersion: __APP_VERSION__, repo: UPDATE_REPOSITORY })
      useUpdateStore.getState().setResult(result, now)
      if (manual) useUpdateStore.getState().setDismissed(null)
      await persistUpdateState()
      return result
    } finally { useUpdateStore.getState().setChecking(false) }
  })()
  check = run.finally(() => { check = null })
  return check
}

/** A minute timer plus focus/online events also catches sleep and missed launch times. */
export function startDailyUpdateChecks(): () => void {
  let disposed = false
  const tick = () => { if (!disposed) void runUpdateCheck().catch(() => {}) }
  const startup = setTimeout(tick, 1500)
  const interval = setInterval(tick, 60_000)
  const visible = () => { if (document.visibilityState === "visible") tick() }
  window.addEventListener("focus", tick)
  window.addEventListener("online", tick)
  document.addEventListener("visibilitychange", visible)
  return () => {
    disposed = true
    clearTimeout(startup); clearInterval(interval)
    window.removeEventListener("focus", tick); window.removeEventListener("online", tick)
    document.removeEventListener("visibilitychange", visible)
  }
}
