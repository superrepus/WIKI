import { isAbsolutePath, normalizePath } from "./path-utils"
import { externalPathKey, type ExternalSourceRegistry } from "./external-sources"

/** Empty means no monitor; only legacy relative configuration belongs under the project. */
export function scheduledImportDisplayPath(path: string, projectPath?: string): string {
  if (!path) return ""
  const normalized = normalizePath(path)
  if (isAbsolutePath(normalized) || !projectPath) return normalized
  return `${normalizePath(projectPath).replace(/\/+$/, "")}/${normalized}`
}

export interface ManualSourceOrigin { kind: "folder" | "file"; path: string; count: number }

/** Only chooses where the picker opens; it never creates monitor configuration. */
export function scheduledImportBrowsePath(projectPath: string | undefined, draftPath: string, origins: ManualSourceOrigin[]): string | undefined {
  const path = normalizePath(draftPath)
  const project = normalizePath(projectPath ?? "").replace(/\/+$/, "").toLowerCase()
  const key = path.toLowerCase().replace(/\/+$/, "")
  if (isAbsolutePath(path) && (!project || (key !== project && !key.startsWith(`${project}/`)))) return path
  const first = origins[0]
  if (!first) return undefined
  const original = normalizePath(first.path)
  if (first.kind === "folder") return original
  const index = original.lastIndexOf("/")
  return index === 0 ? "/" : index === 2 && /^[A-Za-z]:/.test(original) ? original.slice(0, 3) : original.slice(0, index) || undefined
}

/** Display original locations, never the virtual raw/sources identity as an origin. */
export function manualSourceOrigins(registry: ExternalSourceRegistry): ManualSourceOrigin[] {
  const folders = new Map<string, ManualSourceOrigin>()
  for (const root of Object.values(registry.roots ?? {})) {
    if (root.kind === "folder") folders.set(externalPathKey(root.path), { kind: "folder", path: root.path, count: 0 })
  }
  // Old sources may have been last touched by an extra-directory scan. Their
  // physical membership in a manual root still makes them always-monitored.
  for (const source of Object.values(registry.sources)) {
    if (source.kind === "folder" && source.root) {
      const key = externalPathKey(source.root)
      if (!folders.has(key)) folders.set(key, { kind: "folder", path: source.root, count: 0 })
    }
  }
  const files = new Map<string, ManualSourceOrigin>()
  for (const source of Object.values(registry.sources)) {
    const physical = externalPathKey(source.path)
    const containing = [...folders.entries()].filter(([root]) => physical === root || physical.startsWith(`${root}/`))
    for (const [, folder] of containing) folder.count++
    if (!containing.length && source.kind === "file") files.set(physical, { kind: "file", path: source.path, count: 1 })
  }
  return [...folders.values(), ...files.values()].sort((a,b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "folder" ? -1 : 1)
}
