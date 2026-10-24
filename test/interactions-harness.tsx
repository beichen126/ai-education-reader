import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnnotatedMarkdown } from '../src/annotations/AnnotatedMarkdown'
import { ZoomableImageDialog } from '../src/gallery/ZoomableImageDialog'
import { useBackTarget } from '../src/engine/back-navigation'
function Nested({close}:{close:()=>void}) {
  useBackTarget(true,close,10)
  return <ZoomableImageDialog src={'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>')} onClose={close} labels={{close:'Close image',dialog:'Image viewer'}}/>
}
function Harness(){
  const [open,setOpen]=useState(false)
  return <><button onClick={()=>setOpen(true)}>Open image</button>{open&&<Nested close={()=>setOpen(false)}/>}<AnnotatedMarkdown messageId="interaction-message" conversationId="interaction-chat" content={'A complete **paragraph** with several words.\n\n$$\nx^2+y^2=1\n$$\n\n| A | B |\n|---|---|\n| 1 | 2 |'}/></>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness/></StrictMode>)
