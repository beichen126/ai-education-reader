import { tx } from '../engine/locale'
import css from './media-inversion.module.css'

export function MediaRotateButton({ className, onRotate }: { className: string; onRotate: () => void }) {
  return <button type="button" className={className + ' ' + css.toggle} data-testid="media-rotate"
    aria-label={tx('顺时针旋转 90°', 'Rotate clockwise 90°')} onClick={onRotate}>{tx('旋转', 'Rotate')}</button>
}
