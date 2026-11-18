import {configuredImageKeys, FirecrawlKeyPoolError, type ImageKey} from './key-pool'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {useSettings} from '../engine/settings-store'
import {parseImageQueries, type ImageQuery} from './protocol'
import {searchFirstImage, rememberLoadedImage, ImageSearchError, type WebImage} from './search'
import './web-images.css'

function Picture({item, keys}: {item: ImageQuery; keys: ImageKey[]}) {
  const [image, setImage] = useState<WebImage>()
  const [error, setError] = useState('')
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setImage(undefined); setError(''); setFailed(false); setLoaded(false)
    void searchFirstImage(item.query, keys, controller.signal, retry > 0).then(result => {if (active) setImage(result)}).catch(reason => {
      if (!active) return
      setError(reason instanceof ImageSearchError || reason instanceof FirecrawlKeyPoolError ? reason.message
        : reason instanceof DOMException && reason.name === 'TimeoutError' ? '图片搜索超时' : '图片搜索连接失败')
    })
    return () => {active = false; controller.abort()}
  }, [item.query, keys, retry])
  const nextCandidate = useCallback(() => {
    if (!image) return
    const next = image.backup
    if (next) {
      setImage(current => current === image ? next : current)
      setLoaded(false)
    } else setFailed(true)
  }, [image])
  useEffect(() => {
    if (!image || loaded || failed) return
    const timer = setTimeout(nextCandidate, 20000)
    return () => clearTimeout(timer)
  }, [image, loaded, failed, nextCandidate])
  const retryButton = <button type="button" onClick={() => setRetry(n => n + 1)}>重试搜索</button>
  return <figure className={'reader-web-image' + (failed || error ? ' reader-web-image-failed' : '')}>
    {image ? <>
      {!failed ? <a href={image.imageUrl} target="_blank" rel="noopener noreferrer" aria-label="打开完整图片"><img key={image.imageUrl} onLoad={()=>{setLoaded(true);void rememberLoadedImage(item.query,image)}} src={image.imageUrl} alt={item.alt} referrerPolicy="no-referrer" onError={nextCandidate} /></a> : <span className="reader-broken-image" role="img" aria-label="图片加载失败" title="候选图片均无法加载"><svg width="36" height="28" viewBox="0 0 36 28" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="32" height="24" rx="3"/><path d="M4 23l9-9 6 6 5-7 8 9M21 1l-5 9 5 4-6 13"/><circle cx="9" cy="8" r="2"/></svg></span>}
      <figcaption><a href={image.sourceUrl} target="_blank" rel="noopener noreferrer">{new URL(image.sourceUrl).hostname}</a>{failed && retryButton}</figcaption>
    </> : error ? <><span role="status">{error}</span>{retryButton}</> : <p role="status">{retry ? '正在重新搜索图片…' : '正在查找图片…'}</p>}
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
