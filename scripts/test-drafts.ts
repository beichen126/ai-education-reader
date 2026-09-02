import { setDraftText, addDraftImages, getDraft, clearDraft, deleteDraft, removeDraftImage } from '../src/engine/draft-store.ts'

let pass=0, fail=0
function assert(c:boolean,m:string){ if(c){pass++;console.log('  ok: '+m)}else{fail++;console.log('  FAIL: '+m)} }
const join = (s:string[]) => s.join(',')

// A / B text isolation.
{
  setDraftText('A', 'aaa'); setDraftText('B', 'bbb')
  assert(getDraft('A').text === 'aaa', 'A text independent')
  assert(getDraft('B').text === 'bbb', 'B text independent')
}

// A / B image isolation.
{
  addDraftImages('A', ['img1','img2']); addDraftImages('B', ['img3'])
  assert(join(getDraft('A').imageIds) === 'img1,img2', 'A images [img1,img2]')
  assert(join(getDraft('B').imageIds) === 'img3', 'B images [img3]')
  assert(!getDraft('A').imageIds.includes('img3'), 'A does not contain B image')
  assert(!getDraft('B').imageIds.includes('img1'), 'B does not contain A image')
}

// A -> B -> A restore (both text and images unchanged for A).
{
  const textA = getDraft('A').text
  const imgsA = [...getDraft('A').imageIds]
  setDraftText('B', 'bbb2'); addDraftImages('B', ['img4'])
  assert(getDraft('A').text === textA, 'A text restored after visiting B')
  assert(join(getDraft('A').imageIds) === join(imgsA), 'A images restored after visiting B')
}

// clearDraft only empties the draft; it does NOT delete attachments (design intent).
{
  addDraftImages('C', ['sent1','sent2'])
  clearDraft('C')
  assert(getDraft('C').imageIds.length === 0, 'clearDraft empties image ids')
  assert(getDraft('C').text === '', 'clearDraft empties text')
}

// removeDraftImage removes only the target image.
{
  addDraftImages('D', ['x','y','z'])
  removeDraftImage('D','y')
  assert(join(getDraft('D').imageIds) === 'x,z', 'removeDraftImage removes only the given id')
}

// deleteDraft removes the entry; next read materializes an empty one.
{
  setDraftText('E', 'temp')
  deleteDraft('E')
  assert(getDraft('E').text === '' && getDraft('E').imageIds.length === 0, 'deleteDraft -> fresh empty draft')
}

// Two conversations never share a draft object.
{
  assert(getDraft('A') !== getDraft('B'), 'different conversations hold distinct draft objects')
}

console.log('\nRESULT pass='+pass+' fail='+fail)
process.exit(fail===0?0:1)

