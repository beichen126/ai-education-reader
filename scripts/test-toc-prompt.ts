// Stage 9.4C.1: REAL production prompt contract regression (P0).
// The prompt and the parser are a matched pair — if the parser is strict JSONL +
// sourceImageIndex but the prompt drifts back to a JSON array / absolute-level /
// children protocol, this test fails directly. It must never rely on mocked output.
import { TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT } from '../src/documents/ai-toc.ts'
import { parseTocJsonl, parseTocStructure } from '../src/documents/ai-toc.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const t = TOC_TRANSCRIPTION_SYSTEM_PROMPT

assert(t.includes('JSON object') && t.includes('"rows"'), 'one complete JSON outline object');
for (const field of ['title', 'pageLabel', 'sourceImageIndex', 'level']) assert(t.includes(field), 'outline prompt defines ' + field);
assert(t.includes('across pages') && t.includes('whole directory'), 'hierarchy is inferred across all OCR pages');
assert(t.includes('printed destination label') && t.includes('empty string'), 'page labels preserve their printed values and allow unresolved entries');

// --- parser/prompt match: a model following the prompt yields a parseable row ---
{
  const sample = '{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n{"title":"第一节 研究对象","pageLabel":"3","sourceImageIndex":2}';
  const r = parseTocJsonl(sample);
  assert(r.ok === true && r.ok && r.rows[0].sourceImageIndex === 1 && r.rows[1].sourceImageIndex === 2, 'prompt-conformant JSONL parses (sourceImageIndex)');
}

// --- structure prompt: compact levels only, forbids returning transcription fields ---
const s = TOC_STRUCTURE_PROMPT
assert(s.includes('JSON object'), 'structure prompt requires compact JSON object');
assert(s.includes('levels'), 'structure prompt requires levels sequence');
assert(s.includes('level'), 'structure prompt proposes level');
assert(s.includes('Input row 1 maps to levels[0]'), 'structure prompt defines row-order mapping');
assert(!s.includes('Output JSONL'), 'structure prompt no longer requests JSONL');
assert(s.includes('ids') && s.includes('Do not return'), 'structure prompt explicitly forbids row ids');
assert(s.includes('title') && s.includes('pageLabel'), 'structure prompt forbids returning title/pageLabel etc');

{
  const sample = '{"levels":[1,2]}';
  const r = parseTocStructure(sample);
  assert(r.ok === true && r.ok && r.levels.length === 2, 'structure-conformant compact JSON parses');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
