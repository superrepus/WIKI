/** Project-local references to read-only source files stored outside the project. */
import { invoke } from "@tauri-apps/api/core"
import { createDirectory, fileExists, getFileModifiedTime, getFileSize, readFile, writeFileAtomic } from "@/commands/fs"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"

export interface ExternalSource {
  path: string
  root?: string
  relativePath?: string
  kind: "file" | "folder" | "scheduled"
  addedAt?: number
  size?: number
  mtime?: number
  hash?: string
  pending?: boolean
}
export interface ExternalSourceRoot {
  path: string
  kind: "folder" | "scheduled"
  logicalRoot: string
}
export interface ExternalSourceRegistry {
  version: 1
  sources: Record<string, ExternalSource>
  roots?: Record<string, ExternalSourceRoot>
  ignoredPaths?: string[]
}
const writes = new Map<string, Promise<unknown>>()
const empty = (): ExternalSourceRegistry => ({ version: 1, sources: {}, roots: {}, ignoredPaths: [] })
export const externalSourcesPath = (projectPath: string) => `${normalizePath(projectPath).replace(/\/+$/, "")}/.llm-wiki/external-sources.json`

/** Preserve display case and UNC prefix; never interpret device paths or traversal. */
export function normalizeExternalPath(path: string): string {
  const normalized = normalizePath(path)
  const value = normalized.startsWith("//") ? `//${normalized.slice(2).replace(/\/+/g, "/")}` : normalized.replace(/\/+/g, "/")
  if (!isAbsolutePath(value) || /\0/.test(value) || /^\/\/[?.]\//.test(value)) throw new Error("External source must be an absolute file path")
  const parts = value.split("/")
  if (parts.some(part => part === "." || part === "..")) throw new Error("External source path cannot contain traversal segments")
  if (value.startsWith("//") && parts.filter(Boolean).length < 2) throw new Error("UNC source requires server and share")
  return /^[A-Za-z]:\/+$/u.test(value) ? `${value.slice(0, 2)}/` : value.replace(/\/+$/, "") || "/"
}
export function externalPathKey(path: string): string {
  const value = normalizeExternalPath(path)
  return /^[A-Za-z]:\//.test(value) || value.startsWith("//") ? value.toLowerCase() : value
}
export function normalizeLogicalSourcePath(projectPath: string, path: string): string {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  let value = normalizePath(path)
  if (isAbsolutePath(value)) {
    const windows = /^[A-Za-z]:\//.test(pp) || pp.startsWith("//")
    const key = windows ? value.toLowerCase() : value
    const prefix = `${windows ? pp.toLowerCase() : pp}/`
    if (!key.startsWith(prefix)) throw new Error("Logical source must belong to this project")
    value = value.slice(pp.length + 1)
  }
  if (!value.startsWith("raw/sources/") || value === "raw/sources/" || value.split("/").some(p => !p || p === "." || p === ".." || /[:\0]/.test(p))) {
    throw new Error("Logical source must be a safe path inside raw/sources")
  }
  return value
}
export const logicalSourcePath = normalizeLogicalSourcePath
const logicalKey = (path: string) => path.toLowerCase()
function checkedSource(entry: ExternalSource): ExternalSource {
  if (!entry || !["file", "folder", "scheduled"].includes(entry.kind)) throw new Error("Invalid external source kind")
  const path = normalizeExternalPath(entry.path)
  const result = { ...entry, path }
  if (entry.root) {
    result.root = normalizeExternalPath(entry.root)
    const key = externalPathKey(path), root = externalPathKey(result.root)
    if (key !== root && !key.startsWith(`${root.replace(/\/+$/, "")}/`)) throw new Error("External source is outside its registered root")
  }
  if (entry.relativePath && (isAbsolutePath(entry.relativePath) || normalizePath(entry.relativePath).split("/").some(p => p === ".." || p === "." || /\0/.test(p)))) throw new Error("Invalid external relative path")
  return result
}
function checkedRegistry(pp: string, registry: ExternalSourceRegistry): ExternalSourceRegistry {
  if (!registry || registry.version !== 1 || !registry.sources || typeof registry.sources !== "object" || Array.isArray(registry.sources)) throw new Error("External source registry is invalid; existing references were not changed")
  const result = empty()
  const logicalNames = new Set<string>()
  for (const [path, source] of Object.entries(registry.sources)) {
    const logical = normalizeLogicalSourcePath(pp, path)
    if (logicalNames.has(logicalKey(logical))) throw new Error("Duplicate logical source in registry")
    logicalNames.add(logicalKey(logical)); result.sources[logical] = checkedSource(source)
  }
  if (registry.roots && (typeof registry.roots !== "object" || Array.isArray(registry.roots))) throw new Error("Invalid external source roots")
  for (const [id, root] of Object.entries(registry.roots ?? {})) {
    if (!id || ["__proto__", "prototype", "constructor"].includes(id)) throw new Error("Invalid external source root id")
    if (!root || !["folder", "scheduled"].includes(root.kind)) throw new Error("Invalid external source root")
    result.roots![id] = { ...root, path: normalizeExternalPath(root.path), logicalRoot: normalizeLogicalSourcePath(pp, root.logicalRoot) }
  }
  if (registry.ignoredPaths && !Array.isArray(registry.ignoredPaths)) throw new Error("Invalid ignored external source paths")
  result.ignoredPaths = (registry.ignoredPaths ?? []).map(normalizeExternalPath)
  return result
}
export async function loadExternalSources(projectPath: string): Promise<ExternalSourceRegistry> {
  const path = externalSourcesPath(projectPath)
  if (!(await fileExists(path))) return empty()
  // Corruption or denied reads must not silently erase source registrations.
  return checkedRegistry(projectPath, JSON.parse(await readFile(path)))
}
async function serialize<T>(pp: string, run: () => Promise<T>): Promise<T> {
  const key = externalPathKey(pp), prior = writes.get(key) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(run)
  writes.set(key, next)
  try { return await next } finally { if (writes.get(key) === next) writes.delete(key) }
}
async function persist(pp: string, registry: ExternalSourceRegistry): Promise<void> {
  const checked = checkedRegistry(pp, registry)
  await createDirectory(`${normalizePath(pp).replace(/\/+$/, "")}/.llm-wiki`)
  await writeFileAtomic(externalSourcesPath(pp), JSON.stringify(checked, null, 2))
}
/** Deliberate full replacement; prefer register/unregister for concurrent updates. */
export async function saveExternalSources(pp: string, registry: ExternalSourceRegistry): Promise<void> {
  await serialize(pp, () => persist(pp, registry))
}
export async function lookupExternalSource(pp: string, logicalPath: string): Promise<ExternalSource | null> {
  const logical = normalizeLogicalSourcePath(pp, logicalPath), registry = await loadExternalSources(pp)
  return Object.entries(registry.sources).find(([key]) => logicalKey(key) === logicalKey(logical))?.[1] ?? null
}
export const resolveExternalSource = lookupExternalSource
export async function registerExternalSources(pp: string, entries: Record<string, ExternalSource>): Promise<Record<string, string>> {
  return serialize(pp, async () => {
    const registry = await loadExternalSources(pp), mapped: Record<string, string> = {}
    for (const [path, raw] of Object.entries(entries)) {
      const logical = normalizeLogicalSourcePath(pp, path), entry = checkedSource(raw)
      const samePhysical = Object.entries(registry.sources).find(([, value]) => externalPathKey(value.path) === externalPathKey(entry.path))
      const sameLogical = Object.entries(registry.sources).find(([key]) => logicalKey(key) === logicalKey(logical))
      if (sameLogical && externalPathKey(sameLogical[1].path) !== externalPathKey(entry.path)) throw new Error(`Logical source already refers to another original file: ${logical}`)
      const actual = samePhysical?.[0] ?? sameLogical?.[0] ?? logical
      registry.sources[actual] = { ...registry.sources[actual], ...entry, addedAt: registry.sources[actual]?.addedAt ?? entry.addedAt ?? Date.now() }
      registry.ignoredPaths = registry.ignoredPaths?.filter(path => externalPathKey(path) !== externalPathKey(entry.path))
      mapped[path] = actual
    }
    await persist(pp, registry)
    return mapped
  })
}
export async function registerExternalSource(pp: string, logicalPath: string, entry: ExternalSource): Promise<string> {
  return (await registerExternalSources(pp, { [logicalPath]: entry }))[logicalPath]
}
export async function unregisterExternalSources(pp: string, paths: readonly string[]): Promise<void> {
  const keys = new Set(paths.map(path => logicalKey(normalizeLogicalSourcePath(pp, path))))
  await serialize(pp, async () => {
    const registry = await loadExternalSources(pp)
    registry.sources = Object.fromEntries(Object.entries(registry.sources).filter(([key]) => !keys.has(logicalKey(key))))
    await persist(pp, registry)
  })
}
export async function unregisterExternalSource(pp: string, path: string): Promise<void> { await unregisterExternalSources(pp, [path]) }
/** User removal detaches the reference without deleting the original or rediscovering it on the next folder scan. */
export async function ignoreExternalSource(pp: string, logicalPath: string): Promise<void> {
  const logical = logicalKey(normalizeLogicalSourcePath(pp, logicalPath))
  await serialize(pp, async () => {
    const registry = await loadExternalSources(pp)
    const match = Object.entries(registry.sources).find(([key]) => logicalKey(key) === logical)
    if (!match) return
    const [key, entry] = match
    const ignored = new Map((registry.ignoredPaths ?? []).map(path => [externalPathKey(path), path]))
    ignored.set(externalPathKey(entry.path), entry.path)
    registry.ignoredPaths = [...ignored.values()]
    delete registry.sources[key]
    await persist(pp, registry)
  })
}
export async function registerExternalRoot(pp: string, id: string, root: ExternalSourceRoot): Promise<string> {
  if (!id || ["__proto__", "prototype", "constructor"].includes(id)) throw new Error("Invalid external source root id")
  await serialize(pp, async () => {
    const registry = await loadExternalSources(pp)
    registry.roots ??= {}; registry.roots[id] = root
    await persist(pp, registry)
  })
  return id
}
export async function removeExternalRoot(pp: string, id: string): Promise<void> {
  await serialize(pp, async () => {
    const registry = await loadExternalSources(pp)
    delete registry.roots?.[id]
    await persist(pp, registry)
  })
}
export const unregisterExternalRoot = removeExternalRoot

export type ExternalSourceProbe =
  | { status: "present"; entry: ExternalSource; size: number; mtime: number }
  | { status: "missing"; entry: ExternalSource }
  | { status: "unavailable"; entry: ExternalSource; error: string }
  | { status: "unregistered" }
/** A vanished/disconnected share is unavailable, never proof every source was deleted. */
export async function probeExternalSource(pp: string, logicalPath: string): Promise<ExternalSourceProbe> {
  const entry = await lookupExternalSource(pp, logicalPath)
  if (!entry) return { status: "unregistered" }
  try {
    const status = await invoke<string>("probe_external_path", { path: entry.path })
    if (status === "missing") return { status: "missing", entry }
    if (status !== "present") return { status: "unavailable", entry, error: "Original source location is unavailable" }
    const size = await getFileSize(entry.path), mtime = await getFileModifiedTime(entry.path)
    return { status: "present", entry, size, mtime }
  } catch (error) {
    return { status: "unavailable", entry, error: String(error) }
  }
}
