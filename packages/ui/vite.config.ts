import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // ES2022: the owner's key is loaded with a top-level await before anything signs (src/house/api.ts).
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, rollupOptions: {
    input: { map: resolve(__dirname, 'index.html'), approvals: resolve(__dirname, 'approvals.html') },
    // Ionic in one chunk, loaded with the panel: its own lazy imports (focus, animations, the keyboard) then come from code
    // already here. As separate files, one first asked for while the phone was offline failed to load and broke the screen
    // (14 Nov: "Failed to fetch dynamically imported module").
    output: { manualChunks: (id) => (id.includes('node_modules/@ionic/') ? 'ionic' : undefined) },
  } },
  server: { proxy: { '/events': { target: 'ws://localhost:7000', ws: true } } },
});
