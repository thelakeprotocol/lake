import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectiveCounter, studyId, verifyAgreementSignature, verifyCredential, verifyLakeCard, verifyMessage, type AgentCard } from './index.js';

// The committed examples in spec/examples must always verify: agents learn the protocol from them.
const ex = (name: string) => JSON.parse(readFileSync(new URL(`../../../spec/examples/${name}`, import.meta.url), 'utf8'));
const keyOf = async (card: AgentCard) => (await verifyLakeCard(card)).publicJwk;
const envelope = async (name: string) => {
  const d = ex(name);
  const key = await keyOf(d.card);
  return verifyMessage(d.envelope, async () => key, { now: d.envelope.payload.iat * 1000 });
};

describe('spec/examples', () => {
  it('cards are genuine', async () => {
    for (const f of ['visitor-card.json', 'house-card.json']) await expect(verifyLakeCard(ex(f))).resolves.toBeDefined();
  });

  it('every step is a verifiable signed envelope', async () => {
    for (const f of ['count-open.json', '1-offer.json', '2-counter.json', '4-join.json', '5-compute.json', 'count-report.json', '6-counted.json', 'count-share.json', '7-receipt.json']) await expect(envelope(f)).resolves.toBeDefined();
  });

  it('credentials verify against their issuers', async () => {
    for (const f of ['ethics-approval.json', 'study-certificate.json', 'intent-mandate.json']) {
      const d = ex(f);
      await expect(verifyCredential(d.credential, await keyOf(d.card))).resolves.toBeDefined();
    }
    const house = await keyOf(ex('house-card.json'));
    const visitor = await keyOf(ex('visitor-card.json'));
    await expect(verifyCredential(ex('grant.json').credential, house)).resolves.toBeDefined();
    await expect(verifyCredential(ex('payment-mandate.json').credential, visitor)).resolves.toBeDefined();
    const receipt = (await envelope('7-receipt.json')) as unknown as { receipt: { credential: string; card: AgentCard } };
    await expect(verifyCredential(receipt.receipt.credential, await keyOf(receipt.receipt.card))).resolves.toBeDefined();
  });

  it('the agreement is signed by the house and countersigned by the visitor', async () => {
    const join = (await envelope('4-join.json')) as unknown as { agreement: { agreement: never; signatures: { jws: string }[] } };
    const compute = (await envelope('5-compute.json')) as unknown as { countersignature: string };
    expect(await verifyAgreementSignature(join.agreement.agreement, join.agreement.signatures[0]!.jws, await keyOf(ex('house-card.json')))).toBe(true);
    expect(await verifyAgreementSignature(join.agreement.agreement, compute.countersignature, await keyOf(ex('visitor-card.json')))).toBe(true);
  });

  it('ids and bloc terms follow the rules', () => {
    const s = ex('study.json');
    expect(studyId(s.study)).toBe(s.id);
    const b = ex('3-bloc.json');
    expect(collectiveCounter(b.counters)).toEqual(b.bloc);
  });
});
