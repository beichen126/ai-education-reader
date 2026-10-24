import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
const browser=await launchBrowser()
try {
  for(const width of [390,1280]){
    const page=await browser.newPage({viewport:{width,height:850},hasTouch:width===390})
    await page.goto((process.env.E2E_BASE||'http://127.0.0.1:5322/ai-education-reader/').replace(/\/$/,'')+'/test/interactions.html')
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}}))
    for(const [selector,expected] of [['p','A complete **paragraph** with several words.'],['[data-math-id]','x^2+y^2=1'],['td','| A | B |']]){
      await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'))})
      await page.locator(selector).first().dblclick()
      const copy=page.getByTestId('selection-copy')
      await copy.waitFor({state:'visible'})
      assert.ok(await page.evaluate(()=>!getSelection().isCollapsed),'explicit native selection')
      await copy.click()
      assert.ok((await page.evaluate(()=>window.__copied)).includes(expected),'copies Markdown source '+selector)
    }
    const url=page.url()
    if(width===390){
      await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'))})
      const p=await page.locator('p').first().boundingBox()
      await page.touchscreen.tap(p.x+15,p.y+10)
      await page.waitForTimeout(70)
      await page.touchscreen.tap(p.x+15,p.y+10)
      await page.getByTestId('selection-copy').waitFor({state:'visible'})
      assert.match(await page.evaluate(()=>getSelection().toString()),/complete.*paragraph/)
    }
    for(let repeat=0;repeat<5;repeat++){
      await page.getByRole('button',{name:'Open image',exact:true}).click()
      await page.getByRole('dialog',{name:'Image viewer'}).waitFor()
      await page.mouse.click(3,200)
      await page.getByRole('dialog',{name:'Image viewer'}).waitFor({state:'hidden'})
      await page.waitForTimeout(180)
      assert.equal(page.url(),url,'closing nested image surfaces must not leave Reader')
      assert.ok(await page.getByRole('button',{name:'Open image',exact:true}).isVisible())
    }
    await page.getByRole('button',{name:'Open image',exact:true}).click()
    await page.goBack()
    await page.getByRole('dialog',{name:'Image viewer'}).waitFor({state:'hidden'})
    assert.equal(page.url(),url)
    await page.close()
  }
  console.log('PASS double-click paragraph/math/table selection, source copy and repeated nested image close/browser back at phone/desktop widths')
} finally {await browser.close()}
