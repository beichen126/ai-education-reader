// Stage 9.4C.1: AI TOC domain tests (PURE) — strict JSONL transcription, source-page
// mapping, structure parse/validate, boundary dedupe, review single-source validation.
import {
  parseTocJsonl, parseTocStructure, validateTocStructure, assignLocalRowIds,
  mapTocSourcePages, reindexRows, dedupeWindowBoundary, normalizeTitle, normalizeTocLevels,
  describeTocStructureFailure, buildTocStructureRepairPrompt, buildTocStructureInput, inferFallbackTocLevels,
  buildTocTranscriptionRepairPrompt, tocTranscriptionDiagnosticEnglish, validateTocPageLabelCoverage,
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
// --- common compatible model wrappers are accepted without dropping malformed rows ---
{
  const array = parseTocJsonl('```json\n[{"title":"A","pageLabel":"1","sourceImageIndex":"1"},{"title":"B","pageLabel":2,"source_image_index":2}]\n```')
  assert(array.ok && array.rows.length === 2 && array.rows[1].sourceImageIndex === 2, 'JSON array/fence and compatible index fields are normalized')
  const wrapped = parseTocJsonl('{"rows":[{"title":"A","pageLabel":"1"}]}', { defaultSourceImageIndex: 1 })
  assert(wrapped.ok && wrapped.rows[0].sourceImageIndex === 1, 'single-image batch can safely supply the only source index')
  const invalidWrapped = parseTocJsonl('{"items":[{"title":"A","pageLabel":"1","sourceImageIndex":1},{"title":"","pageLabel":"2","sourceImageIndex":1}]}')
  assert(!invalidWrapped.ok, 'wrapper compatibility remains all-or-nothing when a row is malformed')
}
// --- compatible page-label omissions/aliases stay reviewable instead of failing the batch ---
{
  const missing = parseTocJsonl('{"title":"Preface","sourceImageIndex":1}')
  assert(missing.ok && missing.rows[0].pageLabel === '', 'missing pageLabel becomes an unresolved review row')
  const empty = parseTocJsonl('{"title":"Introduction","pageLabel":"","sourceImageIndex":1}')
  assert(empty.ok && empty.rows[0].pageLabel === '', 'explicit empty pageLabel remains reviewable')
  const aliases = parseTocJsonl('{"title":"Chapter 1","page_number":7,"sourceImageIndex":1}\n{"title":"Chapter 2","page":"12","sourceImageIndex":1}')
  assert(aliases.ok && aliases.rows.map(row => row.pageLabel).join(',') === '7,12', 'common printed-page aliases are normalized without guessing')
}
// --- corrective retry carries the previous stable validation errors, not raw output ---
{
  const retry = buildTocTranscriptionRepairPrompt([
    '第 1 行缺少合法的 sourceImageIndex',
    '第 2 行不是合法 JSON',
  ])
  assert(retry.includes('Row 1 was missing a valid sourceImageIndex'), 'transcription retry includes the prior missing-field error')
  assert(retry.includes('Row 2 was not valid JSON'), 'transcription retry includes the prior malformed-row error')
  assert(retry.includes('pageLabel:""') && retry.includes('never omit'), 'transcription retry repeats the missing-pageLabel recovery contract')
  assert(tocTranscriptionDiagnosticEnglish('第 4 行 sourceImageIndex 超出当前请求图片范围').includes('Row 4'), 'source-image mapping errors have a specific safe English diagnostic')
}
// --- a wholly empty page-label batch is retried instead of creating N manual fixes ---
{
  const allMissing = validateTocPageLabelCoverage([{ pageLabel: '' }, { pageLabel: '  ' }])
  assert(allMissing.ok === false && allMissing.diagnostics[0].includes('2'), 'all-empty page labels fail batch coverage validation with a count')
  const partial = validateTocPageLabelCoverage([{ pageLabel: '' }, { pageLabel: '12' }])
  assert(partial.ok, 'an individual heading without a printed page remains reviewable')
  assert(tocTranscriptionDiagnosticEnglish('全部 138 个目录条目均缺少 pageLabel').includes('138'), 'all-empty coverage failure has a specific English diagnostic')
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
// --- an exact physical-page echo is recovered; unknown indices still invalidate ---
{
  const physical = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":8}');
  const physicalMapped = mapTocSourcePages(assignLocalRowIds(physical.ok ? physical.rows : []), [7, 8]);
  assert(physicalMapped.ok && physicalMapped.rows[0].tocPage === 8, 'physical page echoed by model maps only on an exact current-batch match');
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":9}');
  const rows = assignLocalRowIds(tl.ok ? tl.rows : []);
  const m = mapTocSourcePages(rows, [7, 8]);
  assert(m.ok === false, 'out-of-range sourceImageIndex -> whole batch invalid');
}

// --- compact structure strict parse ---
{
  const r = parseTocStructure('{"levels":[1,2]}');
  assert(r.ok === true && r.ok && r.levels.join(',') === '1,2', 'compact structure object parses');
  const fenced = parseTocStructure('```json\n{"levels":[1,2]}\n```');
  assert(fenced.ok === true, 'fenced compact structure parses');
  const bad = parseTocStructure('{"levels":[1,2,');
  assert(bad.ok === false, 'compact structure malformed JSON -> invalid');
  if (!bad.ok) assert(bad.diagnostics.some(d => d.code === 'MALFORMED_OUTPUT'), 'malformed output diagnostic is explicit');
  const empty = parseTocStructure('  ');
  assert(empty.ok === false && !empty.ok && empty.diagnostics.some(d => d.code === 'EMPTY_OUTPUT'), 'empty structure output diagnostic is explicit');
  const numericStringLevel = parseTocStructure('{"levels":[1,"2"]}');
  assert(numericStringLevel.ok === true && numericStringLevel.levels.join(',') === '1,2', 'numeric-string levels are normalized');
  const invalidLevel = parseTocStructure('{"levels":[1,"two"]}');
  assert(invalidLevel.ok === false && !invalidLevel.ok && invalidLevel.diagnostics.some(d => d.code === 'INVALID_LEVEL'), 'invalid level diagnostic is explicit');
  const old = parseTocStructure('{"id":"r0001","level":1}');
  assert(old.ok === false, 'legacy per-row id/level output is rejected');
  const direct = parseTocStructure('[1,"2"]');
  assert(direct.ok && direct.levels.join(',') === '1,2', 'direct level arrays are normalized');
  const wrapped = parseTocStructure('{"result":{"levels":[1,2]}}');
  assert(wrapped.ok && wrapped.levels.length === 2, 'nested result wrapper is normalized');
}
// --- structure input is stable and excludes local provenance metadata ---
{
  const input = buildTocStructureInput([
    { id: 'r0001', title: '第一章 绪论', pageLabel: '1', tocPage: 7, sourceImageIndex: 2, rowOrder: 0, visualIndent: 0, numbering: '第一章' },
    { id: 'r0002', title: '第一节 对象', pageLabel: '3', tocPage: 8, sourceImageIndex: 2, rowOrder: 1 },
  ])
  assert(input === 'row 1 | 第一章 绪论 | indent 0 | 第一章 | p1\nrow 2 | 第一节 对象 | indent - | - | p3', 'structure input preserves order and hierarchy cues')
  assert(!input.includes('r0001') && !input.includes('tocPage') && !input.includes('sourceImageIndex'), 'structure input excludes local provenance fields')
}
// --- structure validation: valid global levels ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"B.1","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"B.1","pageLabel":"3","sourceImageIndex":1}').rows : [])
  const v = validateTocStructure(rows, [1,2,3]);
  assert(v.ok === true && v.levels.join(',') === '1,2,3', 'valid global levels accepted');
}
// --- compact level count is strict ---
{
  const rows2 = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}').rows : [])
  const short = validateTocStructure(rows2, [1]);
  assert(short.ok === false && short.diagnostics.some(d => d.code === 'LEVEL_COUNT_MISMATCH'), 'level count mismatch diagnostic is explicit');
  const long = validateTocStructure(rows2, [1,2,3]);
  assert(long.ok === false && long.diagnostics.some(d => d.code === 'LEVEL_COUNT_MISMATCH'), 'extra levels are rejected');
}
// --- level jump rejected ---
{
  const rows3 = assignLocalRowIds(parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"C","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}\n{"title":"C","pageLabel":"3","sourceImageIndex":1}').rows : [])
  const jumped = validateTocStructure(rows3, [1,2,4]);
  assert(jumped.ok === false && jumped.diagnostics.some(d => d.code === 'LEVEL_JUMP'), 'level jump rejected with diagnostic');
}
// --- a mid-directory selection is not rejected solely because its first row is not level 1 ---
{
  const rows = assignLocalRowIds(parseTocJsonl('{"title":"第三节","pageLabel":"1","sourceImageIndex":1}\n{"title":"第四节","pageLabel":"2","sourceImageIndex":1}\n{"title":"第二章","pageLabel":"3","sourceImageIndex":1}').ok ? parseTocJsonl('{"title":"第三节","pageLabel":"1","sourceImageIndex":1}\n{"title":"第四节","pageLabel":"2","sourceImageIndex":1}\n{"title":"第二章","pageLabel":"3","sourceImageIndex":1}').rows : [])
  const mid = validateTocStructure(rows, [2,2,1]);
  assert(mid.ok === true && mid.levels.join(',') === '2,2,1', 'mid-directory selection with first level 2 is accepted');
}
// --- user-facing messages stay actionable while diagnostics remain structured ---
{
  const msg = describeTocStructureFailure([{ code: 'LEVEL_COUNT_MISMATCH', message: 'test', expectedRows: 3, actualLevels: 2 }]);
  assert(msg.includes('层级数量') && !msg.includes('expectedRows'), 'count mismatch gets a concise user message');
}
// --- structure repair prompt: diagnostics are carried without raw model output ---
{
  const prompt = buildTocStructureRepairPrompt(3, [
    { code: 'LEVEL_COUNT_MISMATCH', message: 'local', expectedRows: 3, actualLevels: 2 },
    { code: 'LEVEL_JUMP', message: 'local', rowIndex: 2 },
  ]);
  assert(prompt.includes('expected 3, received 2'), 'repair prompt carries expected/actual count');
  assert(prompt.includes('Item 3 has an invalid hierarchy jump'), 'repair prompt carries row-level jump diagnostic');
  assert(prompt.includes('{"levels":[...]}') && prompt.includes('exactly 3 positive integers'), 'repair prompt preserves compact exact-count contract');
  assert(!prompt.includes('local'), 'repair prompt excludes diagnostic message text');
}
// --- normalization: pure min->1 shift, deterministic, no semantic reorder ---
{ assert(normalizeTocLevels([3,4,5]).join(',') === '1,2,3', 'levels 3,4,5 -> 1,2,3') }

// --- failed remote structure analysis has a deterministic, valid local fallback ---
{
  const rows = [
    { id:'r1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0, visualIndent:0 },
    { id:'r2', title:'A.1', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:1, visualIndent:20 },
    { id:'r3', title:'A.1.a', pageLabel:'3', tocPage:7, sourceImageIndex:1, rowOrder:2, visualIndent:80 },
  ] as any
  assert(inferFallbackTocLevels(rows).join(',') === '1,2,3', 'fallback ranks indentation and clamps hierarchy jumps')
  assert(inferFallbackTocLevels(rows.map((r: any) => ({ ...r, visualIndent: undefined }))).join(',') === '1,1,1', 'fallback is conservatively flat without indentation evidence')
}

// --- FINDING 10: within-window identical rows are PRESERVED (no global adjacent dedupe) ---
{
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"B","pageLabel":"2","sourceImageIndex":1}');
  const rows = assignLocalRowIds(tl.ok ? tl.rows : []);
  const m = mapTocSourcePages(rows, [7]);
  // prev empty -> no boundary dedupe, ALL rows preserved.
  const merged = m.ok ? [...dedupeWindowBoundary([], m.rows)] : [];
  assert(merged.length === 3, 'within-window identical rows preserved (got ' + merged.length + ')');
}
// --- FINDING 10: cross-window head duplicate IS deduped (boundary) ---
{
  const prev = [ { id:'r1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 } ];
  const cur = [
    { id:'x1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 },
    { id:'x2', title:'B', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:1 },
  ];
  const d = dedupeWindowBoundary(prev as any, cur as any);
  assert(d.length === 1 && d[0].title === 'B', 'cross-window boundary duplicate deduped (got ' + d.length + ' rows)');
}
// --- FINDING 10: a window head that does NOT match the tail is preserved ---
{
  const prev = [ { id:'r1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 } ];
  const cur = [ { id:'x1', title:'C', pageLabel:'3', tocPage:7, sourceImageIndex:1, rowOrder:0 } ];
  const d = dedupeWindowBoundary(prev as any, cur as any);
  assert(d.length === 1 && d[0].title === 'C', 'non-boundary head NOT deduped');
}
// --- reindexRows: order preserved, contiguous ids, no dedupe ---
{
  const tl = parseTocJsonl('{"title":"A","pageLabel":"1","sourceImageIndex":1}\n{"title":"A","pageLabel":"1","sourceImageIndex":2}\n{"title":"B","pageLabel":"2","sourceImageIndex":2}');
  const m = mapTocSourcePages(assignLocalRowIds(tl.ok ? tl.rows : []), [7,8]);
  const ri = m.ok ? reindexRows(m.rows) : [];
  assert(ri.map(x => x.id).join(',') === 'r0001,r0002,r0003', 'reindex keeps all rows, contiguous ids');
}
// --- similar-but-not-equal title NOT deduped at a boundary ---
{
  const prev = [ { id:'r1', title:'第一章 自然地理', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 } ];
  const cur = [ { id:'x1', title:'第一章 自然地理学', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 } ];
  const d = dedupeWindowBoundary(prev as any, cur as any);
  assert(d.length === 1 && d[0].title === '第一章 自然地理学', 'similar-but-different title NOT boundary-deduped');
}
// --- FINDING 0.4: longest-suffix-overlap boundary dedupe (multi-row overlap) ---
{
  // prev=[X,A,B], cur=[A,B,C] -> longest k=2 overlap -> [C]
  const prev = [ { id:'r1', title:'X', pageLabel:'0', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'r2', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:1 }, { id:'r3', title:'B', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:2 } ];
  const cur = [ { id:'x1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'x2', title:'B', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:1 }, { id:'x3', title:'C', pageLabel:'3', tocPage:7, sourceImageIndex:1, rowOrder:2 } ];
  const d = dedupeWindowBoundary(prev as any, cur as any);
  assert(d.length === 1 && d[0].title === 'C', 'overlap [A,B] removed, only C returned (got ' + d.length + ' rows)');
  const prev2 = [ { id:'r1', title:'X', pageLabel:'0', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'r2', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:1 }, { id:'r3', title:'B', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:2 } ];
  const cur2 = [ { id:'x1', title:'B', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'x2', title:'C', pageLabel:'3', tocPage:7, sourceImageIndex:1, rowOrder:1 } ];
  const d2 = dedupeWindowBoundary(prev2 as any, cur2 as any);
  assert(d2.length === 1 && d2[0].title === 'C', 'partial overlap [B] removed, only C returned (got ' + d2.length + ' rows)');
  // prev=[X,A,B], cur=[A,C] -> k=0 (no full suffix/prefix match) -> unchanged
  const prev3 = [ { id:'r1', title:'X', pageLabel:'0', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'r2', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:1 }, { id:'r3', title:'B', pageLabel:'2', tocPage:7, sourceImageIndex:1, rowOrder:2 } ];
  const cur3 = [ { id:'x1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'x2', title:'C', pageLabel:'3', tocPage:7, sourceImageIndex:1, rowOrder:1 } ];
  const d3 = dedupeWindowBoundary(prev3 as any, cur3 as any);
  assert(d3.length === 2 && d3[0].title === 'A', 'non-contiguous [A,C] NOT deduped (got ' + d3.length + ' rows)');
  // same-window identical [A,A] preserved when prev empty
  const d4 = dedupeWindowBoundary([], [ { id:'x1', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:0 }, { id:'x2', title:'A', pageLabel:'1', tocPage:7, sourceImageIndex:1, rowOrder:1 } ] as any);
  assert(d4.length === 2, 'same-window [A,A] preserved (got ' + d4.length + ' rows)');
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


// --- FINDING 9: draft-level issue maps back to the ORIGINAL row index (not filtered draft index) ---
{
  // Row 0 is unresolved (filtered out of the draft). Row 1 has page 20 then row 2 has page 10 =>
  // a page-decreases issue at DRAFT index 1 (row 2 in the draft), which is ORIGINAL row index 2.
  const items = [
    { title: 'A', level: 1, pageLabel: 'x', tocPage: 1, startPage: null },
    { title: 'B', level: 1, pageLabel: '20', tocPage: 1, startPage: 20 },
    { title: 'C', level: 1, pageLabel: '10', tocPage: 1, startPage: 10 },
  ];
  const v = validateMappedTocReview(items as any, 30);
  // Page decreases must be flagged on ORIGINAL row 2, not mapped to draft index.
  assert(v.blockingRowIndices.includes(2), 'page-decreases mapped to original row index 2');
  assert(v.issuesByRow[2] && v.issuesByRow[2].some(m => m.includes('不能小于')), 'original row 2 carries the decrease message');
  assert(v.blockingRowIndices.includes(0), 'unresolved row 0 also blocking (its own issue)');
  assert(v.blockingRowIndices.includes(0) && v.blockingRowIndices.includes(2) && v.blockingRowIndices.length === 2, 'exactly rows 0 and 2 blocking');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
