import type { LlmConfig } from "@/stores/wiki-store"
import { createDirectory, listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "./path-utils"

export interface TokenUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; cacheCreationInputTokens?: number; reasoningTokens?: number }
export interface ModelRequestMetric {
  startedAt: number; endedAt?: number; durationMs?: number; stage: string; model: string
  inputChars: number; outputChars: number; status: string; usage: TokenUsage | null
}
export interface TaskMetric {
  version: 1; id: string; taskId: string; kind: "ingest"; sourcePath: string; model: string
  queuedAt?: number; startedAt: number; endedAt?: number; durationMs?: number; waitMs?: number
  status: string; attempt: number; stage: string; stageStartedAt: number; stages: Record<string, number>
  requests: ModelRequestMetric[]; inputTokens: number | null; outputTokens: number | null
  totalTokens: number | null; reportedTokens: number; usageCoverage: string; unknownUsageRequests: number
  retrievedPages?: string[]; filesWritten?: string[]
  updatedAt?: number
}
type Tracker = { record: TaskMetric; pp: string; pending: Promise<void>; persist: () => Promise<void> }
const trackers = new WeakMap<LlmConfig, Tracker>()
const activeMetricIds = new Set<string>()

/** Provider-reported values only. Never infer tokens from characters. */
export function parseTokenUsage(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, any>
  const u = p.usage ?? p.message?.usage ?? p.response?.usage ?? p.usageMetadata
    ?? (p.prompt_eval_count !== undefined || p.eval_count !== undefined ? p : null)
  if (!u) return null
  const number = (...values: unknown[]): number | undefined => values.find(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0) as number | undefined
  let inputTokens = number(u.prompt_tokens, u.input_tokens, u.promptTokenCount, u.prompt_eval_count)
  if (u.prompt_tokens === undefined && u.input_tokens !== undefined && inputTokens !== undefined) inputTokens += (number(u.cache_read_input_tokens) ?? 0) + (number(u.cache_creation_input_tokens) ?? 0)
  const outputTokens = number(u.completion_tokens, u.output_tokens, u.candidatesTokenCount, u.eval_count)
  const totalTokens = number(u.total_tokens, u.totalTokenCount) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  const value = { inputTokens, outputTokens, totalTokens,
    cachedInputTokens: number(u.prompt_tokens_details?.cached_tokens, u.cache_read_input_tokens, u.cachedContentTokenCount),
    cacheCreationInputTokens: number(u.cache_creation_input_tokens),
    reasoningTokens: number(u.completion_tokens_details?.reasoning_tokens, u.thoughtsTokenCount) }
  return Object.values(value).some(v => v !== undefined) ? value : null
}

export function summarizeUsage(requests: ModelRequestMetric[]) {
  const sum = (key: keyof TokenUsage) => requests.reduce((n, r) => n + (r.usage?.[key] ?? 0), 0)
  const complete = (key: keyof TokenUsage) => requests.every(r => r.usage?.[key] !== undefined)
  const unknownUsageRequests = requests.filter(r => r.usage?.totalTokens === undefined).length
  return { inputTokens: complete("inputTokens") ? sum("inputTokens") : null,
    outputTokens: complete("outputTokens") ? sum("outputTokens") : null,
    totalTokens: complete("totalTokens") ? sum("totalTokens") : null,
    reportedTokens: sum("totalTokens"), unknownUsageRequests,
    usageCoverage: requests.length === 0 ? "no-model-requests" : unknownUsageRequests === 0 ? "complete" : unknownUsageRequests === requests.length ? "unavailable" : "partial" }
}

export function setTaskStage(config: LlmConfig, stage: string): void {
  const t = trackers.get(config)
  if (!t || t.record.stage === stage) return
  const now = Date.now(), old = t.record.stage
  t.record.stages[old] = (t.record.stages[old] ?? 0) + Math.max(0, now - t.record.stageStartedAt)
  t.record.stage = stage; t.record.stageStartedAt = now
  void t.persist()
}
export function recordRetrievedPages(config: LlmConfig, paths: string[]): void {
  const t = trackers.get(config); if (t) { t.record.retrievedPages = [...new Set([...(t.record.retrievedPages ?? []), ...paths])]; void t.persist() }
}

