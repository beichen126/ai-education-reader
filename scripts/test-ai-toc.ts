// Stage 9.4C.1: AI TOC domain tests (PURE) — strict JSONL transcription, source-page
// mapping, structure parse/validate, boundary dedupe, review single-source validation.
import {
  parseTocJsonl, parseTocStructure, validateTocStructure, assignLocalRowIds,
  mapTocSourcePages, reindexRows, dedupeBoundaryRows, normalizeTitle, normalizeTocLevels,
} from '../src/documents/ai-toc.ts'
import {
  exactLabelToPage, labelsArePlainNumeric, buildInitialMapping, numericOffsetFromAnchor,
  applyGlobalOffset, pickVerificationAnchor, setManualPageOverride, validateMappedTocReview,
} from '../src/documents/toc-mapping.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- strict JSONL parse: valid lines + sourceImageIndex ---
{
  const r = parseTocJsonl('{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n{"title":"第一节 研究对象","pageLabel":"3","sourceImageIndex":2}\n')
  assert(r.ok === true, 'valid JSONL transcript parses');
  if (r.ok) { assert(r.rows.length === 2, '2 rows'); assert(r.rows[0].sourceImageIndex === 1 && r.rows[1].sourceImageIndex === 2, 'sourceImageIndex kept') }
}
// --- strict: ANY malformed nonblank line invalidates whole result ---
{
  const r = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\nnot-json\n{"title":"B","pageLabel":"2","sourceImageIndex":2}')
  assert(r.ok === false, 'malformed line -> whole result invalid (no partial)')
  if (!r.ok) assert((r as { diagnostics: string[] }).diagnostics.length === 1, 'one precise diagnostic');
}
// --- sourceImageIndex required ---
{
  const r = parseTocJsonl('{"title":"A","pageLabel":"1"}');
  assert(r.ok === false, 'missing sourceImageIndex -> invalid');
  const r0 = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":0}');
  assert(r0.ok === false, 'sourceImageIndex 0 -> invalid');
}
// --- whole fenced JSONL accepted ---
{
  const r = parseTocJsonl('```jsonl\n{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}\n```')
  assert(r.ok === true && r.ok && r.rows.length === 2, 'whole fenced JSONL accepted');
}
// --- normalizeTitle ---
{ assert(normalizeTitle('  第  一章  ') === '第 一章', 'normalizeTitle collapses + trims') }

// --- mapTocSourcePages: sourceImageIndex -> physical page from batch ---
{
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}')
  const rows = assignLocalRowIds(tl.ok ? tl.rows : []);
  const m = mapTocSourcePages(rows, [7, 8]);
  assert(m.ok === true, 'mapping ok');
  if (m.ok) assert(m.rows[0].tocPage === 7 && m.rows[1].tocPage === 8, 'tocPage derived locally (7,8)');
}
// --- invalid sourceImageIndex invalidates batch (never coerced) ---
{
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":9}');
  const rows = assignLocalRowIds(tl.ok ? tl.rows : []);
  const m = mapTocSourcePages(rows, [7, 8]);
  assert(m.ok === false, 'out-of-range sourceImageIndex -> whole batch invalid');
}

// --- structure strict parse ---
{
  const r = parseTocStructure('{"id":"r0001","level":1}\n{"id":"r0002","level":2}');
  assert(r.ok === true && r.ok && r.proposals.length === 2, 'structure JSONL parses');
  const bad = parseTocStructure('{"id":"r0001","level":1}\ngarbage');
  assert(bad.ok === false, 'structure malformed line -> invalid');
}
// --- structure validation: valid global levels ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"B.1","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"B.1","pageLabel":"3","sourceImageIndex":1}').rows : [])
  const v = validateTocStructure(rows, [{id:'r0001',level:1},{id:'r0002',level:2},{id:'r0003',level:3}]);
  assert(v.ok === true && v.levels.join(',') === '1,2,3', 'valid global levels accepted');
}
// --- missing / unknown / duplicate id rejected ---
{
  const rows2 = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}').rows : [])
  assert(validateTocStructure(rows2, [{id:'r0001',level:1}]).ok === false, 'missing id rejected');
  assert(validateTocStructure(rows2, [{id:'r0001',level:1},{id:'r0002',level:2},{id:'r9999',level:3}]).ok === false, 'unknown id rejected');
  assert(validateTocStructure(rows2, [{id:'r0001',level:1},{id:'r0001',level:2}]).ok === false, 'duplicate id rejected');
}
// --- level jump rejected ---
{
  const rows3 = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"C","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"C","pageLabel":"3","sourceImageIndex":1}').rows : [])
  assert(validateTocStructure(rows3, [{id:'r0001',level:1},{id:'r0002',level:2},{id:'r0003',level:4}]).ok === false, 'level jump 2->4 rejected');
}
// --- normalization: pure min->1 shift, deterministic, no semantic reorder ---
{ assert(normalizeTocLevels([3,4,5]).join(',') === '1,2,3', 'levels 3,4,5 -> 1,2,3') }

