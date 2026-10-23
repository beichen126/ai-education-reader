import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'
import { readerLocalProxyPlugin, LOCAL_PROXY_PATH } from './server/local-transport.mjs'
// Single version source of truth: package.json -> build-time __APP_VERSION__ (see vite-env.d.ts).
export default defineConfig(({mode}) => ({
  plugins: [react(), ...(mode === 'reader-local' ? [readerLocalProxyPlugin()] : [])],
  ...(mode === 'reader-local' ? { server: { proxy: { [LOCAL_PROXY_PATH]: {
    target: 'http://127.0.0.1:8091', changeOrigin: true,
    rewrite: (path: string) => path.slice(LOCAL_PROXY_PATH.length) || '/',
  } } } } : {}),
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: '/ai-education-reader/',
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true }
}))
