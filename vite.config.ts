import {genuiAssetsPlugin,genuiAliases} from './scripts/genui-vite.mjs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'
// Single version source of truth: package.json -> build-time __APP_VERSION__ (see vite-env.d.ts).
export default defineConfig({
  resolve: {alias:genuiAliases},
  // These source imports need the Reader transforms in development as well as at build time.
  optimizeDeps: {exclude: Object.keys(genuiAliases), include: ['anser']},
  plugins: [react(), genuiAssetsPlugin()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: '/ai-education-reader/',
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true }
})
