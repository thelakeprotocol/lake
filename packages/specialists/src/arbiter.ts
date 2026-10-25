import { createHash } from 'node:crypto';
import { canonicalize, cartHash, checkCart, checkCredentialStatus, sendLake, signMessage, verifyCredential, verifyLakeCard, verifyMessage, type AgentCard, type CartMandate, type LakeData } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * An arbiter for trades (SPEC §6.5): either party sends what it holds about one cart, every piece signed by whoever said
 * it, and gets back a signed ruling on the facts those signatures settle: was the cart real, was it paid, was it
 * delivered, and did the buyer's own connector sign that exactly that delivery arrived. It reads no free text and judges
 * no quality (free text never decides, and no model sits in this path): a dispute about whether a poem is good enough
 * is said to be one, with the delivered text attached for a person to read. Run 27's trickster disputed a delivery its
 * own signed receipt named; nobody could rule.
 */
interface Signed { card?: AgentCard; envelope?: { payload?: Record<string, unknown> } }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createArbiter(o: SpecialistOptions & { payments?: string[] }) {
  const payments = o.payments ?? ['payments.lake.local'];
  // A signed message as it was when signed: its sender's card, and the signature checked at its own time (old evidence is
  // still evidence). Returns who said what, or null.
  const said = async (x: Signed) => {
    try {
      const signer = await verifyLakeCard(x.card as AgentCard);
      const iat = Number(x.envelope?.payload?.iat ?? 0) * 1000;
      const { nonce: _n, iat: _i, exp: _e, iss: _s, ...payload } = (await verifyMessage(x.envelope as never, async (kid) => (kid === signer.publicJwk.kid ? signer.publicJwk : null), { now: iat || undefined })) as Record<string, unknown>;
      return { by: signer.webId, domain: signer.ownerDomain, at: iat ? new Date(iat).toISOString() : undefined, payload };
    } catch {
      return null;
    }
  };

