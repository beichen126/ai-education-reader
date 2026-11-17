import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg,createBranchFromMessage} from './e2e-fixture.mjs'
const pending=new Set()
const delta=text=>'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n'
const server=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*')
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'POST, GET, OPTIONS'});res.end();return}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.flushHeaders()
  pending.add(res);res.on('close',()=>pending.delete(res))
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await launchBrowser()
try {
  for(const branch of [false,true]){
    const page=await browser.newPage({viewport:{width:1280,height:900}})
    await seedAndBoot(page,{convs:[
      {id:'chat-a',title:'Chat Alpha',createdAt:2,updatedAt:2,messages:[msg('u','user','Root question'),msg('a','assistant','Root answer')]},
      {id:'chat-b',title:'Chat Beta',createdAt:1,updatedAt:1,messages:[msg('bu','user','Other question'),msg('ba','assistant','Other answer')]},
    ],settings:{lastConversationId:'chat-a',apiKey:'mock',apiBaseUrl:`http://127.0.0.1:${server.address().port}`,model:'deepseek-flash',webSearchEnabled:false}})
    if(branch)await createBranchFromMessage(page,0)
    await page.unroute('**/chat/completions')
    await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('Continue')
    await page.keyboard.press('Enter')
    await page.getByRole('button',{name:'停止生成',exact:true}).waitFor()
    const switchTo=title=>page.locator('[data-testid="history-session"]').filter({hasText:title}).click()
    await switchTo('Chat Beta')
    await page.getByText('Other answer',{exact:true}).waitFor()
    await page.locator('[data-testid="background-generation"]').waitFor()
    await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('Keep my draft')
    while(!pending.size)await new Promise(r=>setTimeout(r,20))
    for(const res of pending)res.write(delta('FIRST_TOKEN'))
    await page.waitForTimeout(300)
    assert.equal(await page.getByText('FIRST_TOKEN',{exact:true}).count(),0)
    await page.getByRole('button',{name:'返回查看',exact:true}).click()
    await page.getByText('FIRST_TOKEN',{exact:true}).waitFor()
    assert.equal(pending.size,1,'switching keeps the original stream alive')
    await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('Next Alpha draft')
    await switchTo('Chat Beta')
    assert.equal(await page.getByRole('textbox',{name:'输入消息',exact:true}).inputValue(),'Keep my draft')
    if(branch)await page.getByRole('button',{name:'停止后台生成',exact:true}).click()
    else for(const res of pending)res.end(delta('_FINAL')+'data: [DONE]\n\n')
    await page.locator('[data-testid="background-generation"]').waitFor({state:'hidden'})
    assert.equal(await page.getByText('FIRST_TOKEN_FINAL',{exact:true}).count(),0)
    await switchTo('Chat Alpha')
    await page.getByText(branch?'FIRST_TOKEN':'FIRST_TOKEN_FINAL',{exact:true}).waitFor()
    // Navigation renders immediately; wait for its separate IndexedDB selection
    // write before deliberately destroying the page to test durable restoration.
    await page.waitForFunction(() => new Promise(resolve => {
      const request=indexedDB.open('ai-education-reader')
      request.onerror=()=>resolve(false)
      request.onsuccess=()=>{
        const db=request.result
        const read=db.transaction('settings','readonly').objectStore('settings').get('lastConversationId')
        read.onsuccess=()=>{const ready=read.result?.value==='chat-a';db.close();resolve(ready)}
        read.onerror=()=>{db.close();resolve(false)}
      }
    }))
    assert.equal(await page.getByRole('textbox',{name:'输入消息',exact:true}).inputValue(),'Next Alpha draft','settled background sends preserve newly edited owner drafts')
    await page.reload({waitUntil:'networkidle'})
    await page.getByText(branch?'FIRST_TOKEN':'FIRST_TOKEN_FINAL',{exact:true}).waitFor()
    await page.close();for(const res of pending)res.destroy()
    console.log('PASS background '+(branch?'branch':'root')+': navigation before first delta, token/draft isolation, stop/completion and persistence')
  }
} finally {for(const res of pending)res.destroy();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
