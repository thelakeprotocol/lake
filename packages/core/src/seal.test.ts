import { describe, expect, it } from 'vitest';
import { buildCard, generateIdentity, openLake, sealLake, signCard, signMessage, type LakeData } from './index.js';

const agent = async (name: string) => {
  const id = await generateIdentity();
  const card = await signCard(buildCard({ name, description: name, url: `https://${name}.example/a2a`, skills: [], profile: { role: 'visitor', webId: `https://${name}.example/#agent`, ownerDomain: `${name}.example`, tags: [] } }, id), id);
  return { id, card };
};

describe('sealed messages (JWE)', () => {
  it('only the recipient can open one; a changed one opens for nobody', async () => {
    const [alice, bob, eve] = await Promise.all([agent('alice'), agent('bob'), agent('eve')]);
    const data: LakeData = { lake: '0.1', card: alice.card, envelope: (await signMessage({ kind: 'offer', price: 5 }, alice.id, { iss: 'https://alice.example/#agent' })) as LakeData['envelope'] };
    const sealed = await sealLake(data, bob.card);
    // Whoever carries it sees neither the message nor who sent it.
    expect(sealed.sealed).not.toContain('offer');
    expect(sealed.sealed).not.toContain('alice');
    expect(await openLake(sealed, bob.id)).toEqual(data);
    await expect(openLake(sealed, eve.id)).rejects.toThrow();
    const parts = sealed.sealed.split('.');
    parts[3] = parts[3]!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(openLake({ ...sealed, sealed: parts.join('.') }, bob.id)).rejects.toThrow();
  });
});
