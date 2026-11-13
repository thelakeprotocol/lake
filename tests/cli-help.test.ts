import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The server commands answer --help with their options, and an unknown option with one line (round 6: a stack trace).
// Each starts Node twice: slow on a busy machine running the whole suite at once.
describe('server commands', { timeout: 30_000 }, () => {
  for (const [bin, name] of [['packages/house/dist/main.js', 'lake-house'], ['packages/lake/dist/main.js', 'lake-node'], ['packages/specialists/dist/main.js', 'lake-specialist']]) {
    it(`${name} --help and a mistyped option`, () => {
      const help = spawnSync(process.execPath, [bin!, '--help'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }, timeout: 20_000 });
      expect(help.status).toBe(0);
      expect(help.stdout).toMatch(/^Usage: /m);
      expect(help.stdout).toMatch(/--port <value>/);
      const bad = spawnSync(process.execPath, [bin!, '--prot', '4000'], { encoding: 'utf8', timeout: 20_000 });
      expect(bad.status).toBe(2);
      expect(bad.stderr.trim()).toBe(`${name}: unknown option '--prot'. ${name} --help lists them.`);
    });
  }
  it('lake-house says plainly when its data folder can\'t be written', () => {
    // A folder inside a plain file can't exist, whoever runs this.
    const file = join(mkdtempSync(join(tmpdir(), 'lake-cli-')), 'a-file');
    writeFileSync(file, '');
    const r = spawnSync(process.execPath, ['packages/house/dist/main.js', '--name', 'x', '--data', join(file, 'house')], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^lake-house: can't write to .*a-file\/house \(ENOTDIR\): pass --data/);
  });
});

// A study is what gets certified and counted, never a sentence: the CLI used to run its first example for any --goal
// (round 23). It now says what it can run, and how to write one, before anything is started or paid.
describe('lake dispatch', { timeout: 30_000 }, () => {
  const lake = (...args: string[]) => spawnSync(process.execPath, ['packages/visitor/dist/cli.js', ...args], { encoding: 'utf8', timeout: 20_000 });
  it('lists what a study may ask about', () => {
    const listed = JSON.parse(lake('fields', '--json').stdout) as { field: string; ask: string[]; studies: boolean }[];
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed) expect(f, f.field).toMatchObject({ ask: expect.arrayContaining(['present']), studies: expect.any(Boolean) });
    expect(lake('fields').stdout).toContain(listed[0]!.field);
  });
  it('a question it has no study for, or a study that can\'t be asked, is one line and exit 2', () => {
    const words = lake('dispatch', '--goal', 'Is this a real study?');
    expect(words.status).toBe(2);
    expect(words.stderr.trim()).toMatch(/^lake: "Is this a real study\?" isn't a question the loaded packs offer \(.*\)\. Write your own as a file and pass --study; lake fields lists what it may ask about$/);
    const file = join(mkdtempSync(join(tmpdir(), 'lake-cli-')), 'study.json');
    writeFileSync(file, JSON.stringify({ question: 'Who keeps a pet?', predicates: [{ name: 'has a pet', field: 'pets_of_the_house', op: 'present' }] }));
    const bad = lake('dispatch', '--study', file);
    expect(bad.status).toBe(2);
    expect(bad.stderr.trim()).toMatch(/^lake: .*study\.json can't be asked: question "has a pet" reads "pets_of_the_house", which no pack here declares\. lake fields lists what a study may ask about$/);
    const missing = lake('dispatch', '--study', join(file, 'nowhere.json'));
    expect(missing.status).toBe(2);
    expect(missing.stderr.trim().split('\n')).toHaveLength(1);
  });
});
