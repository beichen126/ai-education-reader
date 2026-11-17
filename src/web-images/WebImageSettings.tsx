import {useEffect, useState} from 'react'
import {patchSettings, useSettings} from '../engine/settings-store'
import {getSetting} from '../storage/storage'
import {configuredImageKeys, imageKeyState, resetImageKey, type ImageKey} from './key-pool'
import {Button, Input} from '../dsh/primitives'
import css from '../cockpit/cockpit.module.css'

export function WebImageSettings({saveRef}: {saveRef?: {current: (() => Promise<void>) | null}}) {
  const settings = useSettings(s => s)
  const [rows, setRows] = useState<ImageKey[]>(() => configuredImageKeys(settings).length ? configuredImageKeys(settings) : [{name:'配置 1',key:''}])
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState('')
  const [states, setStates] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  async function refresh() {
    setStates(await Promise.all(rows.map(async row => {const state = row.key ? await imageKeyState(row.key) : undefined; return state && state.until > Date.now() ? state.reason : '可用，按顺序尝试'})))
    setCurrent(await getSetting('firecrawl-current') || '')
  }
  useEffect(() => {void refresh()}, [rows])
  const edit = (index: number, patch: Partial<ImageKey>) => setRows(old => old.map((row,i) => i === index ? {...row,...patch} : row))
  async function save(clear = false) {
    setBusy(true)
    try {
      const keys = clear ? [] : configuredImageKeys({firecrawlKeys: rows})
      await patchSettings({firecrawlApiKey:'',firecrawlKeys:keys})
      if (clear) setRows([{name:'配置 1',key:''}])
      setStatus(keys.length ? '已保存，单图与双图配图能力已开启' : '已清除，模型配图能力已关闭')
      await refresh()
    } catch (error) {setStatus('保存失败，请重试'); throw error} finally {setBusy(false)}
  }
  if (saveRef) saveRef.current = () => save()
  return <div className={css.byokBlock} data-testid="firecrawl-settings">
    <div className={css.byokTitle}>网络配图 · Firecrawl</div>
    <p className={css.settingsHint}>按列表顺序使用 Key，连续 3 次额度耗尽后切换下一项，末项之后回到首项。每个图片位置直接取首张；调用由 Firecrawl 计费。配置独立于对话模型，Key 仅保存在当前设备。</p>
    {rows.map((row,i) => <div key={i} className={css.field}>
      <label htmlFor={'firecrawl-name-'+i}>配置 {i+1} 名称</label><Input id={'firecrawl-name-'+i} className={css.fieldInput} value={row.name} onChange={e=>edit(i,{name:e.target.value})} />
      <label htmlFor={'firecrawl-key-'+i}>{i === 0 ? 'Firecrawl API Key' : 'Firecrawl API Key '+(i+1)}</label><Input id={'firecrawl-key-'+i} className={css.fieldInput} type={visible ? 'text' : 'password'} value={row.key} onChange={e=>edit(i,{key:e.target.value})} autoComplete="off" placeholder="fc-…" />
      <div className={css.settingsHint}>{row.key ? states[i] : '待填写'}</div>
      <div className={css.keyControls}>
        <Button variant="outline" disabled={!row.key} onClick={()=>void resetImageKey(row.key).then(refresh)}>从此项开始</Button>
        {i>0 && <Button variant="outline" onClick={()=>setRows(old=>{const next=[...old];[next[i-1],next[i]]=[next[i],next[i-1]];return next})}>上移</Button>}
        {rows.length>1 && <Button variant="outline" onClick={()=>setRows(old=>old.filter((_,n)=>n!==i))}>移除</Button>}
      </div>
    </div>)}
    <div className={css.keyControls} style={{flexWrap:'wrap'}}>
      <Button variant="outline" disabled={rows.length>=10} onClick={()=>setRows(old=>[...old,{name:'配置 '+(old.length+1),key:''}])}>添加 Key</Button>
      <Button variant="outline" onClick={()=>setVisible(v=>!v)}>{visible?'隐藏':'显示'}</Button>
      <Button disabled={busy} onClick={()=>void save().catch(()=>{})}>保存配图配置</Button>
      <Button variant="outline" disabled={busy} onClick={()=>void save(true).catch(()=>{})}>清除</Button>
    </div>
    <p className={css.settingsHint}>{configuredImageKeys(settings).length ? '状态：单图与双图已开启' : '状态：待配置，模型能力目录中隐藏配图'}{current && ' · 最近使用：'+current}</p>
    <p className={css.settingsHint}>每次请求最多轮换一圈；网络错误单独处理。下次从保存的位置继续，也可指定起点。相同账号的 Key 可能共享额度。</p>
    <a href="https://www.firecrawl.dev/app" target="_blank" rel="noopener noreferrer">打开 Firecrawl 控制台</a>
    {status && <p role="status">{status}</p>}
  </div>
}
