import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ReplayGuard, verifyMessage, type JWK, type Signed } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A demo person checker (SPEC §6.4): stamps a house as belonging to one person, without saying who. It checks
 * nothing real; a real one is a bank, a government ID or people vouching for each other. What it does keep:
 * one person number per owner key, the same for every house that owner has, so anything that counts people
 * (a pledge, a strike, a group) counts them once. The owner asks from their own device: the house forwards
 * the owner's signed consent, and only then is the house stamped.
 */
export async function createPersonhood(o: SpecialistOptions & { dataDir: string }) {
  const file = `${o.dataDir}/person-secret`;
  const secret = await readFile(file, 'utf8').catch(async () => { const s = randomBytes(32).toString('hex'); await writeFile(file, s, { mode: 0o600 }); return s; });
  const replay = new ReplayGuard();
  const s: Specialist = await specialist(o, 'Person checker (demo)', 'Stamps a house as belonging to one person, without saying who. A demo: it checks nothing real (a real one is a bank or a government ID). One person number per owner key, the same for every house that owner has, so whatever counts people counts them once. Houses ask with their owner\'s signed consent: { kind: "personhood.request", owner, consent }.', 'personhood', async (p, from, profile) => {
    if (p.kind !== 'personhood.request') return { kind: 'refused', problems: ['send { kind: "personhood.request", owner: <the owner\'s public key>, consent: <the owner\'s signed { kind: "personhood.consent", house }> }'] };
    if (profile.role !== 'house') return { kind: 'refused', problems: ['only a house is stamped, on its owner\'s say-so'] };
    const owner = p.owner as JWK | undefined;
    if (!owner?.x || owner.crv !== 'Ed25519' || !owner.kid) return { kind: 'refused', problems: ['owner: the owner\'s Ed25519 public key, with its kid'] };
    try {
      const consent = await verifyMessage(p.consent as Signed<{ kind: string; house: string }>, async (kid) => (kid === owner.kid ? owner : null), { replay });
      if (consent.kind !== 'personhood.consent' || consent.house !== from) throw new Error('the consent is for another house');
    } catch (e) {
      return { kind: 'refused', problems: [`the owner's consent does not check out: ${(e as Error).message}`] };
    }
    // The same owner key always gets the same number, and nobody can work back from the number to the key.
    const person = `urn:lake:person:${createHash('sha256').update(`${secret}|${owner.x}`).digest('hex').slice(0, 24)}`;
    const credential: string = await s.vc('LakePersonhood', { id: from, person, checked: 'nothing real: a sandbox stand-in for a bank or a government ID' }, 365);
    return { kind: 'stamped', credential, person };
  });
  return s;
}
