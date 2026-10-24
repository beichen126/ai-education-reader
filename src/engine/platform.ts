/** Native Android shell already owns its window; browser fullscreen is redundant. */
export function isAndroidReader(): boolean {
  return typeof location !== 'undefined' && location.origin === 'https://appassets.androidplatform.net'
}
