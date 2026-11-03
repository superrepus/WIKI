import { afterEach, beforeEach, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, realFs, writeFileRaw, readFileRaw } from "@/test-helpers/fs-temp"
vi.mock("@/commands/fs", () => ({ ...realFs, writeFileAtomic: realFs.writeFile }))
import { refreshWikiCatalog, retrieveIngestContext, rankCatalog, catalogPage, renderCatalog } from "./wiki-catalog"
import { updateBoundedRecentIndexSection } from "./ingest"

let tmp: Awaited<ReturnType<typeof createTempProject>>
beforeEach(async () => { tmp = await createTempProject("full-catalog"); await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n\nHand maintained note.\n") })
afterEach(async () => tmp.cleanup())
it("catalogs every page past 200, preserves manual text and retrieves an early old page body", async () => {
  await writeFileRaw(`${tmp.path}/wiki/entities/early.md`, '---\ntype: entity\ntitle: SE-CUR-SHUNT-06\naliases: [SHUNT06]\nsources: [early.pdf]\n---\nEARLY_EVIDENCE_701 is a shunt from DEWETRON.')
  for (let n = 0; n < 240; n++) await writeFileRaw(`${tmp.path}/wiki/concepts/later-${n}.md`, `---\ntype: concept\ntitle: Unrelated ${n}\n---\nDifferent unrelated material.`)
  await writeFileRaw(`${tmp.path}/wiki/topics/directory.md`, '---\ntype: topic\n---\nNavigation')
  await writeFileRaw(`${tmp.path}/wiki/media/fake.md`, "MEDIA_MUST_NOT_BE_A_PAGE")
  const catalog = await refreshWikiCatalog(tmp.path)
  expect(catalog.pages).toHaveLength(242)
  const index = await readFileRaw(`${tmp.path}/wiki/index.md`)
  expect(index).toContain("Hand maintained note."); expect(index).toContain("entities/early"); expect(index).toContain("later-239")
  expect(index).not.toContain("MEDIA_MUST_NOT_BE_A_PAGE")
  const context = await retrieveIngestContext(tmp.path, "The SHUNT06 measurement device", "new.pdf")
  expect(context.paths).toContain("wiki/entities/early.md"); expect(context.context).toContain("EARLY_EVIDENCE_701")
  expect(context.sources).toContain("early.pdf")
  await fs.unlink(`${tmp.path}/wiki/entities/early.md`)
  await refreshWikiCatalog(tmp.path)
  expect(await readFileRaw(`${tmp.path}/wiki/index.md`)).not.toContain("entities/early")
  expect(await readFileRaw(`${tmp.path}/.llm-wiki/wiki-catalog.json`)).not.toContain("EARLY_EVIDENCE_701")
}, 20000)
it("matches Chinese terms and aliases without forcing every document pair into a comparison", () => {
  const pages=[catalogPage("wiki/concepts/shunt.md",'---\ntitle: 分流器\naliases: [电流分流电阻]\n---\n电流测量原理'),catalogPage("wiki/entities/fan.md",'---\ntitle: Cooling Fan\n---\nAir flow')]
  expect(rankCatalog(pages,"电流分流电阻用于电流测量")[0].path).toContain("shunt")
})

it("keeps full-catalog and directory marker pairs intact across repeated upstream recent-index updates", () => {
  const pages=[catalogPage("wiki/entities/a.md","# A")]
  let index=renderCatalog("# Index\n",pages)+"\n<!-- directory-topics -->\n## 来源目录\n- [[topics/x]]\n<!-- /directory-topics -->\n"
  for(let i=0;i<4;i++) index=renderCatalog(updateBoundedRecentIndexSection(index,[`- [[new-${i}]]`]),pages)
  expect(index.match(/<!-- llm-wiki:catalog-start -->/g)).toHaveLength(1)
  expect(index.match(/<!-- llm-wiki:catalog-end -->/g)).toHaveLength(1)
  expect(index.match(/<!-- directory-topics -->/g)).toHaveLength(1)
  expect(index).toContain("<!-- /directory-topics -->")
})
