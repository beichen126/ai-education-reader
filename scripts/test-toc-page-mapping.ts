// v1.1.3 regression: printed page-label canonicalization + numeric offset calibration.
// The AI faithfully transcribes decorated labels ("/1", "／3", "……24"); these must be
// read as the single Arabic integer they denote for (a) matching against PDF PageLabels
// and (b) numeric offset calibration, WITHOUT ever rewriting the raw pageLabel (which the
// UI still shows) and WITHOUT a fuzzy match on non-numeric labels.
import {
  canonicalizeNumericPageLabel, canonicalNumericPageNumber, exactLabelToPage,
  isNumericLabel, canUseNumericOffset, applyGlobalOffset, setManualPageOverride,
  pageLabelFamily, romanNumeralValue,
  validateMappedTocReview, buildInitialMapping, labelsArePlainNumeric,
  type MappedTocItem,
} from '../src/documents/toc-mapping.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// ---------------------------------------------------------------------------
// 1. canonicalizeNumericPageLabel — accepted decorated labels
// ---------------------------------------------------------------------------
{
  const cases: [string, string][] = [
    ['1', '1'],
    [' 1 ', '1'],
    ['/1', '1'],
    ['／1', '1'],
    ['1/', '1'],
    ['·1', '1'],
    ['1·', '1'],
    ['……24', '24'],
    ['24……', '24'],
    ['···31', '31'],
    ['— 15', '15'],
    ['—— 15', '15'],
    ['(1)', '1'],
    ['（3）', '3'],
    ['007', '7'],           // leading zeros are unambiguous -> stripped
    ['/08', '8'],
  ]
  for (const [inp, out] of cases) {
    assert(canonicalizeNumericPageLabel(inp) === out, 'canon(' + JSON.stringify(inp) + ') = ' + JSON.stringify(out) + ' (got ' + JSON.stringify(canonicalizeNumericPageLabel(inp)) + ')')
  }
}

// ---------------------------------------------------------------------------
// 1b. canonicalizeNumericPageLabel — must NOT coerce (conservative → null)
// ---------------------------------------------------------------------------
{
  const bad = ['A-1', 'S1', '1-2', '1.2', '3a', 'iii', 'IV', '附1', 'O1', 'I', 'l1', '第1章', 'p.3', '1/2', '·', '.', '引言', '1.2.3', '章节一', '', '   ']
  for (const inp of bad) {
    assert(canonicalizeNumericPageLabel(inp) === null, 'canon(' + JSON.stringify(inp) + ') = null (got ' + JSON.stringify(canonicalizeNumericPageLabel(inp)) + ')')
  }
}

// ---------------------------------------------------------------------------
// 2. isNumericLabel — based on canonicalization, not a bare /^\d+$/
// ---------------------------------------------------------------------------
{
  assert(isNumericLabel('/24') === true, 'isNumericLabel("/24") true')
  assert(isNumericLabel('24') === true, 'isNumericLabel("24") true')
  assert(isNumericLabel('／2') === true, 'isNumericLabel("／2") true')
  assert(isNumericLabel('S24') === false, 'isNumericLabel("S24") false')
  assert(isNumericLabel('iii') === false, 'isNumericLabel("iii") false')
}

// ---------------------------------------------------------------------------
// 3. exactLabelToPage — raw exact first, then canonical numeric fallback
// ---------------------------------------------------------------------------
{
  // canonical fallback: AI decorated -> PDF plain
  assert(exactLabelToPage(['1', '2', '3'], '/1') === 1, 'AI "/1" -> PDF label 1 (canonical)')
  assert(exactLabelToPage(['1', '2', '3'], '／2') === 2, 'AI "／2" -> PDF label 2 (canonical)')
  assert(exactLabelToPage(['1', '2', '3'], '……24') === 0, 'AI "……24" against 1..3 -> no match (0)')
  assert(exactLabelToPage(['3', '24', '2'], '/24') === 2, 'AI "/24" -> PDF label 24 (canonical) at index 2')
  // raw exact priority beats canonical
  assert(exactLabelToPage(['/24', '24'], '/24') === 1, 'raw exact wins: "/24" matches the PDF label "/24"')
  assert(exactLabelToPage(['/24', '24'], '24') === 2, 'raw exact wins: "24" matches the PDF label "24" (not the /24)')
  // no fuzzy match for non-numeric / ambiguous
  assert(exactLabelToPage(['1', '2', '3'], 'iii') === 0, 'AI "iii" -> no fuzzy match (0)')
  assert(exactLabelToPage(['1', '2', '3'], 'A-1') === 0, 'AI "A-1" -> no fuzzy match (0)')
  assert(exactLabelToPage(['1', '2', '3'], '1-2') === 0, 'AI "1-2" (range) -> no match (0)')
  assert(exactLabelToPage(null, '/1') === 0, 'no labels -> 0')
}

