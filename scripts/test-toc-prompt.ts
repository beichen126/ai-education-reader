// Stage 9.4C.1: REAL production prompt contract regression (P0).
// The prompt and the parser are a matched pair — if the parser is strict JSONL +
// sourceImageIndex but the prompt drifts back to a JSON array / absolute-level /
// children protocol, this test fails directly. It must never rely on mocked output.
import { TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT } from '../src/documents/ai-toc.ts'
import { parseTocJsonl, parseTocStructure } from '../src/documents/ai-toc.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const t = TOC_TRANSCRIPTION_SYSTEM_PROMPT

// --- MUST contain: JSONL + sourceImageIndex + faithful transcription + continuity contract ---
assert(t.includes('JSONL'), 'transcription prompt requires JSONL output');
assert(t.includes('sourceImageIndex'), 'transcription prompt requires sourceImageIndex');
assert(/faithfully|faithful/i.test(t), 'transcription prompt requires faithful transcription');
assert(t.includes('do not repeat'), 'transcription prompt forbids re-outputting continuity rows');

// --- MUST NOT contain old JSON-array protocol: 'level' / 'children' / 'JSON 数组' ---
assert(!/\blevel\b/.test(t), 'transcription prompt must NOT instruct level');
assert(!t.includes('children'), 'transcription prompt must NOT instruct children');
assert(!t.includes('JSON array'), 'transcription prompt must NOT instruct a JSON array');
assert(!/\[\]/.test(t), 'transcription prompt must NOT instruct an array literal');

// --- prompt must forbid language drift + keep missing printed labels schema-valid ---
assert(t.includes('Simplified') && t.includes('Traditional'), 'transcription prompt addresses simplified/traditional drift');
assert(t.includes('translate') && t.includes('normalize'), 'transcription prompt forbids translation and normalization');
assert(t.includes('printed destination-page label'), 'transcription prompt scopes pageLabel to the printed destination page only');
assert(t.includes('pageLabel to the empty string ""') && t.includes('never omit'), 'transcription prompt defines the missing-pageLabel contract');

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
