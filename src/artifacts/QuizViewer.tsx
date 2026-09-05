import { useMemo, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { optionLetter } from './artifact-export'
import type { QuizDocument, QuizQuestion } from './artifact-types'

type AnswerMap = Record<string, string | number[] | boolean | string>

/** Grade a question. null means "cannot be auto-graded" (short-answer) — do NOT fabricate a wrong. */
function isCorrect(q: QuizQuestion, a: AnswerMap[string]): boolean | null {
  const sel = a
  switch (q.type) {
    case 'single-choice': {
      const chosen = Array.isArray(sel) ? sel[0] : sel
      if (typeof chosen !== 'number') return false
      return chosen === q.answer
    }
    case 'multiple-choice': {
      if (!Array.isArray(sel)) return false
      const mine = [...new Set(sel.map(Number))].sort((x, y) => x - y)
      const correct = [...q.answers].sort((x, y) => x - y)
      return mine.length === correct.length && mine.every((v, i) => v === correct[i])
    }
    case 'true-false': {
      return typeof sel === 'boolean' && sel === q.answer
    }
    case 'short-answer': {
      return null
    }
    default: return false
  }
}

function isShortAnswerClose(user: string, ref: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return norm(user) === norm(ref)
}

function Question({ q, answers, revealed, setAnswer }: { q: QuizQuestion; answers: AnswerMap; revealed: boolean; setAnswer: (v: any) => void }) {
  const chosen = answers[q.id] as any
  const correct = isCorrect(q, chosen)
  const correctIdx = (i: number) => {
    if (q.type === 'single-choice') return q.answer === i
    if (q.type === 'multiple-choice') return q.answers.includes(i)
    return false
  }
  const chosenIdx = q.type === 'multiple-choice' ? (Array.isArray(chosen) ? chosen.map(Number) : []) : (typeof chosen === 'number' ? [chosen] : [])
  const source = q.source ? (q.source.fileName ?? '') + (q.source.pageNumber ? ' · p.' + q.source.pageNumber : '') : undefined
  const shortExact = q.type === 'short-answer' && typeof chosen === 'string' && revealed
  return (
    <div style={{ borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '0.75rem 0' }}>
      <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{q.question}</div>
      {q.type === 'single-choice' && q.options.map((opt, i) => {
        const isSel = chosen === i
        return (<label key={i} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', padding: '0.25rem 0' }}><input type='radio' name={q.id} checked={isSel} disabled={revealed} onChange={() => setAnswer(i)} />{optionLetter(i)}. {opt}</label>)
      })}
      {q.type === 'multiple-choice' && q.options.map((opt, i) => {
        const isSel = chosenIdx.includes(i)
        return (<label key={i} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', padding: '0.25rem 0' }}><input type='checkbox' checked={isSel} disabled={revealed} onChange={(e) => { const cur = Array.isArray(chosen) ? chosen.map(Number) : []; const next = e.target.checked ? [...cur, i] : cur.filter((x) => x !== i); setAnswer(next) }} />{optionLetter(i)}. {opt}</label>)
      })}
      {q.type === 'true-false' && [true, false].map((b) => {
        const isSel = chosen === b
        return (<label key={String(b)} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', padding: '0.25rem 0' }}><input type='radio' name={q.id} checked={isSel} disabled={revealed} onChange={() => setAnswer(b)} />{b ? '正确' : '错误'}</label>)
      })}
      {q.type === 'short-answer' && <input aria-label='简答题答案' disabled={revealed} value={typeof chosen === 'string' ? chosen : ''} onChange={(e) => setAnswer(e.target.value)} style={{ width: '100%', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '0.375rem', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '0.375rem' }} />}
      {revealed && q.type === 'short-answer' && (<div style={{ marginTop: '0.5rem', fontSize: '0.8125rem', color: 'var(--dsw-alias-label-secondary)' }}>
        {shortExact && isShortAnswerClose(chosen, q.answer) ? '（与参考答案接近）' : ''}
        <div>参考答案：{q.answer}</div>
        <div style={{ opacity: 0.8 }}>简答题请自行对照检查，系统不自动判为对/错。</div>
      </div>)}
      {revealed && q.type !== 'short-answer' && (<div style={{ marginTop: '0.5rem', fontSize: '0.8125rem', color: correct ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }}>{correct ? '✓ 正确' : '✗ 错误'}</div>)}
      {revealed && q.explanation && <div style={{ marginTop: '0.25rem', fontSize: '0.8125rem', color: 'var(--dsw-alias-label-secondary)' }}>解析：{q.explanation}</div>}
      {revealed && source && <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: 'var(--dsw-alias-label-tertiary)' }}>来源：{source}</div>}
    </div>
  )
}

export function QuizViewer({ quiz }: { quiz: QuizDocument }) {
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [revealed, setRevealed] = useState(false)
  const score = useMemo(() => {
    if (!revealed) return { correct: 0, graded: 0, total: quiz.questions.length, ungraded: quiz.questions.length }
    let n = 0, graded = 0, ungraded = 0
    for (const q of quiz.questions) { const r = isCorrect(q, answers[q.id]); if (r === null) ungraded++; else { graded++; if (r) n++ } }
    return { correct: n, graded, total: quiz.questions.length, ungraded }
  }, [revealed, answers, quiz])
  const unanswered = quiz.questions.filter((q) => answers[q.id] === undefined).length
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>共 {quiz.questions.length} 题{revealed ? (' · 得分 ' + score.correct + '/' + score.graded) : (unanswered > 0 ? (' · 未答 ' + unanswered) : '')}{revealed && score.ungraded > 0 ? (' · ' + score.ungraded + ' 题需自行对照') : ''}</span>
        <Button size='sm' variant='primary' onClick={() => setRevealed(true)} disabled={revealed}>提交/查看答案</Button>
        <Button size='sm' variant='ghost' onClick={() => { setAnswers({}); setRevealed(false) }}>重置</Button>
      </div>
      {quiz.questions.map((q) => (<Question key={q.id} q={q} answers={answers} revealed={revealed} setAnswer={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))} />))}
    </div>
  )
}
