import {OMITTED_GENUI_TYPES} from '../src/genui/catalog-policy.ts'
import {readFileSync,writeFileSync} from 'node:fs'
import {GENUI_PROMPT_EXAMPLES} from '../src/genui/prompt-examples.ts'
import {COMPONENT_SCHEMAS,GENUI_SPEC_SCHEMA} from '../node_modules/@changfenhuang/dsh-genui/src/client/genui-runtime/schema.ts'
const common=new Set(['type','span','when','enableWhen','disabledReason'])
const describe=(s:any,depth=0):string=>{
 const fields=Object.keys(s.fields).filter(k=>!common.has(k)).map(k=>k+(s.required.includes(k)?'*':'')+':'+(s.enums[k]?s.enums[k].join('|'):s.fields[k])).join(',')
 const nested=Object.entries(s.nested).filter(([k])=>!common.has(k)).map(([k,v])=>k+'{'+(k==='children'?'name*:string,children:同结构数组':describe(v,depth+1))+'}').join(';')
 const alternatives=(s.oneOfRequired||[]).map((group:string[])=>'至少填写 '+group.join(' / ')).join('；')
 return fields+(nested?' ['+nested+']':'')+(alternatives?' （'+alternatives+'）':'')
}
const lines=Object.entries(COMPONENT_SCHEMAS).filter(([name])=>!OMITTED_GENUI_TYPES.has(name)).map(([name,s])=>name==='choices'?'choices: title:string,prompt:string,mode:single|multi,items*:[{label*:string,hint:string,disabled:boolean,reason:string}],max:number,answer:string|array,explanation:string,submit:string':name+': '+describe(s))
lines.unshift('ROOT: '+describe(GENUI_SPEC_SCHEMA))
const rules=readFileSync('src/genui/generation-rules.md','utf8').trim()
const examples=GENUI_PROMPT_EXAMPLES.map(({name,spec})=>name+'\n```genui\n'+JSON.stringify(spec)+'\n```').join('\n\n')
const intro=rules+'\n\n完整输出示例（每个围栏均可独立渲染）\n'+examples+'\n\n单词卡用独立 genui 围栏，根 schema="reader-vocabulary"，items 为 vocabulary 记录数组；word、phonetic、meaning、example 为字符串，word 最多120字、phonetic 最多200字、meaning/example 最多2000字。朗读由用户点击扬声器触发，音色、倍速与次数使用设置。\n\n组件字段目录（基础 '+(lines.length-1)+' 种，扩展以当前请求附带目录为准）：\n通用字段：span:number、disabledReason:string；when/enableWhen:{field:string,op:eq|neq|in|not-in|gt|gte|lt|lte|empty|not-empty|checked,value:对应字段的值}。card.accent 为颜色字符串，如 "#5b8def"；flat 为布尔值。\n'
writeFileSync('src/genui/catalog-prompt.ts','// Generated from @changfenhuang/dsh-genui 0.16.0. See THIRD_PARTY_NOTICES.\nexport const FULL_GENUI_PROMPT = '+JSON.stringify(intro+lines.join('\n'))+'\n')
console.log('catalog components',lines.length-1,'characters',intro.length+lines.join('\n').length)
