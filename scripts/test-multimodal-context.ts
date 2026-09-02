import { buildContextMessages, buildApiMessages, countImageParts, DEFAULT_IMAGE_CONTEXT } from '../src/api/deepseek.ts'
import type { Message } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const msg = (id:string, role:'user'|'assistant', content:string, images:string[]):Message => ({ id, role, content, images, createdAt:1, updatedAt:1 })
const toData = async (id:string) => 'data:image/png;base64,AAAA'

// history: [user img turn (t1), assistant, user img turn (t2), assistant, current user img turn (t3)]
const t1 = msg('u1','user','前文图',['a','b'])
const a1 = msg('a1','assistant','回复1',[])
const t2 = msg('u2','user','追问',['c'])
const a2 = msg('a2','assistant','回复2',[])
const t3 = msg('u3','user','当前附图',['d','e','f'])
const history: Message[] = [t1, a1, t2, a2, t3]
const allImages = (msgs: Message[]) => msgs.reduce((s,m)=>s+m.images.length,0)

// 1) default policy (keepRecentImageTurns=1): only the most recent image turn keeps images.
{
  const ctx = buildContextMessages(history)
  assert(allImages(ctx) === 3, 'default keeps only current turn (3 images: d,e,f)')
  const t3c = ctx.find(m=>m.id==='u3')!; assert(t3c.images.length===3, 'current turn images retained')
  const t2c = ctx.find(m=>m.id==='u2')!; assert(t2c.images.length===0, 'previous image turn dropped')
  assert(t2c.content==='追问', 'dropped image turn keeps TEXT')
  const t1c = ctx.find(m=>m.id==='u1')!; assert(t1c.images.length===0, 'first image turn dropped')
  assert(ctx.length===history.length, 'message count unchanged (only images pruned)')
  assert(ctx.find(m=>m.id==='a1')!.role==='assistant', 'assistant messages untouched')
}

// 2) keepRecentImageTurns=2 keeps the two most recent image turns.
{
  const ctx = buildContextMessages(history, { keepRecentImageTurns: 2 })
  assert(allImages(ctx) === 3+1, 'keeps t3(3) + t2(1) images')
  assert(ctx.find(m=>m.id==='u1')!.images.length===0, 'oldest turn dropped')
  assert(ctx.find(m=>m.id==='u2')!.images.length===1, 't2 retained')
  assert(ctx.find(m=>m.id==='u3')!.images.length===3, 't3 retained')
}

// 3) keepRecentImageTurns=3 keeps all three.
{
  const ctx = buildContextMessages(history, { keepRecentImageTurns: 3 })
  assert(allImages(ctx) === 2+1+3, 'keep=3 keeps all (a,b,c,d,e,f)')
}

// 4) keepRecentImageTurns=0 -> text-only (no images).
{
  const ctx = buildContextMessages(history, { keepRecentImageTurns: 0 })
  assert(allImages(ctx) === 0, 'keep=0 drops ALL images (text-only request)')
  assert(ctx.every(m=>m.content !== undefined), 'text retained across all messages')
}

// 5) The request built from the filtered context encodes exactly the retained images.
{
  const ctx = buildContextMessages(history) // default: 3 images
  const api = await buildApiMessages(ctx, toData)
  assert(countImageParts(api) === 3, 'encoded image parts === retained images (3)')
  assert(countImageParts(api) === ctx.reduce((s,m)=>s+m.images.length,0), 'invariant: encoded === context-expected')
}

// 6) buildApiMessages is UNCHANGED for callers that want full history (decoupling kept).
{
  const api = await buildApiMessages(history, toData)
  assert(countImageParts(api) === allImages(history), 'raw buildApiMessages still encodes ALL images when given full history')
}

// 7) Empty history / single text turn edge cases.
{
  assert(buildContextMessages([]).length === 0, 'empty history -> empty')
  const textOnly: Message[] = [msg('x','user','纯文本',[])]
  const ctx = buildContextMessages(textOnly)
  assert(ctx[0].images.length===0 && ctx[0].content==='纯文本', 'text-only turn untouched')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

