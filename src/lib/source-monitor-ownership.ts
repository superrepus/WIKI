import type { ExternalSourceRegistry, ExternalSourceRoot } from "./external-sources"
import { normalizePath } from "./path-utils"

export function monitorPathKey(path: string): string {
  const value = normalizePath(path).replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(value) || value.startsWith("//") ? value.toLowerCase() : value
}
export function monitorContains(root: string, path: string): boolean {
  const parent = monitorPathKey(root), child = monitorPathKey(path)
  return child === parent || child.startsWith(`${parent}/`)
}
/** A manual folder always owns its descendants, irrespective of extra-monitor switches. */
export function manualRootForPath(registry: ExternalSourceRegistry, path: string): ExternalSourceRoot | undefined {
  return Object.values(registry.roots ?? {}).filter(root => root.kind === "folder" && monitorContains(root.path, path))
    .sort((a,b) => b.path.length-a.path.length)[0]
}
