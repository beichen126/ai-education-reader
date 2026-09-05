import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'
// Single version source of truth: package.json -> build-time __APP_VERSION__ (see vite-env.d.ts).
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: '/ai-education-reader/',
  build: { outDir: 'dist', emptyOutDir: true }
})
