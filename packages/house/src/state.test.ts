import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJson, saveWhole } from './state.js';

describe('the house\'s state files (a kill mid-write left half a file, and the house stopped at every start)', () => {
  it('saves a file whole, and of many saves at once the last one stays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lake-state-')), file = join(dir, 'notes.json');
    await Promise.all(Array.from({ length: 50 }, (_, i) => saveWhole(file, JSON.stringify({ n: i, pad: 'x'.repeat(20_000) }))));
    expect((JSON.parse(await readFile(file, 'utf8')) as { n: number }).n).toBe(49);
    await saveWhole(file, '[1]');
    expect(await loadJson(file, [])).toEqual([1]);
    expect(await readdir(dir)).toEqual(['notes.json']);
  });

  it('starts without a file that doesn\'t read, keeps it under another name and says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lake-state-')), file = join(dir, 'agenda.json');
    await writeFile(file, '[{"id":"a1","wh');
    const said: string[] = [];
    expect(await loadJson(file, [], (m) => said.push(m))).toEqual([]);
    expect(said[0]).toContain('agenda.json.unreadable');
    expect(await readFile(`${file}.unreadable`, 'utf8')).toBe('[{"id":"a1","wh');
    expect(await loadJson(file, { none: true })).toEqual({ none: true });
  });
});
