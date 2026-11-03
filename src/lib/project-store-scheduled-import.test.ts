import { beforeEach, describe, expect, it, vi } from "vitest"
import { createScheduledImportDirectory } from "./scheduled-import-config"

const storage = vi.hoisted(() => new Map<string, unknown>())
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => storage.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { await Promise.resolve(); storage.set(key, structuredClone(value)) },
    delete: async (key: string) => storage.delete(key),
    save: async () => {},
  })),
}))
import { loadScheduledImportConfig, recordScheduledDirectoryScan, saveScheduledImportConfig } from "./project-store"
const project = "D:/Wiki/Project"
const rowA = () => createScheduledImportDirectory("//server/share/A", { interval: 1 })
const rowB = () => createScheduledImportDirectory("//server/share/B", { interval: 9 })
const config = (directories = [rowA(), rowB()]) => ({ enabled: true, path: "", interval: 60, lastScan: null, directories })

describe("per-directory scheduled-import persistence", () => {
  beforeEach(() => storage.clear())
  it("migrates old settings once while preserving unrelated model configuration", async () => {
    storage.set(`scheduledImportConfig:${project}`, { enabled: true, path: "\\\\server\\share\\A", interval: 4, lastScan: 40 })
    storage.set("llmConfig", { model: "preserved" })
    const result = await loadScheduledImportConfig(project)
    expect(result?.directories?.[0]).toMatchObject({ path: "//server/share/A", interval: 4, lastScan: 40 })
    expect(storage.get(`scheduledImportConfig:${project}`)).toEqual(result)
    expect(storage.get("llmConfig")).toEqual({ model: "preserved" })
  })
  it("only migrates a legacy global monitor into the first requesting project", async () => {
    storage.set("scheduledImportConfig", { enabled: true, path: "D:/Input", interval: 1, lastScan: null })
    const [first, other] = await Promise.all([loadScheduledImportConfig(project), loadScheduledImportConfig("D:/Wiki/Other")])
    expect(first?.directories).toHaveLength(1)
    expect(other).toBeNull()
    expect(storage.has("scheduledImportConfig")).toBe(false)
  })
  it("records concurrent scans for separate roots without dropping either root", async () => {
    await saveScheduledImportConfig(project, config())
    await Promise.all([recordScheduledDirectoryScan(project, "\\\\SERVER\\share\\A", 100), recordScheduledDirectoryScan(project, "//server/share/B", 200)])
    const result = await loadScheduledImportConfig(project)
    expect(result?.directories?.map(row => row.lastScan)).toEqual([100, 200])
    expect(result?.lastScan).toBe(100)
    expect(result?.directories?.map(row => row.interval)).toEqual([1, 9])
  })
  it("preserves a scan timestamp when saving a stale settings draft", async () => {
    await saveScheduledImportConfig(project, config())
    const stale = structuredClone((await loadScheduledImportConfig(project))!)
    await recordScheduledDirectoryScan(project, "//server/share/A", 500)
    stale.directories![0].enabled = false
    await saveScheduledImportConfig(project, stale)
    expect((await loadScheduledImportConfig(project))?.directories?.[0]).toMatchObject({ enabled: false, lastScan: 500 })
  })
  it("never brings back a removed root when its in-flight scan finishes", async () => {
    await saveScheduledImportConfig(project, config())
    await saveScheduledImportConfig(project, config([rowB()]))
    const latest = await recordScheduledDirectoryScan(project, "//server/share/A", 700)
    expect(latest?.directories?.map(row => row.path)).toEqual(["//server/share/B"])
    await saveScheduledImportConfig(project, config([]))
    await recordScheduledDirectoryScan(project, "//server/share/B", 800)
    expect((await loadScheduledImportConfig(project))?.directories).toEqual([])
  })
  it("resets a changed location and does not transfer a late scan to the new path", async () => {
    await saveScheduledImportConfig(project, config())
    await recordScheduledDirectoryScan(project, "//server/share/A", 100)
    const next = structuredClone((await loadScheduledImportConfig(project))!)
    next.directories![0].path = "//server/share/C"
    await saveScheduledImportConfig(project, next)
    await recordScheduledDirectoryScan(project, "//server/share/A", 900)
    const result = await loadScheduledImportConfig(project)
    expect(result?.directories?.[0]).toMatchObject({ path: "//server/share/C", lastScan: null })
  })
})