// --- boundary dedupe: exact duplicate (title+pageLabel+tocPage) only ---
{
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}');
  const m = mapTocSourcePages(assignLocalRowIds(tl.ok ? tl.rows : []), [7]);
  const d = m.ok ? dedupeBoundaryRows(m.rows) : [];
  assert(d.length === 2 && d[0].title === 'A' && d[1].title === 'B', 'exact adjacent duplicate removed (A,B)');
}
// --- reindexRows ---
{
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}');
  const m = mapTocSourcePages(assignLocalRowIds(tl.ok ? tl.rows : []), [7,8]);
  const ri = m.ok ? reindexRows(m.rows) : [];
  assert(ri.map(x => x.id).join(',') === 'r0001,r0002', 'reindex -> contiguous r0001,r0002');
}
// --- similar-but-not-equal title NOT deduped ---
{
  const tl = parseTocJsonl('{"title":"第一章 自然地理","pageLabel":"1","sourceImageIndex":1}\n{"title":"第一章 自然地理学","pageLabel":"1","sourceImageIndex":1}');
  const m = mapTocSourcePages(assignLocalRowIds(tl.ok ? tl.rows : []), [7]);
  const d = m.ok ? dedupeBoundaryRows(m.rows) : [];
  assert(d.length === 2, 'similar-but-different title NOT deduped');
}

// --- exact label mapping ---
{
  const labels = ['i','ii','iii','1','2','3','4'];
  assert(exactLabelToPage(labels, 'iii') === 3, 'exact roman label -> page 3');
  assert(exactLabelToPage(labels, '1') === 4, 'exact arabic label -> page 4');
  assert(exactLabelToPage(labels, '9') === 0, 'missing label -> 0 (no guess)');
}
// --- plain numeric detection ---
{
  assert(labelsArePlainNumeric(['1','2','3']) === true, 'plain numeric labels true');
  assert(labelsArePlainNumeric(['i','ii']) === false, 'roman labels false');
  assert(labelsArePlainNumeric(null) === false, 'null labels false');
}
// --- buildInitialMapping leaves unresolved when no exact match ---
{
  const items = buildInitialMapping([{ title: 'A', level: 1, pageLabel: '1', tocPage: 7 }], ['1','2']);
  assert(items[0].startPage === 1, 'exact label -> physical page 1');
  const items2 = buildInitialMapping([{ title: 'B', level: 1, pageLabel: '99', tocPage: 7 }], ['1','2']);
  assert(items2[0].startPage === null, 'unmatched label -> null (unresolved)');
}
// --- numeric offset ---
{ assert(numericOffsetFromAnchor(1, 15) === 14, 'offset from printed 1 -> PDF 15 = 14') }
// --- applyGlobalOffset ---
{
  const items = [
    { title: 'A', level: 1, pageLabel: '15', tocPage: 7, startPage: null },
    { title: 'B', level: 1, pageLabel: 'i', tocPage: 7, startPage: 3, manualOverride: true },
    { title: 'C', level: 1, pageLabel: '20', tocPage: 7, startPage: null },
  ];
  const remapped = applyGlobalOffset(items, 12);
  assert(remapped[0].startPage === 27, 'numeric label remapped (15+12=27)');
  assert(remapped[1].startPage === 3 && remapped[1].manualOverride === true, 'manual override preserved');
  assert(remapped[2].startPage === 32, 'second numeric remapped');
}
// --- verification anchor ---
{
  const items = [
    { title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: 15 },
    { title: 'B', level: 1, pageLabel: '57', tocPage: 7, startPage: 71 },
    { title: 'C', level: 1, pageLabel: 'x', tocPage: 7, startPage: null },
  ];
  const anchor = pickVerificationAnchor(items, 15);
  assert(anchor && anchor.title === 'B', 'verification anchor = farthest resolved');
}
// --- setManualPageOverride ---
{
  const items = [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: null }];
  const r = setManualPageOverride(items, 0, 31);
  assert(r[0].startPage === 31 && r[0].manualOverride === true, 'manual page override set + flagged');
}

// --- review single-source validator (Stage 9.4C.1) ---
{
  const items = [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: null }];
  const v = validateMappedTocReview(items, 30);
  assert(v.ok === false && v.unresolvedCount === 1 && v.errorCount === 1, 'unresolved => invalid, 1 blocking row');
}
{
  const items = [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: 15 }];
  const v = validateMappedTocReview(items, 30);
  assert(v.ok === true && v.unresolvedCount === 0 && v.errorCount === 0, 'all resolved => valid');
}
{
  const items = [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: 20 }, { title: 'B', level: 1, pageLabel: '2', tocPage: 7, startPage: 10 }];
  const v = validateMappedTocReview(items, 30);
  assert(v.ok === false, 'resolved but page decreases => invalid');
}
{
  const items = [{ title: 'A', level: 1, pageLabel: '1', tocPage: 7, startPage: 1 }, { title: 'B', level: 1, pageLabel: '2', tocPage: 7, startPage: null }];
  const v = validateMappedTocReview(items, 30);
  assert(v.ok === false && v.unresolvedCount === 1, 'one unresolved, one resolved@p1 (B never coerced to 1)');
}
{
  // a row with BOTH blank title and bad page counts as ONE blocking row
  const items = [{ title: '', level: 1, pageLabel: '1', tocPage: 7, startPage: 99 }];
  const v = validateMappedTocReview(items, 30);
  assert(v.ok === false && v.errorCount === 1, 'one row with multiple problems => 1 blocking row');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
