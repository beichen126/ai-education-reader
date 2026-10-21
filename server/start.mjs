import { createLocalService } from './local-server.mjs'
import { createChatGPTAdapter } from './chatgpt-auth.mjs'
import { prepareLocalTransport } from './local-transport.mjs'
import { createPairingStore } from './pairing-store.mjs'
import { createCredentialVault } from './credential-vault.mjs'

let adapter
try { adapter = await createChatGPTAdapter() }
catch { console.error('无法读取或保护 Reader 本机凭证。 / Unable to read or protect Reader credentials.'); process.exit(1) }
const localTransport = await prepareLocalTransport()
const pairingStore = await createPairingStore(createCredentialVault(undefined, 'pairings'))
const service = createLocalService({ adapter, localTransport, pairingStore })
service.server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Reader 本机服务端口 8091 已被占用。 / Port 8091 is in use.' : 'Reader 本机服务无法启动。 / Unable to start local service.')
  process.exitCode = 1
})
service.server.listen(8091, '127.0.0.1', () => {
  console.log('Reader local service: http://127.0.0.1:8091')
  // One-use local pairing capability, NOT an OpenAI credential. Never persist it.
  console.log('一次性本机配对码 / One-use local pairing code:', service.pairingCode)
  console.log('npm run dev:local 自动连接本机服务，无需反复配对。 / npm run dev:local connects automatically; no repeated pairing.')
})
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { await service.stop() })
