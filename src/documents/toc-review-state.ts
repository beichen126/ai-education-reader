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

// Finding 9.4D.2-0.3: the save preflight state machine. A single pure decision so the
// dual-confirm flow (unchecked first, then issue) is unit-testable without rendering React.
export type SaveStage =
  | { kind: 'invalid'; invalidCount: number }
  | { kind: 'confirm-unchecked'; count: number }
  | { kind: 'confirm-issue'; count: number }
  | { kind: 'save' }

export function resolveSaveStage(opts: {
  invalid: boolean
  invalidCount: number
  uncheckedCount: number
  issueCount: number
  uncheckedAck: boolean
  issueAck: boolean
}): SaveStage {
  if (opts.invalid) return { kind: 'invalid', invalidCount: opts.invalidCount }
  if (opts.uncheckedCount > 0 && !opts.uncheckedAck) return { kind: 'confirm-unchecked', count: opts.uncheckedCount }
  if (opts.issueCount > 0 && !opts.issueAck) return { kind: 'confirm-issue', count: opts.issueCount }
  return { kind: 'save' }
}
