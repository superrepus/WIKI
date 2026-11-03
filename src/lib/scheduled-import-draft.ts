import type { ScheduledImportConfig, ScheduledImportDirectory } from "@/stores/wiki-store"
import type { SettingsDraft } from "@/components/settings/settings-types"
import { createScheduledImportDirectory, normalizeScheduledImportConfig, scheduledDirectoryPathKey, validateScheduledImportDirectories } from "./scheduled-import-config"

/** Path edits keep row identity, so adding an old path must also check existing IDs. */
export function appendScheduledImportDraftDirectories(current: readonly ScheduledImportDirectory[], paths: readonly string[]) {
  const keys = new Set(current.map(row => scheduledDirectoryPathKey(row.path)))
  const ids = new Set(current.map(row => row.id))
  const added: ScheduledImportDirectory[] = []
  let duplicates = 0
  for (const path of paths) {
    const key = scheduledDirectoryPathKey(path)
    if (keys.has(key)) { duplicates++; continue }
    const row = createScheduledImportDirectory(path)
    const baseId = row.id
    let suffix = 1
    while (ids.has(row.id)) row.id = `${baseId}-${suffix++}`
    keys.add(key)
    ids.add(row.id)
    added.push(row)
  }
  return { directories: [...current, ...added], addedCount: added.length, duplicates }
}

/** New list is authoritative, including an explicitly empty list after removing all rows. */
export function scheduledImportDraftDirectories(draft: Pick<SettingsDraft, "scheduledImportDirectories" | "scheduledImportEnabled" | "scheduledImportPath" | "scheduledImportInterval">, projectPath?: string): ScheduledImportDirectory[] {
  if (draft.scheduledImportDirectories) return draft.scheduledImportDirectories.map(row => ({ ...row }))
  return normalizeScheduledImportConfig({ enabled: draft.scheduledImportEnabled, path: draft.scheduledImportPath, interval: draft.scheduledImportInterval, lastScan: null }, projectPath).directories ?? []
}

/** Background scan timestamps are status, never a reason to reset an unsaved settings form. */
export function scheduledImportSemanticKey(config: ScheduledImportConfig, projectPath?: string): string {
  return JSON.stringify((normalizeScheduledImportConfig(config, projectPath).directories ?? []).map(row => [row.id, scheduledDirectoryPathKey(row.path), row.enabled, row.interval]))
}

export function validateScheduledImportDraft(draft: Parameters<typeof scheduledImportDraftDirectories>[0], projectPath?: string): string[] {
  const directories = scheduledImportDraftDirectories(draft, projectPath)
  const errors = directories.flatMap((row, index) => row.enabled
    ? validateScheduledImportDirectories([row], projectPath).map(message => message.replace(/^监控目录 1/, `额外目录 ${index + 1}`))
    : [])
  const seen = new Set<string>()
  for (const row of directories) {
    if (!row.path.trim()) continue
    const key = scheduledDirectoryPathKey(row.path)
    if (seen.has(key)) errors.push(`额外监控目录不能重复：${row.path}`)
    seen.add(key)
  }
  return [...new Set(errors)]
}

/** Keep current runtime stamps when saving a draft; a changed origin starts with no scan result. */
export function scheduledImportConfigFromDraft(draft: Parameters<typeof scheduledImportDraftDirectories>[0], current: ScheduledImportConfig, projectPath?: string): ScheduledImportConfig {
  const latest = normalizeScheduledImportConfig(current, projectPath).directories ?? []
  const directories = scheduledImportDraftDirectories(draft, projectPath).map(row => {
    const saved = latest.find(item => item.id === row.id && scheduledDirectoryPathKey(item.path) === scheduledDirectoryPathKey(row.path))
    return { ...row, lastScan: saved?.lastScan ?? null }
  })
  return normalizeScheduledImportConfig({ ...current, directories }, projectPath)
}
