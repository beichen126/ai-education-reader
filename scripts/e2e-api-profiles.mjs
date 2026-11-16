import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot} from './e2e-fixture.mjs'
import {openSettings} from './e2e-navigation.mjs'
const browser=await launchBrowser()
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}})
 await seedAndBoot(page,{settings:{apiKey:'deepseek-key',model:'deepseek-flash'}})
 await openSettings(page,'api')
 const name=page.getByLabel('配置名称'),base=page.getByPlaceholder('https://api.deepseek.com',{exact:true}).first(),key=page.getByPlaceholder('sk-...'),model=page.getByPlaceholder('deepseek-flash',{exact:true})
 await name.fill('DeepSeek 官方');await page.getByRole('button',{name:'当前设置另存为',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[aria-label="切换配置"]')?.selectedOptions[0].text==='DeepSeek 官方')
 await name.fill('TeamoRouter');await page.getByRole('button',{name:'新建配置',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[aria-label="切换配置"]')?.selectedOptions[0].text==='TeamoRouter')
 assert.equal(await key.inputValue(),'','new configurations never inherit a key')
 await base.fill('https://teamorouter.com/v1');await key.fill('router-key');await model.fill('custom-model')
 await page.getByLabel('切换配置').selectOption({label:'DeepSeek 官方'})
 await page.waitForFunction(()=>document.querySelector('input[placeholder="sk-..."]')?.value==='deepseek-key')
 assert.equal(await base.inputValue(),'https://api.deepseek.com');assert.equal(await model.inputValue(),'deepseek-flash')
 await page.getByLabel('切换配置').selectOption({label:'TeamoRouter'})
 await page.waitForFunction(()=>document.querySelector('input[placeholder="sk-..."]')?.value==='router-key')
 assert.equal(await base.inputValue(),'https://teamorouter.com/v1');assert.equal(await model.inputValue(),'custom-model')
 await name.fill('我的中转');await page.getByRole('button',{name:'重命名',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[aria-label="切换配置"]')?.selectedOptions[0].text==='我的中转')
 await page.reload({waitUntil:'networkidle'});await openSettings(page,'api')
 assert.equal(await key.inputValue(),'router-key');assert.equal(await page.getByLabel('切换配置').locator('option:checked').textContent(),'我的中转')
 await page.setViewportSize({width:390,height:844})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 console.log('PASS independent named API profiles: create, draft save on switch, credentials, rename, reload and mobile layout')
} finally {await browser.close()}
