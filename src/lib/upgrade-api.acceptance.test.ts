/** Opt-in acceptance against the compiled native API. Only a registered synthetic project is mutated. */
import { expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { realFs } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => ({ ...realFs, writeFileAtomic: realFs.writeFile,
  getFileMd5: async (p:string) => createHash("md5").update(await fs.readFile(p)).digest("hex") }))
vi.mock("@tauri-apps/plugin-store", () => ({load:async()=>({get:async()=>undefined,set:async()=>{},save:async()=>{}})}))
import { retractManagedSourceKnowledge } from "./source-reconciliation"
import { refreshWikiCatalog } from "./wiki-catalog"
import { autoIngest } from "./ingest"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { getTaskLlmConfig } from "./llm-task-routing"
import { useWikiStore } from "@/stores/wiki-store"

it.skipIf(process.env.UPGRADE_API_ACCEPTANCE !== "1")("native API routing, complete catalog, withdrawal, stale chat and original compiler rebuild", async () => {
  const cfg=JSON.parse(await fs.readFile("windows-native/runtime/upgrade-staging-project.private.json","utf8"))
  if (!cfg.path.replace(/\\/g,"/").includes("/upgrade-acceptance-")) throw new Error("Refusing non-test project")
  const root=cfg.path, old="REMOVED_UPGRADE_FACT_583719", keep="KEEP_IP65_583719"
  const prefix=`http://127.0.0.1:19828/api/v1/projects/${cfg.id}`
  const headers={Authorization:`Bearer ${cfg.token}`,"Content-Type":"application/json"}
  const request=async (path:string,body?:unknown) => fetch(prefix+path,{method:body===undefined?"GET":"POST",headers,body:body===undefined?undefined:JSON.stringify(body)})
  const read=async (path:string) => { const r=await request(path);if(r.status!==200)throw new Error(`${path}: HTTP ${r.status}: ${await r.text()}`);return r.json() }
  const write=async(p:string,text:string) => {await fs.mkdir(`${root}/${p}`.slice(0,`${root}/${p}`.lastIndexOf("/")),{recursive:true});await fs.writeFile(`${root}/${p}`,text)}
  const pages:Record<string,string[]>={}
  const page=async(p:string,sources:string[],body:string,type="entity")=>{pages[p]=sources;await write(p,`---\ntype: ${type}\ntitle: ${JSON.stringify(p.includes("keep")?"SurvivorB":p)}\nsources: ${JSON.stringify(sources)}\n---\n${body}`)}
  await write("raw/sources/a.md",old);await write("raw/sources/b.md",`SurvivorB product: ${keep}. This source has no other product specification.`)
  await page("wiki/entities/shared.md",["a.md","b.md"],`${old} and ${keep}`)
  await page("wiki/synthesis/downstream.md",["a.md","b.md"],`[[entities/shared]] ${old}`,"synthesis")
  await page("wiki/synthesis/second-hop.md",["a.md","b.md"],`[[synthesis/downstream]] ${old}`,"synthesis")
  await page("wiki/entities/keep.md",["b.md"],`SurvivorB: ${keep}`)
  for(let n=0;n<210;n++) await page(`wiki/concepts/later-${n}.md`,["b.md"],`Unrelated navigation fixture ${n}`,"concept")
  await write("wiki/index.md",`# Index\n${old}`);await write("wiki/overview.md",old);await write("wiki/log.md",old)
  await write(".llm-wiki/source-reconciliation.json",JSON.stringify({version:1,enabled:true,generation:0,blocked:false,sources:{"a.md":"fixture-a","b.md":"fixture-b"},pages,pendingSources:[]}))
  await refreshWikiCatalog(root)
  const routing=await read("/model-routing");expect(routing.chat.model).toBe("chat-route-model");expect(routing.ingest.model).toBe("ingest-route-model")
  const catalog=await read("/catalog?limit=1000");expect(catalog.total).toBe(214)
  const before=await request("/search",{query:old,includeContent:true});expect(await before.text()).toContain(old)
  const chat=await request("/chat",{message:"Route probe",mode:"fast",tools:{wiki:false,web:false,anytxt:false},sessionId:"upgrade-old-session",stream:false})
  expect(chat.status).toBe(200);expect(await chat.text()).toContain("ROUTE_VERIFIED")
  const marker=`${root}/.llm-wiki/source-reconciliation.json`;const state=JSON.parse(await fs.readFile(marker,"utf8"))
  await fs.writeFile(marker,JSON.stringify({...state,blocked:true}))
  for(const path of ["/catalog","/graph","/task-metrics"]) expect((await request(path)).status).toBe(503)
  await fs.writeFile(marker,JSON.stringify(state))
  useWikiStore.setState({project:null})
  const withdrawn=await retractManagedSourceKnowledge(root,["raw/sources/a.md"],true)
  expect(withdrawn?.deletedWikiPaths).toHaveLength(3)
  expect((await request("/files/content?path=wiki/entities/shared.md")).status).toBe(404)
  expect((await request("/files/content?path=wiki/entities/keep.md")).status).toBe(200)
  expect(JSON.stringify(await read("/graph?limit=1000"))).not.toContain("shared.md")
  const after=await request("/search",{query:old,includeContent:true});expect(await after.text()).not.toContain(old)
  expect((await read(`/catalog?q=${old}`)).total).toBe(0)
  const afterChat=await request("/chat",{message:"Repeat the supported facts",mode:"fast",tools:{wiki:false,web:false,anytxt:false},sessionId:"upgrade-old-session",historyExplicit:true,history:[{role:"assistant",content:old}],stream:false})
  expect(afterChat.status).toBe(200)
  const httpLog=JSON.parse(await fs.readFile(cfg.capturePath,"utf8"));expect(JSON.stringify(httpLog.at(-1).messages)).not.toContain(old)
  expect(httpLog.at(-1).model).toBe("chat-route-model")
  const stalePromise=request("/chat",{message:"delay-route-probe",mode:"fast",tools:{wiki:false},stream:false})
  let signalled=false
  for(let n=0;n<80;n++){if(await fs.access(cfg.delayMarker).then(()=>true,()=>false)){signalled=true;break}await new Promise(r=>setTimeout(r,25))}
  expect(signalled).toBe(true)
  const fresh=JSON.parse(await fs.readFile(marker,"utf8"));await fs.writeFile(marker,JSON.stringify({...fresh,generation:fresh.generation+1}))
  const stale=await stalePromise;expect(stale.status).toBe(409)
  const model={provider:"custom" as const,model:"global-model",apiKey:"fixture-key",customEndpoint:cfg.modelEndpoint,ollamaUrl:"",maxContextSize:64000,streamingEnabled:false}
  useWikiStore.setState({project:{id:cfg.id,name:"Isolated upgrade acceptance",path:root},llmConfig:model,
    taskModelRouting:{chatPresetId:"custom-upgrade-chat",ingestPresetId:"custom-upgrade-ingest"},projectLlmOverride:{enabled:false,presetId:null,model:""},
    customLlmPresets:[{id:"custom-upgrade-chat",label:"Chat"},{id:"custom-upgrade-ingest",label:"Ingest"}],
    providerConfigs:{"custom-upgrade-chat":{model:"chat-route-model",baseUrl:cfg.modelEndpoint,streamingEnabled:false},"custom-upgrade-ingest":{model:"ingest-route-model",baseUrl:cfg.modelEndpoint,streamingEnabled:false}},
    embeddingConfig:{enabled:false,endpoint:"",apiKey:"",model:""},multimodalConfig:{...useWikiStore.getState().multimodalConfig,enabled:false}})
  const summary=`wiki/sources/${sourceSummarySlugFromIdentity("b.md")}.md`
  const generation=[`---FILE: ${summary}---\n---\ntype: source\ntitle: SurvivorB source\nsources: [b.md]\n---\n${keep}\n---END FILE---`,
    `---FILE: wiki/entities/rebuilt-b.md---\n---\ntype: entity\ntitle: SurvivorB rebuilt\nsources: [b.md]\n---\n${keep}\n---END FILE---`].join("\n\n")
  await fs.writeFile(cfg.generationPath,generation)
  const built=await autoIngest(root,`${root}/raw/sources/b.md`,getTaskLlmConfig("ingest"),undefined,undefined,undefined,{taskId:"upgrade-rebuild",queuedAt:Date.now()-1000})
  expect(built).toContain("wiki/entities/rebuilt-b.md")
  expect(await fs.readFile(`${root}/wiki/entities/rebuilt-b.md`,"utf8")).toContain(keep)
  expect((await read(`/catalog?q=${old}`)).total).toBe(0)
  const metrics=await read("/task-metrics?limit=1000");const build=metrics.tasks.find((t:any)=>t.taskId==="upgrade-rebuild")
  expect(build.status).toBe("done");expect(build.model).toBe("ingest-route-model");expect(build.totalTokens).toBeGreaterThan(0)
  expect(build.durationMs).toBeGreaterThan(0);expect(build.endedAt).toBeGreaterThanOrEqual(build.startedAt);expect(build.retrievedPages).toContain("wiki/entities/keep.md")
  expect(build.usageCoverage).toBe("complete")
  expect(metrics.tasks.some((t:any)=>t.kind==="chat"&&t.model==="chat-route-model"&&t.totalTokens===20)).toBe(true)
  const calls=JSON.parse(await fs.readFile(cfg.capturePath,"utf8"));const buildCalls=calls.filter((c:any)=>c.model==="ingest-route-model")
  expect(buildCalls.length).toBeGreaterThanOrEqual(2);expect(JSON.stringify(buildCalls)).not.toContain(old)
  await fs.writeFile("windows-native/runtime/upgrade-api-acceptance.json",JSON.stringify({passed:true,syntheticProject:cfg.id,originalCompiler:true,
    completeCatalogPages:catalog.total,withdrawnPages:withdrawn?.deletedWikiPaths.length,blockedStatus:503,removedPageStatus:404,staleRequestStatus:stale.status,
    mixedAndDownstreamFactsRemoved:true,oldHistoryExcluded:true,survivorRebuilt:true,chatModel:routing.chat.model,ingestModel:build.model,
    buildDurationMs:build.durationMs,buildReportedTokens:build.totalTokens,requests:build.requests.length,usageCoverage:build.usageCoverage},null,2))
},120000)
