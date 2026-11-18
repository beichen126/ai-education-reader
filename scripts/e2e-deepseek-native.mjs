import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot} from './e2e-fixture.mjs'
const browser=await launchBrowser()
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}}),requests=[]
 await page.route('https://api.deepseek.com/files',route=>route.fulfill({json:{id:'file-api-browser',expires_at:Date.now()/1000+3600}}))
 await page.route('**/chat/completions',async route=>{
  requests.push(route.request().postDataJSON())
  await route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({choices:[{delta:{content:'文件分析完成。',title:'文件学习笔记',server_tool_calls:[{index:0,calls:[]}],annotations:[{type:'url_citation',url_citation:{url:'https://example.com/source',title:'参考资料'}}]},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'})
 })
 await seedAndBoot(page,{convs:[
  {id:'native-test',title:'Native test',createdAt:1,updatedAt:1,messages:[]},
  {id:'other-chat',title:'Other chat',createdAt:2,updatedAt:2,messages:[]},
 ],settings:{apiKey:'test-native',apiBaseUrl:'https://api.deepseek.com',model:'deepseek-flash',lastConversationId:'native-test',webSearchEnabled:'true',userLocation:'杭州'}})
 await page.locator('[data-testid="composer-attach"]').click()
 await page.locator('[data-testid="composer-deepseek-files"]').click()
 await page.waitForFunction(()=>document.querySelector('input[aria-label="批量上传文件"]')?.disabled===false)
 await page.getByLabel('批量上传文件').setInputFiles({name:'lesson.txt',mimeType:'text/plain',buffer:Buffer.from('Hello')})
 await page.getByText('lesson.txt',{exact:true}).waitFor()
 await page.getByRole('dialog',{name:'DeepSeek 文件解析'}).screenshot({path:'tmp/deepseek-file-picker.png'})
 await page.getByRole('checkbox',{name:'lesson.txt'}).check()
 await page.getByRole('button',{name:/加入本次提问/}).click()
 const removeFile = page.getByRole('button',{name:'移除文件',exact:true})
 const switchChat = title => page.getByTestId('history-session').filter({hasText:title}).click()
 await removeFile.waitFor()
 await switchChat('Other chat')
 await removeFile.waitFor({state:'hidden'})
 await switchChat('Native test')
 await removeFile.waitFor()
 await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('总结文件')
 await page.locator('[data-testid="composer-send-stop"]').click()
 await removeFile.waitFor({state:'hidden'})
 await page.getByText('文件学习笔记',{exact:true}).first().waitFor()
 assert.equal(requests[0].title.enabled,true)
 assert.equal(requests[0].messages.at(-2).role,'latest_reminder')
 assert.ok(requests[0].messages.at(-1).content.some(p=>p.file_id==='file-api-browser'))
 await page.getByRole('link',{name:/参考资料/}).first().waitFor()
 await page.reload({waitUntil:'networkidle'})
 await page.getByRole('textbox',{name:'输入消息',exact:true}).fill('继续解释')
 await page.locator('[data-testid="composer-send-stop"]').click()
 await page.waitForFunction(()=>document.querySelector('[data-testid="composer-send-stop"]')?.getAttribute('aria-busy')==='false')
 assert.equal(requests.length,2);assert.equal(requests[1].title,undefined)
 assert.ok(requests[1].messages.find(m=>m.role==='assistant')?.server_tool_calls)
 await page.setViewportSize({width:390,height:844})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 console.log('PASS native document draft isolation, selection, metadata, auto title, citations and reload continuation')
} finally {await browser.close()}
