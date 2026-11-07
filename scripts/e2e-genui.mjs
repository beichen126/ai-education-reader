import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
const browser = await launchBrowser()
try {
 for (const width of [390,1280]) {
  const page=await browser.newPage({viewport:{width,height:850}})
  await page.goto('http://127.0.0.1:5328/ai-education-reader/test/genui.html')
  await page.getByRole('button',{name:'4',exact:true}).click()
  assert.match(await page.getByRole('status').innerText(),/回答正确/)
  await page.getByRole('button',{name:'数量'}).click()
  assert.match(await page.locator('tbody tr').first().innerText(),/乙/)
  await page.getByRole('textbox',{name:'筛选表格'}).fill('甲')
  assert.equal(await page.locator('tbody tr').count(),1)
  await page.getByLabel('学习主题').fill('物理')
  await page.getByRole('button',{name:'继续学习'}).click()
  await page.waitForFunction(()=>window.__action)
  assert.deepEqual(JSON.parse((await page.evaluate(()=>window.__action)).split('\n')[1]),{action:'continue',fields:{topic:'物理'}})
  await page.getByRole('button',{name:'例子',exact:true}).click()
  assert.equal(await page.getByText('例子内容',{exact:true}).count(),1)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.close()
 }
 console.log('GenUI browser: mobile/desktop quiz, sort, filter, form action, tabs passed')
} finally { await browser.close() }
