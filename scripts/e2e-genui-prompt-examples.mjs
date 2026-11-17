import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg} from './e2e-fixture.mjs'
const source=readFileSync('src/genui/catalog-prompt.ts','utf8')
const prompt=JSON.parse(source.slice(source.indexOf(' = ')+3).trim())
const fences=[...prompt.matchAll(/```genui\n([\s\S]*?)\n```/g)].map(match=>match[0])
const browser=await launchBrowser()
try {
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width:1280,height:900}})
  await seedAndBoot(page,{convs:[{id:'prompt-examples',title:'提示词示例验收',createdAt:1,updatedAt:1,messages:[msg('answer','assistant',fences.join('\n\n'))]}],settings:{lastConversationId:'prompt-examples'}})
  await page.setViewportSize({width,height:900})
  await page.locator('.reader-genui-surface').nth(6).waitFor()
  assert.equal(await page.locator('.reader-genui-surface').count(),7)
  await page.getByText('analytics',{exact:true}).waitFor()
  assert.equal(await page.locator('.reader-genui-repair').count(),0,'examples render without repair')
  const radius=page.locator('input[type="range"]').first()
  await radius.fill('3')
  await page.waitForFunction(()=>document.querySelectorAll('.reader-genui-surface')[1]?.innerText.includes('28.27'))
  const quiz=page.locator('[data-genui-choices]').first()
  await quiz.getByRole('checkbox',{name:'2',exact:true}).check()
  await quiz.getByRole('checkbox',{name:'4',exact:true}).check()
  await quiz.getByRole('button',{name:'检查答案'}).click()
  assert.match(await quiz.getByRole('status').innerText(),/回答正确/)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'responsive layout '+width)
  await page.close()
 }
 console.log('PASS prompt examples render on desktop/mobile, with live calculation and quiz feedback')
}finally{await browser.close()}
