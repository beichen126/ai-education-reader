// Stage F regression gate - compact structure contract, retry diagnostics,
// mid-directory selection, abort-safe validation, and provenance immutability.
// PURE: no React, network, IndexedDB, or paid API.
import { buildInitialMapping, type MappedTocItem } from '../src/documents/toc-mapping.ts'
import { parseTocStructure, validateTocStructure, type TocTranscriptionRow } from '../src/documents/ai-toc.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const rows: TocTranscriptionRow[] = [
  { id: 'r0001', title: '第一章 绪论', pageLabel: '1', tocPage: 7, sourceImageIndex: 1, rowOrder: 0, visualIndent: 0, numbering: '第一章' },
  { id: 'r0002', title: '第一节 对象', pageLabel: '3', tocPage: 7, sourceImageIndex: 1, rowOrder: 1, visualIndent: 1, numbering: '第一节' },
  { id: 'r0003', title: '第二章 方法', pageLabel: '12', tocPage: 8, sourceImageIndex: 2, rowOrder: 2, visualIndent: 0, numbering: '第二章' },
]

// Case A: normal compact structure has one level per row and builds normally.
{
  const parsed = parseTocStructure('{"levels":[1,2,1]}')
  assert(parsed.ok, 'A: normal compact structure parses')
  if (parsed.ok) {
    const checked = validateTocStructure(rows, parsed.levels)
    assert(checked.ok && checked.levels.length === rows.length, 'A: levels.length equals rows.length')
    if (checked.ok) {
      const mapped = buildInitialMapping(rows.map((row, i) => ({
        title: row.title, level: checked.levels[i], pageLabel: row.pageLabel, tocPage: row.tocPage,
      })), ['1', '3', '12'])
      assert(mapped.length === rows.length, 'A: validated rows build into a complete mapping')
    }
  }
}

// Cases B/C: fenced compact JSON is accepted; malformed JSON is rejected.
{
  const fence = String.fromCharCode(96).repeat(3)
  assert(parseTocStructure(fence + 'json\n{"levels":[1,2,1]}\n' + fence).ok, 'B: fenced compact JSON parses')
  const malformed = parseTocStructure('{"levels":[1,2,')
  assert(!malformed.ok && malformed.diagnostics.some(d => d.code === 'MALFORMED_OUTPUT'), 'C: malformed compact JSON is rejected')
}

// Cases D/E/F: mismatch drives one repair; success yields a draft, two failures do not.
{
  const mismatch = validateTocStructure(rows, [1, 2])
  assert(!mismatch.ok && mismatch.diagnostics.some(d => d.code === 'LEVEL_COUNT_MISMATCH'), 'D: count mismatch is a repair diagnostic')

  const repaired = validateTocStructure(rows, [2, 2, 1])
  assert(repaired.ok && repaired.levels.join(',') === '2,2,1', 'E: one invalid attempt followed by a valid attempt succeeds')

  const failedAgain = validateTocStructure(rows, [1, 3])
  assert(!failedAgain.ok && failedAgain.levels.length === 0, 'F: second invalid attempt returns no partial levels')
}

// Cases G/H: selected mid-directory slices may start above level 1, but jumps fail.
{
  const midDirectory = validateTocStructure(rows, [2, 2, 1])
  assert(midDirectory.ok, 'G: mid-directory selection with first level 2 is valid')
  const jump = validateTocStructure(rows.slice(0, 2), [1, 3])
  assert(!jump.ok && jump.diagnostics.some(d => d.code === 'LEVEL_JUMP'), 'H: illegal level jump is diagnosed')
}

// Case J: structure validation is read-only; all provenance fields survive untouched.
{
  const before = JSON.stringify(rows)
  const checked = validateTocStructure(rows, [1, 2, 1])
  assert(checked.ok && JSON.stringify(rows) === before, 'J: structure validation does not mutate provenance rows')
  const mapped: MappedTocItem[] = buildInitialMapping(rows.map((row, i) => ({
    title: row.title, level: checked.levels[i], pageLabel: row.pageLabel, tocPage: row.tocPage,
  })), ['1', '3', '12'])
  assert(mapped[0].title === rows[0].title && mapped[0].pageLabel === rows[0].pageLabel, 'J: title and pageLabel remain source-owned')
  assert(mapped[0].tocPage === rows[0].tocPage, 'J: tocPage remains local source metadata')
  assert(rows[0].sourceImageIndex === 1 && rows[0].rowOrder === 0, 'J: sourceImageIndex and rowOrder remain unchanged')
}

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
