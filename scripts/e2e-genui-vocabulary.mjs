import assert from 'node:assert/strict'
import {launchBrowser} from './e2e-browser.mjs'
import {seedAndBoot,msg} from './e2e-fixture.mjs'
const browser=await launchBrowser()
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}),tts=[],errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 const pcm=Buffer.alloc(16000*2*10),wav=Buffer.alloc(44+pcm.length)
 wav.write('RIFF');wav.writeUInt32LE(36+pcm.length,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40)
 await page.route('https://api.deepseek.com/v1/tools/tts',async route=>{
  assert.equal(route.request().headers().authorization,'Bearer ds-word-test')
  tts.push(route.request().postDataJSON());await route.fulfill({contentType:'audio/wav',body:wav})
 })
 let chatCalls=0
 await page.route('**/chat/completions',route=>{chatCalls++;return route.abort()})
 const spec={schema:'reader-vocabulary',title:'单词学习',items:[{type:'vocabulary',word:'analytics',phonetic:'/ˌænəˈlɪtɪks/',meaning:'n. 数据分析；分析学',example:'We use analytics to understand learning progress.'}]}
 await seedAndBoot(page,{convs:[{id:'word-chat',title:'Word cards',createdAt:1,updatedAt:1,messages:[msg('word-answer','assistant','```dsh-ui\n'+JSON.stringify(spec)+'\n```')]}],settings:{lastConversationId:'word-chat',appearance:'dark',apiBaseUrl:'https://other.example/v1',apiKey:'other-key',model:'text-only-model',apiProfiles:JSON.stringify([{id:'ds',name:'DeepSeek',config:{apiBaseUrl:'https://api.deepseek.com',apiKey:'ds-word-test',model:'deepseek-flash',visionCapability:'auto'}}])}})
 const card=page.locator('[data-testid="genui-word-card"]')
 await card.getByText('analytics',{exact:true}).waitFor()
 await card.getByText('/ˌænəˈlɪtɪks/',{exact:true}).waitFor()
 assert.equal(tts.length,0,'no autoplay')
 await card.getByLabel('单词音色',{exact:true}).selectOption('tide')
 await card.getByLabel('单词朗读倍速',{exact:true}).selectOption('0.75')
 await card.getByRole('button',{name:'朗读单词 analytics',exact:true}).click()
 await page.locator('[data-testid="read-aloud-pause"]').waitFor()
 assert.equal(tts.length,1);assert.equal(tts[0].text,'analytics');assert.equal(tts[0].voice_id,'tide')
 await card.getByLabel('单词朗读倍速',{exact:true}).selectOption('1.5')
 await page.getByText(/英文 · 1.5×/).waitFor()
 assert.equal(tts.length,1,'speed changes locally without synthesizing again')
 await card.getByRole('button',{name:'停止单词朗读',exact:true}).click()
 assert.equal(await page.locator('[data-testid="read-aloud-player"]').count(),0)
 await page.screenshot({path:'tmp/vocabulary-desktop.png'})
 await page.setViewportSize({width:390,height:844})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 await page.screenshot({path:'tmp/vocabulary-mobile.png'})
 assert.equal(chatCalls,0,'word controls do not send chat messages')
 assert.deepEqual(errors,[])
 console.log('PASS vocabulary word/IPA/meaning, explicit playback, official DS key, voice, live speed without request, stop and mobile layout')
} finally {await browser.close()}
