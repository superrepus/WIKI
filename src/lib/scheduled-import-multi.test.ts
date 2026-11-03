import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import type { ScheduledImportConfig } from "@/stores/wiki-store"
import type { ExternalSourceRegistry, ExternalSource } from "./external-sources"

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(), readFile: vi.fn(), writeFileAtomic: vi.fn(), listDirectory: vi.fn(),
  getFileMd5: vi.fn(), getFileSize: vi.fn(), getFileModifiedTime: vi.fn(), copyFile: vi.fn(),
  archiveLegacySource: vi.fn(), register: vi.fn(), unregister: vi.fn(), probe: vi.fn(), loadRegistry: vi.fn(),
  enqueue: vi.fn(), retract: vi.fn(), discard: vi.fn(), manualScan: vi.fn(),
  loadConfig: vi.fn(), saveConfig: vi.fn(), recordScan: vi.fn(), recents: vi.fn(), watch: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  fileExists: mocks.fileExists, readFile: mocks.readFile, writeFileAtomic: mocks.writeFileAtomic,
  listDirectory: mocks.listDirectory, getFileMd5: mocks.getFileMd5, getFileSize: mocks.getFileSize,
  getFileModifiedTime: mocks.getFileModifiedTime, copyFile: mocks.copyFile,
  archiveLegacySource: mocks.archiveLegacySource, createDirectory: vi.fn(),
}))
vi.mock("@/lib/source-lifecycle", () => ({
  deleteSourceFile: mocks.retract, enqueueSourceIngest: mocks.enqueue,
  folderContextForSourcePath: () => "original", isIngestableSourcePath: () => true,
}))
vi.mock("@/lib/ingest-queue", () => ({ discardTasksForSources: mocks.discard, enqueueInactiveProjectBatch: mocks.enqueue }))
vi.mock("@/lib/project-store", () => ({
  loadScheduledImportConfig: mocks.loadConfig, saveScheduledImportConfig: mocks.saveConfig,
  recordScheduledDirectoryScan: mocks.recordScan, getRecentProjects: mocks.recents, loadSourceWatchConfig: mocks.watch,
}))
vi.mock("@/lib/external-sources", async () => ({
  ...await vi.importActual<typeof import("@/lib/external-sources")>("@/lib/external-sources"),
  loadExternalSources: mocks.loadRegistry, registerExternalSource: mocks.register,
  unregisterExternalSource: mocks.unregister, probeExternalSource: mocks.probe,
}))
vi.mock("@/lib/external-source-sync", () => ({ scanRegisteredExternalSources: mocks.manualScan }))
vi.mock("@/lib/source-reconciliation", () => ({ loadSourceReconciliation: async () => null }))
vi.mock("@/lib/project-file-tree-refresh", () => ({ refreshProjectFileTree: vi.fn().mockResolvedValue([]) }))

import { scanAndImport, startScheduledImport, stopScheduledImport } from "./scheduled-import"
import { normalizeScheduledImportConfig } from "./scheduled-import-config"
import { useWikiStore } from "@/stores/wiki-store"
import { externalPathKey } from "./external-sources"

const project: WikiProject = { id: "multi-root-project", name: "Multi root", path: "/projects/knowledge" }
const dbPath = `${project.path}/.llm-wiki/scheduled-import-db.json`
type DbStore = { version: number; directories: Record<string, { files: Record<string, string>; lastScan: number | null }> }
let disk: Map<string, string>
let originals: Map<string, { hash: string; size: number; mtime: number }>
let trees: Map<string, Array<{ name: string; path: string; is_dir: boolean; children?: Array<{ name: string; path: string; is_dir: boolean }> }>>
let registry: ExternalSourceRegistry
let unavailable: Set<string>
let config: ScheduledImportConfig
const key = (value: string) => value.replace(/\\/g, "/").toLowerCase()
const relative = (value: string) => value.startsWith(`${project.path}/`) ? value.slice(project.path.length + 1) : value
const db = (): DbStore => JSON.parse(disk.get(dbPath) ?? '{"version":1,"directories":{}}')
function addFile(root: string, file: string, hash = "same-content") {
  originals.set(key(file), { hash, size: 120, mtime: 1000 })
  trees.set(root, [{ name: file.split("/").pop()!, path: file, is_dir: false }])
}
function monitoring(directories: Array<{ id: string; path: string; enabled?: boolean; interval?: number; lastScan?: number | null }>) {
  return normalizeScheduledImportConfig({ enabled: true, path: "", interval: 1, lastScan: null,
    directories: directories.map(d => ({ enabled: true, interval: 1, lastScan: null, ...d })) }, project.path)
}

