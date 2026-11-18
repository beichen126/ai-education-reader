import {lazy,Suspense} from 'react'
import {LegacyGenUiBlock} from './LegacyGenUiBlock'
export {GenUiActions} from './LegacyGenUiBlock'
const VocabularyBlock=lazy(()=>import('./VocabularyBlock'))
const AdvancedGenUi=lazy(()=>import('./AdvancedGenUi'))
const advancedTypes=/"type"\s*:\s*"(?:plot|echart|mermaid|scene3d|diagram|carousel|image-group|hero|checkbox|radio|switch|textarea|date-picker|segmented-control|choices|file-tree|timeline|code|diff|json|keyvalue|image|audio|video|svg|map|editor|entity-card|popover|compare|blocks|copy|divider|spacer|icon|avatar|ring)"/
function isVocabularySource(source: string): boolean {
 if (/"schema"\s*:\s*"reader-vocabulary"|"reader-vocabulary"\s*:/.test(source)) return true
 if (!/"type"\s*:\s*"vocabulary"|"word"\s*:/.test(source)) return false
 try {
   const first = JSON.parse(source)?.items?.[0]
   return first?.type === 'vocabulary' || (first?.type == null && typeof first?.word === 'string')
 } catch {
   return /"items"\s*:\s*\[\s*\{[^{}]*"(?:type"\s*:\s*"vocabulary"|word"\s*:)/.test(source)
 }
}
export function GenUiBlock({source,stateKey,modern=false}:{source:string;stateKey?:string;modern?:boolean}) {
 if (isVocabularySource(source)) return <Suspense fallback={<p role="status">正在加载单词卡…</p>}><VocabularyBlock source={source}/></Suspense>
 const advanced=modern || /"(?:schema|scheme)"\s*:/.test(source) || source.includes('"dsh-genui"') || advancedTypes.test(source) || /"(?:computed|kind|preset|series|when|enableWhen)"\s*:/.test(source)
 return advanced ? <Suspense fallback={<p role="status">正在加载交互界面…</p>}><AdvancedGenUi source={source} stateKey={stateKey}/></Suspense> : <LegacyGenUiBlock source={source}/>
}
