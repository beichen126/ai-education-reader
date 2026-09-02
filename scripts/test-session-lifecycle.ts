import 'fake-indexeddb/auto'
import { initStore, sessionsActions, getSessionsCurrent } from '../src/engine/sessions-store.ts'
import { initSettings } from '../src/engine/settings-store.ts'
import { getSetting, listConversations } from '../src/storage/storage.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const LAST='lastConversationId'
const last = () => getSetting(LAST)
await initSettings()

// S1 (bug case, run first so no leftover convs): delete a NEWER non-current session.
// a,b,c created in order (a oldest, c newest). current=a. list desc = c,b,a.
{
  const a = await sessionsActions.newChat()
  const b = await sessionsActions.newChat()
  const c = await sessionsActions.newChat()
  await sessionsActions.open(a)      // current=a
  await sessionsActions.remove(c)    // delete newest non-current
  assert(getSessionsCurrent() === a, 'S1: current stays A after deleting newer C')
  assert((await last()) === a, 'S1: LAST_CONV = A (current)')
  assert((await last()) !== b, 'S1: LAST_CONV is NOT B (a naive list[0] fallback would pick B)')
}

// S2: delete the CURRENT session -> current becomes a valid remaining (newest); reload reopens it.
{
  const a = await sessionsActions.newChat()
  const b = await sessionsActions.newChat()
  const c = await sessionsActions.newChat()
  await sessionsActions.open(a)      // current=a
  const curAtDelete = getSessionsCurrent()
  await sessionsActions.remove(a)    // delete current
  const newCur = getSessionsCurrent()
  assert(newCur !== a, 'S2: after deleting current, a new current is chosen')
  assert(newCur !== undefined, 'S2: a current exists (not the last session)')
  assert((await last()) === newCur, 'S2: LAST_CONV === new current after deleting current')
  await initStore()                  // reload
  assert(getSessionsCurrent() === newCur, 'S2: reload reopens the SAME current chosen at delete time')
}

// S3: reload consistency invariant — LAST_CONV always tracks current.
{
  const a = await sessionsActions.newChat()
  const b = await sessionsActions.newChat()
  await sessionsActions.open(a)
  await sessionsActions.remove(b)    // delete non-current
  assert((await last()) === getSessionsCurrent(), 'S3: LAST_CONV === current (reload would reopen the visible session)')
  await initStore()
  assert(getSessionsCurrent() === a, 'S3: reload reopens the preserved current A')
}

// S4: deleting ALL sessions -> no current, LAST_CONV empty.
{
  const convs = await listConversations()
  for (const c of convs) await sessionsActions.remove(c.id)
  assert(getSessionsCurrent() === undefined, 'S4: no current after deleting ALL sessions')
  assert((await last()) === '', 'S4: LAST_CONV empty when no sessions remain')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

