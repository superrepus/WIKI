import {
  fileExists,
  archiveLegacySource,
  getFileMd5,
  getFileModifiedTime,
  getFileSize,
  listDirectory,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import type { FileNode, WikiProject } from "@/types/wiki"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import type { ScheduledImportConfig, SourceWatchConfig } from "@/stores/wiki-store"
import {
  loadScheduledImportConfig,
  loadSourceWatchConfig,
  recordScheduledDirectoryScan,
  getRecentProjects,
} from "@/lib/project-store"
import {
  isPathAllowedBySourceWatch,
  normalizeSourceWatchConfig,
} from "@/lib/source-watch-config"
import {
  deleteSourceFile,
  enqueueSourceIngest,
  folderContextForSourcePath,
  isIngestableSourcePath,
} from "@/lib/source-lifecycle"
import { discardTasksForSources, enqueueInactiveProjectBatch } from "@/lib/ingest-queue"
import { useActivityStore } from "@/stores/activity-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { loadSourceReconciliation } from "@/lib/source-reconciliation"
import { loadExternalSources, registerExternalSource, unregisterExternalSource, probeExternalSource, externalPathKey } from "@/lib/external-sources"
import { externalSourceLogicalPath } from "@/lib/external-source-paths"
import { normalizeScheduledImportConfig } from "@/lib/scheduled-import-config"
import { manualRootForPath, monitorContains } from "@/lib/source-monitor-ownership"

interface ImportStat {
  size: number
  mtime: number
}

interface ImportDb {
  files: Record<string, string>
  /**
   * Size + mtime (ms) per source path. Lets a scan reuse the recorded content
   * hash for files that did not change instead of re-reading and re-hashing
   * every file on every run. Optional and additive: databases written by
   * older builds simply lack it and fall back to hashing once.
   */
  destinations?: Record<string, string>
  statCache?: Record<string, ImportStat>
  lastScan: number | null
}

interface ImportDbStore {
  version: 1
  /**
   * Each additional directory has an independent observation snapshot.
   * Saving one root must retain every other root, including disabled roots.
   */
  directories: Record<string, ImportDb>
}

type ScanOptions = {
  runId?: number
  allowInactive?: boolean
  sourceWatchConfig?: SourceWatchConfig
}

const EMPTY_DB: ImportDb = {
  files: {},
  statCache: {},
  destinations: {},
  lastScan: null,
}

let scanTimer: ReturnType<typeof setInterval> | null = null
let scanTail: Promise<void> = Promise.resolve()
const queuedScans = new Map<string, Promise<void>>()
let activeRunId = 0
const managedPathWarningKeys = new Set<string>()

const DB_PATH = ".llm-wiki/scheduled-import-db.json"
const LEGACY_DB_DIR = ".llm-wiki-imported"
const SCHEDULED_IMPORT_DIR = "scheduled-import"
const MAX_SCHEDULED_IMPORT_BYTES = 100 * 1024 * 1024
const SCHEDULED_IMPORT_CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "xml"])
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

function emptyStore(): ImportDbStore {
  return { version: 1, directories: {} }
}

function dbFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${DB_PATH}`
}

function dbDirectoryKey(importPath: string): string {
  return caseFoldPath(normalizePath(importPath))
}

// Windows drive-letter and UNC paths are case-insensitive; fold them for
// comparison purposes only (never for the paths actually written to disk).
function caseFoldPath(normalized: string): string {
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized
}

function cloneDb(db: ImportDb): ImportDb {
  return {
    files: { ...db.files },
    statCache: { ...(db.statCache ?? {}) },
    destinations: { ...(db.destinations ?? {}) },
    lastScan: db.lastScan,
  }
}

function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = dbDirectoryKey(path)
  const normalizedParent = dbDirectoryKey(parent).replace(/\/+$/, "")
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  )
}

function projectSubpath(projectPath: string, relPath: string): string {
  return `${normalizePath(projectPath)}/${relPath}`
}

export function isProjectManagedScheduledImportPath(
  projectPath: string,
  importPath: string,
): boolean {
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  const root = normalizePath(importPath).replace(/\/+$/, "")
  return (
    root === project ||
    isPathInside(project, root) ||
    isPathInside(root, projectSubpath(project, "raw")) ||
    isPathInside(root, projectSubpath(project, "raw/sources")) ||
    isPathInside(root, projectSubpath(project, "wiki")) ||
    isPathInside(root, projectSubpath(project, ".llm-wiki"))
  )
}

function notifyManagedScheduledImportPath(project: WikiProject, importRoot: string): void {
  const key = `${project.id}:${normalizePath(importRoot)}`
  if (managedPathWarningKeys.has(key)) return
  managedPathWarningKeys.add(key)
  useActivityStore.getState().addItem({
    type: "ingest",
    title: "Scheduled import skipped",
    status: "error",
    detail: `Scheduled import path is inside or contains the current LLM Wiki project: ${importRoot}. Choose an external folder; project sources are handled by source folder monitoring.`,
    filesWritten: [],
  })
}

function stableSuffix(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

function sanitizePathSegment(segment: string): string {
  let value = segment
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()

  if (!value) {
    value = "_"
  }

  const stem = value.split(".")[0]?.toLowerCase() ?? value.toLowerCase()
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    value = `_${value}`
  }

  return value
}

function appendSuffixToFileName(fileName: string, suffix: string): string {
  const dot = fileName.lastIndexOf(".")
  if (dot > 0) {
    return `${fileName.slice(0, dot)}-${suffix}${fileName.slice(dot)}`
  }
  return `${fileName}-${suffix}`
}

function safeRelativePath(path: string): string {
  const normalized = normalizePath(path)
  const parts = normalized
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
  const safeParts = parts.map(sanitizePathSegment)

  if (safeParts.length === 0) {
    return "_"
  }

  const safePath = safeParts.join("/")
  if (safePath !== parts.join("/")) {
    const last = safeParts[safeParts.length - 1]
    safeParts[safeParts.length - 1] = appendSuffixToFileName(last, stableSuffix(normalized))
  }
  return safeParts.join("/")
}

export function isScheduledImportInternalPath(path: string): boolean {
  const parts = normalizePath(path).split("/")
  return parts.includes(LEGACY_DB_DIR) || parts.includes(".llm-wiki")
}

export function shouldSkipScheduledImportFile(
  projectPath: string,
  filePath: string,
): boolean {
  const path = normalizePath(filePath)
  const project = normalizePath(projectPath)

  if (isScheduledImportInternalPath(path)) {
    return true
  }

  if (isPathInside(path, projectSubpath(project, "wiki"))) {
    return true
  }

  if (isPathInside(path, projectSubpath(project, "raw/sources/.cache"))) {
    return true
  }

  const name = path.split("/").pop() ?? ""
  return name.startsWith(".")
}

export function shouldSkipScheduledImportConfigFile(path: string): boolean {
  const name = normalizePath(path).split("/").pop() ?? ""
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""
  return Boolean(ext && SCHEDULED_IMPORT_CONFIG_EXTENSIONS.has(ext))
}

export function resolveImportPath(projectPath: string, configPath: string): string {
  const path = normalizePath(configPath || "raw/sources")
  if (isAbsolutePath(path)) {
    return path
  }
  return `${normalizePath(projectPath)}/${path}`
}

export function scheduledImportDestinationForFile(
  projectPath: string,
  importPath: string,
  file: Pick<FileNode, "path" | "name">,
): string {
  const project = normalizePath(projectPath)
  const source = normalizePath(file.path)
  const sourcesRoot = projectSubpath(project, "raw/sources")

  if (isPathInside(source, sourcesRoot)) {
    return source
  }

  const importRoot = normalizePath(importPath).replace(/\/+$/, "")
  const sourceKey = caseFoldPath(source)
  const importRootKey = caseFoldPath(importRoot)
  const relative =
    sourceKey === importRootKey || !sourceKey.startsWith(`${importRootKey}/`)
      ? file.name
      : source.slice(importRoot.length + 1)

  return `${sourcesRoot}/${SCHEDULED_IMPORT_DIR}/${safeRelativePath(relative)}`
}

function collectFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (!node.is_dir) {
      files.push(node)
    } else if (node.children) {
      files.push(...collectFiles(node.children))
    }
  }
  return files
}

function scheduledImportDestinationForSourceKey(
  projectPath: string,
  importPath: string,
  sourceKey: string,
): string {
  const name = normalizePath(sourceKey).split("/").pop() ?? "_"
  return scheduledImportDestinationForFile(projectPath, importPath, {
    name,
    path: sourceKey,
  })
}

async function cleanupRemovedScheduledImports(
  project: WikiProject, importRoot: string, db: ImportDb,
  observedEligibleKeys: ReadonlySet<string>, nextDb: ImportDb,
): Promise<boolean> {
  const removed=Object.keys(db.files).filter(key=>!observedEligibleKeys.has(key)&&!(key in nextDb.files))
  if(!removed.length)return false
  const pp=normalizePath(project.path)
  const registry=await loadExternalSources(pp)
  const config=normalizeScheduledImportConfig(await loadScheduledImportConfig(pp),pp)
  const cfg=normalizeSourceWatchConfig(useWikiStore.getState().sourceWatchConfig)
  let changed=false
  for(const key of removed){
    const found=Object.entries(registry.sources).find(([,entry])=>externalPathKey(entry.path)===externalPathKey(key))
    const destination=db.destinations?.[key] ?? (found ? `${pp}/${found[0]}` : scheduledImportDestinationForSourceKey(pp,importRoot,key))
    const keep=()=>{nextDb.files[key]=db.files[key];(nextDb.destinations??={})[key]=destination}
    try {
      if(!monitorContains(`${pp}/raw/sources`,destination) || normalizePath(destination).split("/").some(p=>p===".."))throw new Error("Unsafe scheduled source identity")
      // An extra monitor is never allowed to detach or cancel an always-on manual source.
      if(found && (found[1].kind!=="scheduled" || manualRootForPath(registry,found[1].path)))continue
      if(found){
        const probe=await probeExternalSource(pp,destination)
        if(probe.status==="unavailable"){keep();continue}
        const otherOwner=(config.directories??[]).some(row=>row.enabled && dbDirectoryKey(row.path)!==dbDirectoryKey(importRoot) && monitorContains(resolveImportPath(pp,row.path),key))
        if(probe.status==="present" && otherOwner && isPathAllowedBySourceWatch(key,cfg) && isIngestableSourcePath(key)){keep();continue}
      }
      const exists=await fileExists(destination)
      if(!found && !exists){
        const reconciliation=await loadSourceReconciliation(pp)
        const identity=normalizePath(destination).slice(`${pp}/raw/sources/`.length)
        if(reconciliation && !(identity in reconciliation.sources))continue
      }
      // Unavailable or still-owned sources must not even have their queued work cancelled.
      await discardTasksForSources([destination])
      await deleteSourceFile(pp,destination,{fileAlreadyDeleted:!exists,logReason:"scheduled import source removed or excluded"})
      await archiveLegacySource(pp,destination)
      await unregisterExternalSource(pp,destination)
      changed=true
    }catch(err){keep();console.warn(`[scheduled-import] source cleanup deferred ${destination}:`,err)}
  }
  return changed
}

async function loadDbStore(projectPath: string): Promise<ImportDbStore> {
  const path = dbFilePath(projectPath)
  try {
    if (!(await fileExists(path))) {
      return emptyStore()
    }
    const content = await readFile(path)
    const parsed = JSON.parse(content) as Partial<ImportDbStore>
    if (!parsed.directories || typeof parsed.directories !== "object") {
      return emptyStore()
    }
    return {
      version: 1,
      directories: parsed.directories as Record<string, ImportDb>,
    }
  } catch (err) {
    console.warn("Failed to load scheduled import database:", err)
    return emptyStore()
  }
}

async function loadImportDb(
  projectPath: string,
  importPath: string,
): Promise<ImportDb> {
  const store = await loadDbStore(projectPath)
  const directoryKey = dbDirectoryKey(importPath)
  const db = store.directories[directoryKey] ??
    Object.entries(store.directories).find(
      ([storedKey]) => dbDirectoryKey(storedKey) === directoryKey,
    )?.[1]
  if (!db) return cloneDb(EMPTY_DB)

  // Older builds persisted Windows directory and file keys with their
  // observed casing. Normalize both levels while loading so upgrading does
  // not make the first scan treat every unchanged file as new.
  return {
    files: Object.fromEntries(
      Object.entries(db.files).map(([path, md5]) => [dbDirectoryKey(path), md5]),
    ),
    statCache: Object.fromEntries(
      Object.entries(db.statCache ?? {}).map(([path, stat]) => [dbDirectoryKey(path), stat]),
    ),
    destinations: Object.fromEntries(Object.entries(db.destinations ?? {}).map(([path, dest]) => [dbDirectoryKey(path), dest])),
    lastScan: db.lastScan,
  }
}

async function saveImportDb(
  projectPath: string,
  importPath: string,
  db: ImportDb,
): Promise<void> {
  const store = await loadDbStore(projectPath)
  const key = dbDirectoryKey(importPath)
  for (const existing of Object.keys(store.directories)) if (dbDirectoryKey(existing) === key) delete store.directories[existing]
  store.directories[key] = cloneDb(db)
  await writeFileAtomic(dbFilePath(projectPath), JSON.stringify(store, null, 2))
}

function isCurrentProject(projectId: string): boolean {
  return useWikiStore.getState().project?.id === projectId
}

function isCurrentRun(
  projectId: string,
  runId?: number,
  allowInactive = false,
): boolean {
  return (allowInactive || isCurrentProject(projectId)) &&
    (runId === undefined || runId === activeRunId)
}

export function isScheduledImportDue(
  config: ScheduledImportConfig,
  now = Date.now(),
): boolean {
  if (!config.enabled || !config.path || config.interval <= 0) return false
  if (!config.lastScan) return true
  const intervalMs = Math.max(1, Math.min(1440, config.interval)) * 60 * 1000
  return now - config.lastScan >= intervalMs
}

export function scanAndImport(project:WikiProject,importPath:string,options:ScanOptions={}):Promise<void>{
  if(!importPath)return Promise.resolve()
  const key=`${project.id}:${dbDirectoryKey(resolveImportPath(project.path,importPath))}`
  const existing=queuedScans.get(key)
  if(existing)return existing
  const run=scanTail.catch(()=>{}).then(()=>scanAndImportImpl(project,importPath,options))
  scanTail=run.catch(()=>{})
  const tracked=run.finally(()=>{if(queuedScans.get(key)===tracked)queuedScans.delete(key)})
  queuedScans.set(key,tracked)
  return tracked
}

async function scanAndImportImpl(
  project: WikiProject,
  importPath: string,
  options: ScanOptions = {},
): Promise<void> {
  if (!importPath) return

  const projectPath = normalizePath(project.path)
  const importRoot = resolveImportPath(projectPath, importPath)
  if (isProjectManagedScheduledImportPath(projectPath, importRoot)) {
    console.warn(
      `[scheduled-import] skipped self-referential path "${importRoot}". Use source folder monitoring for project sources instead.`,
    )
    if (isCurrentProject(project.id)) {
      notifyManagedScheduledImportPath(project, importRoot)
    }
    return
  }

  try {
    if (!isCurrentRun(project.id, options.runId, options.allowInactive)) {
      return
    }

    const tree = await listDirectory(importRoot)
    const sourceWatchConfig = normalizeSourceWatchConfig(
      options.sourceWatchConfig ??
        (isCurrentProject(project.id)
          ? useWikiStore.getState().sourceWatchConfig
          : await loadSourceWatchConfig(project.id)),
    )
    const maxFileSizeBytes = sourceWatchConfig.maxFileSizeMb * 1024 * 1024
    const db = await loadImportDb(projectPath, importRoot)
    const references = await loadExternalSources(projectPath)
    const ignoredSources = new Set((references.ignoredPaths ?? []).map(externalPathKey))
    const referenceFor = (sourcePath:string) => Object.entries(references.sources).find(([,entry])=>externalPathKey(entry.path)===externalPathKey(sourcePath))
    const destinationFor = (file: Pick<FileNode,"path"|"name">) => {
      const known=referenceFor(file.path), saved=db.destinations?.[dbDirectoryKey(file.path)]
      if(saved && (!monitorContains(`${projectPath}/raw/sources`,saved) || normalizePath(saved).split("/").some(p=>p===".."))) throw new Error("Unsafe scheduled source identity")
      return known ? `${projectPath}/${known[0]}` : saved ?? (db.files[dbDirectoryKey(file.path)]
        ? scheduledImportDestinationForFile(projectPath,importRoot,file)
        : externalSourceLogicalPath(projectPath,file.path,manualRootForPath(references,file.path)?.path ?? importRoot))
    }
    const register = async (sourcePath:string,destPath:string,hash:string,size:number,mtime:number,pending=false) => {
      const known=referenceFor(sourcePath), manual=manualRootForPath(references,sourcePath)
      const entry=known?.[1]
      const logical = await registerExternalSource(projectPath,destPath,{
        ...(entry ?? {}), path:sourcePath,
        root: manual?.path ?? entry?.root ?? importRoot,
        kind: manual ? "folder" : entry?.kind ?? "scheduled", hash,size,mtime,pending,
      })
      return `${projectPath}/${logical}`
    }
    const nextDb: ImportDb = { files: {}, destinations: {}, lastScan: Date.now() }
    const nextStatCache: Record<string, ImportStat> = {}
    const changedFiles: Array<{ key: string; md5: string; destPath: string }> = []
    const observedEligibleKeys = new Set<string>()

    for (const file of collectFiles(tree)) {
      try {
        const sourcePath = normalizePath(file.path)
        if (
          shouldSkipScheduledImportFile(projectPath, sourcePath) ||
          shouldSkipScheduledImportConfigFile(sourcePath) ||
          !isPathAllowedBySourceWatch(sourcePath, sourceWatchConfig) ||
          !isIngestableSourcePath(sourcePath)
        ) {
          continue
        }

        const key = dbDirectoryKey(sourcePath)
        if (ignoredSources.has(externalPathKey(sourcePath))) {
          if (db.files[key]) {
            nextDb.files[key] = db.files[key]
            if (db.destinations?.[key]) nextDb.destinations![key] = db.destinations[key]
          }
          continue
        }

        if (!isCurrentRun(project.id, options.runId, options.allowInactive)) {
          return
        }

        const size = await getFileSize(sourcePath)
        if (size > Math.min(MAX_SCHEDULED_IMPORT_BYTES, maxFileSizeBytes)) {
          const limitMb = Math.min(100, sourceWatchConfig.maxFileSizeMb)
          console.warn(
            `[scheduled-import] skipping ${sourcePath}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds ${limitMb} MB limit`,
          )
          continue
        }

        observedEligibleKeys.add(key)
        let destPath = destinationFor(file)
        nextDb.destinations![key] = destPath

        // Fast path: if size and mtime are unchanged since the last scan,
        // reuse the recorded hash instead of re-reading and re-hashing the
        // file. Files whose stat differs, including imports from older
        // builds that have no cache entry yet, are still verified by content
        // hash below.
        const cachedStat = db.statCache?.[key]
        const mtime = await getFileModifiedTime(sourcePath)
        const known = referenceFor(sourcePath)
        const manual = known && (known[1].kind !== "scheduled" || Boolean(manualRootForPath(references,sourcePath)))
        if (manual) {
          // Manual sources retain their own fingerprints and always-on polling; an extra root cannot take them over.
          nextDb.files[key] = await getFileMd5(sourcePath)
          nextStatCache[key] = { size, mtime }
          continue
        }
        if (cachedStat && db.files[key] && cachedStat.size === size && cachedStat.mtime === mtime && (!known || known[1].hash === db.files[key]) && !known?.[1].pending) {
          await register(sourcePath,destinationFor(file),db.files[key],size,mtime)
          nextDb.files[key] = db.files[key]
          nextStatCache[key] = cachedStat
          continue
        }

        const md5 = await getFileMd5(sourcePath)
        nextStatCache[key] = { size, mtime }

        if ((db.files[key] === md5 || known?.[1].hash === md5) && !known?.[1].pending) {
          await register(sourcePath,destinationFor(file),md5,size,mtime)
          nextDb.files[key] = md5
          continue
        }

        const priorHash = known?.[1].hash ?? db.files[key]
        if (priorHash && priorHash !== md5 && await loadSourceReconciliation(projectPath)) {
          // Keep upstream queue/compiler; retract old evidence before replacing
          // its local source mirror. This never writes to the external share.
          await discardTasksForSources([destPath])
          await deleteSourceFile(projectPath, destPath, {
            fileAlreadyDeleted: true, logReason: "scheduled source modified; retract old version",
          })
        }
        destPath = await register(sourcePath,destPath,md5,size,mtime,true)
        nextDb.destinations![key] = destPath
        changedFiles.push({ key, md5, destPath })
      } catch (err) {
        const key = dbDirectoryKey(file.path)
        if (db.files[key]) {
          nextDb.files[key] = db.files[key]
          if (db.destinations?.[key]) nextDb.destinations![key] = db.destinations[key]
        }
        console.warn(`[scheduled-import] skipped ${file.path}:`, err)
      }
    }

    if (!isCurrentRun(project.id, options.runId, options.allowInactive)) {
      return
    }

    let removedSourcesChanged = false
    if (isCurrentProject(project.id)) {
      removedSourcesChanged = await cleanupRemovedScheduledImports(
        project,
        importRoot,
        db,
        observedEligibleKeys,
        nextDb,
      )
    } else {
      // Defer destructive cleanup until the project is opened. Preserve old
      // records so the first active scan can still identify removals.
      for (const [key, md5] of Object.entries(db.files)) {
        if (!observedEligibleKeys.has(key)) {
          nextDb.files[key] = md5
          if (db.destinations?.[key]) nextDb.destinations![key] = db.destinations[key]
        }
      }
    }

    if (!isCurrentRun(project.id, options.runId, options.allowInactive)) {
      return
    }

    if (changedFiles.length > 0) {
      const destPaths = changedFiles.map((file) => file.destPath)
      if (isCurrentRun(project.id, options.runId, options.allowInactive)) {
        const ids = isCurrentProject(project.id)
          ? await enqueueSourceIngest(
              project,
              destPaths,
              useWikiStore.getState().llmConfig,
            )
          : await enqueueInactiveProjectBatch(
              project.id,
              project.path,
              destPaths.map((sourcePath) => ({
                sourcePath,
                folderContext: folderContextForSourcePath(sourcePath),
              })),
            )
        if (ids.length > 0) {
          for (const file of changedFiles) {
            nextDb.files[file.key] = file.md5
            const entries=await loadExternalSources(projectPath)
            const logical=normalizePath(file.destPath).slice(projectPath.length+1), entry=entries.sources[logical]
            if(entry) await registerExternalSource(projectPath,logical,{...entry,pending:false})
          }
        } else {
          console.warn("[scheduled-import] LLM is not configured; changed files were not marked imported")
        }
      }
    }


    if (
      isCurrentProject(project.id) &&
      (removedSourcesChanged || changedFiles.some((file) => nextDb.files[file.key]))
    ) {
      await refreshProjectFileTree(projectPath, {
        projectId: project.id,
        bumpDataVersion: true,
      })
    }

    nextDb.statCache = nextStatCache

    await saveImportDb(projectPath, importRoot, nextDb)

    const currentConfig = await recordScheduledDirectoryScan(projectPath,importRoot,nextDb.lastScan!)
    if (isCurrentProject(project.id) && currentConfig) useWikiStore.getState().setScheduledImportConfig(currentConfig)

  } catch (err) {
    console.error("Scheduled import scan failed:", err)
  }
}

export function startScheduledImport(
  project: WikiProject,
  config: ScheduledImportConfig,
): void {
  stopScheduledImport()

  const runId = ++activeRunId
  void runScheduledImportSweep(project, config, runId, true).catch((err) => {
    console.error("Scheduled import sweep failed:", err)
  })

  scanTimer = setInterval(() => {
    void runScheduledImportSweep(project, config, runId, false).catch((err) => {
      console.error("Scheduled import sweep failed:", err)
    })
  }, 60 * 1000)
}

async function runScheduledImportSweep(
  activeProject: WikiProject,
  activeConfig: ScheduledImportConfig,
  runId: number,
  forceActive: boolean,
): Promise<void> {
  const recents = await getRecentProjects().catch(()=>[])
  const projects = [activeProject, ...recents.filter((item) => item.id !== activeProject.id)]
  for (const project of projects) {
    if (runId !== activeRunId) return
    try {
      const { scanRegisteredExternalSources } = await import("./external-source-sync")
      await scanRegisteredExternalSources(project)
    } catch (err) { console.warn(`[scheduled-import] manual source check deferred for ${project.path}:`,err) }
    let stored: ScheduledImportConfig | null
    try { stored = project.id===activeProject.id && forceActive ? activeConfig : await loadScheduledImportConfig(project.path) }
    catch(err){console.warn(`[scheduled-import] cannot read additional monitors for ${project.path}:`,err);continue}
    const config=normalizeScheduledImportConfig(stored ?? (project.id===activeProject.id ? activeConfig : null),project.path)
    for (const directory of config.directories ?? []) {
      if(runId!==activeRunId)return
      if(!directory.enabled || !directory.path || directory.interval<=0)continue
      if(!isScheduledImportDue(directory) && !(project.id===activeProject.id && forceActive))continue
      await scanAndImport(project,directory.path,{runId,allowInactive:project.id!==activeProject.id})
    }
  }
}

export function stopScheduledImport(): void {
  activeRunId += 1
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
}

/** Stop the timer first, then wait for already-started source work before exiting. */
export async function waitForScheduledImports(): Promise<void> { await scanTail }
