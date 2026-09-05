// Shared browser launcher for the CRITICAL browser E2E (Agent H, H8). Windows-local runs use
// real Microsoft Edge by default; Linux CI sets PLAYWRIGHT_CHANNEL=chromium (or leaves it unset on
// a non-Windows runner) to use the Playwright-bundled Chromium, so the same critical subset gates
// the Pages deployment without depending on a Windows runner having Edge installed.
import { chromium } from 'playwright-core'

export async function launchBrowser() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium')
  // 'chromium' (or unset on non-Windows) means the bundled browser -> no channel.
  if (channel && channel !== 'chromium') return chromium.launch({ channel, headless: true })
  return chromium.launch({ headless: true })
}
