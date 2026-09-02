import { parseAndValidate, BackupError } from '../src/export/backup-import.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const clone = (x:any) => JSON.parse(JSON.stringify(x))
const b64 = (n:number) => Buffer.from(new Array(n).fill(7)).toString('base64')

function validBackup(){ return {
  format:'ai-education-reader-backup', version:1, exportedAt:1,
  settings:{ apiBaseUrl:'https://api.deepseek.com', model:'deepseek-chat', customSystemPrompt:'', customSystemPromptEnabled:false },
  conversations:[{ id:'c1', title:'会话', createdAt:1, updatedAt:1, messages:[{ id:'m1', role:'user', content:'hi', images:['att1'], createdAt:1, updatedAt:1 }] }],
  annotations:[{ id:'a1', conversationId:'c1', messageId:'m1', target:{ type:'text', anchor:{scope:'block',blockId:'b1'}, start:0, end:2, quote:{exact:'hi',prefix:'',suffix:''} }, createdAt:1, updatedAt:1, version:1 }],
  attachments:[{ id:'att1', meta:{ id:'att1', name:'a.png', mimeType:'image/png', size:4, createdAt:1, updatedAt:1 }, mimeType:'image/png', data:b64(4) }],
}}

function mustReject(b:any, label:string){ let threw=false; try{ parseAndValidate(b) }catch(e){ threw = e instanceof BackupError } assert(threw, 'rejects '+label) }

// 1) valid backup passes.
assert(parseAndValidate(validBackup()) !== null, 'valid backup passes validation')

// 2) reference consistency.
{ const b=clone(validBackup()); b.conversations[0].messages[0].images=['missing-att']; mustReject(b, 'message referencing missing attachment') }
{ const b=clone(validBackup()); b.annotations[0].conversationId='nope'; mustReject(b, 'annotation referencing nonexistent conversation') }
{ const b=clone(validBackup()); b.annotations[0].messageId='nope'; mustReject(b, 'annotation referencing nonexistent message') }

// 3) annotation target validity.
{ const b=clone(validBackup()); b.annotations[0].target.type='bogus'; mustReject(b, 'annotation with unsupported target.type') }
{ const b=clone(validBackup()); b.annotations[0].target.type='math'; mustReject(b, 'math annotation missing mathId/mathKind') }
{ const b=clone(validBackup()); b.annotations[0].target={ type:'table-cells', tableId:'t1', bounds:{rowStart:-1,rowEnd:0,columnStart:0,columnEnd:1} }; mustReject(b, 'out-of-range table-cells bounds') }

// 4) attachment integrity.
{ const b=clone(validBackup()); b.attachments[0].meta.id='DIFFERENT'; mustReject(b, 'attachment meta.id !== at.id') }
{ const b=clone(validBackup()); b.attachments[0].mimeType='application/pdf'; mustReject(b, 'invalid attachment mimeType') }
{ const b=clone(validBackup()); b.attachments[0].data='not valid base64 !!!'; mustReject(b, 'invalid attachment base64') }

// 5) message / conversation shape.
{ const b=clone(validBackup()); b.conversations[0].messages[0].role='system'; mustReject(b, 'invalid message.role') }
{ const b=clone(validBackup()); b.conversations[0].messages[0].content=5; mustReject(b, 'non-string message.content') }
{ const b=clone(validBackup()); b.conversations[0].messages[0].images=[1,2]; mustReject(b, 'non-string images entries') }
{ const b=clone(validBackup()); delete b.conversations[0].title; mustReject(b, 'conversation missing title') }
{ const b=clone(validBackup()); b.conversations[0].createdAt='now'; mustReject(b, 'non-number timestamps') }

// 6) corrupt base64 that atob rejects.
{ const b=clone(validBackup()); b.attachments[0].data='===='; mustReject(b, 'malformed base64 padding') }

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)
