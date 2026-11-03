// Official Playwright WebView2/CDP testing; the debug listener exists only in the isolated test task.
import { chromium } from '../native-tools/ui-test/node_modules/playwright-core/index.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
const root=process.cwd(),runtime=path.join(root,'windows-native/runtime')
const zh=JSON.parse(await fs.readFile(path.join(root,'src/i18n/zh.json'),'utf8'))
const original=JSON.parse((await fs.readFile(path.join(runtime,'foxess-current-profile.private.json'),'utf8')).replace(/^\uFEFF/,''))
const actualKey=original.llmConfig.apiKey
const browser=await chromium.connectOverCDP('http://127.0.0.1:9224')
try{
  const page=browser.contexts()[0].pages().find(p=>p.url().includes('tauri.localhost'))??browser.contexts()[0].pages()[0]
  await page.setViewportSize({width:1280,height:820})
  await page.locator('.fox-workspace-header').waitFor({timeout:25000})
  const workspace=await page.locator('.fox-workspace-header').innerText()
  if(!/FoxEss WIKI 验收样例|foxess-model-acceptance-\d+/.test(workspace))throw Error('Refusing UI testing outside the isolated project')
  if(await page.title()!=='FoxEss WIKI')throw Error('Application title not branded')
  await page.evaluate(()=>document.documentElement.classList.remove('dark'))
  await page.screenshot({path:path.join(runtime,'foxess-ui-workspace.png')})
  const startChat=page.getByRole('button',{name:'开始对话',exact:true})
  if(await startChat.count())await startChat.click()
  await page.locator('.fox-nav-rail button').filter({has:page.locator('svg.lucide-settings')}).click()
  await page.getByRole('button',{name:zh.settings.categories.llm,exact:true}).click()
  await page.getByRole('button',{name:/FoxEss 企业默认模型/}).first().waitFor()
  const rendered=await page.locator('body').innerText()
  const values=await page.locator('input').evaluateAll(ns=>ns.map(n=>n.value))
  if(rendered.includes(actualKey)||JSON.stringify(values).includes(actualKey))throw Error('A plaintext default credential reached the view')
  if(await page.locator('input[type=password]').count()!==0)throw Error('The built-in card must not render an API-key field')
  await page.screenshot({path:path.join(runtime,'foxess-ui-models.png')})
  await page.evaluate(()=>document.documentElement.classList.add('dark'))
  await page.screenshot({path:path.join(runtime,'foxess-ui-models-dark.png')})
  await page.evaluate(()=>document.documentElement.classList.remove('dark'))
  await page.getByRole('button',{name:zh.settings.sections.llm.customProfiles.add,exact:true}).click()
  const ownKey=page.locator('input[type=password]')
  await ownKey.waitFor();await ownKey.fill('UI_TEST_ONLY_KEY')
  await page.getByRole('button',{name:'使用手册',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await dialog.getByText('FoxEss WIKI 使用手册',{exact:true}).waitFor()
  const headings=await dialog.locator('article h2').allTextContents()
  if(headings.length!==16){console.log(JSON.stringify({manualHeadings:headings}));await page.screenshot({path:path.join(runtime,'foxess-ui-manual-diagnostic.png')});throw Error('The complete manual is missing chapters: '+headings.length)}
  const manualTop=await dialog.locator('article').evaluate(n=>n.parentElement.scrollTop)
  if(manualTop>2)throw Error('Manual should open at the beginning')
  await page.screenshot({path:path.join(runtime,'foxess-ui-manual.png')})
  await dialog.getByRole('button',{name:zh.common.close,exact:true}).click()
  await page.getByRole('button',{name:'切换知识库',exact:true}).click()
  await page.getByText('打开你的知识工作台',{exact:true}).waitFor()
  await page.screenshot({path:path.join(runtime,'foxess-ui-welcome.png')})
  await page.setViewportSize({width:800,height:600})
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)
  if(overflow)throw Error('Welcome layout overflows horizontally')
  const result={passed:true,windowTitle:'FoxEss WIKI',protectedModelVisible:true,plaintextCredentialAbsent:true,builtInKeyFieldAbsent:true,customModelKeyEditable:true,manualChapters:16,librarySwitchPreserved:true,lightAndDarkScreenshots:true,smallWindowChecked:true}
  await fs.writeFile(path.join(runtime,'foxess-ui-acceptance.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result))
} finally {await browser.close()}
