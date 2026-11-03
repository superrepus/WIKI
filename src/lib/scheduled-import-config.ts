import type { ScheduledImportConfig, ScheduledImportDirectory } from "@/stores/wiki-store"
import { isAbsolutePath, normalizePath } from "./path-utils"

function normalizedDirectoryPath(value: string): string {
  const path = normalizePath(value.trim())
  return path === "/" || /^[A-Za-z]:\/$/.test(path) ? path : path.replace(/\/+$/, "")
}

export function scheduledDirectoryPathKey(path: string): string {
  const value = normalizedDirectoryPath(path)
  return /^[A-Za-z]:\//.test(value) || value.startsWith("//") ? value.toLowerCase() : value
}

function directoryId(path: string): string {
  let hash = 2166136261
  const key = scheduledDirectoryPathKey(path)
  for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return `monitor-${(hash >>> 0).toString(36)}-${key.length}`
}
const interval = (value: unknown, fallback = 60) => typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(1440, Math.floor(value))) : fallback
const timestamp = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

export function createScheduledImportDirectory(path: string, overrides: Partial<ScheduledImportDirectory> = {}): ScheduledImportDirectory {
  const normalized = normalizedDirectoryPath(path)
  return {
    id: overrides.id?.trim() || directoryId(normalized), path: normalized,
    enabled: overrides.enabled ?? true, interval: interval(overrides.interval, 1), lastScan: timestamp(overrides.lastScan),
  }
}

/** Old scalar settings migrate once; an explicitly empty list never restores a removed monitor. */
export function normalizeScheduledImportConfig(value?: Partial<ScheduledImportConfig> | null, projectPath?: string): ScheduledImportConfig {
  const raw = value ?? {}
  const source: Partial<ScheduledImportDirectory>[] = Array.isArray(raw.directories)
    ? raw.directories
    : typeof raw.path === "string" && raw.path.trim()
      ? [{ path: raw.path, enabled: raw.enabled === true, interval: raw.interval, lastScan: raw.lastScan }]
      : []
  const directories: ScheduledImportDirectory[] = []
  const paths = new Map<string, ScheduledImportDirectory>()
  const ids = new Set<string>()
  source.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return
    let path = typeof entry.path === "string" ? normalizedDirectoryPath(entry.path) : ""
    if (path && projectPath && !isAbsolutePath(path)) path = `${normalizedDirectoryPath(projectPath).replace(/\/+$/, "")}/${path}`
    const item = createScheduledImportDirectory(path, { ...entry, enabled: entry.enabled === true, interval: interval(entry.interval), id: typeof entry.id === "string" ? entry.id : undefined })
    const key = scheduledDirectoryPathKey(item.path)
    const existing = key ? paths.get(key) : undefined
    if (existing) {
      existing.enabled ||= item.enabled
      existing.interval = Math.min(existing.interval, item.interval)
      existing.lastScan = Math.max(existing.lastScan ?? 0, item.lastScan ?? 0) || null
      return
    }
    if (ids.has(item.id)) item.id = `${directoryId(item.path)}-${index}`
    ids.add(item.id)
    if (key) paths.set(key, item)
    directories.push(item)
  })
  const first = directories[0]
  return {
    enabled: directories.some(row => row.enabled), path: first?.path ?? "",
    interval: first?.interval ?? interval(raw.interval), lastScan: first?.lastScan ?? null, directories,
  }
}

export function validateScheduledImportDirectories(directories: readonly ScheduledImportDirectory[], projectPath?: string): string[] {
  const errors: string[] = [], seen = new Set<string>()
  const project = projectPath ? scheduledDirectoryPathKey(projectPath) : ""
  const inside = (path: string, parent: string) => path === parent || path.startsWith(`${parent.replace(/\/+$/, "")}/`)
  directories.forEach((entry, index) => {
    const label = `监控目录 ${index + 1}`
    const path = normalizedDirectoryPath(entry.path)
    if (!path) { errors.push(`${label}：请选择原始文件夹。`); return }
    if (!isAbsolutePath(path) || /^\/\/[?.]\//.test(path) || path.startsWith("//") && path.split("/").filter(Boolean).length < 2 || /\0/.test(path) || path.split("/").some(p => p === "." || p === "..")) errors.push(`${label}：请使用有效的绝对路径或 UNC 共享路径。`)
    const key = scheduledDirectoryPathKey(path)
    if (seen.has(key)) errors.push(`${label}：这个目录已经添加。`)
    seen.add(key)
    if (project && (inside(key, project) || inside(project, key))) errors.push(`${label}：原始资料目录不能与当前知识库目录相同或互相包含。`)
    if (!Number.isInteger(entry.interval) || entry.interval < 1 || entry.interval > 1440) errors.push(`${label}：扫描周期必须为 1～1440 分钟。`)
  })
  return errors
}
