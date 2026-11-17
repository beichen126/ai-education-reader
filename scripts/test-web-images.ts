import {prepareEmbeddedImages, embeddedImagePayload} from '../src/web-images/embedded'
import {processGenuiSpec,isRenderableProcess} from '../node_modules/@changfenhuang/dsh-genui/src/client/guard.ts'
import 'fake-indexeddb/auto'
import {requestWithImageKeys, configuredImageKeys} from '../src/web-images/key-pool'
import {patchSettings, initSettings, getSettingsSnapshot} from '../src/engine/settings-store'
import {deleteSetting} from '../src/storage/storage'
import assert from 'node:assert/strict'
import {parseImageQueries, WEB_IMAGE_PROMPT, withWebImageCapabilities} from '../src/web-images/protocol'
import {requestFirstImage} from '../src/web-images/search'
import {appendGenUiGuidance} from '../src/prompts/prompt-compile-strategies'
import {FULL_GENUI_PROMPT} from '../src/genui/catalog-prompt'
assert.equal(parseImageQueries('{"type":"image","query":"神经元"}').length,1)
assert.equal(parseImageQueries('{"type":"image-group","items":[{"query":"动物细胞"},{"query":"植物细胞"}]}').length,2)
assert.throws(()=>parseImageQueries('{"type":"image-group","items":[{"query":"动物细胞"}]}'))
assert.throws(()=>parseImageQueries('{"type":"image","query":"x"}'))
const messages:any=[{role:'user',content:'hello'}]
appendGenUiGuidance(messages)
assert.ok(!messages[0].content.includes(WEB_IMAGE_PROMPT),'unconfigured model receives no image capability')
assert.ok(FULL_GENUI_PROMPT.includes('使用 genui 代码围栏'))
assert.ok(!FULL_GENUI_PROMPT.includes('"schema":"dsh-genui"'))
const original=globalThis.fetch
try {
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://api.firecrawl.dev/v2/search')
    assert.deepEqual(JSON.parse(init!.body as string),{query:'neuron diagram',sources:['images'],limit:1})
    return Response.json({success:true,data:{images:[{imageUrl:'https://images.example/a.png',url:'https://example.org/source',title:'Neuron'},{imageUrl:'https://images.example/b.png'}]},creditsUsed:2})
  }
  assert.equal((await requestFirstImage('neuron diagram','test')).imageUrl,'https://images.example/a.png')
  globalThis.fetch=async()=>Response.json({success:true,data:{images:[{imageUrl:'javascript:alert(1)',url:'https://example.org'}]}})
  await assert.rejects(requestFirstImage('neuron','test'))
  globalThis.fetch=async()=>new Response('',{status:401})
  await assert.rejects(requestFirstImage('neuron','test'),/Key/)
  await assert.rejects(requestFirstImage('neuron',''),/配置/)
}finally{globalThis.fetch=original}
console.log('PASS simplified GenUI protocol, capability gating, single-result search and URL validation')

const pool=['1','2','3','4'].map(key=>({name:key,key}))
const calls:string[]=[]
await requestWithImageKeys(pool,async key=>{calls.push(key);if(key==='1')throw Object.assign(new Error('quota'),{status:402});return key})
assert.deepEqual(calls,['1','1','1','2'])
calls.length=0
await requestWithImageKeys(pool,async key=>{calls.push(key);if(key!=='1')throw Object.assign(new Error('quota'),{status:402});return key})
assert.deepEqual(calls,['2','2','2','3','3','3','4','4','4','1'],'wraps back to first key')
calls.length=0
await assert.rejects(requestWithImageKeys(pool,async key=>{calls.push(key);throw Object.assign(new Error('quota'),{status:402})}))
assert.equal(calls.length,12,'one cycle is bounded')
calls.length=0
await requestWithImageKeys(pool,async key=>{calls.push(key);if(key==='1')throw new Error('network');return key})
assert.deepEqual(calls,['1','2'],'network failure is not retried as quota')
assert.equal(configuredImageKeys({firecrawlKeys:[...pool,pool[0]]}).length,4)
await patchSettings({firecrawlKeys:pool})
await initSettings()
assert.deepEqual(getSettingsSnapshot().firecrawlKeys,pool)
const enabled:any=[{role:'user',content:'hello'}]
appendGenUiGuidance(enabled)
assert.ok(enabled[0].content.includes(WEB_IMAGE_PROMPT))
assert.ok(!enabled[0].content.includes('Bearer'))
await patchSettings({firecrawlKeys:[],firecrawlApiKey:''})
console.log('PASS 3 quota attempts, persisted rotation, wraparound, bounded failure, network classification and capability enablement')

const embedded = prepareEmbeddedImages({items:[{type:'card',title:'神经系统',items:[{type:'image',query:'人体神经系统 示意图'},{type:'text',content:'说明'}]}]})
assert.ok(isRenderableProcess(processGenuiSpec(embedded)))
assert.equal(JSON.parse(embeddedImagePayload(embedded.items[0].items[0].src)!).query,'人体神经系统 示意图')
console.log('PASS nested image nodes use safe host renderer inside native cards')

assert.ok(withWebImageCapabilities(FULL_GENUI_PROMPT).includes('image: query*:string'))
assert.ok(withWebImageCapabilities('自定义协议').includes('当前阅读器运行时能力'))
