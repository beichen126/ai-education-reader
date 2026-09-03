// Stage 9.4C.1: REAL production prompt contract regression (P0).
// The prompt and the parser are a matched pair — if the parser is strict JSONL +
// sourceImageIndex but the prompt drifts back to a JSON array / absolute-level /
// children protocol, this test fails directly. It must never rely on mocked output.
import { TOC_TRANSCRIPTION_SYSTEM_PROMPT, TOC_STRUCTURE_PROMPT } from '../src/documents/ai-toc.ts'
import { parseTocJsonl, parseTocStructure } from '../src/documents/ai-toc.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const t = TOC_TRANSCRIPTION_SYSTEM_PROMPT

// --- MUST contain: JSONL + sourceImageIndex + 忠实抄录 + keep continuity (don't re-output tail) ---
assert(t.includes('JSONL'), 'transcription prompt requires JSONL output');
assert(t.includes('sourceImageIndex'), 'transcription prompt requires sourceImageIndex');
assert(t.includes('忠实') || t.includes('抄录'), 'transcription prompt requires faithful transcription');
assert(t.includes('不要重复输出'), 'transcription prompt forbids re-outputting continuity rows');

// --- MUST NOT contain old JSON-array protocol: 'level' / 'children' / 'JSON 数组' ---
assert(!/\blevel\b/.test(t), 'transcription prompt must NOT instruct level');
assert(!t.includes('children'), 'transcription prompt must NOT instruct children');
assert(!t.includes('JSON 数组'), 'transcription prompt must NOT instruct a JSON array');
assert(!/\[\]/.test(t.replace(/数组中/,'')), 'transcription prompt must NOT instruct an array literal');

// --- parser/prompt match: a model following the prompt yields a parseable row ---
{
  const sample = '{"title":"第一章 绪论","pageLabel":"1","sourceImageIndex":1,"visualIndent":0,"numbering":"第一章"}\n{"title":"第一节 研究对象","pageLabel":"3","sourceImageIndex":2}';
  const r = parseTocJsonl(sample);
  assert(r.ok === true && r.ok && r.rows[0].sourceImageIndex === 1 && r.rows[1].sourceImageIndex === 2, 'prompt-conformant JSONL parses (sourceImageIndex)');
}

// --- structure prompt: only id+level, forbids returning transcription fields ---
const s = TOC_STRUCTURE_PROMPT
assert(s.includes('JSONL'), 'structure prompt requires JSONL');
assert(s.includes('level'), 'structure prompt proposes level');
assert(s.includes('id'), 'structure prompt references row id');
assert(s.includes('不') && s.includes('title'), 'structure prompt forbids returning title/pageLabel etc');

{
  const sample = '{"id":"r0001","level":1}\n{"id":"r0002","level":2}';
  const r = parseTocStructure(sample);
  assert(r.ok === true && r.ok && r.proposals.length === 2, 'structure-conformant JSONL parses');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)