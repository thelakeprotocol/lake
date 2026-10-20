import { defineConfig } from 'vitest/config';

// End-to-end: real processes, real pods. Run after `pnpm build`.
export default defineConfig({ test: { include: ['e2e/**/*.e2e.test.ts'], testTimeout: 30_000, hookTimeout: 120_000, fileParallelism: false } });
