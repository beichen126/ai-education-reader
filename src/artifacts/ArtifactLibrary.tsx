import { useEffect, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { listArtifacts, deleteArtifact } from './artifact-store'
import { filterLiveArtifactSources } from './artifact-service'
import type { ArtifactKind, StudyArtifact } from './artifact-types'
import css from './artifact.module.css'
import { tx } from '../engine/locale'

// New outputs are Note / Quiz. Legacy kinds remain browsable under one history filter
// so they are never deleted or mistaken for a currently supported creation type.
type LibraryFilter = 'all' | 'note' | 'quiz' | 'legacy'
const FILTERS: { key: LibraryFilter; label: string; labelEn: string }[] = [
  { key: 'all', label: '全部', labelEn: 'All' },
  { key: 'note', label: '笔记', labelEn: 'Notes' },
  { key: 'quiz', label: '题目', labelEn: 'Quizzes' },
  { key: 'legacy', label: '历史类型', labelEn: 'Legacy' },
]
const LEGACY_KINDS: ArtifactKind[] = ['custom', 'summary', 'study-guide']

const KIND_LABEL: Record<ArtifactKind, string> = { note: '笔记', quiz: '题目', summary: '历史类型 · 总结', 'study-guide': '历史类型 · 学习指南', custom: '历史类型 · 自定义' }
const KIND_LABEL_EN: Record<ArtifactKind, string> = { note: 'Note', quiz: 'Quiz', summary: 'Legacy · Summary', 'study-guide': 'Legacy · Study guide', custom: 'Legacy · Custom' }

type Props = { onOpen: (artifact: StudyArtifact) => void }

/**
 * Local Study Artifact library. Lists title/kind/source/updatedAt, filters by kind,
 * opens (edit/view) or deletes. Never hydrates full bodies for a list view.
 */
export function ArtifactLibrary({ onOpen }: Props) {
  const [arts, setArts] = useState<StudyArtifact[]>([])
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [loaded, setLoaded] = useState(false)
  // A11: the frozen source.snapshot.sourceDeleted flag is never trusted; evaluate the
  // live source conversation/branch on open and display the dynamic result.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  useEffect(() => { void reload() }, [])
  async function reload() {
    const a = await listArtifacts()
    setArts(a)
    const del = await filterLiveArtifactSources(a)
    setDeletedIds(del)
    setLoaded(true)
  }
  const shown = filter === 'all' ? arts : arts.filter((a) => filter === 'legacy' ? LEGACY_KINDS.includes(a.kind) : a.kind === filter)

  async function remove(id: string) {
    if (!globalThis.confirm(tx('删除该学习成果？', 'Delete this study output?'))) return
    await deleteArtifact(id)
    await reload()
  }

  return (<div className={css.library}>
    <h2 className={css.libraryTitle}>{tx('学习成果', 'Study outputs')}</h2>
    <div className={css.filters}>
      {FILTERS.map((f) => (<button key={f.key} type="button" className={css.filterBtn + (filter === f.key ? ' ' + css.active : '')} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{tx(f.label, f.labelEn)}</button>))}
    </div>
    {loaded && shown.length === 0 && <div className={css.empty}>{tx('还没有学习成果。在消息里选择「整理成笔记 / 生成题目」开始创建。', 'No study outputs yet. Create a note or quiz from a message to begin.')}</div>}
    <div className={css.grid}>
      {shown.map((a) => (
        <div key={a.id} className={css.card} role="button" tabIndex={0} onClick={() => onOpen(a)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(a) }} aria-label={tx('打开 ', 'Open ') + a.title}>
          <h3 className={css.cardTitle}>{a.title}</h3>
          <p className={css.cardKind}>{tx(KIND_LABEL[a.kind], KIND_LABEL_EN[a.kind])}</p>
          <p className={css.cardMeta}>{a.source.snapshot.sourceLabel}{deletedIds.has(a.id) ? tx(' · 原会话已删除', ' · Source chat deleted') : ''}</p>
          <p className={css.cardMeta}>{new Date(a.updatedAt).toLocaleString()}</p>
          <div style={{ marginTop: '0.5rem' }}>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpen(a) }}>{tx('打开', 'Open')}</Button>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void remove(a.id) }}>{tx('删除', 'Delete')}</Button>
          </div>
        </div>
      ))}
    </div>
  </div>)
}
