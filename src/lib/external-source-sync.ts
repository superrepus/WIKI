import { archiveLegacySource, getFileMd5, getFileModifiedTime, getFileSize, listDirectory } from "@/commands/fs"
import type { WikiProject, FileNode } from "@/types/wiki"
import { loadExternalSources, registerExternalSource, unregisterExternalSource, probeExternalSource, externalPathKey } from "./external-sources"
import { externalSourceLogicalPath } from "./external-source-paths"
import { manualRootForPath } from "./source-monitor-ownership"
import { loadSourceWatchConfig } from "./project-store"
import { normalizeSourceWatchConfig, isPathAllowedBySourceWatch } from "./source-watch-config"
import { isSensitiveConfigSourceFile } from "./source-filter"
import { normalizePath } from "./path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { enqueueInactiveProjectBatch, discardTasksForSources } from "./ingest-queue"
import { deleteSourceFile, enqueueSourceIngest, folderContextForSourcePath, isIngestableSourcePath } from "./source-lifecycle"
import { refreshProjectFileTree } from "./project-file-tree-refresh"

const runs = new Map<string, Promise<void>>()
export async function waitForExternalSourceScans(): Promise<void> { await Promise.allSettled([...runs.values()]) }
const flatten = (nodes: FileNode[]): FileNode[] => nodes.flatMap(n => n.is_dir ? flatten(n.children ?? []) : [n])

/** A failed share/permission probe never becomes a deletion event. */
export function scanRegisteredExternalSources(project: WikiProject): Promise<void> {
  const active = runs.get(project.id)
  if (active) return active
  const run = scan(project).finally(() => runs.delete(project.id))
  runs.set(project.id, run)
  return run
}

async function scan(project: WikiProject): Promise<void> {
  const pp = normalizePath(project.path).replace(/\/+$/, "")
  let registry = await loadExternalSources(pp)
  if (!Object.keys(registry.sources).length && !Object.keys(registry.roots ?? {}).length) return
  const current = useWikiStore.getState().project?.id === project.id
  const cfg = normalizeSourceWatchConfig(current ? useWikiStore.getState().sourceWatchConfig : await loadSourceWatchConfig(project.id))
  const changed = new Set<string>()
  // Recover manual ownership from registered roots even if an older extra monitor had replaced entry.kind.
  for(const [logical,entry] of Object.entries(registry.sources)){
    const root=manualRootForPath(registry,entry.path)
    if(root && entry.kind==="scheduled") await registerExternalSource(pp,logical,{...entry,kind:"folder",root:root.path,relativePath:normalizePath(entry.path).slice(normalizePath(root.path).replace(/\/+$/, "").length+1)})
  }
  registry=await loadExternalSources(pp)
  const ignored = new Set((registry.ignoredPaths ?? []).map(externalPathKey))
  for (const root of Object.values(registry.roots ?? {})) {
    if (root.kind !== "folder") continue // scheduled roots follow their saved monitor configuration
    let files: FileNode[]
    try { files = flatten(await listDirectory(root.path, true)) }
    catch { continue }
    for (const file of files) {
      if (ignored.has(externalPathKey(file.path)) || isSensitiveConfigSourceFile(file.path) || !isIngestableSourcePath(file.path)) continue
      const relative = normalizePath(file.path).slice(normalizePath(root.path).replace(/\/+$/, "").length + 1)
      if (!isPathAllowedBySourceWatch(`raw/sources/${relative}`, cfg)) continue
      if (Object.values(registry.sources).some(e => externalPathKey(e.path) === externalPathKey(file.path))) continue
      try {
        const size = await getFileSize(file.path)
        if (size > cfg.maxFileSizeMb * 1024 * 1024) continue
        const logical = await registerExternalSource(pp, externalSourceLogicalPath(pp, file.path, root.path), {
          path: file.path, root: root.path, relativePath: relative, kind: "folder", size,
          mtime: await getFileModifiedTime(file.path), hash: await getFileMd5(file.path), pending: true,
        })
        changed.add(`${pp}/${logical}`)
      } catch (error) { console.warn("[external-sources] discovery deferred", file.path, error) }
    }
  }
  registry = await loadExternalSources(pp)
  for (const [logical, source] of Object.entries(registry.sources)) {
    if (source.kind === "scheduled") continue
    const path = `${pp}/${logical}`
    const state = await probeExternalSource(pp, logical)
    if (state.status === "unavailable" || state.status === "unregistered") continue
    if (state.status === "missing") {
      // Inactive projects retain the record until they can run the full retraction transaction.
      if (!current) continue
      await discardTasksForSources([path])
      await deleteSourceFile(pp, path, { fileAlreadyDeleted: true, logReason: "external original removed" })
      await archiveLegacySource(pp,path)
      await unregisterExternalSource(pp, logical)
      changed.delete(path)
      await refreshProjectFileTree(pp, { projectId: project.id, bumpDataVersion: true })
      continue
    }
    try {
      const size = await getFileSize(source.path), mtime = await getFileModifiedTime(source.path)
      if (size > cfg.maxFileSizeMb * 1024 * 1024) continue
      if (size === source.size && mtime === source.mtime && !source.pending) continue
      const hash = await getFileMd5(source.path)
      if (source.hash && hash !== source.hash) {
        if (!current) continue // never publish mixed old/new evidence for an inactive project
        await discardTasksForSources([path])
        await deleteSourceFile(pp, path, { fileAlreadyDeleted: true, logReason: "external original modified" })
      }
      const needsIngest = source.pending || !source.hash || hash !== source.hash
      await registerExternalSource(pp, logical, { ...source, size, mtime, hash, pending: needsIngest })
      if (needsIngest) changed.add(path)
    } catch (error) { console.warn("[external-sources] source refresh deferred", source.path, error) }
  }
  if (!changed.size) return
  const paths = [...changed]
  const ids = current
    ? await enqueueSourceIngest(project, paths, useWikiStore.getState().llmConfig)
    : await enqueueInactiveProjectBatch(project.id, pp, paths.map(sourcePath => ({ sourcePath, folderContext: folderContextForSourcePath(sourcePath) })))
  if (ids.length) {
    const latest = await loadExternalSources(pp)
    for (const path of paths) {
      const logical = path.slice(pp.length + 1), source = latest.sources[logical]
      if (source) await registerExternalSource(pp, logical, { ...source, pending: false })
    }
  }
  if (current) await refreshProjectFileTree(pp, { projectId: project.id, bumpDataVersion: true })
}
