import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { seedAndBoot, msg } from './e2e-fixture.mjs'
import { openSettings } from './e2e-navigation.mjs'
const browser=await launchBrowser()
try {
  for(const language of ['zh-CN','en']) {
    const context=await browser.newContext({viewport:{width:1100,height:850}})
    await context.addInitScript(()=>{
      window.__spoken=[]
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){},pause(){},resume(){},getVoices(){return [{name:'Microsoft English Online Natural',lang:'en-US'},{name:'Microsoft Chinese Online Natural',lang:'zh-CN'}]},speak(utterance){window.__spoken.push(utterance)}}})
      window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}}
    })
    const page=await context.newPage(), errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    const content='Zero. One. Two. Target sentence. Four. Five. Six.'
    await seedAndBoot(page,{convs:[{id:'read-chat',title:'Read test',createdAt:1,updatedAt:1,messages:[msg('read-u','user','Explain'),msg('read-a','assistant',content)]}],settings:{uiLanguage:language,lastConversationId:'read-chat'}})
    const select=async()=>{
      const root=page.locator('[data-message-id="read-a"]').first()
      await root.scrollIntoViewIfNeeded()
      await root.evaluate(el=>{
        const span=[...el.querySelectorAll('[data-canonical-start]')].find(span=>span.firstChild?.nodeType===3&&span.firstChild.textContent.includes('Target sentence.'))
        const text=span.firstChild,start=text.textContent.indexOf('Target sentence.'),range=document.createRange()
        range.setStart(text,start);range.setEnd(text,start+'Target sentence.'.length)
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await page.locator('[data-testid="selection-read-aloud"]').waitFor({state:'visible'})
    }
    await select()
    await page.locator('[data-testid="selection-read-aloud"]').click()
    const first=await page.evaluate(()=>({text:window.__spoken[0].text,rate:window.__spoken[0].rate,voice:window.__spoken[0].voice.name}))
    assert.equal(first.text,'Target sentence.');assert.equal(first.rate,0.9);assert.match(first.voice,/Microsoft/)
    assert.match(await page.locator('[data-testid="read-aloud-repeat"]').textContent(),/1 \/ 3/)
    await page.locator('[data-testid="read-aloud-pause"]').click()
    await page.locator('[data-testid="read-aloud-resume"]').click()
    await page.evaluate(()=>window.__spoken[0].onend())
    assert.match(await page.locator('[data-testid="read-aloud-repeat"]').textContent(),/2 \/ 3/)
    await page.evaluate(()=>window.__spoken[1].onend())
    assert.match(await page.locator('[data-testid="read-aloud-repeat"]').textContent(),/3 \/ 3/)
    await page.evaluate(()=>window.__spoken[2].onend())
    assert.equal(await page.locator('[data-testid="read-aloud-player"]').count(),0)
    await select()
    await page.getByRole('button',{name:language==='en'?'Mark':'标记',exact:true}).click()
    await page.waitForTimeout(250)
    await page.locator('[data-testid="sidebar-entry-cards"]').click()
    await page.locator('[data-testid="learning-tab-marks"]').click()
    await page.locator('[data-testid="card-item"]').first().click()
    await page.locator('[data-testid="mark-context-exact"]').waitFor({state:'visible'})
    assert.equal(await page.locator('[data-testid="mark-context-exact"]').textContent(),'Target sentence.')
    assert.equal((await page.locator('[data-testid="mark-context-before"]').textContent()).trim(),'One. Two.')
    assert.equal((await page.locator('[data-testid="mark-context-after"]').textContent()).trim(),'Four. Five.')
    const focus=await page.locator('[data-testid="mark-context-exact"]').boundingBox(),body=await page.locator('[data-testid="card-detail-body"]').boundingBox()
    assert.ok(Math.abs((focus.y+focus.height/2)-(body.y+body.height/2))<65,'mark remains near the reading viewport center')
    await page.locator('[data-testid="learning-center-close"]').click()
    await openSettings(page)
    await page.locator('[data-testid="settings-nav-general"]').click()
    await page.locator('[data-testid="settings-englishSpeechRate"]').selectOption('0.8')
    await page.locator('[data-testid="settings-speechRepeatCount"]').selectOption('5')
    await page.reload({waitUntil:'networkidle'})
    await openSettings(page)
    await page.locator('[data-testid="settings-nav-general"]').click()
    assert.equal(await page.locator('[data-testid="settings-englishSpeechRate"]').inputValue(),'0.8')
    assert.equal(await page.locator('[data-testid="settings-speechRepeatCount"]').inputValue(),'5')
    assert.deepEqual(errors,[])
    console.log('PASS v3 '+language+': selected-only speech, default three whole passes, pause/resume, online voice preference, mark context/centering and durable general settings')
    await context.close()
  }
} finally {await browser.close()}
