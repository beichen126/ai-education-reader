// Stage 9.4D.1: review-state semantics (finding 8) — pure helpers used by TocReview.
import { emptyReviewState, markRowUnchecked, markChangedRowsUnchecked, verifiedCount, issueCount, uncheckedCount } from '../src/documents/toc-review-state.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- empty state is all unchecked ---
{
  const s = emptyReviewState(4);
  assert(uncheckedCount(s) === 4 && verifiedCount(s) === 0 && issueCount(s) === 0, 'empty state = 4 unchecked, 0 verified, 0 issue');
}

// --- editing a row resets it to unchecked (even if it was verified/issue) ---
{
  let s = emptyReviewState(3);
  s = { ...s, [1]: 'verified' };
  s = markRowUnchecked(s, 1);
  assert(s[1] === 'unchecked', 'editing a verified row resets it to unchecked');
  s = { ...s, [2]: 'issue' };
  s = markRowUnchecked(s, 2);
  assert(s[2] === 'unchecked', 'editing an issue row resets it to unchecked');
}

// --- global remap resets only the rows whose startPage actually changed ---
{
  let s = emptyReviewState(3);
  s = { ...s, [0]: 'verified', [1]: 'verified', [2]: 'issue' };
  const before = [1, 2, 3];
  const after = [ { startPage: 5 }, { startPage: 2 }, { startPage: 3 } ];
  const next = markChangedRowsUnchecked(s, before, after);
  assert(next[0] === 'unchecked', 'row 0 (page changed) reset to unchecked');
  assert(next[1] === 'verified', 'row 1 (page unchanged) stays verified');
  assert(next[2] === 'issue', 'row 2 (page unchanged) keeps issue');
}

// --- verifiedCount counts only verified, NOT issue and NOT unchecked ---
{
  const s = { 0: 'verified', 1: 'issue', 2: 'unchecked', 3: 'verified' };
  assert(verifiedCount(s as any) === 2, 'verifiedCount = 2 (issue not counted as verified)');
  assert(issueCount(s as any) === 1, 'issueCount = 1');
  assert(uncheckedCount(s as any) === 1, 'uncheckedCount = 1');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
