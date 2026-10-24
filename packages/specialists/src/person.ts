import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { issueSdJwtVc, PERSON_VCT, PERSON_IN_CONTEXT_VCT, ReplayGuard, verifyMessage, verifySdJwtVc, type JWK, type Signed } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A demo person checker (SPEC §6.4): stamps a house as belonging to one person, without saying who. It checks
 * nothing real; a real one is a bank, a government ID or people vouching for each other. What it does keep:
 * one person number per owner key, the same for every house that owner has, so anything that counts people
 * (a pledge, a strike, a group) counts them once. The owner asks from their own device: the house forwards
 * the owner's signed consent, and only then is the house stamped.
 *
 * Stamps are SD-JWT VCs bound to the house's key. The person number is hidden in the stamp, and never shown where
 * people are counted: for each count (a context), the house shows its number to this checker alone and gets a
 * stamp with a number for that context only, so two counts can't match a person's houses or follow them from one
 * to the next. This checker does see which contexts a person asks for; BBS pseudonyms (SPEC §13) would hide that too.
 */
export async function createPersonhood(o: SpecialistOptions & { dataDir: string }) {
  const file = `${o.dataDir}/person-secret`;
  const secret = await readFile(file, 'utf8').catch(async () => { const s = randomBytes(32).toString('hex'); await writeFile(file, s, { mode: 0o600 }); return s; });
  const replay = new ReplayGuard();
  const s: Specialist = await specialist(o, 'Person checker (demo)', 'Stamps a house as belonging to one person, without saying who. A demo: it checks nothing real (a real one is a bank or a government ID). One person per owner key, whatever number of houses they have, and a different number for every count a person joins, so counts can\'t link their houses. Houses ask with their owner\'s signed consent: { kind: "personhood.request", owner, consent }; then, for each count, { kind: "personhood.context", context, stamp } with the stamp shown to this checker.', 'personhood', async (p, from, profile) => {
    if (profile.role !== 'house') return { kind: 'refused', problems: ['only a house is stamped, on its owner\'s say-so'] };
    if (p.kind === 'personhood.context') {
      // The house shows its stamp's hidden number to this checker only, and gets a number for this one context.
      const context = String(p.context ?? '');
      if (!context || context.length > 300) return { kind: 'refused', problems: ['context: what is being counted, as the counter names it'] };
      let base;
      try {
        base = await verifySdJwtVc(String(p.stamp ?? ''), o.id.publicJwk, { vct: PERSON_VCT, aud: s.webId, nonce: context, holder: profile.publicJwk });
      } catch (e) {
        return { kind: 'refused', problems: [`the stamp does not check out: ${(e as Error).message}`] };
      }
      if (base.iss !== s.webId || base.sub !== from || typeof base.person !== 'string') return { kind: 'refused', problems: ['show this checker\'s stamp for this house, with its person number'] };
      const person = `urn:lake:person:${createHmac('sha256', secret).update(`${base.person}|${context}`).digest('hex').slice(0, 24)}`;
      const credential = await issueSdJwtVc({ iss: s.webId, sub: from, vct: PERSON_IN_CONTEXT_VCT, holder: profile.publicJwk, days: 30, context, person, checked: 'nothing real: a sandbox stand-in for a bank or a government ID' }, [], o.id);
      return { kind: 'stamped', credential, context };
    }
    if (p.kind !== 'personhood.request') return { kind: 'refused', problems: ['a house asks with { kind: "personhood.request", owner: <the owner\'s public key>, consent: <the owner\'s signed { kind: "personhood.consent", house }> }, then { kind: "personhood.context", context, stamp } for each count. Owners don\'t write this by hand: the control panel does it (Home → One person, one house → Get a person stamp). An assistant can\'t; tell your human where to tap.'] };
    const owner = p.owner as JWK | undefined;
    if (!owner?.x || owner.crv !== 'Ed25519' || !owner.kid) return { kind: 'refused', problems: ['owner: the owner\'s Ed25519 public key, with its kid'] };
    try {
      const consent = await verifyMessage(p.consent as Signed<{ kind: string; house: string }>, async (kid) => (kid === owner.kid ? owner : null), { replay });
      if (consent.kind !== 'personhood.consent' || consent.house !== from) throw new Error('the consent is for another house');
    } catch (e) {
      return { kind: 'refused', problems: [`the owner's consent does not check out: ${(e as Error).message}`] };
    }
    // The same owner key always gets the same number, and nobody can work back from the number to the key. It stays
    // hidden in the stamp: only this checker is ever shown it.
    const person = `urn:lake:person:${createHash('sha256').update(`${secret}|${owner.x}`).digest('hex').slice(0, 24)}`;
    const credential = await issueSdJwtVc({ iss: s.webId, sub: from, vct: PERSON_VCT, holder: profile.publicJwk, days: 365, person, checked: 'nothing real: a sandbox stand-in for a bank or a government ID' }, ['person'], o.id);
    return { kind: 'stamped', credential };
    // Quiet, like the tally: who asks for a stamp, just before a people-only pledge fills, says who signed it.
  }, [], true);
  return s;
}
