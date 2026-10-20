import { describe, expect, it } from 'vitest';
import { buildCard, CardError, generateIdentity, ReplayGuard, signCard, signMessage, SignatureError, verifyLakeCard, verifyMessage } from './index.js';

const resolverFor = (jwk: object) => async () => jwk as never;

describe('signed messages', () => {
  it('verifies, then rejects tampering, replay and expiry', async () => {
    const id = await generateIdentity();
    const msg = await signMessage({ kind: 'offer', priceUsd: 2 }, id, { iss: 'https://uni.example/agent' });
    const guard = new ReplayGuard();
    await expect(verifyMessage(msg, resolverFor(id.publicJwk), { replay: guard })).resolves.toMatchObject({ priceUsd: 2 });
    await expect(verifyMessage(msg, resolverFor(id.publicJwk), { replay: guard })).rejects.toMatchObject({ code: 'replayed' });

    const tampered = { ...msg, payload: { ...msg.payload, priceUsd: 200 } };
    await expect(verifyMessage(tampered, resolverFor(id.publicJwk))).rejects.toMatchObject({ code: 'bad-signature' });

    const old = await signMessage({ kind: 'offer' }, id, { iss: 'x', ttl: 1, now: Date.now() - 60_000 });
    await expect(verifyMessage(old, resolverFor(id.publicJwk))).rejects.toBeInstanceOf(SignatureError);
  });

  it('rejects a message signed by someone else', async () => {
    const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const msg = await signMessage({ hi: 1 }, a, { iss: 'a' });
    await expect(verifyMessage(msg, resolverFor({ ...b.publicJwk, kid: a.kid }))).rejects.toMatchObject({ code: 'bad-signature' });
  });
});

describe('Lake agent cards', () => {
  const input = {
    name: 'House stan',
    description: 'Housekeeper for stan',
    url: 'http://localhost:4100/a2a',
    skills: [{ id: 'health-study', name: 'Health study', description: 'Answers research offers', tags: ['research-volunteers'] }],
    profile: { role: 'house' as const, webId: 'http://localhost:3000/stan/profile/card#me', ownerDomain: 'localhost', tags: ['research-volunteers'] },
  };

  it('signs with the official A2A signer and verifies', async () => {
    const id = await generateIdentity();
    const card = await signCard(buildCard(input, id), id);
    expect(card.signatures).toHaveLength(1);
    await expect(verifyLakeCard(card)).resolves.toMatchObject({ role: 'house', ownerDomain: 'localhost' });
  });

  it('rejects unsigned cards and forged ones', async () => {
    const id = await generateIdentity();
    await expect(verifyLakeCard(buildCard(input, id))).rejects.toMatchObject({ code: 'unsigned' });

    const card = await signCard(buildCard(input, id), id);
    const forged = structuredClone(card);
    forged.capabilities!.extensions[0]!.params!.ownerDomain = 'nhs.uk';
    await expect(verifyLakeCard(forged)).rejects.toBeInstanceOf(CardError);
  });
});
