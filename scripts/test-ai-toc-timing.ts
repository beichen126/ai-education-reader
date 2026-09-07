import {
  createAiTocTiming, aiTocDurationMs, finalizeAiTocTiming,
} from '../src/documents/ai-toc-timing.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

{
  const timing = createAiTocTiming()
  assert(timing.renderingMs === 0 && timing.mappingMs === 0 && timing.totalMs === 0, 'new timing starts with zero scalar phases')
  assert(timing.transcriptionMs.length === 0 && timing.structureAttemptMs.length === 0, 'new timing starts with empty per-call phases')
}
{
  assert(aiTocDurationMs(10, 25) === 15, 'duration uses milliseconds')
  assert(aiTocDurationMs(25, 10) === 0, 'negative duration is clamped to zero')
  assert(aiTocDurationMs(Number.NaN, 10) === 0, 'non-finite duration is safe')
}
{
  const timing = createAiTocTiming()
  timing.renderingMs = 12
  timing.transcriptionMs.push(34, 56)
  timing.structureAttemptMs.push(78)
  timing.mappingMs = 2
  const snapshot = finalizeAiTocTiming(timing, Number.MAX_SAFE_INTEGER)
  assert(snapshot.totalMs >= 0, 'finalized total timing is non-negative')
  assert(snapshot.renderingMs === 12 && snapshot.mappingMs === 2, 'finalized snapshot preserves scalar phases')
  assert(snapshot.transcriptionMs.join(',') === '34,56' && snapshot.structureAttemptMs.join(',') === '78', 'finalized snapshot preserves per-call phases')
  snapshot.transcriptionMs.push(999)
  assert(timing.transcriptionMs.join(',') === '34,56', 'timing snapshot arrays are isolated from the live run')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
