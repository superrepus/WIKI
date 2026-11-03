const barriers = new Set<() => Promise<void>>()
const dirtySettings = new Set<object>()

export function registerUpdateSaveBarrier(save: () => Promise<void>): () => void {
  barriers.add(save)
  return () => { barriers.delete(save) }
}

export function markUpdateSettingsDirty(owner: object, dirty: boolean): void {
  if (dirty) dirtySettings.add(owner)
  else dirtySettings.delete(owner)
}

export function hasUnsavedUpdateSettings(): boolean { return dirtySettings.size > 0 }

export async function flushUpdateSaveBarriers(): Promise<void> {
  for (const save of barriers) await save()
}
