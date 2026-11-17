import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot} from './e2e-fixture.mjs'
const browser=await launchBrowser()
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}})
 await seedAndBoot(page,{convs:[{id:'context-a',title:'Context Alpha',messages:[],createdAt:2,updatedAt:2},{id:'context-b',title:'Context Beta',messages:[],createdAt:1,updatedAt:1}],settings:{lastConversationId:'context-a'}})
 await page.locator('[data-testid="sidebar-entry-files"], [data-testid="rail-files"]').first().click()
 await page.locator('[data-testid="document-library"] input[type="file"]').setInputFiles('test/fixtures/outline-sample.pdf')
 await page.locator('[data-testid="document-reader"]').waitFor()
 await page.locator('[data-testid="reader-close"]').click()
 if(await page.locator('[data-testid="library-close"]').isVisible())await page.locator('[data-testid="library-close"]').click()
 await page.evaluate(()=>{
   window.pdfCancelled=0;window.pdfPending=[]
   window.AndroidPdf={request(id,raw){const request=JSON.parse(raw);if(request.op==='render'){window.pdfPending.push(id);return}setTimeout(()=>window.postMessage({channel:'reader-pdf-response',id},location.origin),0)},cancel(){window.pdfCancelled++}}
 })
 for(const action of ['cancel','switch']){
   if(action==='switch')await page.setViewportSize({width:390,height:850})
   await page.locator('[data-testid="composer-attach"]').click()
   await page.locator('[data-testid="composer-from-library"]').click()
   await page.locator('[data-testid^="doc-context-doc-"]').first().click()
   await page.locator('[data-testid="doc-context-whole"]').click()
   await page.locator('[data-testid="doc-context-add"]').click()
   if(await page.locator('[data-testid="doc-context-confirm-yes"]').isVisible())await page.locator('[data-testid="doc-context-confirm-yes"]').click()
   await page.locator('[data-testid="composer-ctx-cancel"]').waitFor()
   await page.waitForFunction(()=>window.pdfPending.length>window.pdfCancelled)
   if(action==='cancel')await page.locator('[data-testid="composer-ctx-cancel"]').click()
   else { await page.locator('[data-testid="mobile-menu-toggle"]').click(); await page.locator('[data-testid="history-session"]').filter({hasText:'Context Beta'}).click() }
   await page.locator('[data-testid="composer-notice"]').waitFor({state:'hidden'})
   await page.waitForFunction(expected=>window.pdfCancelled>=expected,action==='cancel'?1:2)
 }
 await page.evaluate(()=>{for(const id of window.pdfPending)window.postMessage({channel:'reader-pdf-response',id,error:'late reply'},location.origin)})
 await page.locator('[data-testid="mobile-menu-toggle"]').click()
 await page.locator('[data-testid="history-session"]').filter({hasText:'Context Alpha'}).click()
 assert.equal(await page.locator('[data-testid="composer-notice"]').count(),0)
 assert.equal(await page.locator('[data-testid="pdf-group-card"]').count(),0)
 console.log('PASS context lifecycle: cancel/switch dismiss progress immediately, abort native rendering and ignore late replies')
} finally {await browser.close()}