export function trackChildModel(parent: LlmConfig, child: LlmConfig | null): LlmConfig | null {
  if (!child) return null
  const tracker = trackers.get(parent)
  if (!tracker) return child
  const tracked = { ...child }; trackers.set(tracked, tracker); return tracked
}

/** One object per actual HTTP call, including failed calls and compatibility retries. */
export function beginModelRequest(config: LlmConfig, inputChars: number) {
  const t = trackers.get(config)
  if (!t) return null
  const r: ModelRequestMetric = { startedAt: Date.now(), stage: t.record.stage, model: config.model, inputChars, outputChars: 0, status: "running", usage: null }
  t.record.requests.push(r); void t.persist()
  let finished = false
  return { output: (text: string) => { if (!finished) r.outputChars += text.length },
    usage: (payload: unknown) => {
      const usage = parseTokenUsage(payload)
      if (usage) {
        r.usage = { ...r.usage, ...Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) }
        if (r.usage.inputTokens !== undefined && r.usage.outputTokens !== undefined && usage.totalTokens === undefined) r.usage.totalTokens = r.usage.inputTokens + r.usage.outputTokens
      }
    },
    finish: (status: string) => {
      if (finished) return
      finished = true; r.status = status; r.endedAt = Date.now(); r.durationMs = Math.max(0, r.endedAt - r.startedAt); void t.persist()
    } }
}

export async function withTaskMetrics<T extends string[]>(pp: string, source: string, config: LlmConfig,
  run: (tracked: LlmConfig) => Promise<T>, options: { taskId?: string; queuedAt?: number; attempt?: number } = {}): Promise<T> {
  const now = Date.now(), id = `ingest-${now}-${crypto.randomUUID()}`
  const tracked = { ...config }
  const record: TaskMetric = { version: 1, id, taskId: options.taskId ?? id, kind: "ingest", sourcePath: normalizePath(source), model: config.model,
    queuedAt: options.queuedAt, startedAt: now, waitMs: options.queuedAt === undefined ? undefined : Math.max(0, now - options.queuedAt),
    status: "running", attempt: options.attempt ?? 1, stage: "parse", stageStartedAt: now, stages: {}, requests: [], ...summarizeUsage([]) }
  const dir = `${normalizePath(pp)}/.llm-wiki/task-metrics`
  const tracker: Tracker = { pp, record, pending: Promise.resolve(), persist: () => {
    Object.assign(record, summarizeUsage(record.requests))
    record.updatedAt = Date.now()
    const snapshot = JSON.stringify(record)
    tracker.pending = tracker.pending.then(async () => { await createDirectory(dir); await writeFileAtomic(`${dir}/${id}.json`, snapshot) }).catch(() => {
      // Telemetry must not corrupt or fail an otherwise valid original compile.
      console.warn("[task-metrics] Could not persist task timing; inspect project storage permissions")
    })
    return tracker.pending
  } }
  trackers.set(tracked, tracker); activeMetricIds.add(id); await tracker.persist()
  try { const result = await run(tracked); record.status = result.length ? "done" : "failed"; record.filesWritten = result; return result }
  catch (error) { record.status = error instanceof Error && /cancel|abort/i.test(error.message) ? "cancelled" : "failed"; throw error }
  finally {
    const end = Date.now(); record.stages[record.stage] = (record.stages[record.stage] ?? 0) + Math.max(0, end - record.stageStartedAt)
    record.endedAt = end; record.durationMs = Math.max(0, end - now)
    await tracker.persist(); trackers.delete(tracked); activeMetricIds.delete(id)
  }
}

/** Never invent a completion time for a process that stopped unexpectedly. */
export async function recoverInterruptedMetrics(pp: string): Promise<void> {
  const dir = `${normalizePath(pp)}/.llm-wiki/task-metrics`
  const files = await listDirectory(dir).catch(() => [])
  for (const f of files.filter(f => !f.is_dir && f.name.endsWith(".json"))) {
    const r = JSON.parse(await readFile(f.path))
    if (r.status !== "running" || activeMetricIds.has(r.id)) continue
    r.status = "interrupted"; r.totalTokens = null; r.inputTokens = null; r.outputTokens = null; r.usageCoverage = "interrupted"
    r.recoveryObservedAt = Date.now()
    await writeFileAtomic(f.path, JSON.stringify(r))
  }
}
