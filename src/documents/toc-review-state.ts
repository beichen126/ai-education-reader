// Pure review-state helpers (Stage 9.4D.1). Extracted so the review semantics are unit-
// tested without rendering React. ReviewState is per-row: 'unchecked' | 'verified' | 'issue'.

export type ReviewStateValue = 'unchecked' | 'verified' | 'issue'
export type ReviewState = Record<number, ReviewStateValue>

export function emptyReviewState(count: number): ReviewState {
  const s: ReviewState = {}
  for (let i = 0; i < count; i++) s[i] = 'unchecked'
  return s
}

/** Editing a row (title/level/page) resets that row's review state to unchecked. */
export function markRowUnchecked(state: ReviewState, i: number): ReviewState { return { ...state, [i]: 'unchecked' } }

/** A global page-offset remap resets every row whose startPage actually changed. */
export function markChangedRowsUnchecked(state: ReviewState, before: (number | null)[], after: { startPage: number | null }[]): ReviewState {
  let s = state
  for (let i = 0; i < after.length; i++) {
    if (after[i].startPage !== before[i]) s = { ...s, [i]: 'unchecked' }
  }
  return s
}

export function verifiedCount(state: ReviewState): number { return Object.values(state).filter(v => v === 'verified').length }
export function issueCount(state: ReviewState): number { return Object.values(state).filter(v => v === 'issue').length }
export function uncheckedCount(state: ReviewState): number { return Object.values(state).filter(v => v === 'unchecked').length }