// ---------------------------------------------------------------------------
// 4. applyGlobalOffset — decorated Arabic labels get the batch offset
// ---------------------------------------------------------------------------
{
  const items: MappedTocItem[] = [
    { title: '第一部分 方法论', level: 1, pageLabel: '/1', tocPage: 1, startPage: null },
    { title: '第一节 题型的设计类型', level: 1, pageLabel: '/3', tocPage: 1, startPage: null },
    { title: '第六节 常见失误', level: 1, pageLabel: '/24', tocPage: 2, startPage: null },
  ]
  const after = applyGlobalOffset(items, 7)
  assert(after[0].startPage === 8, '"/1" + 7 = 8')
  assert(after[1].startPage === 10, '"/3" + 7 = 10')
  assert(after[2].startPage === 31, '"/24" + 7 = 31')
  // raw pageLabel NEVER rewritten by the offset
  assert(after[2].pageLabel === '/24', 'raw pageLabel "/24" preserved after offset')
}

// ---------------------------------------------------------------------------
// 4b. offset that pushes below page 1 -> unresolved (never coerced, never negative)
// ---------------------------------------------------------------------------
{
  const items: MappedTocItem[] = [
    { title: 'a', level: 1, pageLabel: '/3', tocPage: 1, startPage: null },
    { title: 'b', level: 1, pageLabel: '/1', tocPage: 1, startPage: null },
  ]
  const after = applyGlobalOffset(items, -5) // 3-5 = -2, 1-5 = -4
  assert(after[0].startPage === null, '"/3" - 5 -> below page 1 -> unresolved')
  assert(after[1].startPage === null, '"/1" - 5 -> below page 1 -> unresolved')
}

// ---------------------------------------------------------------------------
// 5. mixed labels — only canonical-Arabic items are mapped; others stay unresolved
// ---------------------------------------------------------------------------
{
  const mixed: MappedTocItem[] = [
    { title: 'a', level: 1, pageLabel: '/1', tocPage: 1, startPage: null },
    { title: 'b', level: 1, pageLabel: 'iii', tocPage: 1, startPage: null },
    { title: 'c', level: 1, pageLabel: '/24', tocPage: 2, startPage: null },
    { title: 'd', level: 1, pageLabel: 'A-1', tocPage: 2, startPage: null },
  ]
  const after = applyGlobalOffset(mixed, 7)
  assert(after[0].startPage === 8, '"/1" mapped (8)')
  assert(after[1].startPage === null, '"iii" stays unresolved')
  assert(after[2].startPage === 31, '"/24" mapped (31)')
  assert(after[3].startPage === null, '"A-1" stays unresolved')
}

// ---------------------------------------------------------------------------
// 6. manual override is immune to the global offset
// ---------------------------------------------------------------------------
{
  const items: MappedTocItem[] = [
    { title: 'a', level: 1, pageLabel: '/1', tocPage: 1, startPage: 8, manualOverride: true },
    { title: 'b', level: 1, pageLabel: '/3', tocPage: 1, startPage: null },
  ]
  const after = applyGlobalOffset(items, 7)
  assert(after[0].startPage === 8, 'manualOverride item keeps its page (8)')
  assert(after[0].manualOverride === true, 'manualOverride flag preserved')
  assert(after[1].startPage === 10, 'non-override "null" item remapped (10)')
}

// ---------------------------------------------------------------------------
// 7. out-of-range after offset must be flagged (never silently clamped)
// ---------------------------------------------------------------------------
{
  const items: MappedTocItem[] = [
    { title: 'a', level: 1, pageLabel: '/114', tocPage: 114, startPage: 121 }, // 121 > 114
  ]
  const v = validateMappedTocReview(items, 114)
  assert(v.ok === false, 'out-of-range review is NOT ok')
  assert(v.blockingRowIndices.includes(0), 'row 0 is blocking')
  assert((v.issuesByRow[0] || []).includes('页码超出范围'), 'row 0 flagged 页码超出范围')
}

// ---------------------------------------------------------------------------
// 8. canUseNumericOffset — independent of PDF PageLabels
// ---------------------------------------------------------------------------
{
  assert(canUseNumericOffset([{ pageLabel: '/1' }]) === true, 'one decorated numeric -> can offset (true)')
  assert(canUseNumericOffset([{ pageLabel: 'iii' }]) === false, 'all roman -> cannot offset (false)')
  assert(canUseNumericOffset([]) === false, 'empty -> false')
  assert(canUseNumericOffset([{ pageLabel: 'iii' }, { pageLabel: '/24' }]) === true, 'mixed with one numeric -> true')
}

