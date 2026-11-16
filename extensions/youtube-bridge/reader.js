window.addEventListener('message',async event=>{
 if(event.source!==window||event.origin!==location.origin)return;
 const m=event.data;if(m?.channel!=='reader-youtube-request'||typeof m.id!=='string'||m.id.length>100)return;
 if(m.type==='ping'){window.postMessage({channel:'reader-youtube-response',id:m.id,available:true},location.origin);return;}
 if(!['extract','cancel'].includes(m.type))return;
 try{const result=await chrome.runtime.sendMessage({type:m.type==='cancel'?'reader-youtube-cancel':'reader-youtube-extract',videoId:m.videoId,language:m.language});window.postMessage({channel:'reader-youtube-response',id:m.id,...result},location.origin)}catch(e){window.postMessage({channel:'reader-youtube-response',id:m.id,error:e.message},location.origin)}
});
