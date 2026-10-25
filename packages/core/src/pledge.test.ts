import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCard, checkReveal, commitTo, generateIdentity, openSeal, QUICKNET, roundAfter, roundTimeMs, sealedRound, sealReveal, sealUntil, signCard, type Signer } from './index.js';

// A real quicknet round, as drand published it: the key that opens every seal to round 1,000,000, checked offline.
const round1m = { chain: QUICKNET.hash, round: 1_000_000, randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3', signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72' };
const at = roundTimeMs(round1m.round);

const signer = async (domain: string): Promise<Signer & { webId: string }> => {
  const identity = await generateIdentity();
  const webId = `https://${domain}/#agent`;
  const card = await signCard(buildCard({ name: domain, description: 'A signer', url: `https://${domain}/a2a`, skills: [], profile: { role: 'visitor', webId, ownerDomain: domain, tags: [] } }, identity), identity);
  return { identity, card, webId };
};

describe('unveiling a blind pledge (drand timelock, offline)', () => {
  afterEach(() => vi.useRealTimers());

  it('seals to a round still to come, without the network, and the seal says its round', async () => {
    const round = roundAfter(60_000);
    expect(sealedRound(await sealUntil(round, 'who I am'))).toBe(round);
    expect(sealedRound('not a seal')).toBeUndefined();
  });

  it("opens a signer's sealed reveal only once the round is out, checks it opens that signature, and can't be used to name anyone else", async () => {
    // Sealed a minute before round 1,000,000 (a past round, so its beacon is known), opened just after it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at - 60_000);
    const alice = await signer('alice.example'), mallory = await signer('mallory.example');
    const r = { tally: 'https://tally.example/#agent', id: 'strike', salt: 'a1'.repeat(16) };
    const commit = commitTo(alice.webId, r.salt);
    const sealed = await sealReveal(round1m.round, r, alice.webId, alice);
    expect(sealedRound(sealed)).toBe(round1m.round);
    await expect(openSeal(sealed, round1m)).rejects.toThrow(/too early/);

    vi.setSystemTime(at + 10_000);
    // A beacon that isn't the real round doesn't open it.
    await expect(openSeal(sealed, { ...round1m, signature: round1m.signature.replace(/^8/, '9') })).rejects.toThrow();
    const opened = await openSeal(sealed, round1m);
    expect(await checkReveal(opened, { ...r, commit, sandbox: true })).toEqual({ webId: alice.webId, domain: 'alice.example', url: 'https://alice.example/a2a' });
    // Only for this pledge at this tally, and only for this signature.
    await expect(checkReveal(opened, { ...r, id: 'another', commit, sandbox: true })).rejects.toThrow('another pledge');
    await expect(checkReveal(opened, { ...r, tally: 'https://other-tally.example/#agent', commit, sandbox: true })).rejects.toThrow('another pledge');
    await expect(checkReveal(opened, { ...r, commit: commitTo(alice.webId, 'b2'.repeat(16)), sandbox: true })).rejects.toThrow('does not open');
    // Mallory signs with a commitment to Alice and seals a reveal naming her: it isn't Alice's signature, so it names nobody.
    vi.setSystemTime(at - 60_000);
    const framed = await sealReveal(round1m.round, r, alice.webId, mallory);
    vi.setSystemTime(at + 10_000);
    await expect(checkReveal(await openSeal(framed, round1m), { ...r, commit, sandbox: true })).rejects.toThrow(/does not verify/);
  });
});
