import { describe, expect, it } from 'vitest';
import { checkPass, issuePass, newPassKey, passChallenge, requestPass } from './index.js';

describe('passes (Privacy Pass, RFC 9578)', () => {
  it('a token for one pledge works there once, and nowhere else', async () => {
    const key = await newPassKey();
    const chl = passChallenge('passes.example', 'pledge-1', 'tally.example');
    const { request, finish } = await requestPass(chl, key.publicKey);
    const token = await finish(await issuePass('passes.example', key, request));
    const ok = await checkPass(token, key.publicJwk, chl);
    expect(ok.ok).toBe(true);
    // Another pledge, another tally, another issuer key: refused.
    expect((await checkPass(token, key.publicJwk, passChallenge('passes.example', 'pledge-2', 'tally.example'))).ok).toBe(false);
    expect((await checkPass(token, key.publicJwk, passChallenge('passes.example', 'pledge-1', 'other-tally.example'))).ok).toBe(false);
    expect((await checkPass(token, (await newPassKey()).publicJwk, chl)).ok).toBe(false);
    // Two tokens from one key have different nonces: each can be spent once.
    const second = await (async () => { const r = await requestPass(chl, key.publicKey); return r.finish(await issuePass('passes.example', key, r.request)); })();
    expect((await checkPass(second, key.publicJwk, chl) as { nonce: string }).nonce).not.toBe((ok as { nonce: string }).nonce);
  });
});
