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
      window.Audio=class { pause(){} load(){} removeAttribute(){} async play(){window.__spoken.push(this)} }

    })
    const page=await context.newPage(), errors=[]
    const requests=[]
    await page.route('**/v1/tools/tts', async route=>{requests.push(route.request().postDataJSON());await route.fulfill({status:200,contentType:'audio/wav',body:Buffer.alloc(100)})})
    page.on('pageerror',error=>errors.push(error.message))
    const content='Zero. One. Two. Target sentence. Four. Five. Six.'
    await seedAndBoot(page,{convs:[{id:'read-chat',title:'Read test',createdAt:1,updatedAt:1,messages:[msg('read-u','user','Explain'),msg('read-a','assistant',content)]}],settings:{apiKey:'test-tts-key',speechVoice:'tide',speechApiUrl:'https://api.teamorouter.com/v1',uiLanguage:language,lastConversationId:'read-chat'}})
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
    await page.locator('[data-testid="read-aloud-repeat"]').waitFor()
    assert.equal(requests[0].text,'Target sentence.');assert.equal(requests[0].voice_id,'tide')
    assert.equal(await page.evaluate(()=>window.__spoken[0].playbackRate),0.9)
    assert.match(await page.locator('[data-testid="read-aloud-repeat"]').textContent(),/1 \/ 3/)
    await page.locator('[data-testid="read-aloud-pause"]').click()
    await page.locator('[data-testid="read-aloud-resume"]').click()
    await page.evaluate(()=>window.__spoken[0].onended())
    assert.match(await page.locator('[data-testid="read-aloud-repeat"]').textContent(),/2 \/ 3/)
    await page.evaluate(()=>window.__spoken[1].onended())
    assert.match(await page.locator('[data-testid="read-aloud-repeat"]').textContent(),/3 \/ 3/)
    await page.evaluate(()=>window.__spoken[2].onended())
    assert.equal(await page.locator('[data-testid="read-aloud-player"]').count(),0)
    assert.equal(requests.length,1,'replays reuse synthesized audio')
    await page.evaluate(()=>{getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'))})
    await page.locator('[data-testid="message-read-aloud"]').click()
    await page.locator('[data-testid="read-aloud-repeat"]').waitFor()
    assert.equal(requests.at(-1).text,content,'full answer sent to TTS')
    await page.locator('[data-testid="read-aloud-stop"]').click()
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
