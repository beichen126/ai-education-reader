import {configuredImageKeys, type ImageKey} from './key-pool'
import {useEffect, useMemo, useState} from 'react'
import {useSettings} from '../engine/settings-store'
import {parseImageQueries, type ImageQuery} from './protocol'
import {searchFirstImage, type WebImage} from './search'
import './web-images.css'

function Picture({item, keys}: {item: ImageQuery; keys: ImageKey[]}) {
  const [image, setImage] = useState<WebImage>()
  const [error, setError] = useState('')
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setImage(undefined); setError(''); setFailed(false); setLoaded(false)
    void searchFirstImage(item.query, keys, controller.signal).then(result => {if (active) setImage(result)}).catch(() => {if (active) setError('图片搜索失败，可重试或检查 Firecrawl 配置。')})
    return () => {active = false; controller.abort()}
  }, [item.query, keys, retry])
  useEffect(()=>{
    if(!image || loaded || failed)return
    const timer=setTimeout(()=>setFailed(true),20000)
    return ()=>clearTimeout(timer)
  },[image,loaded,failed,loadAttempt])
  return <figure className={'reader-web-image' + (failed ? ' reader-web-image-failed' : '')}>
    {image ? <>
      {!failed ? <a href={image.imageUrl} target="_blank" rel="noopener noreferrer" aria-label="打开完整图片"><img key={loadAttempt} onLoad={()=>setLoaded(true)} src={image.imageUrl} alt={item.alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} /></a> : <p>图片暂时无法加载，可访问来源网页。</p>}
      <figcaption><a href={image.sourceUrl} target="_blank" rel="noopener noreferrer">{new URL(image.sourceUrl).hostname}</a>{failed && <button onClick={() => {setLoaded(false);setFailed(false);setLoadAttempt(n=>n+1)}}>重试加载</button>}</figcaption>
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
