import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `vite build --mode app` produces app/index.html: one self-contained file (all JS/CSS inlined)
// that opens straight from disk by double-clicking, or from any static host such as GitHub Pages.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'app' ? [viteSingleFile()] : [])],
  base: './',
  build: {
    chunkSizeWarningLimit: 800,
    ...(mode === 'app' ? { outDir: 'app', emptyOutDir: true, chunkSizeWarningLimit: 2000 } : {}),
  },
}))
