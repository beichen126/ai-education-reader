// Shared host budgets; family lists use the component budget instead of small presentation caps.
export const GENUI_SOURCE_LIMIT = 4 * 1024 * 1024
export const READER_GENUI_LIMITS = {
 maxDepth:32, maxNodes:5000, maxString:50000, maxCode:200000,
 maxAccordionItems:5000, maxSteps:5000, maxOptions:5000,
 maxChartPoints:10000, maxPlotSeries:64, maxPlotParams:32,
 maxComputedFields:500, maxMeshes:256,
 maxEChartOptionDepth:32, maxEChartArrayLen:100000, maxEChartOptionNodes:200000,
}

export function transformGenuiBudgets(source,id){
 const path=id.replaceAll('\\','/')
 if(path.endsWith('/genui-runtime/limits.ts')){
  for(const [key,value] of Object.entries(READER_GENUI_LIMITS))source=source.replace(new RegExp(`(${key}:\\s*)[\\d_]+`),`$1${value}`)
 }
 if(path.endsWith('/client/guard.ts')){
  source=source.replaceAll('v.items.slice(0, 8)','v.items.slice(0, GENUI_LIMITS.maxOptions)').replaceAll('v.items.length > 8','v.items.length > GENUI_LIMITS.maxOptions').replace("'choices' keeps at most 8 options",`'choices' exceeds ${READER_GENUI_LIMITS.maxOptions} options`)
  for(const expression of ['str(item?.label, 120)','str(item.hint, 200)','str(item.reason, 200)','str(v.prompt, 400)','str(v.value, 128)','str(v.delta, 64)','str(v.label, 200)'])source=source.replaceAll(expression,expression.replace(/, \d+\)/,', GENUI_LIMITS.maxString)'))
  // Sparkline samples were a separate hardcoded cap.
  source=source.replace('v.slice(0, 60)','v.slice(0, GENUI_LIMITS.maxChartPoints)')
 }
 if(path.endsWith('/blocks/choices.tsx'))source=source.replace('const MAX_OPTIONS = 8',`const MAX_OPTIONS = ${READER_GENUI_LIMITS.maxOptions}`)
 return source
}

export function requiresReaderExport(spec){
 let nodes=0,large=false
 function walk(v){if(!v||typeof v!=='object')return;if(typeof v.type==='string')nodes++
  if(v.type==='accordion'&&v.items?.length>24||v.type==='steps'&&v.steps?.length>24||v.type==='chart'&&v.data?.length>60||v.type==='scene3d'&&v.meshes?.length>5||v.type==='plot'&&v.series?.length>8||v.type==='svg'&&v.code?.length>12000)large=true
  for(const x of Object.values(v)){if(typeof x==='string'&&x.length>2000)large=true;else if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object')walk(x)}
 }walk(spec);return large||nodes>200
}
