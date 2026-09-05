import { useEffect, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { listArtifacts, deleteArtifact } from './artifact-store'
import { isArtifactSourceLive } from './artifact-service'
import type { ArtifactKind, StudyArtifact } from './artifact-types'
import css from './artifact.module.css'

const FILTERS: { key: 'all' | ArtifactKind; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'note', label: '笔记' },
  { key: 'quiz', label: '题目' },
  { key: 'summary', label: '总结' },
  { key: 'study-guide', label: '学习指南' },
  { key: 'custom', label: '自定义' },
]

const KIND_LABEL: Record<ArtifactKind, string> = { note: '笔记', quiz: '题目', summary: '总结', 'study-guide': '学习指南', custom: '自定义' }

type Props = { onOpen: (artifact: StudyArtifact) => void }

/**
 * Local Study Artifact library. Lists title/kind/source/updatedAt, filters by kind,
 * opens (edit/view) or deletes. Never hydrates full bodies for a list view.
 */
export function ArtifactLibrary({ onOpen }: Props) {
  const [arts, setArts] = useState<StudyArtifact[]>([])
  const [filter, setFilter] = useState<'all' | ArtifactKind>('all')
  const [loaded, setLoaded] = useState(false)
  // A11: the frozen source.snapshot.sourceDeleted flag is never trusted; evaluate the
  // live source conversation/branch on open and display the dynamic result.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())
  useEffect(() => { void reload() }, [])
  async function reload() {
    const a = await listArtifacts()
    setArts(a)
    const del = new Set<string>()
    await Promise.all(a.map(async (art) => { if (!(await isArtifactSourceLive(art))) del.add(art.id) }))
    setDeletedIds(del)
    setLoaded(true)
  }
  const shown = filter === 'all' ? arts : arts.filter((a) => a.kind === filter)

  async function remove(id: string) {
    if (!globalThis.confirm('删除该学习成果？')) return
    await deleteArtifact(id)
    await reload()
  }

  return (<div className={css.library}>
    <h2 className={css.libraryTitle}>学习成果</h2>
    <div className={css.filters}>
      {FILTERS.map((f) => (<button key={f.key} type="button" className={css.filterBtn + (filter === f.key ? ' ' + css.active : '')} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>))}
    </div>
    {loaded && shown.length === 0 && <div className={css.empty}>还没有学习成果。在消息里选择「整理成笔记 / 生成题目」开始创建。</div>}
    <div className={css.grid}>
      {shown.map((a) => (
        <div key={a.id} className={css.card} role="button" tabIndex={0} onClick={() => onOpen(a)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(a) }} aria-label={'打开 ' + a.title}>
          <h3 className={css.cardTitle}>{a.title}</h3>
          <p className={css.cardKind}>{KIND_LABEL[a.kind]}</p>
          <p className={css.cardMeta}>{a.source.snapshot.sourceLabel}{deletedIds.has(a.id) ? ' · 原会话已删除' : ''}</p>
          <p className={css.cardMeta}>{new Date(a.updatedAt).toLocaleString()}</p>
          <div style={{ marginTop: '0.5rem' }}>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onOpen(a) }}>打开</Button>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void remove(a.id) }}>删除</Button>
          </div>
        </div>
      ))}
    </div>
  </div>)
}
