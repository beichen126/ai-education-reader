import {configuredImageKeys, type ImageKey} from './key-pool'
import {useEffect, useMemo, useState} from 'react'
import {useSettings} from '../engine/settings-store'
import {parseImageQueries, type ImageQuery} from './protocol'
import {searchFirstImage, rememberLoadedImage, type WebImage} from './search'
import './web-images.css'

function Picture({item, keys}: {item: ImageQuery; keys: ImageKey[]}) {
  const [image, setImage] = useState<WebImage>()
  const [error, setError] = useState('')
  const [failed, setFailed] = useState(false)
  const [backupTried,setBackupTried]=useState(0)
  const [switching,setSwitching]=useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setImage(undefined); setError(''); setFailed(false); setLoaded(false);setBackupTried(0);setSwitching(false)
    void searchFirstImage(item.query, keys, controller.signal).then(result => {if (active) setImage(result)}).catch(() => {if (active) setError('图片搜索失败，可重试或检查 Firecrawl 配置。')})
    return () => {active = false; controller.abort()}
  }, [item.query, keys, retry])
  useEffect(()=>{
    if(!image || loaded || failed)return
    const timer=setTimeout(()=>setFailed(true),20000)
    return ()=>clearTimeout(timer)
  },[image,loaded,failed,loadAttempt])
  useEffect(()=>{
    if(!failed||!image||backupTried>=2)return
    const controller=new AbortController();let active=true,found=false
    setSwitching(true)
    void (async()=>{
      try{
        const result=image.backup?image:await searchFirstImage(item.query,keys,controller.signal,true)
        const next=result.imageUrl!==image.imageUrl?result:result.backup
        if(active&&next&&next.imageUrl!==image.imageUrl){found=true;setImage(next);setFailed(false);setLoaded(false);setLoadAttempt(n=>n+1)}
      }catch{}finally{if(active){setBackupTried(n=>found?n+1:2);setSwitching(false)}}
    })()
    return()=>{active=false;controller.abort()}
  },[failed,image,backupTried,item.query,keys])
  return <figure className={'reader-web-image' + (failed ? ' reader-web-image-failed' : '')}>
    {image ? <>
      {!failed ? <a href={image.imageUrl} target="_blank" rel="noopener noreferrer" aria-label="打开完整图片"><img key={loadAttempt} onLoad={()=>{setLoaded(true);void rememberLoadedImage(item.query,image)}} src={image.imageUrl} alt={item.alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} /></a> : <span role="status">{switching||backupTried<2?'正在换用备用图片…':<span className="reader-broken-image" role="img" aria-label="图片加载失败" title="三张候选图片均无法加载"><svg width="36" height="28" viewBox="0 0 36 28" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="32" height="24" rx="3"/><path d="M4 23l9-9 6 6 5-7 8 9M21 1l-5 9 5 4-6 13"/><circle cx="9" cy="8" r="2"/></svg></span>}</span>}
      <figcaption><a href={image.sourceUrl} target="_blank" rel="noopener noreferrer">{new URL(image.sourceUrl).hostname}</a>{failed && backupTried>=2 && <button onClick={() => {setLoaded(false);setFailed(false);setLoadAttempt(n=>n+1)}}>重试加载</button>}</figcaption>
    </> : error ? <p role="status">{error}<button onClick={() => setRetry(n => n + 1)}>重试搜索</button></p> : <p role="status">正在查找图片…</p>}
  </figure>
}
export function WebImageBlock({source}: {source: string}) {
  const settings = useSettings(s => s)
  const keys = useMemo(() => configuredImageKeys(settings), [settings.firecrawlApiKey, settings.firecrawlKeys])
  const parsed = useMemo(() => {try {return parseImageQueries(source)} catch {return null}}, [source])
  if (!keys.length) return null
  if (!parsed) return <p role="status">配图描述正在生成或格式需要补全…</p>
  return <div className={'reader-web-images ' + (parsed.length === 2 ? 'reader-web-images-pair' : '')} data-annotatable="false">{parsed.map((item, i) => <Picture key={i + item.query} item={item} keys={keys} />)}</div>
}
