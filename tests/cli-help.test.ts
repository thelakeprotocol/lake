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
