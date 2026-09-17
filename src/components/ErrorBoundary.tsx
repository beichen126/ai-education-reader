import { Component } from 'react'
import type { ReactNode } from 'react'
import { tx } from '../engine/locale'
type Props = { children: ReactNode }
type State = { error: Error | null }
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: unknown) { console.error('[ErrorBoundary]', error, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, padding:24, textAlign:'center' }}>
          <div style={{ fontWeight:600 }}>{tx('页面出了一点问题', 'Something went wrong')}</div>
          <div style={{ fontSize:12, color:'#888', maxWidth:480, wordBreak:'break-word' }}>{String(this.state.error?.message || this.state.error)}</div>
          <button onClick={() => window.location.reload()} style={{ padding:'6px 16px', borderRadius:8, border:'1px solid #ccc', background:'transparent', cursor:'pointer' }}>{tx('刷新页面', 'Reload page')}</button>
        </div>
      )
    }
    return this.props.children
  }
}
