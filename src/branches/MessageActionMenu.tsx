import { useEffect, useRef, useState } from 'react'
import type { Message } from '../engine/types'
import type { CreateArtifactKind } from '../artifacts/artifact-types'
import type { StudyCardRating } from '../study-cards/study-card-types'
import css from './branch.module.css'
import { tx } from '../engine/locale'

export type CardSaveState = 'idle' | 'saving' | 'saved' | 'failed'

export type MessageActionMenuProps = {
  conversationId: string
  branchId?: string
  message: Message
  isStreaming: boolean
  cardState: CardSaveState
  cardRating?: StudyCardRating
  onCreateBranch(): void
  onCreateArtifact(kind: CreateArtifactKind): void
  onCreateCustomArtifact(): void
  onSaveCard(rating?: StudyCardRating): void
  onViewSavedCard(): void
  onClose(): void
}

type MenuItem = { testId: string; label: string; action: () => void; disabled?: boolean }

/**
 * v2.2.0 §1.2 message menu. Three first-level entries, and the special-branch group as a
 * real submenu — never a flat list of three unrelated actions:
 *
 *   从这里分支
 *   开启特殊分支  ›   整理成笔记 / 生成题目 / 自定义提示词…
 *   保存本轮回复为学习卡片
 */
export function MessageActionMenu(props: MessageActionMenuProps) {
  const { message, isStreaming, cardState, cardRating, onCreateBranch, onCreateArtifact, onCreateCustomArtifact, onSaveCard, onViewSavedCard, onClose } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const [specialOpen, setSpecialOpen] = useState(false)
  // Only a completed, non-empty, non-streaming assistant reply can become a card.
  const canSaveCard = message.role === 'assistant' && !isStreaming && message.status === undefined && message.content.trim().length > 0
  const saved = cardState === 'saved'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (specialOpen) { setSpecialOpen(false); return }
        onClose()
      }
    }
    const onDown = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [onClose, specialOpen])

  const moveFocus = (delta: number) => {
    if (!ref.current) return
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'))
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : (index + delta + items.length) % items.length
    items[next]?.focus({ preventScroll: true })
  }

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setSpecialOpen(true); window.requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-testid="message-action-note"]')?.focus({ preventScroll: true })) }
    else if (event.key === 'ArrowLeft' && specialOpen) { event.preventDefault(); setSpecialOpen(false); ref.current?.querySelector<HTMLElement>('[data-testid="message-action-special"]')?.focus({ preventScroll: true }) }
  }

  const cardLabel = cardState === 'saving' ? tx('正在保存…', 'Saving…') : saved ? tx('查看已保存卡片', 'View saved card') : cardState === 'failed' ? tx('保存失败，重试', 'Save failed; retry') : tx('保存本轮回复为学习卡片', 'Save this response as a study card')

  const specialItems: MenuItem[] = [
    { testId: 'message-action-note', label: tx('整理成笔记', 'Turn into notes'), action: () => onCreateArtifact('note') },
    { testId: 'message-action-quiz', label: tx('生成题目', 'Generate quiz'), action: () => onCreateArtifact('quiz') },
    { testId: 'message-action-custom', label: tx('自定义提示词…', 'Custom prompt…'), action: onCreateCustomArtifact },
  ]

  return (
    <div ref={ref} className={css.menu} role="menu" aria-label={tx('消息操作', 'Message actions')} data-testid="message-action-menu" style={{ position: 'absolute', top: '100%', left: 0, right: 'auto', zIndex: 30 }} onKeyDown={onMenuKeyDown}>
      <button type="button" className={css.menuItem} role="menuitem" data-testid="message-action-branch" onClick={() => { onCreateBranch(); onClose() }}>{tx('从这里分支', 'Branch from here')}</button>
      <button
        type="button"
        className={css.menuItem}
        role="menuitem"
        data-testid="message-action-special"
        aria-haspopup="menu"
        aria-expanded={specialOpen}
        onClick={() => setSpecialOpen(open => !open)}
      >
        {tx('开启特殊分支', 'Create study output')} <span aria-hidden="true">›</span>
      </button>
      {specialOpen && (
        <div className={css.submenu} role="menu" aria-label={tx('特殊分支', 'Study output')} data-testid="message-action-special-menu">
          {specialItems.map(item => (
            <button key={item.testId} type="button" className={css.menuItem} role="menuitem" data-testid={item.testId} disabled={item.disabled} onClick={() => { item.action(); onClose() }}>{item.label}</button>
          ))}
        </div>
      )}
      <div className={css.sep} aria-hidden="true" />
      <button
        type="button"
        className={css.menuItem}
        role="menuitem"
        data-testid="message-action-save-card"
        data-card-state={cardState}
        disabled={!canSaveCard || cardState === 'saving'}
        title={canSaveCard ? undefined : tx('只能保存已完成且非空的 AI 回复', 'Only completed, non-empty AI responses can be saved')}
        onClick={() => { if (saved) onViewSavedCard(); else onSaveCard(); onClose() }}
      >
        {cardLabel}
      </button>
      {canSaveCard && cardState !== 'saving' && (
        <div className={css.cardRatingQuick} role="group" aria-label={saved ? tx('快速修改学习卡片评分', 'Quickly change card rating') : tx('保存学习卡片并评分', 'Save and rate study card')} data-testid="message-action-card-rating">
          <span>{saved ? tx('快速评分', 'Quick rating') : tx('保存并评分', 'Save and rate')}</span>
          <span className={css.cardRatingStars}>
            {([1, 2, 3, 4, 5] as StudyCardRating[]).map(value => (
              <button
                key={value}
                type="button"
                className={css.cardRatingStar}
                data-testid={'message-action-card-rating-' + value}
                data-active={value <= (cardRating ?? 0) ? 'true' : 'false'}
                aria-label={saved ? tx('修改为 ' + value + ' 分', 'Change rating to ' + value) : tx('保存并设置为 ' + value + ' 分', 'Save with rating ' + value)}
                aria-pressed={cardRating === value}
                title={tx(value + ' 分', value + ' stars')}
                onClick={() => { onSaveCard(value); onClose() }}
              >★</button>
            ))}
          </span>
        </div>
      )}
    </div>
  )
}
