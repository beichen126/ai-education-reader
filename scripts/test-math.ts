import 'fake-indexeddb/auto'
import { parseMarkdown } from '../src/markdown/parse.ts'
import { buildBlockModels, mathIdOf, mathKindOf, startOf, endOf } from '../src/markdown/block-layer.ts'
import { toggleMath } from '../src/annotations/annotation-ops.ts'
import { toggleTextSelection } from '../src/annotations/annotation-service.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { saveAnnotation, getAnnotationsByMessage, saveConversation } from '../src/storage/storage.ts'
import { idbReplaceAll } from '../src/storage/idb.ts'
import type { Annotation } from '../src/annotations/annotation-types.ts'
import type { Conversation } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
function mathNodes(content:string, mid:string){
  const root=parseMarkdown(content); const out:{kind:'inline'|'block';id:string;slice:string}[]=[]
  const walk=(ns:any[])=>{for(const n of ns){ if(n.type==='inlineMath'||n.type==='math'){const kind=mathKindOf(n);out.push({kind,id:mathIdOf(mid,kind,startOf(n),endOf(n)),slice:content.slice(startOf(n),endOf(n))})} if(n.children)walk(n.children)}}
  walk(root.children); return out
}

console.log('=== mathId stability ===')
const a=mathNodes('公式 $E=mc^2$ 很重要。','m1')
assert(a.length===1&&a[0].kind==='inline'&&a[0].slice==='$E=mc^2$','inline $ -> inline math, slice keeps $ => '+JSON.stringify(a[0]))
const a2=mathNodes('公式 $E=mc^2$ 很重要。','m1')
assert(a2[0].id===a[0].id,'inline $ mathId stable across re-parse')
const blk='$$\nE=mc^2\n$$'
const b=mathNodes(blk,'m1')
assert(b.length===1&&b[0].kind==='block'&&b[0].slice===blk,'block $$ -> slice keeps block')
const c=mathNodes(String.raw`公式 \(E=mc^2\) 很重要。`,'m1')
assert(c.length===1&&c[0].kind==='inline'&&c[0].slice===String.raw`\(E=mc^2\)`,'inline \( -> original delimiter preserved')
const d=mathNodes(String.raw`\[\nE=mc^2\n\]`,'m1')
assert(d.length===1&&d[0].kind==='block'&&d[0].slice===String.raw`\[\nE=mc^2\n\]`,'block \[ -> block math slice')
const e=mathNodes('公式 $a+b$ 很重要。','m1')
assert(e[0].id!==a[0].id,'different math -> different mathId')

console.log('=== toggleMath add/remove ===')
const add=toggleMath('c1','m1',a[0].id,'inline',[])
assert(add.add.length===1&&add.keep.length===1&&add.keep[0].target.type==='math'&&add.keep[0].target.mathId===a[0].id,'toggleMath add')
const rem=toggleMath('c1','m1',a[0].id,'inline',add.keep)
assert(rem.remove.length===1&&rem.keep.length===0,'toggleMath remove')
const add2=toggleMath('c1','m1',a[0].id,'inline',[])
assert(toggleMath('c1','m1',b[0].id,'block',add2.keep).keep.length===2,'different math co-exist')

console.log('=== text offsets unchanged (§21) ===')
const para=String.raw`A \(x\) B -- 缓存利用时间局部性。`
const models=buildBlockModels(parseMarkdown(para),'m1')
const p=models.find(x=>x.type==='paragraph')!
assert(typeof p.canonicalText==='string'&&p.canonicalText.length>0,'paragraph canonicalText non-empty (no crash)')
const root2=parseMarkdown(para)
const im=root2.children[0].children.find((n:any)=>n.type==='inlineMath')
assert(!!im&&im.type==='inlineMath','inline math still parses')

console.log('=== malformed math does not crash ===')
let crashed=false
try{ parseMarkdown('先 $未闭合 后 \\ 文本') }catch{ crashed=true }
assert(!crashed,'malformed math does not throw')

console.log('=== backup includes + restores math annotation ===')
const bConv:Conversation={id:'c-math',title:'数学',createdAt:1,updatedAt:1,messages:[{id:'m1',role:'assistant',content:'公式 $E=mc^2$ 很重要。',images:[],createdAt:1,updatedAt:1}]}
const ann0:Annotation={id:'ann-m',conversationId:'c-math',messageId:'m1',target:{type:'math',mathId:a[0].id,mathKind:'inline'},createdAt:1,updatedAt:1,version:1}
await saveConversation(bConv); await saveAnnotation(ann0)
const backup=await buildBackup()
assert(!!backup.annotations.find(x=>x.target.type==='math'&&x.target.mathId===a[0].id),'backup includes math annotation')
await idbReplaceAll({settings:[],conversations:[],attachments:[],annotations:[]})
await restoreBackup(parseAndValidate(JSON.parse(JSON.stringify(backup))))
const after=await getAnnotationsByMessage('c-math','m1')
assert(after.length===1&&after[0].target.type==='math'&&after[0].target.mathId===a[0].id,'import restores math annotation')

console.log('=== text toggle with non-text annotation present (regression: no undefined.scope crash) ===')
const mAnn0: Annotation = { id:'ann-mm', conversationId:'c1', messageId:'m1', target:{ type:'math', mathId:'c1/math-inline-3-11', mathKind:'inline' }, createdAt:1, updatedAt:1, version:1 }
await saveAnnotation(mAnn0)
const seg0 = { messageId:'m1', blockId:'some-block', start:0, end:2, exact:'AB', prefix:'', suffix:'' }
let crash2=false, out: any[]=[]
try { out = await toggleTextSelection('c1','m1',[seg0], (a)=>'AB') } catch(e){ crash2=true; console.log('  threw: '+e) }
assert(!crash2, 'toggleTextSelection with existing math annotation does NOT crash')
assert(out.some((a)=>a.target.type==='math'), 'math annotation preserved after text toggle')
assert(out.some((a)=>a.target.type==='text'), 'text annotation added')

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

