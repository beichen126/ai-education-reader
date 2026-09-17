import { Modal } from '../dsh/primitives/Modal'
import type { PromptTransition } from './prompt-types'
import css from './prompt-inspector.module.css'
import { tx } from '../engine/locale'
import { promptDisplayName } from './prompt-display'

type Props = {
  transition: PromptTransition | null
  positionLabel: string
  onClose: () => void
}

function sourceLabel(source: PromptTransition['snapshot']['source']): string {
  if (source === 'builtin') return tx('内置', 'Built-in')
  if (source === 'custom') return tx('自定义', 'Custom')
  if (source === 'experimental') return tx('实验', 'Experimental')
  return tx('v1.x 历史', 'v1.x legacy')
}

/** Read-only view of the exact transition snapshot; it never resolves the latest profile. */
export function ConversationPromptInspector({ transition, positionLabel, onClose }: Props) {
  const snapshot = transition?.snapshot
  return (
    <Modal open={!!transition} onClose={onClose} title={tx('提示词检查器', 'Prompt inspector')} closeLabel={tx('关闭', 'Close')} className={css.dialog}>
      {snapshot && <div data-testid="prompt-inspector" className={css.inspector}>
        <div className={css.heading}>{promptDisplayName(snapshot.name, snapshot.profileId)}</div>
        <dl className={css.meta}>
          <div><dt>{tx('来源', 'Source')}</dt><dd>{sourceLabel(snapshot.source)}</dd></div>
          <div><dt>{tx('修订版本', 'Revision')}</dt><dd>{snapshot.revision === undefined ? tx('未记录', 'Not recorded') : 'v' + snapshot.revision}</dd></div>
          <div><dt>{tx('生效位置', 'Applied at')}</dt><dd>{positionLabel}</dd></div>
        </dl>
        <label className={css.promptLabel} htmlFor="prompt-inspector-content">{tx('当时实际提示词', 'Effective prompt at the time')}</label>
        <textarea id="prompt-inspector-content" data-testid="prompt-inspector-content" className={css.prompt} readOnly value={snapshot.content || tx('（空提示词）', '(Empty prompt)')} aria-label={tx('当时实际提示词', 'Effective prompt at the time')} />
        <div className={css.snapshotNote}>{tx('这是发送当时保存的快照；提示词资料后续修改或删除不会改变这里的内容。', 'This snapshot was saved when the message was sent. Later prompt edits or deletion do not change it.')}</div>
      </div>}
    </Modal>
  )
}
