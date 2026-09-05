import { downloadText, downloadJson } from '../export/download'
import type { QuizDocument, StudyArtifact } from './artifact-types'

/** Option letter label that never produces "undefined": A..Z, then 1..;  (A12). */
export function optionLetter(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1)
}

/** Sanitize a title into a single safe filename stem (no path separators, no control chars). */
export function sanitizeExportStem(title: string): string {
  const base = String(title || 'artifact')
    .replace(/[\\/\u0000-\u001f:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
  return base || 'artifact'
}

const Q_TYPE_LABEL: Record<string, string> = {
  'single-choice': '单选题',
  'multiple-choice': '多选题',
  'true-false': '判断题',
  'short-answer': '简答题',
}

function answerToText(q: NonNullable<StudyArtifact['quiz']>['questions'][number]): string {
  switch (q.type) {
    case 'single-choice': return optionLetter(q.answer) + (q.options[q.answer] ? '. ' + q.options[q.answer] : '')
    case 'multiple-choice': return q.answers.map((i) => optionLetter(i) + (q.options[i] ? '. ' + q.options[i] : '')).join(', ')
    case 'true-false': return q.answer ? '正确' : '错误'
    case 'short-answer': return q.answer
  }
}

/**
 * Render a quiz artifact as human-readable Markdown (A9). Includes question type, options,
 * answer key, explanation (when present) and a brief source/provenance note.
 */
export function quizArtifactToMarkdown(artifact: StudyArtifact): string {
  const quiz: QuizDocument = artifact.quiz!
  const lines: string[] = []
  lines.push('# ' + (artifact.title || '题目'))
  lines.push('')
  lines.push('> 来源：' + (artifact.source.snapshot.sourceLabel || '未知') + ' · 生成于 ' + new Date(artifact.createdAt).toLocaleString())
  lines.push('')
  quiz.questions.forEach((q, qi) => {
    lines.push('## Question ' + (qi + 1))
    lines.push('')
    lines.push('**类型**：' + (Q_TYPE_LABEL[q.type] ?? q.type))
    lines.push('')
    lines.push(q.question)
    lines.push('')
    if (q.type === 'single-choice' || q.type === 'multiple-choice') {
      lines.push('### Options')
      lines.push('')
      q.options.forEach((opt, oi) => { lines.push(optionLetter(oi) + '. ' + opt) })
      lines.push('')
    }
    if (q.explanation) {
      lines.push('**解析**：' + q.explanation)
      lines.push('')
    }
    if (q.source) {
      const src = [q.source.fileName, q.source.pageNumber !== undefined ? ('p.' + q.source.pageNumber) : undefined].filter(Boolean).join(' · ')
      if (src) {
        lines.push('**来源**：' + src)
        lines.push('')
      }
    }
  })
  lines.push('## Answer Key')
  lines.push('')
  quiz.questions.forEach((q, qi) => {
    lines.push((qi + 1) + '. **' + answerToText(q) + '**')
  })
  lines.push('')
  return lines.join('\n')
}

/** Export a Note / document artifact as <title>.md from its CURRENT edited content (A9). */
export function exportNoteMarkdown(artifact: StudyArtifact): void {
  const stem = sanitizeExportStem(artifact.title)
  downloadText(stem + '.md', artifact.content ?? '', 'text/markdown')
}

/** Export a Quiz artifact as a human-readable <title>.md (A9). */
export function exportQuizMarkdown(artifact: StudyArtifact): void {
  const stem = sanitizeExportStem(artifact.title)
  downloadText(stem + '.md', quizArtifactToMarkdown(artifact), 'text/markdown')
}

/** Export a Quiz artifact as structured <title>.json (A9). Preserves the full quiz model. */
export function exportQuizJson(artifact: StudyArtifact): void {
  const stem = sanitizeExportStem(artifact.title)
  downloadJson(stem + '.json', artifact.quiz)
}
