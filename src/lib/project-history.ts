import { invoke } from "@tauri-apps/api/core"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

interface HistoryStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
  save(): Promise<unknown>
}
interface ProjectProbe { path: string; status: "available" | "missing" | "unavailable" }
const pathKey = (path: string) => {
  const normalized = normalizePath(path).replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}
let cleanup = Promise.resolve()

/** Only a native, positive missing result removes history. Permission or network failures keep it. */
export function pruneDeletedProjectHistory(store: HistoryStore): Promise<void> {
  const next = cleanup.then(() => prune(store))
  cleanup = next.catch(() => {})
  return next
}
async function prune(store: HistoryStore): Promise<void> {
  const recents = (await store.get<WikiProject[]>("recentProjects")) ?? []
  const last = await store.get<WikiProject>("lastProject")
  const paths = [...new Set([...recents.map(p => p.path), ...(last ? [last.path] : [])])]
  if (!paths.length) return
  let probes: ProjectProbe[]
  try { probes = await invoke<ProjectProbe[]>("probe_project_history_paths", { paths }) }
  catch { return } // Older runtimes and temporary transport failures must not erase history.
  if (!Array.isArray(probes)) return
  const requested = new Set(paths.map(pathKey))
  const missing = new Set(probes.filter(p => p.status === "missing" && requested.has(pathKey(p.path))).map(p => pathKey(p.path)))
  if (!missing.size) return
  // Read again after I/O: retain projects added while native paths were being probed.
  const current = (await store.get<WikiProject[]>("recentProjects")) ?? []
  const retained = current.filter(p => !missing.has(pathKey(p.path)))
  let changed = false
  if (retained.length !== current.length) { await store.set("recentProjects", retained); changed = true }
  const currentLast = await store.get<WikiProject>("lastProject")
  if (currentLast && missing.has(pathKey(currentLast.path))) { await store.delete("lastProject"); changed = true }
  const registry = await store.get<Record<string, { path: string }>>("projectRegistry")
  if (registry) {
    const entries = Object.entries(registry).filter(([, p]) => !missing.has(pathKey(p.path)))
    if (entries.length !== Object.keys(registry).length) { await store.set("projectRegistry", Object.fromEntries(entries)); changed = true }
  }
  if (changed) await store.save()
}
