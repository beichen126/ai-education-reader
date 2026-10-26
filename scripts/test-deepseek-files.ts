import assert from 'node:assert/strict'
import { prepareDeepSeekFiles, DEEPSEEK_INLINE_BODY_BYTES, DeepSeekFilesError } from '../src/api/deepseek-files.ts'
import { sendTextChat, streamTextChat, type ApiChatMessage } from '../src/api/deepseek.ts'

const original = globalThis.fetch
const image = (n:number) => ({ type:'image_url' as const, image_url:{url:'data:image/jpeg;base64,' + btoa('page-'+n)} })
const messages:ApiChatMessage[] = [{role:'user',content:[{type:'text',text:'selected only'},...Array.from({length:44},(_,i)=>image(i))]}]
let uploads=0, deletes=0, inFlight=0, peak=0
const request = {baseUrl:'https://api.deepseek.com',apiKey:'mock-key',messages}
try {
  globalThis.fetch = async (url, init) => {
    assert(String(url).startsWith('https://api.deepseek.com/files'))
    if(init?.method==='DELETE') { deletes++; return new Response('{}') }
    uploads++; inFlight++; peak=Math.max(peak,inFlight)
    assert(init?.body instanceof FormData)
    assert.equal(init.body.get('purpose'),'user_data')
    assert.equal(init.body.get('expires_after[seconds]'),'3600')
    const id=uploads
    await new Promise(r=>setTimeout(r,2));inFlight--
    return Response.json({id:'file-api-'+id})
  }
  const small=await prepareDeepSeekFiles(request,DEEPSEEK_INLINE_BODY_BYTES)
  assert.equal(small.messages,messages);assert.equal(uploads,0)
  const custom=await prepareDeepSeekFiles({...request,baseUrl:'https://proxy.example/v1'},DEEPSEEK_INLINE_BODY_BYTES+1)
  assert.equal(custom.messages,messages);assert.equal(uploads,0)
  const prepared=await prepareDeepSeekFiles(request,DEEPSEEK_INLINE_BODY_BYTES+1)
  assert.equal(uploads,44);assert.equal(peak,5)
  const parts=prepared.messages[0].content as any[]
  assert.equal(parts[0].text,'selected only')
  assert(parts.slice(1).every(p=>p.type==='file'&&p.file_id.startsWith('file-api-')))
  assert.equal((messages[0].content as any[])[1].type,'image_url','original history is never mutated')
  await prepared.cleanup();assert.equal(deletes,44)
  console.log('PASS: exact boundary, custom-provider isolation, 44 uploads / 5 workers, order, cleanup, unchanged history')

  // A real >48 MiB serialized chat with 44 selected pages reaches completions
  // through file references. No live provider calls / paid inference.
  const data='data:image/jpeg;base64,'+'A'.repeat(1_600_000)
  const large:ApiChatMessage[]=[{role:'user',content:Array.from({length:44},()=>({type:'image_url',image_url:{url:data}}))}]
  let completed=0,removed=0
  globalThis.fetch=async(url,init)=>{
    if(init?.method==='DELETE'){removed++;return Response.json({deleted:true})}
    if(String(url).endsWith('/files'))return Response.json({id:'file-api-large'})
    const body=JSON.parse(String(init?.body));assert(body.messages[0].content.every((p:any)=>p.type==='file'))
    completed++
    if(body.stream)return new Response('data: '+JSON.stringify({choices:[{delta:{content:'live'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
    return Response.json({choices:[{message:{content:'ok'}}]})
  }
  assert.equal((await sendTextChat({...request,messages:large,model:'deepseek-flash'})).content,'ok')
  let delta=''
  assert.equal((await streamTextChat({...request,messages:large,model:'deepseek-flash',onDelta:d=>{delta+=d}})).content,'live')
  assert.equal(delta,'live');assert.equal(completed,2);assert.equal(removed,2)
  console.log('PASS: large nonstream + SSE requests use Files API and clean up after completion')

  globalThis.fetch=async()=>new Response('{}',{status:403})
  await assert.rejects(prepareDeepSeekFiles(request,DEEPSEEK_INLINE_BODY_BYTES+1),DeepSeekFilesError)
  const aborted=new AbortController();aborted.abort()
  await assert.rejects(prepareDeepSeekFiles({...request,signal:aborted.signal},DEEPSEEK_INLINE_BODY_BYTES+1),{name:'AbortError'})
  console.log('PASS: upload rejection / pre-cancellation never start model inference')
  await assert.rejects(prepareDeepSeekFiles({...request,messages:[{role:'user',content:Array.from({length:601},()=>image(1))}]},1000), /600/)
  let pending=0, cancelled=0
  globalThis.fetch=async(url,init)=>{
    if(init?.method==='DELETE'){cancelled++;return Response.json({deleted:true})}
    if(++pending===1)return Response.json({id:'file-api-cleanup'})
    return new Response('{}',{status:403})
  }
  await assert.rejects(prepareDeepSeekFiles(request,DEEPSEEK_INLINE_BODY_BYTES+1), /403/)
  assert.equal(cancelled,1,'partial upload is deleted after another upload fails')
  console.log('PASS: documented DeepSeek-only count limit and partial-failure cleanup')
} finally {globalThis.fetch=original}
