import { invoke } from "@tauri-apps/api/core"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useUpdateStore } from "@/stores/update-store"
import { hasUnsavedUpdateSettings, flushUpdateSaveBarriers } from "./update-save-barrier"
import { suspendAutoSaveForUpdate, resumeAutoSave } from "./auto-save"
import * as ingest from "./ingest-queue"
import * as dedup from "./dedup-queue"
import { stopScheduledImport, startScheduledImport, waitForScheduledImports } from "./scheduled-import"
import { waitForExternalSourceScans } from "./external-source-sync"
import { stopProjectFileSync, stopAllProjectFileSync, startProjectFileSync, startAllProjectFileSync, waitForProjectFileSync } from "./project-file-sync"

type FailureCode = "settings" | "busy" | "download" | "save" | "restart" | "recovered"
class UpdateFailure extends Error { constructor(readonly code: FailureCode) { super(code) } }
let installing: Promise<void> | null = null

export function isUpdateQuiescing(): boolean {
  return ["saving", "restarting"].includes(useUpdateStore.getState().installStage)
}

function assertNotBusy(): void {
  if (hasUnsavedUpdateSettings()) throw new UpdateFailure("settings")
  // Duplicate merges and chat may rewrite multiple files outside the ingest commit coordinator.
  if (useChatStore.getState().isStreaming || dedup.getQueueSummary().processing > 0) throw new UpdateFailure("busy")
}

/** Download first; only the second native command may commit an installation. */
export function installAvailableUpdate(version: string): Promise<void> {
  if (installing) return installing
  const run = (async () => {
    const state = useUpdateStore.getState()
    let code: FailureCode = "download"
    let stopped = false, pausedQueue = false
    let project = useWikiStore.getState().project
    let wasPaused = ingest.isQueuePaused()
    try {
      assertNotBusy()
      state.setInstall("preparing")
      const ready = await invoke<{ status: string; version: string; receipt: string }>("install_github_update", { version })
      if (ready.status !== "ready" || !ready.receipt) throw new UpdateFailure("download")
      assertNotBusy()
      project = useWikiStore.getState().project
      wasPaused = ingest.isQueuePaused()
      state.setInstall("saving")
      code = "save"
      stopScheduledImport(); stopAllProjectFileSync()
      stopped = true
      await stopProjectFileSync()
      await Promise.all([waitForScheduledImports(), waitForExternalSourceScans(), waitForProjectFileSync()])
      assertNotBusy()
      await flushUpdateSaveBarriers()
      await ingest.pauseQueue({ verifyPersisted: true })
      pausedQueue = true
      await suspendAutoSaveForUpdate()
      if (useWikiStore.getState().project?.id !== project?.id) throw new UpdateFailure("busy")
      state.setInstall("restarting")
      code = "restart"
      await invoke("quit_for_update", { receipt: ready.receipt })
    } catch (error) {
      // A failed save or helper launch leaves the old application fully usable.
      resumeAutoSave()
      if (project && stopped && useWikiStore.getState().project?.id === project.id) {
        if (pausedQueue) await ingest.restoreQueue(project.id, project.path, { startPaused: wasPaused }).catch(() => {})
        else if (!wasPaused) ingest.resumeProcessing()
        const config = useWikiStore.getState()
        startScheduledImport(project, config.scheduledImportConfig)
        if (config.sourceWatchConfig.enabled) await startProjectFileSync(project, config.sourceWatchConfig).catch(() => {})
        if (config.sourceWatchAllProjects) startAllProjectFileSync(project)
      }
      state.setInstall("error", error instanceof UpdateFailure ? error.code : code)
    }
  })()
  installing = run.finally(() => { installing = null })
  return installing
}

export async function loadLastUpdateOutcome(): Promise<void> {
  try {
    const outcome = await invoke<{ status?: string } | null>("get_github_update_status")
    if (outcome && ["failed", "rolled-back"].includes(outcome.status ?? "")) useUpdateStore.getState().setInstall("error", "recovered")
  } catch { /* Older installations may not have an updater outcome yet. */ }
}