beforeEach(() => {
  vi.clearAllMocks()
  disk = new Map(); originals = new Map(); trees = new Map(); unavailable = new Set()
  registry = { version: 1, sources: {}, roots: {}, ignoredPaths: [] }
  config = monitoring([])
  useWikiStore.setState({ project, sourceWatchConfig: {
    ...useWikiStore.getState().sourceWatchConfig, enabled: true, autoIngest: true,
    includeExtensions: [], excludeDirs: [], excludeExtensions: [], excludeGlobs: [], maxFileSizeMb: 100,
  } })
  mocks.fileExists.mockImplementation(async (p: string) => {
    const source = registry.sources[relative(p)]
    return disk.has(p) || (source ? originals.has(key(source.path)) : false)
  })
  mocks.readFile.mockImplementation(async (p: string) => disk.get(p) ?? "")
  mocks.writeFileAtomic.mockImplementation(async (p: string, value: string) => { disk.set(p, value) })
  mocks.listDirectory.mockImplementation(async (p: string) => {
    if (unavailable.has(key(p))) throw new Error("Network share unavailable")
    return trees.get(p) ?? []
  })
  mocks.getFileMd5.mockImplementation(async (p: string) => originals.get(key(p))?.hash ?? "missing")
  mocks.getFileSize.mockImplementation(async (p: string) => originals.get(key(p))?.size ?? 120)
  mocks.getFileModifiedTime.mockImplementation(async (p: string) => originals.get(key(p))?.mtime ?? 1000)
  mocks.loadRegistry.mockImplementation(async () => structuredClone(registry))
  mocks.register.mockImplementation(async (_pp: string, logical: string, entry: ExternalSource) => {
    const existing = Object.entries(registry.sources).find(([, value]) => key(value.path) === key(entry.path))
    const actual = existing?.[0] ?? relative(logical)
    registry.sources[actual] = { ...registry.sources[actual], ...entry }
    return actual
  })
  mocks.unregister.mockImplementation(async (_pp: string, logical: string) => { delete registry.sources[relative(logical)] })
  mocks.probe.mockImplementation(async (_pp: string, logical: string) => {
    const entry = registry.sources[relative(logical)]
    if (!entry) return { status: "unregistered" }
    if ([...unavailable].some(root => key(entry.path) === root || key(entry.path).startsWith(root + "/"))) return { status: "unavailable", entry }
    return { status: originals.has(key(entry.path)) ? "present" : "missing", entry }
  })
  mocks.archiveLegacySource.mockResolvedValue(false)
  mocks.enqueue.mockResolvedValue(["synthetic-task"])
  mocks.retract.mockResolvedValue({ deletedWikiPaths: [], rewrittenSourcePages: 0 })
  mocks.discard.mockResolvedValue(0)
  mocks.manualScan.mockResolvedValue(undefined)
  mocks.loadConfig.mockImplementation(async () => structuredClone(config))
  mocks.saveConfig.mockImplementation(async (_pp: string, value: ScheduledImportConfig) => { config = structuredClone(value) })
  mocks.recordScan.mockImplementation(async (_pp: string, path: string, timestamp: number) => {
    const directories = config.directories ?? []
    config = normalizeScheduledImportConfig({ ...config, directories: directories.map(d => externalPathKey(d.path) === externalPathKey(path) ? { ...d, lastScan: timestamp } : d) }, project.path)
    return structuredClone(config)
  })
  mocks.recents.mockResolvedValue([])
  mocks.watch.mockImplementation(async () => useWikiStore.getState().sourceWatchConfig)
})
afterEach(() => { stopScheduledImport(); expect(mocks.copyFile).not.toHaveBeenCalled() })

