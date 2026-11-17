import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot} from './e2e-fixture.mjs'
import {openPromptManager,closePromptManager} from './e2e-navigation.mjs'
const browser=await launchBrowser()
try {
 const page=await browser.newPage({viewport:{width:1280,height:850}}),requests=[]
 page.on('dialog',dialog=>void dialog.accept())
 await page.route('**/chat/completions',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{choices:[{message:{content:'已收到。'},finish_reason:'stop'}]}})})
 await seedAndBoot(page,{settings:{apiKey:'test',model:'deepseek-flash'}})
 await openPromptManager(page)
 await page.getByTestId('prompt-category-protocol').click()
 for(const width of [1280,800,390]) {
  await page.setViewportSize({width,height:850})
  if(width<720 && !(await page.getByTestId('prompt-search').isVisible())) await page.getByRole('button',{name:'‹ 列表',exact:true}).click()
  const box=await page.getByTestId('prompt-search').boundingBox()
  assert.ok(box.width>=140,'search retains usable width at '+width)
  const label=await page.getByTestId('prompt-search').locator('..').locator('span').boundingBox()
  assert.ok(label.height<24,'search label stays on one line')
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 }
 await page.setViewportSize({width:1280,height:850})
 await page.getByTestId('prompt-row').filter({hasText:'GenUI · 交互界面'}).click()
 assert.match(await page.getByTestId('prompt-editor-content').inputValue(),/```genui/)
 await page.screenshot({path:'tmp/genui-protocol-layout.png'})
 await page.getByTestId('prompt-copy').click()
 await page.getByTestId('prompt-editor-content').fill('GENUI_CUSTOM_MARKER: Use dsh-ui interactive learning cards when helpful.')
 await page.getByTestId('prompt-save').click()
 await page.getByText('提示词已保存。',{exact:true}).waitFor()
 await page.getByTestId('protocol-activate').click()
 await page.getByText('实验协议已启用。新请求开始前会冻结当前版本。',{exact:true}).waitFor()
 await closePromptManager(page)
 await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('展示一个交互卡片')
 await page.getByTestId('composer-send-stop').click()
 await page.waitForFunction(()=>document.querySelector('[data-testid="composer-send-stop"]')?.getAttribute('aria-busy')==='false')
 assert.equal(requests.length,1)
 assert.ok(JSON.stringify(requests[0].messages).includes('GENUI_CUSTOM_MARKER'))
 console.log('PASS prompt layout on desktop/mobile and editable GenUI protocol reaches actual chat request')
} finally {await browser.close()}
