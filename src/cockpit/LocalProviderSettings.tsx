import { useEffect, useRef, useState } from 'react'
import { useSettings, patchSettings } from '../engine/settings-store'
import { getLocalStatus, pairLocalService, disconnectLocalService, beginChatGPTLogin, cancelChatGPTLogin, logoutChatGPT, selectChatGPTAccount, localErrorLabel, isLocalReader, usesLocalProxy, LocalProviderError, type LocalStatus } from '../api/openai-local'
import { tx } from '../engine/locale'
import css from './cockpit.module.css'

export function LocalProviderSettings() {
  const settings = useSettings(s => s)
  // Android App 内用原生桥实现同一份官方授权，没有本机服务与配对码，视同“自动连接”。
  const androidBridge = typeof window !== 'undefined' && !!(window as unknown as { AndroidChatGpt?: unknown }).AndroidChatGpt
  const androidApp = androidBridge || (typeof location !== 'undefined' && location.origin === 'https://appassets.androidplatform.net')
  const automaticConnection = usesLocalProxy() || androidApp
  const [rememberPairing, setRememberPairing] = useState(true)
  const [code, setCode] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [paired, setPaired] = useState(false)
  const [loginUrl, setLoginUrl] = useState(''), [waiting, setWaiting] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const loginInFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])
  useEffect(() => {
    if (!waiting) return
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    const poll = async () => {
      try {
        const next = await getLocalStatus(stop.signal)
        if (stop.signal.aborted) return
        setStatus(next)
        if (next.auth === 'authorized' && !next.ready && next.errorCode && failures++ < 2) {
          setMessage(tx('授权已保存，正在重试加载模型列表…', 'Authorization is saved. Retrying model discovery…'))
          timer = setTimeout(poll, 2000); return
        }
        if (next.login !== 'pending') {
          setWaiting(false); setLoginUrl('')
          setMessage(next.ready ? tx('ChatGPT 已授权，模型列表已加载。', 'ChatGPT authorized; models loaded.') : next.errorCode ? localErrorLabel(next.errorCode) : tx('授权未完成。', 'Authorization is not complete.'))
          return
        }
      } catch (error) { if (!stop.signal.aborted) {
        if (error instanceof LocalProviderError && ['pairing_required', 'pairing_expired'].includes(error.code)) { setPaired(false); setWaiting(false); setMessage(error.message); return }
        if (failures++ < 2) { setMessage(tx('暂未收到状态，正在重试；无需重新授权…', 'Status is temporarily unavailable. Retrying; no reauthorization needed…')); timer = setTimeout(poll, 2000); return }
        setMessage(error instanceof Error ? error.message : tx('检查登录状态失败。', 'Unable to check sign-in status.')); setWaiting(false); return
      } }
      timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 1500)
    return () => { stop.abort(); clearTimeout(timer) }
  }, [waiting])
  const login = async (newAccount = false) => {
    if (loginInFlight.current) return
    if (!androidBridge && !paired) { setMessage(localErrorLabel('pairing_required')); return }
    controller.current?.abort()
    loginInFlight.current = true; setLoginBusy(true)
    setBusy(true); setMessage(tx('正在准备 OpenAI 授权链接…', 'Preparing the OpenAI authorization link…')); setLoginUrl('')
    try {
      const url = await beginChatGPTLogin(newAccount)
      if (!mounted.current) return
      setLoginUrl(url); setWaiting(true); setMessage(tx('授权链接已准备好。请在 OpenAI 页面登录；若浏览器未打开，请点下方“前往 OpenAI 登录”。', 'Authorization is ready. Sign in on OpenAI; if no page opened, click Open OpenAI sign-in below.'))
      // Never open an empty window before pairing/auth preparation succeeds.
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof LocalProviderError && ['pairing_required', 'pairing_expired', 'pairing_rejected'].includes(error.code)) setPaired(false)
      setMessage(error instanceof Error ? error.message : tx('无法发起登录。', 'Unable to start sign-in.'))
    }
    finally { loginInFlight.current = false; if (mounted.current) { setBusy(false); setLoginBusy(false) } }
  }
  const run = async (action: 'pair' | 'check' | 'disconnect' | 'logout' | 'cancel') => {
    controller.current?.abort()
    const current = new AbortController(); controller.current = current
    setBusy(true); setMessage(action === 'pair' ? tx('正在验证本机配对码…', 'Verifying the local pairing code…') : tx('正在检查本机服务…', 'Checking the local service…'))
    try {
      // The native status bridge already has a bounded wait. Older Android
      // WebViews do not implement AbortSignal.any/timeout.
      const signal = androidApp ? current.signal : AbortSignal.any([current.signal, AbortSignal.timeout(35000)])
      if (action === 'logout') { setWaiting(false); setLoginUrl(''); const result = await logoutChatGPT(); setMessage(result.revoked ? tx('已退出 ChatGPT 并清除本机凭证。', 'Signed out of ChatGPT and cleared local credentials.') : localErrorLabel('revocation_unconfirmed')); return }
      if (action === 'cancel') { await cancelChatGPTLogin(); setWaiting(false); setLoginUrl(''); setMessage(tx('已取消登录。', 'Sign-in cancelled.')); return }
      if (action === 'disconnect') { await disconnectLocalService(signal); setPaired(false); setStatus(null); setWaiting(false); setLoginUrl(''); setMessage(tx('本机配对已断开；这不等同于撤销 OpenAI 授权。', 'Local pairing disconnected; this does not revoke OpenAI authorization.')); return }
      if (action === 'pair') { await pairLocalService(code.trim(), signal, rememberPairing); setCode(''); setPaired(true) }
      const next = await getLocalStatus(signal)
      if (!current.signal.aborted) { setPaired(true); setStatus(next); setMessage(next.ready ? tx('服务已就绪。', 'Service ready.') : next.errorCode ? localErrorLabel(next.errorCode) : automaticConnection ? tx('已自动连接本机服务。下一步：点击 Continue with ChatGPT。', 'Local service connected automatically. Next: click Continue with ChatGPT.') : tx('配对成功。下一步：点击 Continue with ChatGPT。', 'Paired. Next: click Continue with ChatGPT.')); if (next.login === 'pending') setWaiting(true) }
    } catch (error) { if (!current.signal.aborted) {
      if (error instanceof LocalProviderError && ['pairing_required', 'pairing_expired', 'pairing_rejected'].includes(error.code)) { setPaired(false); setStatus(null) }
      setMessage(error instanceof LocalProviderError ? error.message : tx('操作失败，请检查本机服务。', 'Operation failed. Check the local service.'))
    } }
    finally { if (!current.signal.aborted) setBusy(false) }
  }
  useEffect(() => { if (settings.chatProvider === 'openai-local' && isLocalReader()) void run('check') }, [settings.chatProvider])
  return <fieldset className={css.localProvider} data-testid="local-provider-settings">
    <legend>{tx('对话服务', 'Chat service')}</legend>
    <select aria-label={tx('对话 Provider', 'Chat provider')} value={settings.chatProvider || 'deepseek'} onChange={event => {
      void patchSettings({ chatProvider: event.target.value === 'openai-local' ? 'openai-local' : 'deepseek' }).catch(() => setMessage(tx('设置保存失败。', 'Unable to save settings.')))
    }}>
      <option value="deepseek">{tx('DeepSeek / 兼容 API', 'DeepSeek / compatible API')}</option>
      <option value="openai-local" disabled={!isLocalReader()}>{androidBridge ? tx('OpenAI（ChatGPT 订阅 · 手机内置）', 'OpenAI (ChatGPT plan · built into app)') : tx('OpenAI（本机 ChatGPT 订阅）', 'OpenAI (local ChatGPT subscription)')}</option>
    </select>
    {settings.chatProvider === 'openai-local' && <div data-testid="openai-provider-controls">
    {androidBridge
      ? <p>{tx('手机内置登录，无需本机服务或配对。', 'Sign in in the app. No local service or pairing needed.')}</p>
      : <p>{tx('先启动本机服务，再配对。浏览器询问本地网络权限时请选择允许。', 'Start the local service, then pair. Allow local network access when prompted.')}</p>}
    {!isLocalReader() ? <p>{tx('当前站点不在本机连接允许列表中；请使用官方 GitHub Pages 或受支持的本地地址。现有 API 功能不受影响。', 'This site is not allowed to connect locally. Use the official GitHub Pages or a supported local origin. Existing API features are unaffected.')}</p> : <>
      <p data-testid="local-connection-stage">{androidApp ? tx('点击 Continue with ChatGPT 登录，授权后选择模型即可使用；无需配对。', 'Continue with ChatGPT, then choose a model after authorization. No pairing is needed.') : automaticConnection ? tx('① 自动连接本机服务 → ② 使用已保存的 ChatGPT 授权 → ③ 选择模型', '① Connect automatically → ② Use saved ChatGPT authorization → ③ Select model') : paired ? tx('① 本机已配对 → ② ChatGPT 登录授权 → ③ 选择模型', '① Local service paired → ② Authorize ChatGPT → ③ Select model') : tx('① 填写配对码并点“配对” → ② ChatGPT 登录授权 → ③ 选择模型', '① Enter code and click Pair → ② Authorize ChatGPT → ③ Select model')}</p>
      {!automaticConnection && <>
      <label>{tx('本机配对码（见服务终端）', 'Pairing code (from service terminal)')}
        <input type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} /></label>
      <button type="button" disabled={busy || !code} onClick={() => void run('pair')}>{tx('配对', 'Pair')}</button>
      <label><input type="checkbox" checked={rememberPairing} onChange={event => setRememberPairing(event.target.checked)} />{tx('记住此电脑（仅限可信设备）', 'Remember this trusted computer')}</label>
      </>}
      <button type="button" disabled={busy} onClick={() => void run('check')}>{androidApp ? tx('检查手机登录状态', 'Check app sign-in status') : tx('检查本机状态', 'Check local status')}</button>
      {!automaticConnection && <button type="button" disabled={busy} onClick={() => void run('disconnect')}>{tx('断开并忘记配对', 'Disconnect and forget pairing')}</button>}
      <div>
        <button type="button" disabled={(!androidBridge && (!paired || busy)) || loginBusy || waiting} onClick={() => void login()}>Continue with ChatGPT</button>
        <button type="button" disabled={(!androidBridge && (!paired || busy)) || loginBusy || waiting} onClick={() => void login(true)}>{tx('添加其他 ChatGPT 账户', 'Add another ChatGPT account')}</button>
        {waiting && <button type="button" disabled={busy} onClick={() => void run('cancel')}>{tx('取消登录', 'Cancel sign-in')}</button>}
        {status?.auth === 'authorized' && <button type="button" disabled={busy} onClick={() => void run('logout')}>{tx('退出 ChatGPT', 'Sign out of ChatGPT')}</button>}
        {loginUrl && <p><a className={css.localSignInLink} href={loginUrl} target="_blank" rel="noopener noreferrer">{tx('前往 OpenAI 登录（若未自动打开，点这里）', 'Open OpenAI sign-in (click if not opened automatically)')}</a></p>}
        {status?.email && <p>{tx('当前账户：', 'Current account: ')}{status.email}</p>}
        {!!status?.accounts?.length && <select aria-label={tx('ChatGPT 账户', 'ChatGPT account')} value={status.accounts.find(account => account.active)?.id || ''} disabled={busy || waiting} onChange={event => {
          setBusy(true); void selectChatGPTAccount(event.target.value).then(() => run('check')).catch(error => setMessage(error.message)).finally(() => setBusy(false))
        }}>{status.accounts.map(account => <option key={account.id} value={account.id}>{account.email || account.id}</option>)}</select>}
        {status?.scopes?.includes('chatgpt.tokens.use.direct') && <p>{tx('已授予订阅使用权限。', 'ChatGPT plan usage permission granted.')}</p>}
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">{tx('管理 ChatGPT 用量与应用权限', 'Manage ChatGPT usage and app access')}</a>
      </div>
      {status?.ready && <label>{tx('账户可用模型', 'Available account models')}<select value={settings.openaiLocalModel || ''} onChange={event => void patchSettings({ openaiLocalModel: event.target.value }).catch(() => setMessage(tx('设置保存失败。', 'Unable to save settings.')))}><option value="">{tx('选择模型', 'Select a model')}</option>{status.models.map(model => <option key={model} value={model}>{status.modelLabels?.find(entry => entry.slug === model)?.displayName || model}</option>)}</select></label>}
    </>}
    <p role="status">{message}</p>
    <p>{tx('使用 ChatGPT 订阅，额度共享；不会转为付费 API。支持的模型可按需联网、读取已选图片和 PDF 页面。目录识别仍用 DeepSeek 配置。', 'Uses your shared ChatGPT plan, never paid API fallback. Supported models can search and read selected images/PDF pages. TOC recognition uses DeepSeek settings.')}</p>
    {!automaticConnection && <details><summary>{tx('连接说明', 'Connection details')}</summary><p>{tx('启动：npm run local:server。本地网页可用 npm run dev:local 自动连接。配对码不是 OpenAI Token；记住配对后会自动恢复，闲置 30 天过期。需要代理时见帮助中的本机服务说明。', 'Start: npm run local:server. npm run dev:local connects the local web app automatically. Pairing codes are not OpenAI tokens. Remembered pairing restores automatically and expires after 30 idle days. See Help for proxy setup.')}</p></details>}
    </div>}
  </fieldset>
}