describe("independent additional directory state", () => {
  it("retains both directory databases and unchanged rescans do not enqueue again", async () => {
    addFile("/original/a", "/original/a/first.pdf"); addFile("/original/b", "/original/b/second.pdf")
    await scanAndImport(project, "/original/a")
    await scanAndImport(project, "/original/b")
    expect(Object.keys(db().directories).sort()).toEqual(["/original/a", "/original/b"])
    expect(mocks.recordScan).toHaveBeenCalledWith(project.path, "/original/a", expect.any(Number))
    expect(mocks.recordScan).toHaveBeenCalledWith(project.path, "/original/b", expect.any(Number))
    expect(mocks.enqueue).toHaveBeenCalledTimes(2)
    await scanAndImport(project, "/original/a")
    await scanAndImport(project, "/original/b")
    expect(mocks.enqueue).toHaveBeenCalledTimes(2)
  })

  it("retries a newly registered source after no usable model could enqueue it", async () => {
    addFile("/original/a", "/original/a/waiting.pdf")
    mocks.enqueue.mockResolvedValueOnce([])
    await scanAndImport(project, "/original/a")
    expect(Object.values(registry.sources)[0].pending).toBe(true)
    expect(db().directories["/original/a"].files).toEqual({})
    await scanAndImport(project, "/original/a")
    expect(mocks.enqueue).toHaveBeenCalledTimes(2)
    expect(Object.values(registry.sources)[0].pending).toBe(false)
    await scanAndImport(project, "/original/a")
    expect(mocks.enqueue).toHaveBeenCalledTimes(2)
  })

  it("retracts a confirmed deletion in A without removing B state or B source", async () => {
    addFile("/original/a", "/original/a/first.pdf"); addFile("/original/b", "/original/b/second.pdf")
    await scanAndImport(project, "/original/a"); await scanAndImport(project, "/original/b")
    const aLogical = Object.entries(registry.sources).find(([,s]) => s.path.endsWith("first.pdf"))![0]
    originals.delete(key("/original/a/first.pdf")); trees.set("/original/a", [])
    await scanAndImport(project, "/original/a")
    expect(mocks.retract).toHaveBeenCalledWith(project.path, `${project.path}/${aLogical}`, expect.any(Object))
    expect(Object.values(registry.sources).map(s => s.path)).toEqual(["/original/b/second.pdf"])
    expect(db().directories["/original/b"].files).toEqual({ "/original/b/second.pdf": "same-content" })
  })

  it("shares one logical source across overlapping parent and child monitors", async () => {
    const file = "/original/parent/child/common.pdf"
    addFile("/original/parent", file); addFile("/original/parent/child", file)
    await scanAndImport(project, "/original/parent"); await scanAndImport(project, "/original/parent/child")
    expect(Object.keys(registry.sources)).toHaveLength(1)
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(Object.keys(db().directories)).toHaveLength(2)
  })

  it("keeps a manually registered folder source under its always-on ownership", async () => {
    const physical = "/original/manual/common.pdf", logical = "raw/sources/external/manual/common.pdf"
    addFile("/original/manual", physical)
    registry.sources[logical] = { path: physical, root: "/original/manual", kind: "folder", hash: "same-content", size: 120, mtime: 1000 }
    registry.roots = { manual: { path: "/original/manual", kind: "folder", logicalRoot: "raw/sources/external/manual" } }
    await scanAndImport(project, "/original/manual")
    expect(registry.sources[logical].kind).toBe("folder")
    expect(registry.sources[logical].root).toBe("/original/manual")
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it("does not retract a present shared source still owned by another root", async () => {
    const physical = "/original/parent/child/common.pdf"
    addFile("/original/parent", physical); addFile("/original/parent/child", physical)
    config = monitoring([{ id: "parent", path: "/original/parent" }, { id: "child", path: "/original/parent/child" }])
    await scanAndImport(project, "/original/parent"); await scanAndImport(project, "/original/parent/child")
    trees.set("/original/parent", []) // transient enumeration gap; direct child remains accessible
    await scanAndImport(project, "/original/parent")
    expect(mocks.retract).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
    expect(Object.keys(registry.sources)).toHaveLength(1)
    // Retain the observation so the parent can detect a later deletion even if
    // the child monitor is subsequently paused or removed.
    expect(db().directories["/original/parent"].files[physical]).toBe("same-content")
    config = monitoring([{ id: "parent", path: "/original/parent" }, { id: "child", path: "/original/parent/child", enabled: false }])
    originals.delete(key(physical)); trees.set("/original/parent/child", [])
    await scanAndImport(project, "/original/parent")
    expect(mocks.retract).toHaveBeenCalledTimes(1)
    expect(Object.keys(registry.sources)).toHaveLength(0)
  })

  it("does not cancel or retract a temporarily unavailable registered source", async () => {
    addFile("/original/share", "/original/share/common.pdf")
    await scanAndImport(project, "/original/share")
    trees.set("/original/share", [])
    unavailable.add(key("/original/share/common.pdf"))
    await scanAndImport(project, "/original/share")
    expect(mocks.retract).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
    expect(Object.keys(registry.sources)).toHaveLength(1)
  })
})

describe("manual polling and multiple independent schedules", () => {
  it.each(["paused", "removed"])("retains known sources and database when an extra monitor is %s", async mode => {
    addFile("/original/old", "/original/old/existing.pdf")
    await scanAndImport(project, "/original/old")
    const savedState = disk.get(dbPath)
    originals.clear(); trees.clear()
    config = monitoring(mode === "paused" ? [{ id: "old", path: "/original/old", enabled: false }] : [])
    startScheduledImport(project, config)
    await vi.waitFor(() => expect(mocks.manualScan).toHaveBeenCalledWith(project))
    expect(disk.get(dbPath)).toBe(savedState)
    expect(Object.keys(registry.sources)).toHaveLength(1)
    expect(mocks.retract).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it("polls manual sources when the additional monitor list is empty", async () => {
    startScheduledImport(project, monitoring([]))
    await vi.waitFor(() => expect(mocks.manualScan).toHaveBeenCalledWith(project))
    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(mocks.retract).not.toHaveBeenCalled()
  })

  it("scans both enabled directories while leaving a disabled directory untouched", async () => {
    addFile("/original/a", "/original/a/a.pdf"); addFile("/original/b", "/original/b/b.pdf")
    config = monitoring([{ id: "a", path: "/original/a" }, { id: "b", path: "/original/b" }, { id: "c", path: "/original/disabled", enabled: false }])
    startScheduledImport(project, config)
    await vi.waitFor(() => expect(Object.keys(db().directories).sort()).toEqual(["/original/a", "/original/b"]))
    expect(mocks.listDirectory).not.toHaveBeenCalledWith("/original/disabled")
    expect(mocks.manualScan).toHaveBeenCalledWith(project)
  })

  it("continues additional directory scans if the manual source check fails", async () => {
    addFile("/original/a", "/original/a/a.pdf")
    config = monitoring([{ id: "a", path: "/original/a" }])
    mocks.manualScan.mockRejectedValueOnce(new Error("manual registry unavailable"))
    startScheduledImport(project, config)
    await vi.waitFor(() => expect(db().directories["/original/a"]?.files).toEqual({ "/original/a/a.pdf": "same-content" }))
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
  })
})
