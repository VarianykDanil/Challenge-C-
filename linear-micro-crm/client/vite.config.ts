import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { serviceWorkerPlugin } from './build/serviceWorkerPlugin.ts';

/**
 * The libraries every page needs go into their own chunks, apart from the app's code: the entry stays small, and
 * after an update a phone downloads only the app code that changed (these keep their names until the library is
 * updated). Recharts and the PDF tools are not here: they load only when a chart or a PDF is needed.
 */
function vendorChunk(id: string): string | undefined {
  if (!id.includes('/node_modules/')) return undefined;
  if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
  if (/\/node_modules\/(react-router|react-router-dom|cookie|set-cookie-parser)\//.test(id)) return 'router';
  if (/\/node_modules\/@tanstack\//.test(id)) return 'query';
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerPlugin({ swEntry: fileURLToPath(new URL('./sw/sw.ts', import.meta.url)) })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
});
