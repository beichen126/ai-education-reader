import {pathToFileURL} from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg} from './e2e-fixture.mjs'
import {fixtures} from './genui-full-fixtures.mjs'
const browser=await launchBrowser()
try {
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[],requests=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/chat/completions',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{choices:[{message:{content:'计划已收到。'},finish_reason:'stop'}]}})})
 const content=Object.values(fixtures).map(spec=>'```dsh-ui\n'+JSON.stringify(spec)+'\n```').join('\n\n')
 await seedAndBoot(page,{convs:[{id:'full-genui',title:'GenUI full test',createdAt:1,updatedAt:1,messages:[msg('gu','user','展示交互界面'),msg('ga','assistant',content)]}],settings:{apiKey:'mock',lastConversationId:'full-genui'}})
 const curve=page.locator('svg[aria-label="Sine curve"]')
 await curve.waitFor({timeout:30000})
 const before=await curve.locator('polyline').first().getAttribute('points')
 const slider=page.locator('.reader-genui-surface').first().getByRole('slider')
 await slider.fill('2')
 assert.notEqual(await curve.locator('polyline').first().getAttribute('points'),before,'continuous curve redraws locally')
 assert.equal(requests.length,0)
 const form=page.locator('.reader-genui-surface').nth(1)
 await form.getByLabel('单价',{exact:true}).fill('7')
 await form.getByText('21',{exact:true}).waitFor()
 assert.equal(await form.getByLabel('补充说明',{exact:true}).count(),0)
 await form.getByRole('radio',{name:'高级',exact:true}).check()
 await form.getByLabel('补充说明',{exact:true}).fill('需要详细解释')
 await page.waitForFunction(()=>Object.keys(localStorage).some(k=>String(localStorage.getItem(k)).includes('需要详细解释')))
 await page.reload({waitUntil:'networkidle'})
 await form.getByLabel('单价',{exact:true}).waitFor({timeout:30000})
 assert.equal(await form.getByLabel('单价',{exact:true}).inputValue(),'7')
 assert.equal(await form.getByLabel('补充说明',{exact:true}).inputValue(),'需要详细解释')
 const graphics=page.locator('.reader-genui-surface').nth(2)
 await graphics.locator('[data-genui-echart]').scrollIntoViewIfNeeded()
 await graphics.locator('[data-genui-echart] canvas').first().waitFor({timeout:30000})
 await graphics.getByText('三维球体',{exact:true}).scrollIntoViewIfNeeded()
 await graphics.locator('[data-genui-scene3d] canvas').waitFor({timeout:30000})
 await graphics.locator('[data-genui-mermaid] svg').waitFor({timeout:30000})
 const plotSurface=page.locator('.reader-genui-surface').first()
 await plotSurface.getByRole('button',{name:'展开画布',exact:true}).click()
 await page.getByRole('dialog',{name:'GenUI 画布'}).waitFor()
 await page.keyboard.press('Escape')
 const dl=page.waitForEvent('download');await plotSurface.getByRole('button',{name:'导出 JSON',exact:true}).click();const json=await dl
 assert.ok(json.suggestedFilename().endsWith('.genui.json'))
 const htmlDownload=page.waitForEvent('download');await plotSurface.getByRole('button',{name:'导出 HTML',exact:true}).click();const html=await htmlDownload
 assert.ok(html.suggestedFilename().endsWith('.html'))
 const exportPath=path.resolve('tmp/genui-exported.html');await html.saveAs(exportPath)
 const standalone=await context.newPage();await standalone.goto(pathToFileURL(exportPath).href)
 await standalone.locator('svg[aria-label="Sine curve"] polyline').first().waitFor()
 const oldCurve=await standalone.locator('polyline').first().getAttribute('points');await standalone.getByRole('slider').fill('2.5');assert.notEqual(await standalone.locator('polyline').first().getAttribute('points'),oldCurve);await standalone.close()
 await form.getByRole('button',{name:'提交计划',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('[data-testid="composer-send-stop"]')?.getAttribute('aria-busy')==='false')
 assert.equal(requests.length,1);assert.ok(JSON.stringify(requests[0].messages).includes('需要详细解释'))
 for(const width of [390,800]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no page overflow '+width)}
 await plotSurface.scrollIntoViewIfNeeded();await page.screenshot({path:'tmp/genui-full.png'})
 assert.deepEqual(errors,[])
 console.log('PASS continuous curves, slider redraw, computed fields, conditional visibility, reload state, ECharts, Mermaid, 3D, canvas, export and model action')
} finally {await browser.close()}
