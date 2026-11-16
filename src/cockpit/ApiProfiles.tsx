import {useState} from 'react'
import {useSettings,patchSettings,DEFAULT_SETTINGS,useSettingsMutation,type Settings} from '../engine/settings-store'
import {profileConfig,type ApiProfile} from '../engine/api-profiles'
import {tx} from '../engine/locale'
import {Button,Input} from '../dsh/primitives'
import css from './cockpit.module.css'
export function ApiProfiles({draft,onApply}:{draft:Settings;onApply:(settings:Settings)=>void}) {
 const settings=useSettings(s=>s),mutation=useSettingsMutation()
 const [name,setName]=useState(''),[error,setError]=useState('')
 const profiles=settings.apiProfiles || []
 const disabled=mutation.status==='pending'
 const snapshot=():ApiProfile[]=>{
   if (!profiles.length) return [{id:'initial',name:tx('原有配置','Original configuration'),config:profileConfig(draft)}]
   return profiles.map(p=>p.id===settings.activeApiProfileId?{...p,config:profileConfig(draft)}:p)
 }
 async function apply(rows:ApiProfile[],id:string) {
   const selected=rows.find(p=>p.id===id);if(!selected)return
   setError('')
   try {onApply(await patchSettings({...selected.config,chatProvider:'deepseek',apiProfiles:rows,activeApiProfileId:id}));setName('')}
   catch {setError(tx('配置保存失败，请重试。','Unable to save configurations. Please retry.'))}
 }
 const create=(copy:boolean)=>{
  const label=name.trim();if(!label){setError(tx('请先填写配置名称。','Enter a configuration name first.'));return}
  if(profiles.some(p=>p.name===label)){setError(tx('这个名称已存在，请使用其他名称。','This name already exists. Choose another name.'));return}
  const rows=snapshot(),id=crypto.randomUUID()
  rows.push({id,name:label,config:copy?profileConfig(draft):profileConfig({...DEFAULT_SETTINGS,apiKey:'',speechApiKey:'',speechApiUrl:'',speechVoice:'stella',webSearchEnabled:false,readUrlEnabled:true,autoTitleEnabled:true,userMetadataEnabled:true,nativeDeepSeekProxy:false})})
  void apply(rows,id)
 }
 return <div className={css.exportSection} data-testid="api-profiles">
  <div className={css.exportTitle}>{tx('我的 API 配置','My API configurations')}</div>
  <label className={css.field}><span>{tx('切换配置','Switch configuration')}</span><select className={css.fieldInput} aria-label={tx('切换配置','Switch configuration')} value={settings.activeApiProfileId||''} disabled={disabled} onChange={e=>void apply(snapshot(),e.target.value)}>
   {!settings.activeApiProfileId&&<option value="">{tx('当前配置（未命名）','Current configuration (unnamed)')}</option>}
   {profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
  </select></label>
  <Input className={css.fieldInput} aria-label={tx('配置名称','Configuration name')} placeholder={tx('自定义名称，例如 DeepSeek 官方','Name, for example DeepSeek official')} value={name} maxLength={60} onChange={e=>setName(e.target.value)} />
  <div className={css.settingsActions} style={{flexWrap:'wrap'}}>
   <Button variant="outline" disabled={disabled} onClick={()=>create(false)}>{tx('新建配置','New configuration')}</Button>
   <Button variant="outline" disabled={disabled} onClick={()=>create(true)}>{tx('当前设置另存为','Save current as')}</Button>
   <Button variant="outline" disabled={disabled||!settings.activeApiProfileId||!name.trim()} onClick={()=>{if(profiles.some(p=>p.id!==settings.activeApiProfileId&&p.name===name.trim())){setError(tx('名称已存在','Name already exists'));return}void apply(snapshot().map(p=>p.id===settings.activeApiProfileId?{...p,name:name.trim()}:p),settings.activeApiProfileId!)}}>{tx('重命名','Rename')}</Button>
   <Button variant="outline" disabled={disabled||profiles.length<2||!settings.activeApiProfileId} onClick={()=>{const rows=profiles.filter(p=>p.id!==settings.activeApiProfileId);void apply(rows,rows[0].id)}}>{tx('删除当前配置','Delete current configuration')}</Button>
  </div>
  <div className={css.settingsHint}>{tx('每份配置独立保存地址、Key、模型、图片能力、语音和 DeepSeek 原生选项。切换时自动保存当前表单。Key 仅存本机，备份不包含 Key。','Each configuration stores its endpoint, key, model, image capability, speech and DeepSeek native options. Switching saves the current form. Keys stay on this device and are excluded from backups.')}</div>
  {error&&<p role="alert">{error}</p>}
 </div>
}
