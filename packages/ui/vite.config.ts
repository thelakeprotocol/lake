import { defineConfig } from 'vite';

export default defineConfig({ base: './', build: { outDir: 'dist', emptyOutDir: true }, server: { proxy: { '/events': { target: 'ws://localhost:7000', ws: true } } } });
