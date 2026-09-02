import { parseMarkdown } from '../src/markdown/parse.ts'
import { mathIdOf, mathKindOf, startOf, endOf } from '../src/markdown/block-layer.ts'
import { conversationMarkdown, markedOnlyMarkdown } from '../src/export/markdown.ts'
import type { Annotation } from '../src/annotations/annotation-types.ts'
import type { Conversation } from '../src/engine/types.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
function mathNodes(content:string, mid:string){
  const root=parseMarkdown(content); const out:{kind:'inline'|'block';id:string}[]=[]
  const walk=(ns:any[])=>{for(const n of ns){ if(n.type==='inlineMath'||n.type==='math'){const kind=mathKindOf(n);out.push({kind,id:mathIdOf(mid,kind,startOf(n),endOf(n))})} if(n.children)walk(n.children)}}
  walk(root.children); return out
}
function mkConv(content:string):Conversation { return { id:'c-e', title:'数学导出', createdAt:1, updatedAt:1, messages:[{ id:'mE', role:'assistant', content, images:[], createdAt:1, updatedAt:1 }] } }
function mathAnn(mathId:string, kind:'inline'|'block', id:string):Annotation { return { id, conversationId:'c-e', messageId:'mE', target:{ type:'math', mathId, mathKind:kind }, createdAt:1, updatedAt:1, version:1 } }

const i1=mathNodes('公式 $E=mc^2$ 很重要。','mE')
const fullInline=conversationMarkdown(mkConv('公式 $E=mc^2$ 很重要。'),[mathAnn(i1[0].id,'inline','a-in')])
assert(fullInline.includes('$E=mc^2$')&&fullInline.includes('<!-- marked-math:start -->'),'full inline keeps $ source + marker')

const i2=mathNodes('$$\nE=mc^2\n$$','mE')
const fullBlock=conversationMarkdown(mkConv('$$\nE=mc^2\n$$'),[mathAnn(i2[0].id,'block','a-blk')])
assert(fullBlock.includes('$$\nE=mc^2\n$$')&&fullBlock.includes('<!-- marked-math:start -->'),'full block keeps $$ + marker')

const i3=mathNodes(String.raw`\(E=mc^2\)`,'mE')
const fullDelim=conversationMarkdown(mkConv(String.raw`\(E=mc^2\)`),[mathAnn(i3[0].id,'inline','a-del')])
assert(fullDelim.includes(String.raw`\(E=mc^2\)`)&&!fullDelim.includes('$E=mc^2$'),'full \( keeps original delimiter (not rewritten to $)')

const moContent = '# 数学\n\n公式 $E=mc^2$ 很重要。\n'
const iMO = mathNodes(moContent, 'mE')
const mo = markedOnlyMarkdown(mkConv(moContent),[mathAnn(iMO[0].id,'inline','a-mo')])
assert(mo.length>10&&mo.includes('## AI')&&mo.includes('$E=mc^2$')&&mo.includes('<!-- marked-math:start -->'),'marked-only math-only file non-empty with heading + laTeX + marker => '+JSON.stringify(mo.slice(0,100)))

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
