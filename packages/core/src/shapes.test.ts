import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CORE_SHAPES } from './index.js';

it('core shapes in code match model/shapes.ttl', () => {
  expect(CORE_SHAPES).toBe(readFileSync(new URL('../../../model/shapes.ttl', import.meta.url), 'utf8'));
});
