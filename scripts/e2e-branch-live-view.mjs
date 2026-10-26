import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg,createBranchFromMessage} from './e2e-fixture.mjs'
const pending=new Set()
const sse=text=>'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n'
const server=createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*')
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'POST, GET, OPTIONS'});res.end();return}
  if(!req.url.includes('/chat/completions')){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'})
  res.flushHeaders();res.write(sse('LIVE_FIRST'))
  pending.add(res);res.on('close',()=>pending.delete(res))
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const browser=await launchBrowser()
try {
  for(const width of [1280,390])for(const branch of [false,true]){
    // The shared fixture waits for the desktop history title during seeding.
    const page=await browser.newPage({viewport:{width:1280,height:900}})
    await seedAndBoot(page,{convs:[{id:'live-view',title:'Live view',createdAt:1,updatedAt:1,messages:[msg('u','user','Root question'),msg('a','assistant','Root answer')]}],settings:{lastConversationId:'live-view',apiKey:'mock-only',apiBaseUrl:`http://127.0.0.1:${server.address().port}`,model:'deepseek-flash',webSearchEnabled:false}})
    await page.setViewportSize({width,height:900})
    if(branch)await createBranchFromMessage(page,0)
    await page.unroute('**/chat/completions')
    const question=`LIVE_QUESTION_${width}_${branch}`
    await page.getByRole('textbox',{name:'输入消息',exact:true}).fill(question)
    await page.keyboard.press('Enter')
    await page.getByRole('button',{name:'停止生成',exact:true}).waitFor()
    await page.locator('[data-message-id]').filter({hasText:question}).first().waitFor({timeout:5000})
    await page.getByText('LIVE_FIRST',{exact:true}).first().waitFor({timeout:5000})
    assert.ok(await page.getByRole('button',{name:'停止生成',exact:true}).isVisible(),'first delta visible before completion')
    assert.equal(pending.size,1,'upstream is still open')
    for(const res of pending)res.write(sse('_SECOND'))
    await page.getByText('LIVE_FIRST_SECOND',{exact:true}).first().waitFor({timeout:5000})
    if(branch){
      await page.getByRole('button',{name:'停止生成',exact:true}).click()
      await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'})
      assert.ok(await page.getByText('LIVE_FIRST_SECOND',{exact:true}).first().isVisible(),'stopped partial remains visible')
    }else {
      for(const res of pending)res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      await page.getByRole('button',{name:'停止生成',exact:true}).waitFor({state:'hidden'})
    }
    await page.reload({waitUntil:'networkidle'})
    await page.getByText('LIVE_FIRST_SECOND',{exact:true}).first().waitFor()
    if(branch){
      await page.getByRole('button',{name:'切换到主线',exact:true}).first().click()
      await page.getByText('LIVE_FIRST_SECOND',{exact:true}).waitFor({state:'hidden'})
      assert.ok(await page.getByText('Root answer',{exact:true}).first().isVisible(),'root stays separate')
    }
    await page.close()
    for(const res of pending)res.destroy()
    console.log(`PASS ${width}px ${branch?'branch':'root'}: accepted user and two deltas visible before completion, stop/final/reload and root isolation`)
  }
}finally {for(const res of pending)res.destroy();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
