import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { map: resolve(__dirname, 'index.html'), approvals: resolve(__dirname, 'approvals.html') } } },
  server: { proxy: { '/events': { target: 'ws://localhost:7000', ws: true } } },
});
