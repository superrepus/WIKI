import { useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory, readFile } from "@/commands/fs"
import type { TaskMetric } from "@/lib/task-metrics"

const elapsed = (ms: number | undefined) => ms === undefined ? "未知" : `${Math.floor(ms / 60000)}分${Math.round(ms % 60000 / 1000)}秒`
export function TaskMetricsPanel() {
  const project = useWikiStore(s => s.project)
  const [rows, setRows] = useState<TaskMetric[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function load() {
    if (!project || busy) return
    setBusy(true); setError("")
    try {
      const dir = `${project.path.replace(/\\/g, "/")}/.llm-wiki/task-metrics`
      const files = (await listDirectory(dir)).filter(f => !f.is_dir && f.name.endsWith(".json"))
        .sort((a, b) => Number(b.name.match(/\d{13}/)?.[0] ?? 0) - Number(a.name.match(/\d{13}/)?.[0] ?? 0)).slice(0, 100)
      const result = await Promise.all(files.map(async f => JSON.parse(await readFile(f.path)) as TaskMetric))
      setRows(result.sort((a, b) => b.startedAt - a.startedAt))
    } catch { setError("暂无可读取的任务统计。升级前的历史任务没有开始时间和 Token 记录，不会推算补填。") }
    finally { setBusy(false) }
  }
  return <details className="border-b px-3 py-2 text-xs" onToggle={e => { if (e.currentTarget.open) void load() }}>
    <summary className="cursor-pointer font-medium">任务耗时与 Token 统计</summary>
    <p className="my-1 text-[10px] text-muted-foreground">仅统计升级后的任务；每次尝试单独记录。未知或部分用量不作为完整 Token 总量。旧记录保存在项目内，可通过 API 分页查看。</p>
    <button className="my-1 underline" onClick={() => void load()} disabled={busy}>{busy ? "读取中…" : "刷新最近 100 条"}</button>
    {error && <p>{error}</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-[10px]">
      <thead><tr><th>任务 / 模型</th><th>开始 / 状态</th><th>耗时</th><th>Token 输入 / 输出 / 总量</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className="border-t align-top" title={JSON.stringify({ stagesMs: r.stages, requests: r.requests.length, usageCoverage: r.usageCoverage, reportedTokens: r.reportedTokens })}>
        <td className="max-w-64 break-words py-1">{r.sourcePath?.split(/[\\/]/).pop() ?? r.taskId}<br />{r.model}</td>
        <td>{new Date(r.startedAt).toLocaleString()}<br />{r.status} · 第 {r.attempt ?? 1} 次</td>
        <td>{elapsed(r.durationMs)}</td><td>{r.inputTokens ?? "未知"} / {r.outputTokens ?? "未知"} / {r.totalTokens ?? "未知"}<br />{r.usageCoverage === "partial" && `已报告部分：${r.reportedTokens}`}</td>
      </tr>)}</tbody>
    </table></div>
    {!error && rows.length === 0 && <p>尚无新任务统计。</p>}
  </details>
}
