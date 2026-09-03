// Stage 9.4B: AI TOC domain tests (PURE) — parse/merge/mapping.
import { parseAiToc, mergeAiTocChunks, chunkTocPages, normalizeTitle } from '../src/documents/ai-toc.ts'
import {
  exactLabelToPage, labelsArePlainNumeric, buildInitialMapping, numericOffsetFromAnchor,
  applyGlobalOffset, pickVerificationAnchor, setManualPageOverride,
} from '../src/documents/toc-mapping.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- parse: valid JSON array ---
{
  const r = parseAiToc('[{"title":"  第一章  自然地理 ","level":1,"pageLabel":"1","tocPage":7}]')
  assert(r.ok === true, 'valid JSON array parses')
  if (r.ok) { assert(r.entries[0].title === '第一章 自然地理', 'title normalized (got ' + r.entries[0].title + ')'); assert(r.entries[0].pageLabel === '1' && r.entries[0].tocPage === 7, 'label/tocPage kept') }
}
// --- markdown fence handled ---
{
  const r = parseAiToc('the model may wrap\n\n```json\n[{"title":"A","level":1,"pageLabel":"1","tocPage":5}]\n```\nend')
  // Entire body is not a pure fenced block -> prose -> reject (we never scrape)
  assert(r.ok === false, 'prose wrapping a fence is rejected (no scraping)')
  const r2 = parseAiToc('```json\n[{"title":"A","level":1,"pageLabel":"1","tocPage":5}]\n```')
  assert(r2.ok === true, 'pure fenced block is accepted/normalized')
}
// --- missing title rejected ---
{
  const r = parseAiToc('[{"title":"","level":1,"pageLabel":"1","tocPage":5}]')
  assert(r.ok === false, 'empty title rejected')
}
// --- invalid level rejected ---
{
  assert(parseAiToc('[{"title":"A","level":0,"pageLabel":"1","tocPage":5}]').ok === false, 'level 0 rejected')
  assert(parseAiToc('[{"title":"A","level":1.5,"pageLabel":"1","tocPage":5}]').ok === false, 'fractional level rejected')
}
// --- empty pageLabel rejected ---
{
  assert(parseAiToc('[{"title":"A","level":1,"pageLabel":"","tocPage":5}]').ok === false, 'empty pageLabel rejected')
}
// --- numeric pageLabel accepted (stringified), non-array rejected ---
{
  const r = parseAiToc('[{"title":"A","level":1,"pageLabel":37,"tocPage":5}]')
  assert(r.ok === true && r.ok && r.entries[0].pageLabel === '37', 'numeric pageLabel stringified')
  assert(parseAiToc('{"not":"array"}').ok === false, 'non-array top-level rejected')
}
// --- merge: chunk order preserved, exact adjacent duplicate deduped ---
{
  const merged = mergeAiTocChunks([
    [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7 }],
    [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7 }, { title: 'B', level: 2, pageLabel: '2', tocPage: 8 }],
  ])
  assert(merged.length === 2 && merged[0].title === 'A' && merged[1].title === 'B', 'chunk merge keeps order + dedupes exact adjacent duplicate')
  assert(merged[0].tocPage === 7, 'chunk 1 tocPage kept')
}
// --- similar-but-not-equal title NOT deduped ---
{
  const merged = mergeAiTocChunks([
    [{ title: '第一章 自然地理', level: 1, pageLabel: '1', tocPage: 7 }],
    [{ title: '第一章 自然地理学', level: 1, pageLabel: '1', tocPage: 7 }],
  ])
  assert(merged.length === 2, 'similar-but-different title NOT deduped (got ' + merged.length + ')')
}
// --- chunkTocPages ---
{
  const c = chunkTocPages([7,8,9,10,11,12,13,14,15], 4)
  assert(JSON.stringify(c) === JSON.stringify([[7,8,9,10],[11,12,13,14],[15]]), 'chunk by 4 (got ' + JSON.stringify(c) + ')')
}
// --- normalizeTitle ---
{
  assert(normalizeTitle('  第  一章  ') === '第 一章', 'normalizeTitle collapses + trims')
}

// --- exact label mapping ---
{
  const labels = ['i','ii','iii','1','2','3','4']
  assert(exactLabelToPage(labels, 'iii') === 3, 'exact roman label -> page 3')
  assert(exactLabelToPage(labels, '1') === 4, 'exact arabic label -> page 4')
  assert(exactLabelToPage(labels, '9') === 0, 'missing label -> 0 (no guess)')
}
// --- plain numeric detection ---
{
  assert(labelsArePlainNumeric(['1','2','3']) === true, 'plain numeric labels true')
  assert(labelsArePlainNumeric(['i','ii']) === false, 'roman labels false')
  assert(labelsArePlainNumeric(null) === false, 'null labels false')
}
// --- buildInitialMapping leaves unresolved when no exact match ---
{
  const items = buildInitialMapping([{ title: 'A', level: 1, pageLabel: '1', tocPage: 7 }], ['1','2'])
  assert(items[0].startPage === 1, 'exact label -> physical page 1')
  const items2 = buildInitialMapping([{ title: 'B', level: 1, pageLabel: '99', tocPage: 7 }], ['1','2'])
  assert(items2[0].startPage === null, 'unmatched label -> null (unresolved)')
}
// --- numeric offset ---
{
  assert(numericOffsetFromAnchor(1, 15) === 14, 'offset from printed 1 -> PDF 15 = 14')
}
// --- applyGlobalOffset: numeric labels remapped, non-numeric/manual preserved ---
{
  const items = [
    { title: 'A', level: 1, pageLabel: '15', tocPage: 7, startPage: null },
    { title: 'B', level: 1, pageLabel: 'i', tocPage: 7, startPage: 3, manualOverride: true },
    { title: 'C', level: 1, pageLabel: '20', tocPage: 7, startPage: null },
  ]
  const remapped = applyGlobalOffset(items, 12)
  assert(remapped[0].startPage === 27, 'numeric label remapped (15+12=27)')
  assert(remapped[1].startPage === 3 && remapped[1].manualOverride === true, 'manual override preserved on global remap')
  assert(remapped[2].startPage === 32, 'second numeric remapped (20+12=32)')
}
// --- verification anchor picks farthest mapped item ---
{
  const items = [
    { title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: 15 },
    { title: 'B', level: 1, pageLabel: '57', tocPage: 7, startPage: 71 },
    { title: 'C', level: 1, pageLabel: 'x', tocPage: 7, startPage: null },
  ]
  const anchor = pickVerificationAnchor(items, 15)
  assert(anchor && anchor.title === 'B', 'verification anchor = farthest resolved ' + (anchor ? anchor.title : 'null'))
}
// --- setManualPageOverride marks override ---
{
  const items = [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: null }]
  const r = setManualPageOverride(items, 0, 31)
  assert(r[0].startPage === 31 && r[0].manualOverride === true, 'manual page override set + flagged')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
