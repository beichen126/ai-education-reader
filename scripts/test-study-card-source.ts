// v2.2.0 Stage 4 domain gate: which PDFs a saved reply really used.
// The extraction is structural only — it never guesses sources from prose.
import { extractStudyCardReference, type StudyCardAttachmentMeta } from '../src/study-cards/study-card-source.ts'
import type { Message } from '../src/engine/types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) } else { fail++; console.log('  FAIL: ' + message) }
}
function message(id: string, role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, images: [], createdAt: 1, updatedAt: 1, ...extra }
}
function pdfAttachment(id: string, documentId: string | undefined, fileName: string, pageNumber: number): StudyCardAttachmentMeta {
  return { id, name: fileName + ' p' + pageNumber, source: { type: 'pdf-page', ...(documentId ? { documentId } : {}), fileName, pageNumber } }
}

const documentNames = new Map<string, string>([['doc-A', '高等数学.pdf'], ['doc-B', '习题解答.pdf']])

// ---- 1. the turn PDF is turn context, earlier PDFs are prior context ----
{
  const path = [
    message('u1', 'user', '先看这几页', { pdfContexts: [{ documentId: 'doc-A', pageNumbers: [1, 2], createdAt: 1 }] }),
    message('a1', 'assistant', '这是第一章。'),
    message('u2', 'user', '再看这道题', { pdfContexts: [{ documentId: 'doc-B', pageNumbers: [88], createdAt: 2 }] }),
    message('a2', 'assistant', '这道题用到了第一章的定义。'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a2', attachmentsById: new Map(), documentNames })
  const turn = result.documentRefs.filter(ref => ref.relation === 'turn')
  const prior = result.documentRefs.filter(ref => ref.relation === 'prior-context')
  assert(turn.length === 1 && turn[0].documentId === 'doc-B', 'the PDF attached to this turn is turn context')
  assert(prior.length === 1 && prior[0].documentId === 'doc-A', 'an earlier PDF still in context is prior context')
  assert(result.userMessageId === 'u2', 'the extraction reports the user turn the reply answers')
  assert(turn[0].fileNameSnapshot === '习题解答.pdf', 'the turn ref carries the real file name')
  assert(prior[0].fileNameSnapshot === '高等数学.pdf', 'the prior ref carries the real file name')
}

// ---- 2. the first reply of a conversation only has turn context ----
{
  const path = [
    message('u1', 'user', '看这一页', { pdfContexts: [{ documentId: 'doc-A', pageNumbers: [3], createdAt: 1 }] }),
    message('a1', 'assistant', '好。'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a1', attachmentsById: new Map(), documentNames })
  assert(result.documentRefs.length === 1 && result.documentRefs[0].relation === 'turn', 'the first reply has exactly one turn ref')
}

// ---- 3. turn wins when the same document appears in both ----
{
  const path = [
    message('u1', 'user', '第一轮', { pdfContexts: [{ documentId: 'doc-A', pageNumbers: [5], createdAt: 1 }] }),
    message('a1', 'assistant', '回答一'),
    message('u2', 'user', '第二轮', { pdfContexts: [{ documentId: 'doc-A', pageNumbers: [7], createdAt: 2 }] }),
    message('a2', 'assistant', '回答二'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a2', attachmentsById: new Map(), documentNames })
  const forDocA = result.documentRefs.filter(ref => ref.documentId === 'doc-A')
  assert(forDocA.length === 1, 'the same document is merged into one ref (got ' + forDocA.length + ')')
  assert(forDocA[0].relation === 'turn', 'the stronger turn relation wins over prior context')
  assert(forDocA[0].pageNumbers.join('|') === '5|7', 'the merged ref keeps every real page')
}

// ---- 4. prose page numbers are never sources ----
{
  const path = [
    message('u1', 'user', '总结一下'),
    message('a1', 'assistant', '请参见高等数学.pdf 第 3 页和第 12 页的内容。'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a1', attachmentsById: new Map(), documentNames })
  assert(result.documentRefs.length === 0, 'page numbers mentioned in prose never create a document ref')
}

// ---- 5. PDF page attachments contribute real provenance ----
{
  const attachments = new Map<string, StudyCardAttachmentMeta>([
    ['img-1', pdfAttachment('img-1', 'doc-B', '习题解答.pdf', 88)],
    ['img-2', pdfAttachment('img-2', 'doc-B', '习题解答.pdf', 90)],
    ['img-3', { id: 'img-3', name: 'photo.png' }],
  ])
  const path = [
    message('u1', 'user', '看这两页', { images: ['img-1', 'img-2', 'img-3'] }),
    message('a1', 'assistant', '看完了。'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a1', attachmentsById: attachments, documentNames })
  assert(result.documentRefs.length === 1, 'two pages of the same PDF merge into one ref')
  assert(result.documentRefs[0].pageNumbers.join('|') === '88|90', 'both attached pages are recorded')
  assert(!result.documentRefs.some(ref => ref.fileNameSnapshot === 'photo.png'), 'an ordinary image is never treated as a PDF')
}

// ---- 6. a legacy attachment without a documentId keeps its snapshot but no id ----
{
  const attachments = new Map<string, StudyCardAttachmentMeta>([
    ['img-legacy', pdfAttachment('img-legacy', undefined, '旧讲义.pdf', 4)],
  ])
  const path = [
    message('u1', 'user', '看这页', { images: ['img-legacy'] }),
    message('a1', 'assistant', '好。'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a1', attachmentsById: attachments, documentNames })
  assert(result.documentRefs.length === 1 && result.documentRefs[0].documentId === undefined, 'a legacy ref keeps no documentId')
  assert(result.documentRefs[0].fileNameSnapshot === '旧讲义.pdf', 'the legacy ref keeps a readable file name snapshot')
}

// ---- 7. pages are deduplicated, sorted and bounded to the whole path ----
{
  const attachments = new Map<string, StudyCardAttachmentMeta>([
    ['img-1', pdfAttachment('img-1', 'doc-A', '高等数学.pdf', 3)],
  ])
  const path = [
    message('u1', 'user', '第一轮', { images: ['img-1'], pdfContexts: [{ documentId: 'doc-A', pageNumbers: [12, 3, 12], createdAt: 1 }] }),
    message('a1', 'assistant', '回答一'),
    message('u2', 'user', '第二轮'),
    message('a2', 'assistant', '回答二'),
  ]
  const result = extractStudyCardReference({ path, assistantMessageId: 'a2', attachmentsById: attachments, documentNames })
  const refA = result.documentRefs.find(ref => ref.documentId === 'doc-A')
  assert(!!refA && refA.pageNumbers.join('|') === '3|12', 'the page set is unique, sorted and merged across provenance sources')
  assert(!!refA && refA.relation === 'prior-context', 'a PDF from an earlier turn is prior context for a later reply')
}

// ---- 8. an assistant message that is not on the path yields nothing ----
{
  const path = [message('u1', 'user', '问题'), message('a1', 'assistant', '回答')]
  const result = extractStudyCardReference({ path, assistantMessageId: 'nope', attachmentsById: new Map(), documentNames })
  assert(result.documentRefs.length === 0 && result.userMessageId === undefined, 'an off-path message produces no sources')
}

console.log(`RESULT pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
