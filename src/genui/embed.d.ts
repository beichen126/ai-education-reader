declare module 'reader-genui-embed' {
 export const GenuiBlock: import('react').ComponentType<{spec:any;stateKey?:string;animateEntrance?:boolean;initialState?:any;onStateSnapshot?:(state:any)=>void}>
 export const GenuiActionContext: import('react').Context<((action:string,payload:Record<string,unknown>)=>void)|undefined>
 export const ErrorBoundary: import('react').ComponentType<{children:import('react').ReactNode}>
 export function setGenuiAssetBase(url:string):void
 export function processGenuiSpec(value:unknown):{spec:any;errors:string[];warnings:any[]}
 export function isRenderableProcess(value:unknown):boolean
 export function createGenuiArtifact(...args:any[]):any
 export function downloadGenuiArtifactJson(...args:any[]):any
 export function downloadGenuiArtifactHtml(...args:any[]):Promise<any>
}
declare module 'reader-genui-partial' {export function parsePartialGenuiSpec(source:string):any}
declare module 'reader-genui-locale' {export function setLocale(locale:string):void}

declare module 'reader-genui-templates' {export function genuiTemplates():Array<{id:string;name:string;description:string;instruction:string;demo:any}>}

declare module 'reader-genui-diagram-original' { export const DiagramNode: import('react').ComponentType<any> }

declare module 'reader-genui-image-original' { export const ImageNode: import('react').ComponentType<any> }

declare module 'reader-genui-choices-original' { export const ChoicesNode: import('react').ComponentType<any> }
