import {getSetting,setSetting} from '../storage/storage'
import {validTranscript,type YoutubeTranscript} from './transcript'
function request(type:string,data:Record<string,string>,signal?:AbortSignal):Promise<any>{return new Promise((resolve,reject)=>{
 const id=crypto.randomUUID();let timer:ReturnType<typeof setTimeout>;
 const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive);signal?.removeEventListener('abort',cancel)};
 const receive=(e:MessageEvent)=>{if(e.source!==window||e.origin!==location.origin||e.data?.channel!=='reader-youtube-response'||e.data.id!==id)return;cleanup();e.data.error?reject(new Error(e.data.error)):resolve(e.data)};
 const native=(window as any).AndroidYoutube;
 const cancel=()=>{cleanup();if(native)native.cancel();else window.postMessage({channel:'reader-youtube-request',id:crypto.randomUUID(),type:'cancel'},location.origin);reject(new Error('已取消'))};
 window.addEventListener('message',receive);signal?.addEventListener('abort',cancel,{once:true});
 timer=setTimeout(()=>{cleanup();reject(new Error(type==='ping'?'未检测到字幕桥接扩展。请安装扩展后刷新页面。':'字幕提取超时，请确认 YouTube 页面已加载并有字幕。'))},type==='ping'?1500:90000);
 if(signal?.aborted){cancel();return}
 try{if(native){if(type==='ping'){cleanup();resolve({available:true})}else native.extract(id,data.videoId,data.language)}else window.postMessage({channel:'reader-youtube-request',id,type,...data},location.origin)}catch(e){cleanup();reject(e)}
})}
export async function fetchTranscript(videoId:string,language:string,signal:AbortSignal):Promise<{data:YoutubeTranscript;cached:boolean}>{
 const key='youtube-transcript:v1:'+videoId+':'+language,saved=await getSetting(key);
 if(validTranscript(saved)&&saved.videoId===videoId)return {data:saved,cached:true};
 await request('ping',{},signal);const result=await request('extract',{videoId,language},signal);
 if(!validTranscript(result.data)||result.data.videoId!==videoId)throw new Error('提取结果不完整或视频不匹配，请重试。');
 if(signal.aborted)throw new Error('已取消');await setSetting(key,result.data);return {data:result.data,cached:false}
}
