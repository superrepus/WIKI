import { afterEach, beforeEach, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import type { LlmConfig } from "@/stores/wiki-store"
const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }))
vi.mock("@/commands/fs", () => ({ ...realFs, writeFileAtomic: realFs.writeFile }))
vi.mock("./tauri-fetch", () => ({ getHttpFetch: async () => fetcher, isFetchNetworkError: () => false }))
import { parseTokenUsage, summarizeUsage, withTaskMetrics, setTaskStage, recoverInterruptedMetrics } from "./task-metrics"
import { streamChat } from "./llm-client"
let tmp: Awaited<ReturnType<typeof createTempProject>>
const config = { provider: "custom", model: "test", apiKey: "private-not-in-metrics", customEndpoint: "http://127.0.0.1:9/v1", ollamaUrl: "", maxContextSize: 64000, streamingEnabled: false } as LlmConfig
beforeEach(async () => { tmp = await createTempProject("metrics"); fetcher.mockReset() })
afterEach(async () => tmp.cleanup())
async function records() {
  const dir = `${tmp.path}/.llm-wiki/task-metrics`
  return Promise.all((await fs.readdir(dir)).map(async name => JSON.parse(await fs.readFile(`${dir}/${name}`,"utf8"))))
}
it("collects exact provider usage and task/stage timing without persisting prompts or credentials", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:"ANSWER_SECRET"},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})))
  await withTaskMetrics(tmp.path,"a.pdf",config,async c => { setTaskStage(c,"analysis"); await streamChat(c,[{role:"user",content:"PROMPT_SECRET"}],{onToken:()=>{},onDone:()=>{},onError:e=>{throw e}});return ["wiki/a.md"] },{taskId:"task-A",queuedAt:Date.now()-2000})
  const [r]=await records();expect(r.status).toBe("done");expect(r.totalTokens).toBe(120);expect(r.waitMs).toBeGreaterThanOrEqual(2000)
  expect(r.endedAt).toBeGreaterThanOrEqual(r.startedAt);expect(r.stages.analysis).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(r)).not.toMatch(/PROMPT_SECRET|ANSWER_SECRET|private-not-in-metrics/)
})
it("captures SSE usage even when choices are empty, and marks missing usage unknown", async () => {
  fetcher.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\ndata: [DONE]\n\n'))
  await withTaskMetrics(tmp.path,"sse.pdf",{...config,streamingEnabled:true},async c => {await streamChat(c,[{role:"user",content:"x"}],{onToken:()=>{},onDone:()=>{},onError:e=>{throw e}});return []})
  expect((await records())[0].totalTokens).toBe(12)
  const {body}=fetcher.mock.calls[0][1];expect(JSON.parse(body).stream_options.include_usage).toBe(true)
  expect(parseTokenUsage({text:"lots of characters"})).toBeNull()
  const sum=summarizeUsage([{startedAt:0,stage:"analysis",model:"m",inputChars:2,outputChars:2,status:"done",usage:null}]);expect(sum.totalTokens).toBeNull();expect(sum.usageCoverage).toBe("unavailable")
})
it("keeps concurrent attempts isolated and records failure without inventing tokens", async () => {
  await Promise.all([withTaskMetrics(tmp.path,"a",config,async c=>{setTaskStage(c,"generation");return ["wiki/a.md"]}),
    withTaskMetrics(tmp.path,"b",{...config,model:"B"},async ()=>{throw new Error("cancelled")}).catch(()=>{})])
  const rows=await records();expect(rows).toHaveLength(2);expect(rows.find(r=>r.model==="B").status).toBe("cancelled")
})
it("normalizes reported cache tokens without double-counting OpenAI cached input", () => {
  expect(parseTokenUsage({usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:100,cache_creation_input_tokens:20}})?.totalTokens).toBe(135)
  expect(parseTokenUsage({usage:{prompt_tokens:110,completion_tokens:5,prompt_tokens_details:{cached_tokens:100}}})?.totalTokens).toBe(115)
})
it("retains interruption evidence with no guessed finish time", async () => {
  await writeFileRaw(`${tmp.path}/.llm-wiki/task-metrics/old.json`,JSON.stringify({id:"old",kind:"ingest",status:"running",startedAt:1,totalTokens:null}))
  await recoverInterruptedMetrics(tmp.path);const [r]=await records();expect(r.status).toBe("interrupted");expect(r.endedAt).toBeUndefined();expect(r.totalTokens).toBeNull()
})
