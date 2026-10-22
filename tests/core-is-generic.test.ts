import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LakePack } from '../packages/core/src/index.js';

// AGENTS.md: the core is generic. No use case's fields, issuers or converters may be named in packages/;
// they live in usecases/<name>/. This fails the build when one leaks back in.
const root = new URL('..', import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (f === 'node_modules' || f === 'dist') return [];
  return statSync(p).isDirectory() ? files(p) : /\.(ts|vue)$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
});

describe('the core knows no use case', async () => {
  const packs: LakePack[] = [];
  for (const u of readdirSync(join(root, 'usecases'))) packs.push((await import(join(root, 'usecases', u, 'src', 'index.ts'))).default);
  const names = packs.flatMap((p) => [
    ...Object.keys(p.fields), p.source?.issuer.domain, p.source?.converter, p.source?.credentialType,
  ]).filter((x): x is string => !!x);
  const sources = readdirSync(join(root, 'packages')).flatMap((p) => files(join(root, 'packages', p, 'src')));

  it.each(names)('%s appears in no core source file', (name) => {
    const hits = sources.filter((f) => new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`).test(readFileSync(f, 'utf8')));
    expect(hits.map((h) => h.slice(root.length))).toEqual([]);
  });
});
