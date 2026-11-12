import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { houseRunner } from './duty-runner.js';

describe('the house-run AI on duty', () => {
  it('keeps the owner\'s key 0600, never shows it, and forgets it when the house is handed back', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lake-runner-'));
    const r = houseRunner({ dataDir, connector: 'http://localhost:1/mcp', house: 'http://localhost:2', operatorModel: 'stub', log: () => {} });
    expect(await r.status()).toMatchObject({ can: true, model: { provider: 'stub', whose: 'house' }, running: false });
    await r.setModel({ provider: 'anthropic', apiKey: `sk-ant-${'z'.repeat(30)}` });
    expect((await stat(join(dataDir, 'model.json'))).mode & 0o077).toBe(0);
    const st = await r.status();
    expect(st).toMatchObject({ model: { provider: 'anthropic', whose: 'yours' } });
    expect(JSON.stringify(st)).not.toContain('sk-ant-');
    // A sandbox lease ends: the next owner gets the house's offer, not the last owner's key.
    await r.forget();
    await expect(readFile(join(dataDir, 'model.json'), 'utf8')).rejects.toThrow();
    expect(await r.status()).toMatchObject({ model: { whose: 'house' } });
  });
  it('says plainly when it can\'t sign in, and isn\'t left running', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lake-runner-'));
    const r = houseRunner({ dataDir, connector: 'http://localhost:1/mcp', house: 'http://localhost:2', operatorModel: 'stub', log: () => {} });
    await expect(r.start('a-code')).rejects.toThrow();
    expect(await r.status()).toMatchObject({ running: false, lastError: expect.any(String) });
  });
});
