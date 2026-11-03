import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), check: vi.fn() }))
vi.mock("./project-store", () => ({ loadUpdateCheckState: mocks.load, saveUpdateCheckState: mocks.save }))
vi.mock("./update-check", async importOriginal => ({ ...await importOriginal<typeof import("./update-check")>(), checkForUpdates: mocks.check }))
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const available = { kind: "available", local: "1.0.0", remote: "v1.1.0", release: { tag_name: "v1.1.0", name: "v1.1.0", body: "New features", html_url: "https://github.com/superrepus/WIKI/releases/tag/v1.1.0", published_at: "" } }
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(at(3, 7))
  mocks.load.mockReset().mockResolvedValue(null); mocks.save.mockReset().mockResolvedValue(undefined)
  mocks.check.mockReset().mockResolvedValue(available)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it("uses local 06:00 boundaries, including the previous day before 06:00", async () => {
  const { latestUpdateSlot, isDailyUpdateDue } = await import("./update-runtime")
  expect(latestUpdateSlot(at(3, 5, 59))).toBe(at(2, 6))
  expect(latestUpdateSlot(at(3, 6))).toBe(at(3, 6))
  const state = { enabled: true, lastSuccessAt: at(2, 7), lastCheckedAt: at(2, 7) }
  expect(isDailyUpdateDue(state, at(3, 5, 59))).toBe(false)
  expect(isDailyUpdateDue(state, at(3, 6))).toBe(true)
})

it("catches up a missed slot and persists release details so restarts retain the notification", async () => {
  const { runUpdateCheck } = await import("./update-runtime")
  await runUpdateCheck(false, at(3, 8))
  expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ repo: "superrepus/WIKI" }))
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ lastSuccessAt: at(3, 8), lastResult: available }))
  await runUpdateCheck(false, at(3, 20))
  expect(mocks.check).toHaveBeenCalledTimes(1)
})

it("restores an available release without hitting GitHub again in the same daily slot", async () => {
  mocks.load.mockResolvedValue({ repository: "superrepus/WIKI", currentVersion: __APP_VERSION__, enabled: true, lastCheckedAt: at(3, 7), lastSuccessAt: at(3, 7), lastResult: available, dismissedVersion: null })
  const { runUpdateCheck } = await import("./update-runtime")
  await runUpdateCheck(false, at(3, 8))
  const { useUpdateStore } = await import("@/stores/update-store")
  expect(useUpdateStore.getState().lastResult).toEqual(available)
  expect(mocks.check).not.toHaveBeenCalled()
})

it("retries failures after 15 minutes without clearing an already known update", async () => {
  mocks.load.mockResolvedValue({ repository: "superrepus/WIKI", currentVersion: __APP_VERSION__, enabled: true, lastCheckedAt: at(2, 7), lastSuccessAt: at(2, 7), lastResult: available })
  mocks.check.mockResolvedValue({ kind: "error", local: "1.0.0", message: "offline" })
  const { runUpdateCheck } = await import("./update-runtime")
  await runUpdateCheck(false, at(3, 7)); await runUpdateCheck(false, at(3, 7, 14))
  expect(mocks.check).toHaveBeenCalledTimes(1)
  const { useUpdateStore } = await import("@/stores/update-store")
  expect(useUpdateStore.getState().lastResult).toEqual(available)
  expect(useUpdateStore.getState().lastSuccessAt).toBe(at(2, 7))
  await runUpdateCheck(false, at(3, 7, 15))
  expect(mocks.check).toHaveBeenCalledTimes(2)
})

it("deduplicates concurrent clicks and scheduled checks", async () => {
  let resolve!: (result: typeof available) => void
  mocks.check.mockReturnValue(new Promise(done => { resolve = done }))
  const { runUpdateCheck } = await import("./update-runtime")
  const first = runUpdateCheck(true), second = runUpdateCheck(false)
  await Promise.resolve(); await Promise.resolve()
  resolve(available)
  await Promise.all([first, second])
  expect(mocks.check).toHaveBeenCalledTimes(1)
})

it("honors disabled automatic checks while allowing a manual check", async () => {
  mocks.load.mockResolvedValue({ enabled: false, lastCheckedAt: null, dismissedVersion: "v1.1.0" })
  const { runUpdateCheck } = await import("./update-runtime")
  await runUpdateCheck(false)
  expect(mocks.check).not.toHaveBeenCalled()
  await runUpdateCheck(true)
  expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, dismissedVersion: null }))
})

it("does not reuse an upstream repository's cached release after migration to FoxEss v1", async () => {
  mocks.load.mockResolvedValue({ repository: "nashsu/llm_wiki", currentVersion: "0.6.13", enabled: true, lastCheckedAt: at(3, 6), lastSuccessAt: at(3, 6), lastResult: { ...available, release: { ...available.release, html_url: "https://github.com/nashsu/llm_wiki/releases/tag/v99.0.0" } } })
  const { runUpdateCheck } = await import("./update-runtime")
  await runUpdateCheck(false, at(3, 7))
  expect(mocks.check).toHaveBeenCalledTimes(1)
  const { useUpdateStore } = await import("@/stores/update-store")
  expect(useUpdateStore.getState().lastResult).toEqual(available)
})

it("checks on wake/focus after a missed 06:00 and removes its listeners on teardown", async () => {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
  vi.stubGlobal("window", win); vi.stubGlobal("document", doc)
  mocks.load.mockResolvedValue({ repository: "superrepus/WIKI", currentVersion: __APP_VERSION__, enabled: true, lastCheckedAt: at(2, 7), lastSuccessAt: at(2, 7) })
  vi.setSystemTime(at(3, 5, 59))
  const { startDailyUpdateChecks } = await import("./update-runtime")
  const stop = startDailyUpdateChecks()
  await vi.advanceTimersByTimeAsync(1500)
  expect(mocks.check).not.toHaveBeenCalled()
  vi.setSystemTime(at(3, 6, 1)); win.dispatchEvent(new Event("focus"))
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.check).toHaveBeenCalledTimes(1)
  stop(); vi.setSystemTime(at(4, 7)); win.dispatchEvent(new Event("online"))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(mocks.check).toHaveBeenCalledTimes(1)
})
