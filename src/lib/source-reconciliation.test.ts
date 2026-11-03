import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { realFs, createTempProject, writeFileRaw, readFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => ({ ...realFs,
  writeFileAtomic: realFs.writeFile,
  getFileMd5: async (p: string) => createHash("md5").update(await fs.readFile(p)).digest("hex"),
}))

import { assertSourceRevision, captureSourceRevision, planSourceRetraction, recordSourceDependencies, retractManagedSourceKnowledge, recoverPendingRetraction } from "./source-reconciliation"
import { useWikiStore } from "@/stores/wiki-store"

describe("upstream managed source reconciliation", () => {
  let tmp: Awaited<ReturnType<typeof createTempProject>>
  beforeEach(async () => {
    tmp = await createTempProject("managed-reconciliation")
    useWikiStore.setState({ project: null })
    await writeFileRaw(`${tmp.path}/.llm-wiki/source-reconciliation.json`, JSON.stringify({
      version: 1, enabled: true, generation: 0, blocked: false, sources: {}, pages: { "wiki/entities/unrelated.md": ["b.md"] }, pendingSources: [],
    }))
    await writeFileRaw(`${tmp.path}/raw/sources/a.md`, "PS100: OLD_10KW")
    await writeFileRaw(`${tmp.path}/raw/sources/b.md`, "PS200: IP65")
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n- [[shared]]\n- [[downstream]]\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Log\n")
    await writeFileRaw(`${tmp.path}/wiki/entities/shared.md`, '---\nsources: ["a.md", "b.md"]\n---\nOLD_10KW and IP65')
    await writeFileRaw(`${tmp.path}/wiki/synthesis/downstream.md`, '---\nrelated: ["shared"]\n---\n[[shared]] OLD_10KW')
    await writeFileRaw(`${tmp.path}/wiki/entities/unrelated.md`, '---\nsources: ["b.md"]\n---\nIP65')
  })
  afterEach(async () => tmp.cleanup())

  it("finds shared and downstream pages, without confusing identical basenames", () => {
    const pages = [
      { path: "wiki/entities/a.md", content: '---\nsources: ["p/a.md"]\n---\nA' },
      { path: "wiki/entities/b.md", content: '---\nsources: ["q/a.md"]\n---\nB' },
      { path: "wiki/synthesis/c.md", content: "[[a]]" },
    ]
    expect(planSourceRetraction(pages, ["p/a.md"]).affected.sort()).toEqual(["wiki/entities/a.md", "wiki/synthesis/c.md"])
  })

  it("archives and withdraws the entire mixed page rather than editing its source list", async () => {
    const result = await retractManagedSourceKnowledge(tmp.path, [`${tmp.path}/raw/sources/a.md`], true)
    expect(result?.deletedWikiPaths).toContain(`${tmp.path}/wiki/entities/shared.md`)
    expect(result?.deletedWikiPaths).toContain(`${tmp.path}/wiki/synthesis/downstream.md`)
    await expect(fs.access(`${tmp.path}/wiki/entities/shared.md`)).rejects.toThrow()
    await expect(fs.access(`${tmp.path}/raw/sources/a.md`)).rejects.toThrow()
    expect(await readFileRaw(`${tmp.path}/wiki/entities/unrelated.md`)).toContain("IP65")
    const state = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/source-reconciliation.json`))
    expect(state.blocked).toBe(false)
    expect(state.pendingSources).toContain("b.md")
    expect(state.generation).toBe(1)
    const archives = await fs.readdir(`${tmp.path}/.llm-wiki/retracted`)
    expect(await readFileRaw(`${tmp.path}/.llm-wiki/retracted/${archives[0]}/wiki/entities/shared.md`)).toContain("OLD_10KW")
  })

  it("keeps modified source bytes while withdrawing its previous knowledge", async () => {
    await retractManagedSourceKnowledge(tmp.path, ["raw/sources/a.md"], false)
    expect(await readFileRaw(`${tmp.path}/raw/sources/a.md`)).toContain("OLD_10KW")
    await expect(fs.access(`${tmp.path}/wiki/entities/shared.md`)).rejects.toThrow()
  })

  it("rejects a generated result if its input changes or another source is retracted", async () => {
    const snapshot = await captureSourceRevision(tmp.path, `${tmp.path}/raw/sources/b.md`)
    await writeFileRaw(`${tmp.path}/raw/sources/b.md`, "NEW")
    await expect(assertSourceRevision(tmp.path, `${tmp.path}/raw/sources/b.md`, snapshot)).rejects.toThrow("stale")
    const fresh = await captureSourceRevision(tmp.path, `${tmp.path}/raw/sources/b.md`)
    await retractManagedSourceKnowledge(tmp.path, ["raw/sources/a.md"], false)
    await expect(assertSourceRevision(tmp.path, `${tmp.path}/raw/sources/b.md`, fresh)).rejects.toThrow("stale")
  })

  it("records dependencies through the original compiler's commit hook", async () => {
    const a = await captureSourceRevision(tmp.path, `${tmp.path}/raw/sources/a.md`)
    await recordSourceDependencies(tmp.path, `${tmp.path}/raw/sources/a.md`, a, ["wiki/entities/shared.md"])
    const b = await captureSourceRevision(tmp.path, `${tmp.path}/raw/sources/b.md`)
    await recordSourceDependencies(tmp.path, `${tmp.path}/raw/sources/b.md`, b, ["wiki/entities/unrelated.md"])
    const state = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/source-reconciliation.json`))
    expect(state.pages["wiki/entities/unrelated.md"]).toContain("a.md")
    expect(state.pages["wiki/entities/unrelated.md"]).toContain("b.md")
  })

  it("removes a deleted fact from multi-hop pages, aggregates, complete catalog, reviews and extraction caches", async () => {
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "OLD_10KW")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "OLD_10KW")
    await writeFileRaw(`${tmp.path}/wiki/synthesis/second-hop.md`, '---\nrelated: ["synthesis/downstream"]\n---\nOLD_10KW')
    await writeFileRaw(`${tmp.path}/raw/sources/.cache/a.md.txt`, "OLD_10KW")
    await writeFileRaw(`${tmp.path}/raw/parsed/a.md.md`, "OLD_10KW")
    await writeFileRaw(`${tmp.path}/.llm-wiki/review.json`, JSON.stringify([
      {id:"x",type:"suggestion",title:"OLD_10KW",description:"OLD_10KW",sourcePath:`${tmp.path}/raw/sources/a.md`,options:[],resolved:false,createdAt:1},
      {id:"y",type:"confirm",title:"Keep",description:"IP65",sourcePath:`${tmp.path}/raw/sources/c.md`,affectedPages:["wiki/entities/unrelated.md"],options:[],resolved:false,createdAt:2},
      {id:"z",type:"suggestion",title:"Mixed review",description:"OLD_10KW",sourcePath:`${tmp.path}/raw/sources/b.md`,affectedPages:["wiki/entities/shared.md","wiki/entities/unrelated.md"],options:[],resolved:false,createdAt:3},
    ]))
    const result = await retractManagedSourceKnowledge(tmp.path,["raw/sources/a.md"],true)
    expect(result?.deletedWikiPaths).toContain(`${tmp.path}/wiki/synthesis/second-hop.md`)
    for (const name of ["wiki/index.md","wiki/overview.md","wiki/log.md",".llm-wiki/wiki-catalog.json",".llm-wiki/review.json"]) {
      expect(await readFileRaw(`${tmp.path}/${name}`)).not.toContain("OLD_10KW")
    }
    await expect(fs.access(`${tmp.path}/raw/sources/.cache/a.md.txt`)).rejects.toThrow()
    // Markdown has no generated parsed copy: preserve a user-created lookalike.
    await expect(fs.access(`${tmp.path}/raw/parsed/a.md.md`)).resolves.toBeUndefined()
    expect(await readFileRaw(`${tmp.path}/.llm-wiki/review.json`)).toContain("IP65")
  })

  it("does not confuse qualified links to same-named pages in different directories", () => {
    const pages = [
      {path:"wiki/entities/shared.md",content:'---\nsources: ["a.md"]\n---\nA'},
      {path:"wiki/concepts/shared.md",content:'---\nsources: ["b.md"]\n---\nB'},
      {path:"wiki/synthesis/keep.md",content:'---\nsources: ["b.md"]\n---\n[[concepts/shared]]'},
      {path:"wiki/synthesis/remove.md",content:"[[entities/shared]]"},
    ]
    expect(planSourceRetraction(pages,["a.md"]).affected.sort()).toEqual(["wiki/entities/shared.md","wiki/synthesis/remove.md"])
  })

  it("removes the generated parsed copy of a deleted PDF source", async () => {
    await writeFileRaw(`${tmp.path}/raw/sources/spec.pdf`, "fixture PDF bytes")
    await writeFileRaw(`${tmp.path}/raw/parsed/spec.pdf.md`, "OLD_PDF_FACT")
    await writeFileRaw(`${tmp.path}/wiki/entities/spec.md`, '---\nsources: ["spec.pdf"]\n---\nOLD_PDF_FACT')
    await retractManagedSourceKnowledge(tmp.path,["raw/sources/spec.pdf"],true)
    await expect(fs.access(`${tmp.path}/raw/parsed/spec.pdf.md`)).rejects.toThrow()
  })

  it("recovers a persisted interrupted withdrawal and never re-registers a stale compiler result", async () => {
    const revision = await captureSourceRevision(tmp.path,`${tmp.path}/raw/sources/b.md`)
    const file=`${tmp.path}/.llm-wiki/source-reconciliation.json`
    const state=JSON.parse(await readFileRaw(file));state.blocked=true;state.retraction={sources:["raw/sources/a.md"],deleteSources:true}
    await writeFileRaw(file,JSON.stringify(state))
    await recoverPendingRetraction(tmp.path)
    expect(JSON.parse(await readFileRaw(file)).blocked).toBe(false)
    await expect(recordSourceDependencies(tmp.path,`${tmp.path}/raw/sources/b.md`,revision,["wiki/entities/stale.md"])).rejects.toThrow("stale")
  })

  it("keeps the project blocked on journal corruption instead of publishing a partial withdrawal", async () => {
    await writeFileRaw(`${tmp.path}/.llm-wiki/source-page-dependencies.jsonl`,"{broken")
    await expect(retractManagedSourceKnowledge(tmp.path,["raw/sources/a.md"],true)).rejects.toThrow()
    const state=JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/source-reconciliation.json`));expect(state.blocked).toBe(true)
    expect(state.retraction.sources).toEqual(["raw/sources/a.md"])
  })
})
