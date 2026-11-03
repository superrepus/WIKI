import { beforeEach, afterEach, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { realFs, createTempProject, writeFileRaw, readFileRaw } from "@/test-helpers/fs-temp"
const fixture = vi.hoisted(()=>({ generation:"", merged:"", prompts:[] as string[] }))
vi.mock("@/commands/fs",()=>({...realFs,writeFileAtomic:realFs.writeFile,getFileMd5:async(p:string)=>createHash("md5").update(await fs.readFile(p)).digest("hex")}))
vi.mock("@tauri-apps/plugin-store",()=>({load:async()=>({get:async()=>undefined,set:async()=>{},save:async()=>{}})}))
vi.mock("./llm-client",()=>({streamChat:async(_config:unknown,messages:any[],callbacks:any)=>{
  fixture.prompts.push(JSON.stringify(messages))
  callbacks.onToken(messages[0].content.includes("---FILE:") ? fixture.generation : fixture.merged)
  callbacks.onDone({truncated:false})
},isFetchNetworkError:()=>false}))
import { autoIngest } from "./ingest"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
let tmp:Awaited<ReturnType<typeof createTempProject>>
beforeEach(async()=>{tmp=await createTempProject("managed-full-compile");fixture.prompts=[];useActivityStore.setState({items:[]});useReviewStore.setState({items:[]})})
afterEach(async()=>tmp.cleanup())
it("retrieves old evidence and completes the original managed commit, merge, dependency and metrics pipeline without reentrant locks",async()=>{
  const old='---\ntype: entity\ntitle: DEVICE-701\nsources: [old.md]\n---\nOLD_FACT_701: existing supported specification.'
  fixture.merged='---\ntype: entity\ntitle: DEVICE-701\nsources: [old.md, new.md]\n---\nOLD_FACT_701: existing supported specification. NEW_FACT_701: additional supported specification.'
  await writeFileRaw(`${tmp.path}/wiki/entities/device-701.md`,old)
  await writeFileRaw(`${tmp.path}/raw/sources/new.md`,"# DEVICE-701 addendum\nNEW_FACT_701 is an additional specification. Reuse the existing DEVICE-701 page.")
  await writeFileRaw(`${tmp.path}/purpose.md`,"Maintain product pages and preserve each source's evidence.")
  await writeFileRaw(`${tmp.path}/schema.md`,"# Schema\nUse wiki/sources, wiki/entities, wiki/concepts and preserve sources metadata.")
  await writeFileRaw(`${tmp.path}/wiki/index.md`,"# Index\n")
  await writeFileRaw(`${tmp.path}/.llm-wiki/source-reconciliation.json`,JSON.stringify({version:1,enabled:true,generation:0,blocked:false,sources:{"old.md":"fixture"},pages:{"wiki/entities/device-701.md":["old.md"]},pendingSources:[]}))
  const summary=`wiki/sources/${sourceSummarySlugFromIdentity("new.md")}.md`
  fixture.generation=`---FILE: ${summary}---\n---\ntype: source\ntitle: DEVICE-701 addendum\nsources: [new.md]\n---\nNEW_FACT_701: additional specification for DEVICE-701.\n---END FILE---\n\n---FILE: wiki/entities/device-701.md---\n---\ntype: entity\ntitle: DEVICE-701\nsources: [new.md]\n---\nNEW_FACT_701: additional specification for DEVICE-701.\n---END FILE---`
  const model={provider:"custom" as const,model:"fixture",apiKey:"",customEndpoint:"http://127.0.0.1:1/v1",ollamaUrl:"",maxContextSize:64000}
  useWikiStore.setState({project:{id:"test-managed",name:"Test",path:tmp.path},llmConfig:model,
    embeddingConfig:{enabled:false,endpoint:"",apiKey:"",model:""},multimodalConfig:{...useWikiStore.getState().multimodalConfig,enabled:false}})
  const written=await autoIngest(tmp.path,`${tmp.path}/raw/sources/new.md`,model,undefined,undefined,undefined,{taskId:"managed-commit"})
  expect(written).toContain("wiki/entities/device-701.md")
  expect(fixture.prompts[0]).toContain("OLD_FACT_701")
  const merged=await readFileRaw(`${tmp.path}/wiki/entities/device-701.md`)
  expect(merged).toContain("OLD_FACT_701");expect(merged).toContain("NEW_FACT_701")
  const state=JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/source-reconciliation.json`))
  expect(state.pages["wiki/entities/device-701.md"]).toContain("new.md")
  const files=await fs.readdir(`${tmp.path}/.llm-wiki/task-metrics`)
  const metric=JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/task-metrics/${files[0]}`))
  expect(metric.status).toBe("done");expect(metric.retrievedPages).toContain("wiki/entities/device-701.md")
  expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).toContain("## 全库目录")
},15000)
