/** Acceptance test: real upstream autoIngest + real configured local model.
 * Only filesystem/UI transports are adapted to Node; the compiler is unchanged.
 */
import { expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { realFs } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => ({ ...realFs, writeFileAtomic: realFs.writeFile, getFileMd5: async (p: string) => createHash("md5").update(await fs.readFile(p)).digest("hex") }))
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({
  get: async () => undefined, set: async () => {}, save: async () => {},
}) }))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { parseSources } from "./sources-merge"

it.skipIf(process.env.NATIVE_WIKI_SMOKE !== "1")("uses the original compiler for entities and cross-document pages", async () => {
  const warnings = vi.spyOn(console, "warn")
  const root = path.resolve("windows-native/runtime/acceptance-" + Date.now()).replace(/\\/g, "/")
  const config = JSON.parse(await fs.readFile(path.resolve("windows-server/config.local.json"), "utf8"))
  const secrets = JSON.parse(await fs.readFile(path.resolve("windows-server/secrets.local.json"), "utf8"))
  const schema = await fs.readFile(path.resolve("windows-native/runtime/equipment-wiki/schema.md"), "utf8")
  await fs.mkdir(`${root}/raw/sources`, { recursive: true })
  await fs.mkdir(`${root}/wiki`, { recursive: true })
  await fs.mkdir(`${root}/.llm-wiki`, { recursive: true })
  await fs.writeFile(`${root}/.llm-wiki/source-reconciliation.json`, JSON.stringify({ version: 1, enabled: true, generation: 0, blocked: false, sources: {}, pages: {}, pendingSources: [] }))
  await fs.writeFile(`${root}/schema.md`, schema)
  await fs.writeFile(`${root}/purpose.md`, "# 设备知识库验收\n\n这是虚构设备测试，不能用于真实选型。为厂家、设备型号和接口协议生成原版实体/概念页；同厂家同系列设备建立跨文档关系，并在指标可比较时创建比较页。每页保留来源，参数不得串型号。")
  await fs.writeFile(`${root}/wiki/index.md`, "# Wiki Index\n\nNo pages yet.\n")
  await fs.writeFile(`${root}/wiki/log.md`, "# Wiki Log\n")
  const docs = {
    "lab-a.md": "# 虚构设备 ACME PS100 产品手册\n版本1.0，2026年10月。厂家ACME Instruments，系列PS，为可编程直流电源。PS100额定输出电压100 V，最大输出电流10 A，额定功率1000 W。支持RS485物理接口、Modbus RTU协议，地址范围1-247。输出电压与电流限制应分别设置。此资料仅适用于PS100，不代表PS200规格。使用时先设置电流限值再接负载；端子极性必须核对。PS系列应用于实验室直流负载测试。\n",
    "lab-b.md": "# 虚构设备 ACME PS200 产品手册\n版本1.0，2026年10月。厂家ACME Instruments，属于PS系列，与PS100同系列。PS200额定输出电压200 V，最大输出电流10 A，额定功率2000 W。支持RS485物理接口、Modbus RTU协议，地址范围1-247。此资料仅适用于PS200；PS100参数需引用PS100手册。输出电压与电流限制分别设置；端子极性必须核对。PS系列应用于实验室直流负载测试。两种设备均可用于自动化台架，但通信线缆和命令寄存器必须按对应手册核对。\n",
  }
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useWikiStore.setState({ project: { id: "native-acceptance", name: "验收", path: root },
    embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
  })
  useWikiStore.getState().setOutputLanguage("Chinese")
  const llm = { provider: "custom" as const, apiKey: secrets.model_api_key, model: config.model.name,
    customEndpoint: config.model.base_url, ollamaUrl: "", maxContextSize: 64000,
    apiMode: "chat_completions" as const, streamingEnabled: false,
    reasoning: { mode: "off" as const }, ingestReasoning: { mode: "off" as const }, requestTimeoutMinutes: 10 }
  useWikiStore.getState().setLlmConfig(llm)
  const runs = []
  for (const [name, content] of Object.entries(docs)) {
    const source = `${root}/raw/sources/${name}`
    await fs.writeFile(source, content)
    const started = Date.now()
    const written = await autoIngest(root, source, llm)
    expect(written.some(p => p.startsWith("wiki/sources/"))).toBe(true)
    runs.push({ source: name, written, seconds: (Date.now() - started) / 1000 })
  }
  const tree = await realFs.listDirectory(`${root}/wiki`)
  const flatten = (nodes: typeof tree): string[] => nodes.flatMap(n => n.is_dir ? flatten(n.children ?? []) : [n.path])
  const pages = await Promise.all(flatten(tree).filter(p => p.endsWith(".md")).map(async p => {
    const content = await fs.readFile(p, "utf8")
    return { path: p.slice(root.length + 1), sources: parseSources(content), chars: content.length }
  }))
  const entities = pages.filter(p => p.path.startsWith("wiki/entities/"))
  const shared = pages.filter(p => p.sources.length >= 2)
  const dependencies = JSON.parse(await fs.readFile(`${root}/.llm-wiki/source-reconciliation.json`, "utf8"))
  const report = { root, runs, pages, multiSourceDependencies: Object.values(dependencies.pages as Record<string, string[]>).filter(deps => deps.length >= 2).length, entities: entities.length, sharedPages: shared.length,
    reviews: useReviewStore.getState().items.length, realModel: llm.model, originalCompiler: "src/lib/ingest.ts:autoIngest",
    mergeFailures: warnings.mock.calls.filter(args => String(args[0]).includes("[page-merge] LLM merge failed")).length }
  await fs.writeFile(path.resolve("windows-native/runtime/original-compiler-acceptance.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ root, entities: entities.length, sharedPages: shared.length, generatedPages: pages.length }))
  expect(entities.length).toBeGreaterThan(0)
  // Original compiler may correctly cite only the document it actually read.
  // Cross-document links and conservative runtime provenance are separate.
  expect(shared.length).toBeGreaterThan(0)
  expect(report.multiSourceDependencies).toBeGreaterThan(0)
  expect(report.mergeFailures).toBe(0)
  warnings.mockRestore()
}, 20 * 60 * 1000)
