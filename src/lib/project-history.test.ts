import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
const invoke = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
import { pruneDeletedProjectHistory } from "./project-history"

const project = (id: string, path = `C:/wiki/${id}`): WikiProject => ({ id, name: id, path })
function storeWith(initial: Record<string, unknown>) {
  const data = new Map(Object.entries(initial))
  return { data, get: async <T>(key: string) => data.get(key) as T | undefined,
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value) }),
    delete: vi.fn(async (key: string) => { data.delete(key) }), save: vi.fn(async () => {}) }
}
describe("deleted project history", () => {
  beforeEach(() => { invoke.mockReset() })
  it("removes confirmed deleted history, last-open pointer and matching registry only", async () => {
    const deleted = project("deleted"), valid = project("valid"), offline = project("offline", "//server/share/library")
    const store = storeWith({ recentProjects: [deleted, valid, offline], lastProject: deleted,
      projectRegistry: { deleted, valid, offline }, unrelatedSetting: { enabled: true } })
    invoke.mockResolvedValue([{ path: deleted.path, status: "missing" }, { path: valid.path, status: "available" }, { path: offline.path, status: "unavailable" }])
    await pruneDeletedProjectHistory(store)
    expect(store.data.get("recentProjects")).toEqual([valid, offline])
    expect(store.data.has("lastProject")).toBe(false)
    expect(store.data.get("projectRegistry")).toEqual({ valid, offline })
    expect(store.data.get("unrelatedSetting")).toEqual({ enabled: true })
    expect(store.save).toHaveBeenCalledOnce()
  })
  it("keeps inaccessible projects and every setting when probe transport fails", async () => {
    const offline = project("offline")
    const store = storeWith({ recentProjects: [offline], lastProject: offline })
    invoke.mockRejectedValue(new Error("permission denied or older native runtime"))
    await pruneDeletedProjectHistory(store)
    expect(store.data.get("recentProjects")).toEqual([offline])
    expect(store.data.get("lastProject")).toEqual(offline)
    expect(store.set).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
  })
  it("normalizes Windows casing while removing confirmed missing paths", async () => {
    const deleted = project("deleted", "C:\\Wiki\\Deleted")
    const store = storeWith({ recentProjects: [deleted], lastProject: deleted })
    invoke.mockResolvedValue([{ path: "c:/wiki/deleted", status: "missing" }])
    await pruneDeletedProjectHistory(store)
    expect(store.data.get("recentProjects")).toEqual([])
    expect(store.data.has("lastProject")).toBe(false)
  })
  it("preserves projects added while filesystem probes are running", async () => {
    const deleted = project("deleted"), newProject = project("new")
    const store = storeWith({ recentProjects: [deleted], lastProject: deleted })
    invoke.mockImplementation(async () => {
      store.data.set("recentProjects", [newProject, deleted]); store.data.set("lastProject", newProject)
      return [{ path: deleted.path, status: "missing" }]
    })
    await pruneDeletedProjectHistory(store)
    expect(store.data.get("recentProjects")).toEqual([newProject])
    expect(store.data.get("lastProject")).toEqual(newProject)
  })
  it("does not mutate history for an unexpected missing result outside the requested paths", async () => {
    const valid = project("valid"), store = storeWith({ recentProjects: [valid], lastProject: valid })
    invoke.mockResolvedValue([{ path: "C:/other/project", status: "missing" }])
    await pruneDeletedProjectHistory(store)
    expect(store.set).not.toHaveBeenCalled()
    expect(store.delete).not.toHaveBeenCalled()
  })
})
