import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg,createBranchFromMessage} from './e2e-fixture.mjs'
const pending=new Set()
const delta=text=>'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:null}]})+'\n\n'
async function waitForStreams(count) {
  const until = Date.now() + 10000
  while (pending.size !== count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pending.size, count)
}
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
    const composer = page.getByRole('textbox',{name:'输入消息',exact:true})
    await waitForStreams(1)
    const [alpha] = pending
    await composer.fill('Start Beta while Alpha is generating')
    await page.getByRole('button',{name:'发送',exact:true}).click()
    await waitForStreams(2)
    const beta = [...pending].find(response => response !== alpha)
    alpha.write(delta('FIRST_TOKEN'))
    beta.write(delta('BETA_TOKEN'))
    await page.getByText('BETA_TOKEN',{exact:true}).waitFor()
    assert.equal(await page.getByText('FIRST_TOKEN',{exact:true}).count(),0)
    await page.getByRole('button',{name:'返回查看',exact:true}).click()
    await page.getByText('FIRST_TOKEN',{exact:true}).waitFor()
    assert.equal(pending.size,2,'switching keeps both streams alive')
    assert.equal(await page.getByText('BETA_TOKEN',{exact:true}).count(),0)
    await composer.fill('Next Alpha draft')
    await switchTo('Chat Beta')
    await composer.fill('Next Beta draft')
    await page.getByRole('button',{name:'停止生成',exact:true}).click()
    await waitForStreams(1)
    assert.ok(pending.has(alpha),'stopping Beta leaves Alpha running')
    if (branch) {
      await page.getByRole('button',{name:'返回查看',exact:true}).click()
      await page.getByRole('button',{name:'停止生成',exact:true}).click()
      await switchTo('Chat Beta')
    } else {
      alpha.end(delta('_FINAL')+'data: [DONE]\n\n')
    }
    await page.locator('[data-testid="background-generation"]').waitFor({state:'hidden'})
    assert.equal(await composer.inputValue(),'Next Beta draft')
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
    assert.equal(await composer.inputValue(),'Next Alpha draft','settled background sends preserve newly edited owner drafts')
    await page.reload({waitUntil:'networkidle'})
    await page.getByText(branch?'FIRST_TOKEN':'FIRST_TOKEN_FINAL',{exact:true}).waitFor()
    await page.close();for(const res of pending)res.destroy()
    console.log('PASS background '+(branch?'branch':'root')+': navigation before first delta, token/draft isolation, stop/completion and persistence')
  }
} finally {for(const res of pending)res.destroy();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