  const s: Specialist = await specialist<{ kind: string } & Record<string, unknown>>(o, 'Arbiter', 'Rules on trades (SPEC §6.5) from signed evidence alone: send { kind: "arbitrate", cart, seller_card, evidence: [signed messages { card, envelope }…], receipt?: { credential, card }, delivered?: <the trade.deliver payload you sent> }. It checks the seller\'s cart, the payments agent\'s receipt, the seller\'s signed delivery and the buyer\'s signed receipt of it, and answers with a signed ruling on those facts. It reads no free text and judges no quality.', 'arbiter', async (p) => {
    if (p.kind !== 'arbitrate') return { kind: 'refused', problems: ['send { kind: "arbitrate", cart, seller_card, evidence, receipt?, delivered? }'] };
    // The cart: signed by the seller whose card comes with it.
    let cart;
    try {
      const seller = await verifyLakeCard(p.seller_card as AgentCard);
      cart = await checkCart(p.cart as CartMandate, seller.publicJwk, Date.parse((p.cart as CartMandate)?.contents?.cart_expiry ?? '') - 1000);
      if (cart.seller !== seller.webId) throw new Error('the cart names another seller');
    } catch (e) {
      return { kind: 'refused', problems: [`no cart to rule on: ${(e as Error).message}`] };
    }
    const facts: string[] = [];
    // Paid: a receipt from a payments agent this arbiter trusts, naming this very cart, for its total.
    let paid = false;
    const r = p.receipt as { credential?: string; card?: AgentCard } | undefined;
    if (r?.credential && r.card) {
      try {
        const signer = await verifyLakeCard(r.card);
        if (!payments.includes(signer.ownerDomain)) throw new Error(`${signer.ownerDomain} is not a payments agent this arbiter trusts`);
        const vc = await verifyCredential(r.credential, signer.publicJwk);
        const sub = vc.credentialSubject as unknown as { id: string; payer?: string; amount: { value: number; currency?: string }; cart?: { id: string; hash: string } };
        const status = await checkCredentialStatus(vc as never).catch(() => ({ checked: false as const }));
        if (status.checked && status.revoked) throw new Error('the receipt was revoked');
        paid = sub.cart?.hash === cart.hash && sub.id === cart.seller && sub.payer === cart.buyer && Math.round(sub.amount.value * 100) === Math.round(cart.total.value * 100) && (sub.amount.currency ?? 'USD') === cart.total.currency;
        facts.push(paid ? `paid: ${cart.total.currency} ${cart.total.value}, receipt signed by ${signer.ownerDomain}` : 'the receipt shown does not pay this cart');
      } catch (e) {
        facts.push(`the receipt shown does not check: ${(e as Error).message}`);
      }
    } else facts.push('no receipt shown');
    // Delivered: the seller's own signed delivery, or the plain delivery the seller sent plus the buyer's signed receipt of it.
    const evidence = await Promise.all(((Array.isArray(p.evidence) ? p.evidence : []) as Signed[]).slice(0, 20).map(said));
    const fromSeller = evidence.filter((x) => x?.by === cart.seller && x.payload.kind === 'trade.deliver' && x.payload.cart === cart.id);
    const plain = p.delivered as Record<string, unknown> | undefined;
    const deliveries = [...fromSeller.map((x) => x!.payload), ...(plain?.kind === 'trade.deliver' && plain.cart === cart.id ? [plain] : [])];
    const acks = evidence.filter((x) => x?.by === cart.buyer && x.payload.kind === 'received' && typeof x.payload.digest === 'string');
    let delivered: { sha256: string; content: string; acknowledged: boolean; signedBySeller: boolean } | null = null;
    for (const d of deliveries) {
      const content = typeof d.content === 'string' ? d.content : JSON.stringify(d.content ?? null);
      const acknowledged = acks.some((a) => a!.payload.digest === sha256(canonicalize(d)));
      const signedBySeller = fromSeller.some((x) => x!.payload === d);
      // A plain delivery counts only when the buyer's signed receipt names it; the seller's own signature counts by itself.
      if (!acknowledged && !signedBySeller) continue;
      if (!delivered || (acknowledged && !delivered.acknowledged)) delivered = { sha256: sha256(content), content, acknowledged, signedBySeller };
    }
    if (delivered) facts.push(delivered.acknowledged ? `delivered: the buyer's own connector signed that exactly this arrived (content sha256 ${delivered.sha256})` : `the seller signed this delivery (content sha256 ${delivered.sha256}); no signed receipt of it from the buyer was shown`);
    else facts.push('no delivery shown that the seller signed or the buyer acknowledged');
    const verdicts = evidence.filter((x) => x?.by === cart.buyer && x.payload.kind === 'trade.verdict' && x.payload.cart === cart.id).sort((a, b) => String(a!.at).localeCompare(String(b!.at)));
    const firstAccept = verdicts.find((v) => v!.payload.verdict === 'accepted');
    if (firstAccept) facts.push(`the buyer signed "accepted" at ${firstAccept.at}`);
    // The ruling: only what the signatures settle.
    const ruling = !paid ? 'Not shown paid: the seller owes nothing on this cart.'
      : !delivered ? 'Paid, not shown delivered: the seller should deliver or refund.'
      : firstAccept ? 'Paid, delivered and accepted: the trade is closed. A later dispute does not reopen it.'
      : delivered.acknowledged ? 'Paid and delivered: the buyer\'s own signed receipt names exactly this content, so a dispute that it did not arrive fails. Whether it is good enough is not a fact this arbiter rules on: the content is attached for a person to read.'
      : 'Paid, and the seller signed a delivery the buyer has not acknowledged: ask the buyer for its signed receipt before ruling that it arrived.';
    const credential = await s.vc('LakeRuling', { id: `urn:ap2:cart:${cart.id}`, cart: { id: cart.id, hash: cartHash((p.cart as CartMandate).contents) }, seller: cart.seller, buyer: cart.buyer, paid, delivered: delivered ? { sha256: delivered.sha256, acknowledged: delivered.acknowledged } : null, facts, ruling }, 3650);
    // Both sides hear it, whoever asked: a ruling one party keeps to itself settles nothing.
    const tellAll = [p.seller_card, p.buyer_card].filter(Boolean) as AgentCard[];
    for (const c of tellAll) {
      const url = c.supportedInterfaces?.[0]?.url;
      if (!url) continue;
      void (async () => {
        const envelope = await signMessage({ kind: 'trade.ruling', cart: cart.id, ruling, facts, credential: { credential, card: s.card } }, o.id, { iss: s.webId });
        await sendLake(url, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 }).catch(() => {});
      })();
    }
    return { kind: 'ruling', cart: cart.id, paid, delivered: delivered ? { sha256: delivered.sha256, acknowledged: delivered.acknowledged, content: delivered.content.slice(0, 4000) } : null, facts, ruling, credential };
  });
  return s;
}
