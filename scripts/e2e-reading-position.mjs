import assert from 'node:assert/strict'
import { launchBrowser } from './e2e-browser.mjs'
import { msg, seedAndBoot } from './e2e-fixture.mjs'
import { openSettings } from './e2e-navigation.mjs'

const KEY='ai-reader:reading-positions:v1'
const thread=JSON.stringify(['reading-chat',null])
const branchKey=JSON.stringify(['reading-chat','reading-branch'])
const text='A long explanation with enough content to scroll. '.repeat(18)
const browser=await launchBrowser()
try {
  for(const [language,width] of [['zh-CN',1280],['en',390]].filter(([language])=>!process.env.E2E_READING_LANGUAGE||process.env.E2E_READING_LANGUAGE===language)) {
    const context=await browser.newContext({viewport:{width:1280,height:850}})
    const page=await context.newPage(), errors=[]
    page.on('pageerror',error=>errors.push(error.message))
    await seedAndBoot(page,{convs:[{id:'reading-chat',title:'Reading test',createdAt:1,updatedAt:1,messages:Array.from({length:24},(_,i)=>msg('reading-'+i,i%2?'assistant':'user','Paragraph '+i+'\n\n'+text))}],settings:{lastConversationId:'reading-chat',uiLanguage:language,rememberReadingPosition:false}})
    await page.setViewportSize({width,height:850})
    const scroll=page.locator('[data-testid="conversation-scroll"]')
    const move=async(id,offset=40)=>{
      await scroll.evaluate((root,{id,offset})=>{
        const target=root.querySelector('[data-message-id="'+id+'"]')
        root.scrollTop+=target.getBoundingClientRect().top-root.getBoundingClientRect().top+offset
      },{id,offset})
      await page.waitForTimeout(100)
    }
    const position=()=>scroll.evaluate(root=>({top:root.scrollTop,bottom:root.scrollHeight-root.clientHeight-root.scrollTop}))
    const checkpoint=()=>page.evaluate(({KEY,thread})=>JSON.parse(localStorage.getItem(KEY)||'{}')[thread],{KEY,thread})
    await openSettings(page)
    assert.ok(await scroll.evaluate(root=>root.clientHeight>0 && root.clientWidth>0),'opening mobile navigation/settings must not collapse the reading viewport')
    const toggle=page.locator('[data-testid="settings-remember-reading-position"]')
    assert.equal(await toggle.isChecked(),false,'explicitly disabled setting is preserved')
    await page.keyboard.press('Escape')
    await move('reading-8')
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
    assert.equal(await checkpoint(),undefined,'disabled mode does not save on pagehide')
    await openSettings(page);await toggle.click();await page.waitForFunction(()=>document.querySelector('[data-testid="settings-remember-reading-position"]').checked);await page.keyboard.press('Escape')
    await move('reading-10')
    await page.waitForFunction(({KEY,thread})=>!!JSON.parse(localStorage.getItem(KEY)||'{}')[thread],{KEY,thread},{timeout:20000}).catch(async error=>{
      console.log('Reading checkpoint diagnostics',await scroll.evaluate(root=>({height:root.clientHeight,top:root.scrollTop,rows:root.querySelectorAll('[data-message-id]').length,stored:localStorage.getItem('ai-reader:reading-positions:v1'),visibility:document.visibilityState})))
      throw error
    })
    const saved=await checkpoint()
    assert.equal(saved.messageId,'reading-10','10-second automatic checkpoint follows the actual visible message')
    const before=(await position()).top
    await page.reload({waitUntil:'networkidle'})
    await page.waitForFunction(top=>Math.abs(document.querySelector('[data-testid="conversation-scroll"]').scrollTop-top)<3,before)
    assert.ok(Math.abs((await position()).top-before)<3,'reload restores the exact reading location rather than bottom')
    await move('reading-15')
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
    const exitSaved=await checkpoint()
    assert.equal(exitSaved.messageId,'reading-15','exit checkpoint captures the latest scroll without waiting 10 seconds')
    // Install a branch with different rows, then exercise real route changes.
    await page.evaluate(async()=>{
      const db=await new Promise(resolve=>{const req=indexedDB.open('ai-education-reader');req.onsuccess=()=>resolve(req.result)})
      await new Promise(resolve=>{const tx=db.transaction('conversationBranches','readwrite');tx.objectStore('conversationBranches').put({id:'reading-branch',conversationId:'reading-chat',forkMessageId:'reading-5',title:'Reading branch',createdAt:1,updatedAt:1,messages:Array.from({length:12},(_,i)=>({id:'branch-'+i,role:'assistant',content:('Branch paragraph '+i+' ').repeat(90),images:[],createdAt:1,updatedAt:1}))});tx.oncomplete=resolve});db.close()
    })
    await page.reload({waitUntil:'networkidle'})
    const route=page.getByRole('button',{name:language==='en'?'Switch route':'切换路线',exact:true})
    await route.click();await page.getByRole('menuitem',{name:'Reading branch',exact:true}).click()
    await page.locator('[data-message-id="branch-11"]').first().waitFor({state:'attached'})
    await move('branch-5')
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
    const branchSaved=await page.evaluate(({KEY,branchKey})=>JSON.parse(localStorage.getItem(KEY))[branchKey],{KEY,branchKey})
    assert.equal(branchSaved.messageId,'branch-5')
    assert.equal((await checkpoint()).messageId,'reading-15','branch checkpoint does not overwrite the main route')
    await route.click();await page.getByRole('menuitem',{name:language==='en'?'Main':'主线',exact:true}).click()
    await page.waitForFunction(({KEY,thread})=>{
      const root=document.querySelector('[data-testid="conversation-scroll"]'),p=JSON.parse(localStorage.getItem(KEY))[thread]
      const anchor=root.querySelector('[data-message-id="'+p.messageId+'"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top-root.getBoundingClientRect().top-p.offset)<3
    },{KEY,thread})
    await openSettings(page);await toggle.click();await page.waitForFunction(()=>!document.querySelector('[data-testid="settings-remember-reading-position"]').checked);await page.keyboard.press('Escape')
    const unchanged=await checkpoint()
    await move('reading-3');await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
    assert.deepEqual(await checkpoint(),unchanged,'turning off stops checkpoint writes immediately')
    await page.reload({waitUntil:'networkidle'})
    await page.waitForFunction(()=>{const root=document.querySelector('[data-testid="conversation-scroll"]');return root.scrollHeight-root.clientHeight-root.scrollTop<65})
    assert.deepEqual(errors,[])
    console.log('PASS reading memory '+language+'/'+width+'px: opt-in, 10s save, exit save, reload, separate branch/main restoration and disabling')
    await context.close()
  }
} finally {await browser.close()}