// ---------------------------------------------------------------------------
// 9. buildInitialMapping uses the canonical fallback for auto-mapping
// ---------------------------------------------------------------------------
{
  const mapped = buildInitialMapping(
    [{ title: 'a', level: 1, pageLabel: '/1', tocPage: 1 }],
    ['1', '2', '3'],
  )
  assert(mapped[0].startPage === 1, 'buildInitialMapping canonical-matches "/1" -> page 1')
  const none = buildInitialMapping(
    [{ title: 'b', level: 1, pageLabel: 'iii', tocPage: 1 }],
    ['1', '2', '3'],
  )
  assert(none[0].startPage === null, 'buildInitialMapping leaves roman unresolved')
}

// ---------------------------------------------------------------------------
// 10. labelsArePlainNumeric untouched (PDF auto-mapping capability)
// ---------------------------------------------------------------------------
{
  assert(labelsArePlainNumeric(['1', '2', '3']) === true, 'labelsArePlainNumeric(["1","2","3"]) true')
  assert(labelsArePlainNumeric(['/1', '2']) === false, 'labelsArePlainNumeric(["/1","2"]) false')
  assert(labelsArePlainNumeric(null) === false, 'labelsArePlainNumeric(null) false')
}

// ---------------------------------------------------------------------------
// 11. canonicalNumericPageNumber — numeric value accessor for UI calibration
// ---------------------------------------------------------------------------
{
  assert(canonicalNumericPageNumber('/24') === 24, 'canonicalNumericPageNumber("/24") = 24')
  assert(canonicalNumericPageNumber('／1') === 1, 'canonicalNumericPageNumber("／1") = 1')
  assert(canonicalNumericPageNumber('A-1') === null, 'canonicalNumericPageNumber("A-1") = null')
  assert(canonicalNumericPageNumber('iii') === null, 'canonicalNumericPageNumber("iii") = null')
}

// ---------------------------------------------------------------------------
// 12. setManualPageOverride — pure, marks manualOverride, never mutates input
// ---------------------------------------------------------------------------
{
  const base: MappedTocItem[] = [{ title: 'a', level: 1, pageLabel: '/1', tocPage: 1, startPage: null }]
  const after = setManualPageOverride(base, 0, 8)
  assert(after[0].startPage === 8 && after[0].manualOverride === true, 'setManualPageOverride sets page + manualOverride')
  assert(base[0].startPage === null && base[0].manualOverride === undefined, 'setManualPageOverride does not mutate input')
}

// ---------------------------------------------------------------------------
// 13. page-label families (v1.1.3): numeric / roman / other, never fuzzy-inferred
// ---------------------------------------------------------------------------
{
  assert(pageLabelFamily('/1') === 'numeric', 'family("/1") = numeric')
  assert(pageLabelFamily('24') === 'numeric', 'family("24") = numeric')
  assert(pageLabelFamily('iii') === 'roman', 'family("iii") = roman')
  assert(pageLabelFamily('IV') === 'roman', 'family("IV") = roman')
  assert(pageLabelFamily('S12') === 'other', 'family("S12") = other')
  assert(pageLabelFamily('A-3') === 'other', 'family("A-3") = other')
  assert(pageLabelFamily('1-2') === 'other', 'family("1-2") = other')
  assert(pageLabelFamily('附录1') === 'other', 'family("附录1") = other')
}

// ---------------------------------------------------------------------------
// 14. Roman numeral parser — strict, reliable, case-insensitive
// ---------------------------------------------------------------------------
{
  assert(romanNumeralValue('i') === 1, 'roman "i" = 1')
  assert(romanNumeralValue('III') === 3, 'roman "III" = 3')
  assert(romanNumeralValue('iv') === 4, 'roman "iv" = 4')
  assert(romanNumeralValue('XXIV') === 24, 'roman "XXIV" = 24')
  assert(romanNumeralValue('MCMXCIX') === 1999, 'roman "MCMXCIX" = 1999')
  assert(romanNumeralValue('IIII') === null, 'roman "IIII" (non-canonical) -> null')
  assert(romanNumeralValue('VX') === null, 'roman "VX" (invalid) -> null')
  assert(romanNumeralValue('m') === 1000, 'roman "m" = 1000 (lowercase accepted)')
  assert(romanNumeralValue('O') === null, 'roman "O" -> null (not a roman numeral)')
  assert(romanNumeralValue('S12') === null, 'roman "S12" -> null')
  assert(romanNumeralValue('') === null, 'roman "" -> null')
}

console.log('\nSUMMARY ' + pass + '/' + (pass + fail) + ' passed')
process.exit(fail === 0 ? 0 : 1)
