import { beforeEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ invoke: vi.fn(), dirty: false, busy: false, queuePaused: false,
  flush: vi.fn(), save: vi.fn(), resumeSave: vi.fn(), pause: vi.fn(), restore: vi.fn(), resumeQueue: vi.fn(),
  stop: vi.fn(), stopAll: vi.fn(), restart: vi.fn(), startAll: vi.fn(), wait: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }))
vi.mock("./update-save-barrier", () => ({ hasUnsavedUpdateSettings: () => m.dirty, flushUpdateSaveBarriers: m.flush }))
vi.mock("./auto-save", () => ({ suspendAutoSaveForUpdate: m.save, resumeAutoSave: m.resumeSave }))
vi.mock("./ingest-queue", () => ({ isQueuePaused: () => m.queuePaused, pauseQueue: m.pause, restoreQueue: m.restore, resumeProcessing: m.resumeQueue }))
vi.mock("./dedup-queue", () => ({ getQueueSummary: () => ({ processing: m.busy ? 1 : 0 }) }))
vi.mock("./scheduled-import", () => ({ stopScheduledImport: m.stop, startScheduledImport: m.restart, waitForScheduledImports: m.wait }))
vi.mock("./external-source-sync", () => ({ waitForExternalSourceScans: m.wait }))
vi.mock("./project-file-sync", () => ({ stopProjectFileSync: m.stop, stopAllProjectFileSync: m.stopAll, startProjectFileSync: m.restart, startAllProjectFileSync: m.startAll, waitForProjectFileSync: m.wait }))
import { useUpdateStore } from "@/stores/update-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { installAvailableUpdate } from "./update-install"
beforeEach(() => {
  vi.clearAllMocks(); m.dirty = false; m.busy = false; m.queuePaused = false
  m.invoke.mockImplementation(async (command: string) => command === "install_github_update" ? { status: "ready", version: "1.1.0", receipt: "verified-once" } : undefined)
  for (const fn of [m.flush, m.save, m.pause, m.restore, m.wait, m.stop, m.restart]) fn.mockResolvedValue(undefined)
  useWikiStore.setState({ project: { id: "p", name: "Knowledge", path: "C:/Knowledge" } as never })
  useChatStore.setState({ isStreaming: false }); useUpdateStore.getState().setInstall("idle")
})

it("downloads before pausing work and commits the exact native receipt only after safe saves", async () => {
  await installAvailableUpdate("v1.1.0")
  expect(m.invoke.mock.calls).toEqual([["install_github_update", { version: "v1.1.0" }], ["quit_for_update", { receipt: "verified-once" }]])
  expect(m.pause).toHaveBeenCalledWith({ verifyPersisted: true })
  expect(m.invoke.mock.invocationCallOrder[0]).toBeLessThan(m.stop.mock.invocationCallOrder[0])
  expect(m.flush.mock.invocationCallOrder[0]).toBeLessThan(m.pause.mock.invocationCallOrder[0])
  expect(m.save.mock.invocationCallOrder[0]).toBeLessThan(m.invoke.mock.invocationCallOrder[1])
  expect(useUpdateStore.getState().installStage).toBe("restarting")
})

it("never pauses or exits when download or verification fails", async () => {
  m.invoke.mockRejectedValue(new Error("verification failed"))
  await installAvailableUpdate("v1.1.0")
  expect(m.pause).not.toHaveBeenCalled()
  expect(m.invoke).toHaveBeenCalledTimes(1)
  expect(useUpdateStore.getState().installError).toBe("download")
})

it("does not exit after a failed editor flush and resumes scanners", async () => {
  m.flush.mockRejectedValue(new Error("disk is unavailable"))
  await installAvailableUpdate("v1.1.0")
  expect(m.invoke).toHaveBeenCalledTimes(1)
  expect(m.pause).not.toHaveBeenCalled()
  expect(m.restart).toHaveBeenCalled()
  expect(useUpdateStore.getState().installError).toBe("save")
})

it("preserves queue state and resumes processing after a verified pause cannot persist", async () => {
  m.pause.mockRejectedValue(new Error("write verification failed"))
  await installAvailableUpdate("v1.1.0")
  expect(m.invoke).toHaveBeenCalledTimes(1)
  expect(m.restore).not.toHaveBeenCalled()
  expect(m.resumeQueue).toHaveBeenCalledTimes(1)
})

it("restores a previously paused queue after data save fails, without launching the helper", async () => {
  m.queuePaused = true; m.save.mockRejectedValue(new Error("save failed"))
  await installAvailableUpdate("v1.1.0")
  expect(m.restore).toHaveBeenCalledWith("p", "C:/Knowledge", { startPaused: true })
  expect(m.invoke).toHaveBeenCalledTimes(1)
  expect(m.resumeSave).toHaveBeenCalled()
})

it("restores the original session if native helper launch fails", async () => {
  m.invoke.mockImplementation(async (command: string) => {
    if (command === "quit_for_update") throw new Error("helper failed")
    return { status: "ready", version: "1.1.0", receipt: "verified-once" }
  })
  await installAvailableUpdate("v1.1.0")
  expect(m.restore).toHaveBeenCalled()
  expect(useUpdateStore.getState().installError).toBe("restart")
})

it("blocks unsaved settings and busy chat/merge sessions before beginning an update", async () => {
  m.dirty = true; await installAvailableUpdate("v1.1.0")
  expect(useUpdateStore.getState().installError).toBe("settings")
  m.dirty = false; m.busy = true; await installAvailableUpdate("v1.1.0")
  expect(useUpdateStore.getState().installError).toBe("busy")
  expect(m.invoke).not.toHaveBeenCalled()
})

it("deduplicates simultaneous one-click requests", async () => {
  let ready!: (value: unknown) => void
  m.invoke.mockImplementationOnce(() => new Promise(resolve => { ready = resolve }))
  const first = installAvailableUpdate("v1.1.0"), second = installAvailableUpdate("v1.1.0")
  ready({ status: "ready", version: "1.1.0", receipt: "verified-once" })
  await Promise.all([first, second])
  expect(m.invoke).toHaveBeenCalledTimes(2)
})
