import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: '/ai-education-reader/',
  build: { outDir: 'dist', emptyOutDir: true }
})
