/* Runs only inside a YouTube watch page. No cookies or account data leave it. */
globalThis.readerExtractYoutube = async function(language = 'auto') {
 const timedFetch=async(url,options={})=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);try{return await fetch(url,{...options,signal:controller.signal})}finally{clearTimeout(timer)}};
 const videoId=new URL(location.href).searchParams.get('v');
 if(location.hostname!=='www.youtube.com'||!/^[-\w]{11}$/.test(videoId||''))throw new Error('请打开有效的 YouTube 视频页面。');
 const text=v=>v?.simpleText??v?.runs?.map(r=>r.text||'').join('')??'';
 const find=(root,key)=>{const queue=[root];let count=0;while(queue.length&&count++<80000){const v=queue.pop();if(!v||typeof v!=='object')continue;if(v[key])return v[key];for(const x of Object.values(v))if(x&&typeof x==='object')queue.push(x)}return null};
 const player=document.querySelector('#movie_player');
 const data=player?.getPlayerResponse?.()||globalThis.ytInitialPlayerResponse;
 if(data?.videoDetails?.videoId&&data.videoDetails.videoId!==videoId)throw new Error('视频仍在切换，请稍后重试。');
 const tracks=data?.captions?.playerCaptionsTracklistRenderer?.captionTracks||[];
 const rank=t=>(language==='auto'?0:t.languageCode===language?0:t.languageCode?.startsWith(language+'-')?1:10)+(t.kind==='asr'?2:0);
 const track=[...tracks].sort((a,b)=>rank(a)-rank(b))[0];
 const title=data?.videoDetails?.title||document.querySelector('h1 yt-formatted-string')?.textContent||document.title.replace(/ - YouTube$/,'');
 let segments=[],actualLanguage=track?.languageCode||'unknown';
 if(track){try{
  const url=new URL(track.baseUrl);if(url.hostname!=='www.youtube.com'||url.pathname!=='/api/timedtext')throw new Error('Invalid caption URL');url.searchParams.set('fmt','json3');
  const r=await timedFetch(url,{credentials:'same-origin'});
  if(r.ok){const json=await r.json();segments=(json.events||[]).filter(e=>e.segs).map(e=>({start:e.tStartMs/1000,duration:(e.dDurationMs||0)/1000,text:e.segs.map(s=>s.utf8||'').join('').replace(/\s+/g,' ').trim()})).filter(e=>e.text)}
 }catch{/* Player tokens may gate timedtext; use the page transcript endpoint below. */}}
 if(!segments.length){
  const endpoint=find(globalThis.ytInitialData,'getTranscriptEndpoint');
  const config=globalThis.ytcfg;
  if(endpoint?.params&&config?.get){
   const context=config.get('INNERTUBE_CONTEXT');
   const r=await timedFetch('/youtubei/v1/get_transcript?prettyPrint=false&key='+encodeURIComponent(config.get('INNERTUBE_API_KEY')||''),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Youtube-Client-Name':String(config.get('INNERTUBE_CONTEXT_CLIENT_NAME')||1),'X-Youtube-Client-Version':context?.client?.clientVersion||''},body:JSON.stringify({context,params:endpoint.params})});
   if(r.ok){const json=await r.json();const queue=[json];let count=0;while(queue.length&&count++<80000){const v=queue.pop();if(!v||typeof v!=='object')continue;const s=v.transcriptSegmentRenderer;if(s)segments.push({start:Number(s.startMs)/1000,duration:Math.max(0,(Number(s.endMs)-Number(s.startMs))/1000),text:text(s.snippet)});else for(const x of Object.values(v))if(x&&typeof x==='object')queue.push(x)}segments.sort((a,b)=>a.start-b.start);actualLanguage='default';}
  }
 }
 if(!segments.length){
  // Let the site's own player handle session/token requirements, then read its transcript panel.
  const section=find(globalThis.ytInitialData,'videoDescriptionTranscriptSectionRenderer');
  const label=text(section?.primaryButton?.buttonRenderer?.text);
  if(label){const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);button?.click();}
  for(let attempt=0;attempt<10&&!segments.length;attempt++){
   await new Promise(r=>setTimeout(r,700));
   const rows=[...document.querySelectorAll('ytd-transcript-segment-renderer, transcript-segment-view-model')];
   segments=rows.map(row=>{const stamp=row.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp')?.textContent?.trim()||'';const parts=stamp.split(':').map(Number);const start=parts.reduce((v,n)=>v*60+n,0);return {start,duration:0,text:row.querySelector('.segment-text, span[role="text"]')?.textContent?.trim()||''}}).filter(s=>s.text&&Number.isFinite(s.start));
  }
  if(segments.length)actualLanguage='default';
 }
 segments=segments.filter((s,i,a)=>s.text&&Number.isFinite(s.start)&&s.start>=0&&(i===0||s.text!==a[i-1].text));
 if(!segments.length)throw new Error('未能读取字幕。请确认视频有字幕；若出现登录、验证或同意页面，请完成后重试。');
 if(segments.length>20000||JSON.stringify(segments).length>2000000)throw new Error('字幕过长，请选择较短的视频。');
 return {videoId,title:title.slice(0,300),language:actualLanguage,automatic:actualLanguage==='default'?undefined:track?.kind==='asr',segments,fetchedAt:Date.now()};
};
