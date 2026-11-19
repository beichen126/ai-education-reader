import {useState} from 'react'
import {useSettings,patchSettings,DEFAULT_SETTINGS,useSettingsMutation,type Settings} from '../engine/settings-store'
import {profileConfig,type ApiProfile} from '../engine/api-profiles'
import {savedApiProfiles} from '../engine/api-profile-transfer'
import {tx} from '../engine/locale'
import {Button,Input} from '../dsh/primitives'
import css from './api-profiles.module.css'
type Mode='new'|'copy'|'rename'|'delete'|null
export function ApiProfiles({draft,onApply}:{draft:Settings;onApply:(settings:Settings)=>void}) {
 const settings=useSettings(s=>s),mutation=useSettingsMutation(),profiles=settings.apiProfiles||[]
 const currentId=settings.activeApiProfileId||'initial',current=profiles.find(p=>p.id===currentId)
 const dirty=JSON.stringify(profileConfig(draft))!==JSON.stringify(profileConfig(settings))
 const [mode,setMode]=useState<Mode>(null),[name,setName]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('')
 const [pending,setPending]=useState<{id?:string;create?:boolean}|null>(null)
 const [endpoint,setEndpoint]=useState(DEFAULT_SETTINGS.apiBaseUrl),[apiKey,setKey]=useState(''),[model,setModel]=useState(DEFAULT_SETTINGS.model),[replacement,setReplacement]=useState('')
 const disabled=mutation.status==='pending'
 const originalName=tx('原有配置','Original configuration')
 const rows=()=>savedApiProfiles(settings,originalName)
 const currentName=current?.name||tx('未命名配置','Unnamed configuration')
 const failure=()=>setError(tx('保存失败，当前配置未切换，请重试。','Save failed. The current configuration has not changed.'))
 async function apply(list:ApiProfile[],id:string){const selected=list.find(p=>p.id===id);if(!selected)return;try{const next=await patchSettings({...selected.config,apiProfiles:list,activeApiProfileId:id});onApply(next);setMode(null);setPending(null);setError('');setStatus(tx('正在使用：','Now using: ')+selected.name)}catch{failure()}}
 function begin(next:Mode){setError('');setStatus('');setMode(next);setName(next==='rename'?currentName:next==='copy'?currentName+tx(' 副本',' copy'):'');if(next==='new'){setEndpoint(DEFAULT_SETTINGS.apiBaseUrl);setKey('');setModel(DEFAULT_SETTINGS.model)}if(next==='delete')setReplacement(profiles.find(p=>p.id!==currentId)?.id||'')}
 function switchTo(id:string){setError('');if(dirty)setPending({id});else void apply(rows(),id)}
 async function resolvePending(save:boolean){if(!pending)return;let list=rows();try{if(save){const next=await patchSettings({...profileConfig(draft),apiProfiles:list,activeApiProfileId:currentId});list=next.apiProfiles||list;onApply(next)}else onApply(settings);if(pending.create){setPending(null);begin('new')}else await apply(list,pending.id!)}catch{failure()}}
 async function submit(){
  const label=name.trim();if(!label){setError(tx('请输入配置名称。','Enter a name.'));return}
  if(rows().some(p=>p.name===label&&(mode!=='rename'||p.id!==currentId))){setError(tx('名称已存在，请换一个名称。','This name already exists.'));return}
  if(mode==='rename'){try{await patchSettings({apiProfiles:rows().map(p=>p.id===currentId?{...p,name:label}:p),activeApiProfileId:currentId});setMode(null);setStatus(tx('名称已更新。','Name updated.'));setError('')}catch{failure()}return}
  if(mode==='new'){try{const u=new URL(endpoint.trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||u.search)throw new Error()}catch{setError(tx('请输入有效的 API 服务地址。','Enter a valid API base URL.'));return}if(!apiKey.trim()||!model.trim()){setError(tx('填写 API Key 和模型后再启用。','Enter an API key and model before enabling.'));return}}
  const config=mode==='copy'?profileConfig(draft):profileConfig({...DEFAULT_SETTINGS,apiBaseUrl:endpoint.trim(),apiKey:apiKey.trim(),model:model.trim(),speechVoice:'stella'})
  const id=crypto.randomUUID();await apply([...rows(),{id,name:label,config}],id)
 }
 return <section className={css.root} data-testid="api-profiles">
  <div className={css.heading}><strong>{tx('当前使用的配置','Active configuration')}</strong><span className={dirty?css.dirty:css.saved}>{dirty?tx('有未保存修改','Unsaved changes'):tx('已保存','Saved')}</span></div>
  <div className={css.switchRow}><select aria-label={tx('当前使用的配置','Active configuration')} value={currentId} disabled={disabled||!!mode||!!pending} onChange={e=>switchTo(e.target.value)}>{rows().map(p=><option key={p.id} value={p.id}>{p.id===currentId?currentName:p.name}</option>)}</select><Button variant="outline" disabled={disabled||!!mode||!!pending} onClick={()=>dirty?setPending({create:true}):begin('new')}>{tx('添加配置','Add configuration')}</Button></div>
  <p className={css.hint}>{tx('下方填写的是这份配置的连接参数。修改后点击「保存 API 设置」生效。','The connection fields below belong to this configuration. Apply changes with “Save API settings”.')}</p>
  <div className={css.manage}><Button size="sm" disabled={disabled||!!pending} onClick={()=>begin('copy')}>{tx('复制当前配置','Duplicate configuration')}</Button><Button size="sm" disabled={disabled||!!pending} onClick={()=>begin('rename')}>{current?tx('重命名','Rename'):tx('为当前配置命名','Name this configuration')}</Button><Button size="sm" disabled={disabled||profiles.length<2||!!pending} onClick={()=>begin('delete')}>{tx('删除','Delete')}</Button></div>
  {pending&&<div className={css.editor} role="group" aria-label={tx('未保存的修改','Unsaved changes')}><strong>{tx('先处理当前配置的修改','Save your changes first?')}</strong><p className={css.hint}>{tx('当前表单还没有保存。请选择保存后继续，或放弃这些修改。','The current form has unsaved changes. Save them or discard them before continuing.')}</p><div className={css.actions}><Button variant="primary" disabled={disabled} onClick={()=>void resolvePending(true)}>{tx('保存并继续','Save and continue')}</Button><Button variant="outline" disabled={disabled} onClick={()=>void resolvePending(false)}>{tx('放弃修改并继续','Discard and continue')}</Button><Button disabled={disabled} onClick={()=>setPending(null)}>{tx('取消','Cancel')}</Button></div></div>}
  {mode&&<div className={css.editor} role="group" aria-label={mode==='new'?tx('添加配置','Add configuration'):mode==='copy'?tx('复制当前配置','Duplicate configuration'):mode==='rename'?tx('重命名配置','Rename configuration'):tx('删除配置','Delete configuration')}>
   <strong>{mode==='new'?tx('添加一份独立配置','Add an independent configuration'):mode==='copy'?tx('复制当前表单的参数','Duplicate the current form'):mode==='rename'?tx('修改配置名称','Change the configuration name'):tx('删除「','Delete “')+currentName+tx('」','”')}</strong>
   {mode==='delete'?<><p className={css.hint}>{tx('仅删除这份连接配置，不删除会话和资料。删除后改用：','Only this connection is removed; chats and documents remain. Then switch to:')}</p><select aria-label={tx('删除后使用的配置','Replacement configuration')} value={replacement} disabled={disabled} onChange={e=>setReplacement(e.target.value)}>{profiles.filter(p=>p.id!==currentId).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><div className={css.actions}><Button variant="outline" disabled={disabled||!replacement} onClick={()=>void apply(profiles.filter(p=>p.id!==currentId),replacement)}>{tx('删除并切换','Delete and switch')}</Button><Button disabled={disabled} onClick={()=>setMode(null)}>{tx('取消','Cancel')}</Button></div></>:<>
   {mode==='copy'&&<p className={css.hint}>{tx('地址、Key、模型等参数会复制到新配置；原配置不变。','Copies the endpoint, key, model and options into a new configuration; leaves the original unchanged.')}</p>}
   <label className={css.field}>{tx('配置名称','Configuration name')}<Input aria-label={tx('配置名称','Configuration name')} value={name} maxLength={60} disabled={disabled} placeholder={tx('例如：DeepSeek 官方、我的中转','For example: DeepSeek official')} onChange={e=>setName(e.target.value)}/></label>
   {mode==='new'&&<><label className={css.field}>{tx('服务类型','Service type')}<select aria-label={tx('新配置服务类型','New service type')} disabled={disabled} onChange={e=>{setKey('');if(e.target.value==='deepseek'){setEndpoint('https://api.deepseek.com');setModel('deepseek-flash')}else if(e.target.value==='teamo'){setEndpoint('https://api.teamorouter.com/v1');setModel('')}else{setEndpoint('');setModel('')}}}><option value="deepseek">DeepSeek</option><option value="teamo">TeamoRouter</option><option value="custom">{tx('其他兼容 API','Other compatible API')}</option></select></label><label className={css.field}>API Base URL<Input aria-label={tx('新配置服务地址','New endpoint')} value={endpoint} disabled={disabled} onChange={e=>setEndpoint(e.target.value)}/></label><label className={css.field}>API Key<Input aria-label={tx('新配置 API Key','New API key')} type="password" autoComplete="off" value={apiKey} disabled={disabled} onChange={e=>setKey(e.target.value)}/></label><label className={css.field}>{tx('模型 ID','Model ID')}<Input aria-label={tx('新配置模型','New model')} value={model} disabled={disabled} placeholder={tx('填写服务商提供的模型 ID','Model ID from your provider')} onChange={e=>setModel(e.target.value)}/></label></>}
   <div className={css.actions}><Button variant="primary" disabled={disabled||!name.trim()} onClick={()=>void submit()}>{mode==='rename'?tx('保存名称','Save name'):mode==='copy'?tx('复制并启用','Duplicate and use'):tx('保存并启用','Save and use')}</Button><Button disabled={disabled} onClick={()=>{setMode(null);setError('')}}>{tx('取消','Cancel')}</Button></div></>}
  </div>}
  <p className={css.hint}>{tx('完整备份会省略 API Key。','Full backups exclude API keys.')}</p>
  {error&&<p role="alert" className={css.error}>{error}</p>}{status&&<p role="status" className={css.hint}>{status}</p>}
 </section>
}
