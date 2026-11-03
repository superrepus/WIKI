import { expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => realFs)
import { buildPageMerger } from "./ingest"

it.skipIf(process.env.NATIVE_WIKI_SMOKE !== "1")("merges two sources through the original merger without fallback", async () => {
  const cfg=JSON.parse(await fs.readFile("windows-server/config.local.json","utf8"))
  const sec=JSON.parse(await fs.readFile("windows-server/secrets.local.json","utf8"))
  const events: Record<string,unknown>[]=[]
  const originalFetch=globalThis.fetch
  const cfgModel={provider:"custom" as const,apiKey:sec.model_api_key,model:cfg.model.name,
    customEndpoint:cfg.model.base_url,ollamaUrl:"",apiMode:"chat_completions" as const,
    maxContextSize:64000,streamingEnabled:false,reasoning:{mode:"off" as const},ingestReasoning:{mode:"off" as const},requestTimeoutMinutes:5}
  globalThis.fetch=async(input,init)=>{
    const body=JSON.parse(String(init?.body ?? "{}")); const start=Date.now()
    const event:Record<string,unknown>={url:String(input),max_tokens:body.max_tokens,messageChars:JSON.stringify(body.messages).length,stream:body.stream}
    events.push(event)
    try{const response=await originalFetch(input,init);event.status=response.status;event.seconds=(Date.now()-start)/1000;return response}
    catch(e){event.error=e instanceof Error?e.message:String(e);event.causeCode=(e as {cause?:{code?:string}}).cause?.code;throw e}
  }
  try{
    const merged=await buildPageMerger(cfgModel)(
      '---\ntype: entity\ntitle: ACME Instruments\nsources: ["lab-a.md"]\n---\n# ACME Instruments\nACME PS100 rated voltage is 100 V; maximum current 10 A. Source lab-a.md.\n',
      '---\ntype: entity\ntitle: ACME Instruments\nsources: ["lab-b.md"]\n---\n# ACME Instruments\nACME PS200 rated voltage is 200 V; maximum current 10 A. Source lab-b.md.\n',
      'lab-b.md')
    expect(merged).toContain('PS100');expect(merged).toContain('PS200');expect(merged).toMatch(/100\s*V/);expect(merged).toMatch(/200\s*V/)
    await fs.writeFile(path.resolve('windows-native/runtime/original-merge-acceptance.md'),merged)
  }finally{
    globalThis.fetch=originalFetch
    await fs.writeFile(path.resolve('windows-native/runtime/original-merge-request.json'),JSON.stringify(events,null,2))
  }
},6*60*1000)
