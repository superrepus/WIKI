import { invoke } from "@tauri-apps/api/core"
import { openPath } from "@tauri-apps/plugin-opener"

/** Native resolution checks the project's source registration and original-file permissions. */
export async function resolveSourcePath(path: string): Promise<string> {
  return invoke<string>("resolve_source_path", { path })
}
export async function openSourceOriginal(path: string): Promise<void> {
  await openPath(await resolveSourcePath(path))
}
