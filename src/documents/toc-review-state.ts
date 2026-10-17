// Pure review-state helpers (Stage 9.4D.1). Extracted so the review semantics are unit-
// tested without rendering React. ReviewState is per-row: 'unchecked' | 'verified' | 'issue'.

export type ReviewStateValue = 'unchecked' | 'verified' | 'issue'
export type ReviewState = Record<number, ReviewStateValue>

export type RemovedReviewEntry<T> = { index: number; row: T; state: ReviewStateValue; levelRaw?: string }

/** Index-based UI metadata must follow its row when an entry is removed/restored. */
export function removeReviewEntry<T>(rows: T[], state: ReviewState, levelRaw: Record<number, string>, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) throw new RangeError('Invalid outline review index')
  const removed: RemovedReviewEntry<T> = { index, row: rows[index], state: state[index] ?? 'unchecked', levelRaw: levelRaw[index] }
  const nextRows = rows.filter((_, i) => i !== index)
  const nextState: ReviewState = {}, nextRaw: Record<number, string> = {}
  nextRows.forEach((_, i) => {
    const from = i < index ? i : i + 1
    nextState[i] = state[from] ?? 'unchecked'
    if (levelRaw[from] !== undefined) nextRaw[i] = levelRaw[from]
  })
  return { rows: nextRows, state: nextState, levelRaw: nextRaw, removed }
}

export function restoreReviewEntry<T>(rows: T[], state: ReviewState, levelRaw: Record<number, string>, removed: RemovedReviewEntry<T>) {
  const index = Math.max(0, Math.min(rows.length, removed.index))
  const nextRows = [...rows.slice(0, index), removed.row, ...rows.slice(index)]
  const nextState: ReviewState = {}, nextRaw: Record<number, string> = {}
  nextRows.forEach((_, i) => {
    const from = i < index ? i : i - 1
    nextState[i] = i === index ? removed.state : state[from] ?? 'unchecked'
    const raw = i === index ? removed.levelRaw : levelRaw[from]
    if (raw !== undefined) nextRaw[i] = raw
  })
  return { rows: nextRows, state: nextState, levelRaw: nextRaw, index }
}

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
