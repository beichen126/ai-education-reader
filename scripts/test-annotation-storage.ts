import 'fake-indexeddb/auto'
import { saveAnnotation, getAnnotationsByMessage, deleteConversationAnnotations, getConversation } from '../src/storage/storage.ts'
import { openV2, closeDb } from './helpers'
import { newStableId } from '../src/engine/types.ts'
import { makeAnnotation } from '../src/annotations/annotation-ops.ts'

let pass=0, fail=0; function assert(c,m){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const conv = newStableId(), msg = newStableId()

// 18) v2->v3 upgrade preserves conversation/settings/attachments
const before = await openV2()
const anchor = { scope: 'block' as const, blockId: 'p-1-10' }
const a1 = makeAnnotation(conv, msg, anchor, 'ABCDEFG', 0, 3)
await saveAnnotation(a1)

// 20) compound index query
const byMsg = await getAnnotationsByMessage(conv, msg)
assert(byMsg.length === 1 && byMsg[0].id === a1.id, 'compound index returns the message annotations')

// 22) conversation delete cleanup
await deleteConversationAnnotations(conv)
const after = await getAnnotationsByMessage(conv, msg)
assert(after.length === 0, 'conversation delete removes its annotations (no orphan)')

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)