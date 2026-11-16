const allowed=url=>{try{const u=new URL(url);return u.origin==='https://beichen126.github.io'&&u.pathname.startsWith('/ai-education-reader/')}catch{return false}};
const jobs=new Map();
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(!allowed(sender.url)||sender.frameId!==0)return;
 if(m?.type==='reader-youtube-cancel'){jobs.get(sender.tab.id)?.abort();reply({ok:true});return;}
 if(m?.type!=='reader-youtube-extract'||!/^[-\w]{11}$/.test(m.videoId)||!['auto','zh','en','ja','ko','es'].includes(m.language))return;
 if(jobs.has(sender.tab.id)){reply({error:'已有字幕提取任务，请等待或取消。'});return;}
 const controller=new AbortController();jobs.set(sender.tab.id,controller);
 (async()=>{
  let tab;
  try{
   tab=await chrome.tabs.create({url:'https://www.youtube.com/watch?v='+m.videoId,active:true});
   const deadline=Date.now()+60000;let lastError='视频加载超时，请在 YouTube 页面完成加载后重试。';
   while(Date.now()<deadline&&!controller.signal.aborted){
    await new Promise(r=>setTimeout(r,2000));
    const current=await chrome.tabs.get(tab.id);
    const url=new URL(current.url||'https://invalid/');
    if(url.hostname!=='www.youtube.com'||url.pathname!=='/watch'||url.searchParams.get('v')!==m.videoId)continue;
    try{
     await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['extractor.js']});
     const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async lang=>{try{return {data:await globalThis.readerExtractYoutube(lang)}}catch(e){return {error:e.message}}},args:[m.language]});
     const value=result[0]?.result;
     if(value?.data){if(controller.signal.aborted)throw new Error('已取消');reply(value);await chrome.tabs.update(sender.tab.id,{active:true}).catch(()=>{});return;}
     lastError=value?.error||lastError;
    }catch(e){lastError=e.message}
   }
   throw new Error(controller.signal.aborted?'已取消':lastError);
  }catch(e){reply({error:e.message})}finally{jobs.delete(sender.tab.id)}
 })();return true;
});
