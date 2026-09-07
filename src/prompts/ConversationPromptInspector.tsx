import { Modal } from '../dsh/primitives/Modal'
import type { PromptTransition } from './prompt-types'
import css from './prompt-inspector.module.css'

type Props = {
  transition: PromptTransition | null
  positionLabel: string
  onClose: () => void
}

function sourceLabel(source: PromptTransition['snapshot']['source']): string {
  if (source === 'builtin') return '内置'
  if (source === 'custom') return '自定义'
  if (source === 'experimental') return '实验'
  return 'v1.x 历史'
}

/** Read-only view of the exact transition snapshot; it never resolves the latest profile. */
export function ConversationPromptInspector({ transition, positionLabel, onClose }: Props) {
  const snapshot = transition?.snapshot
  return (
    <Modal open={!!transition} onClose={onClose} title="提示词检查器" closeLabel="关闭" className={css.dialog}>
      {snapshot && <div data-testid="prompt-inspector" className={css.inspector}>
        <div className={css.heading}>{snapshot.name}</div>
        <dl className={css.meta}>
          <div><dt>来源</dt><dd>{sourceLabel(snapshot.source)}</dd></div>
          <div><dt>修订版本</dt><dd>{snapshot.revision === undefined ? '未记录' : 'v' + snapshot.revision}</dd></div>
          <div><dt>生效位置</dt><dd>{positionLabel}</dd></div>
        </dl>
        <label className={css.promptLabel} htmlFor="prompt-inspector-content">当时实际提示词</label>
        <textarea id="prompt-inspector-content" data-testid="prompt-inspector-content" className={css.prompt} readOnly value={snapshot.content || '（空提示词）'} aria-label="当时实际提示词" />
        <div className={css.snapshotNote}>这是发送当时保存的快照；提示词资料后续修改或删除不会改变这里的内容。</div>
      </div>}
    </Modal>
  )
}
