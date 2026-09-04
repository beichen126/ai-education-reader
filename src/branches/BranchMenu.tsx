import { useEffect, useRef } from 'react'
import css from './branch.module.css'

type Props = {
  conversationId: string
  branchId?: string
  messageId: string
  onBranch: (messageId: string) => void
  onArtifact: (kind: 'note' | 'quiz' | 'summary' | 'study-guide' | 'custom', messageId: string) => void
  onClose: () => void
}

const ARTIFACT_ACTIONS: { kind: 'note' | 'quiz' | 'summary' | 'study-guide' | 'custom'; label: string }[] = [
  { kind: 'note', label: '整理成笔记' },
  { kind: 'quiz', label: '生成题目' },
  { kind: 'summary', label: '生成总结' },
  { kind: 'study-guide', label: '生成学习指南' },
  { kind: 'custom', label: '自定义处理' },
]

/**
 * Small contextual action menu on a completed message. Subtle, not a "Christmas tree";
 * keyboard accessible (Escape closes). Branches and study artifacts are distinct domains
 * but this menu may present them together.
 */
export function BranchMenu({ conversationId, branchId, messageId, onBranch, onArtifact, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [onClose])
  return (<div ref={ref} className={css.menu} role="menu" style={{ position: 'absolute', top: '100%', left: 0, right: 'auto', zIndex: 30 }} aria-label="消息操作">
    <button type="button" className={css.menuItem} role="menuitem" onClick={() => { onBranch(messageId); onClose() }}>从这里分支</button>
    <div className={css.sep} aria-hidden="true" style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0.25rem 0' }} />
    {ARTIFACT_ACTIONS.map((a) => (<button key={a.kind} type="button" className={css.menuItem} role="menuitem" onClick={() => { onArtifact(a.kind, messageId); onClose() }}>{a.label}</button>))}
  </div>)
}
