import {useEffect, useState} from 'react'
import {patchSettings, useSettings} from '../engine/settings-store'
import {getSetting} from '../storage/storage'
import {configuredImageKeys, imageKeyState, resetImageKey, type ImageKey} from './key-pool'
import {Button, Input} from '../dsh/primitives'
import css from '../cockpit/cockpit.module.css'
import layout from './settings.module.css'

export function WebImageSettings({saveRef, dirtyRef}: {saveRef?: {current: (() => Promise<void>) | null}; dirtyRef?: {current:boolean}}) {
  const settings = useSettings(s => s)
  const [rows, setRows] = useState<ImageKey[]>(() => configuredImageKeys(settings).length ? configuredImageKeys(settings) : [{name:'配置 1',key:''}])
  const [visible, setVisible] = useState<number[]>([])
  const [status, setStatus] = useState('')
  const [states, setStates] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  async function refresh() {
    setStates(await Promise.all(rows.map(async row => {const state = row.key ? await imageKeyState(row.key) : undefined; return state && state.until > Date.now() ? state.reason : '尚无错误记录'})))
    setCurrent(await getSetting('firecrawl-current') || '')
  }
  useEffect(() => {void refresh()}, [rows])
  const savedKeys = JSON.stringify(configuredImageKeys(settings).map(r=>r.key))
  const dirty = JSON.stringify(configuredImageKeys({firecrawlKeys:rows}).map(r=>r.key)) !== savedKeys
  if (dirtyRef) dirtyRef.current = dirty
  useEffect(() => {
    const keys: string[] = JSON.parse(savedKeys)
    setRows(keys.length ? keys.map((key, index) => ({ name:'Key ' + (index + 1), key })) : [{ name:'配置 1', key:'' }])
    setVisible([])
  }, [savedKeys])
  const edit = (index: number, patch: Partial<ImageKey>) => setRows(old => old.map((row,i) => i === index ? {...row,...patch} : row))
  async function save(clear = false) {
    setBusy(true)
    try {
      const keys = clear ? [] : configuredImageKeys({firecrawlKeys: rows}).map((row,i)=>({...row,name:`Key ${i+1}`}))
      await patchSettings({firecrawlApiKey:'',firecrawlKeys:keys})
      if (clear) setRows([{name:'配置 1',key:''}])
      setStatus(keys.length ? '已保存，单图与双图配图能力已开启' : '已清除，模型配图能力已关闭')
      await refresh()
    } catch (error) {setStatus('保存失败，请重试'); throw error} finally {setBusy(false)}
  }
  if (saveRef) saveRef.current = () => save()
  return <div className={css.byokBlock} data-testid="firecrawl-settings">
    <div className={css.byokTitle}>网络配图 · Firecrawl</div>
    <p className={css.settingsHint}>为回答配图，Key 保存在本机。</p>
    <a className={layout.consoleLink} href="https://www.firecrawl.dev/app" target="_blank" rel="noopener noreferrer">获取 API Key ↗</a>
    <div className={layout.entries}>
    {rows.map((row,i) => <section key={i} className={layout.entry}>
      <div className={layout.heading}><strong>{rows.length === 1 ? 'Key 1' : `Key ${i+1}`}</strong><span className={layout.order}>{i === 0 ? '优先使用' : `备用 ${i}`}</span></div>
      <label htmlFor={'firecrawl-key-'+i}>{i === 0 ? 'Firecrawl API Key' : 'Firecrawl API Key '+(i+1)}</label>
      <div className={layout.keyRow}>
        <Input id={'firecrawl-key-'+i} className={css.fieldInput} type={visible.includes(i) ? 'text' : 'password'} value={row.key} onChange={e=>edit(i,{key:e.target.value})} autoComplete="off" placeholder="fc-…" />
        <Button variant="outline" onClick={()=>setVisible(old=>old.includes(i)?old.filter(n=>n!==i):[...old,i])}>{visible.includes(i)?'隐藏':'显示'}</Button>
        <Button variant="outline" className={layout.clear} disabled={!row.key} onClick={()=>edit(i,{key:''})}>清除</Button>
      </div>
      {rows.length>1 && <details className={layout.manage}><summary>管理此配置</summary><p className={css.settingsHint}>{states[i]}</p><div className={layout.actions}>
        <Button variant="outline" disabled={!row.key || dirty} onClick={()=>void resetImageKey(row.key).then(refresh)}>下一次从此项开始</Button>
        {i>0 && <Button variant="outline" onClick={()=>{setVisible([]);setRows(old=>{const next=[...old];[next[i-1],next[i]]=[next[i],next[i-1]];return next})}}>上移一位</Button>}
        <Button variant="outline" className={layout.clear} onClick={()=>{setVisible([]);setRows(old=>old.filter((_,n)=>n!==i))}}>移除此配置</Button>
      </div></details>}
    </section>)}
    </div>
    <Button variant="outline" className={layout.add} disabled={rows.length>=10} onClick={()=>setRows(old=>[...old,{name:'配置 '+(old.length+1),key:''}])}>＋ 添加备用 Key</Button>
    <div className={layout.checks}>
      <strong>配置状态</strong>
      <div>{dirty ? '有修改待保存' : configuredImageKeys(settings).length ? `已保存 ${configuredImageKeys(settings).length} 个 Key · 配图已开启` : '填写并保存 Key 后开启配图'}</div>
      {current && <small>最近使用：{current}</small>}
    </div>
    <details className={layout.manage}><summary>备用 Key 如何切换？</summary><p className={css.settingsHint}>额度耗尽连续 3 次后切换下一项，每次最多轮换一圈。同账号的 Key 可能共享额度。</p></details>
    <div className={layout.footer}><span role="status" className={css.settingsHint}>{dirty ? '修改尚未保存' : status}</span><Button variant="primary" disabled={busy} onClick={()=>void save().catch(()=>{})}>{busy?'正在保存…':'保存配图配置'}</Button></div>
  </div>
}
