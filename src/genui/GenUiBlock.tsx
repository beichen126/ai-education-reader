import {lazy,Suspense} from 'react'
import {LegacyGenUiBlock} from './LegacyGenUiBlock'
export {GenUiActions} from './LegacyGenUiBlock'
const AdvancedGenUi=lazy(()=>import('./AdvancedGenUi'))
const advancedTypes=/"type"\s*:\s*"(?:plot|echart|mermaid|scene3d|diagram|carousel|image-group|hero|checkbox|radio|switch|textarea|date-picker|segmented-control|choices|file-tree|timeline|code|diff|json|keyvalue|image|audio|video|svg|map|editor|entity-card|popover|compare|blocks|copy|divider|spacer|icon|avatar|ring)"/
export function GenUiBlock({source,stateKey}:{source:string;stateKey?:string}) {
 const advanced=source.includes('"dsh-genui"') || advancedTypes.test(source) || /"(?:computed|kind|preset|series|when|enableWhen)"\s*:/.test(source)
 return advanced ? <Suspense fallback={<p role="status">正在加载交互界面…</p>}><AdvancedGenUi source={source} stateKey={stateKey}/></Suspense> : <LegacyGenUiBlock source={source}/>
}
