import assert from 'node:assert/strict'
import { parseMarkdown } from '../src/markdown/parse'
import { mathKindOf } from '../src/markdown/block-layer'

const formula=String.raw`I=\int_0^1\ln(1+x)\,dx,\qquad
J=\int_0^1\frac{\sin^2 x}{1+x}\,dx,\qquad
K=\int_0^1\ln(1+\tan x)\,dx,`
for (const indent of ['', '  ', '   ', '    ']) {
  const source='题目：\n\n1. 设\n'+[String.raw`\[`,...formula.split('\n'),String.raw`\]`,'则（ ）。'].map(line=>indent+line).join('\n')+'\n\n(A) \\(I<J<K\\)'
  const root=parseMarkdown(source)
  const math: any[]=[]
  const walk=(node:any)=>{if(node.type==='math'||node.type==='inlineMath')math.push(node);node.children?.forEach(walk)}
  walk(root)
  assert.ok(math.some(node=>node.value.includes('I=\\int')), 'list display formula at indentation '+indent.length)
  const display=math.find(node=>node.value.includes('I=\\int'))
  assert.equal(mathKindOf(display),'block')
  assert.equal(source.slice(display.position.start.offset,display.position.end.offset).trim().startsWith('\\['),true)
  console.log('PASS list display math: '+indent.length+' spaces, block identity and original source offsets')
}
for(const source of ['`\\[x\\]`','```tex\n\\[x\\]\n```','text \\[incomplete']) {
  const root=parseMarkdown(source)
  const math:any[]=[]
  const walk=(node:any)=>{if(node.type==='math'||node.type==='inlineMath')math.push(node);node.children?.forEach(walk)}
  walk(root);assert.equal(math.length,0,'code and incomplete delimiters stay literal')
}
