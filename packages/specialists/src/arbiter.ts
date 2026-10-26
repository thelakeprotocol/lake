import { createHash } from 'node:crypto';
import { canonicalize, cartHash, checkCart, deliveryMisses, checkCredentialStatus, isParty, sendLake, signMessage, verifyCredential, verifyLakeCard, verifyMessage, type AgentCard, type CartMandate, type LakeData } from '@thelakeprotocol/core';
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

export async function createArbiter(o: SpecialistOptions & { payments?: string[]; log?: (entry: string, kind: string) => Promise<{ index: number; origin: string }> }) {
  const payments = o.payments ?? ['payments.lake.local'];
  // Everything either side has filed about a cart, kept: every ruling is made on all of it, so it can't depend on who
  // files first or leaves something out (run 30 had two contradictory rulings on four carts).
  const pool = new Map<string, { evidence: Signed[]; fromBuyer: Signed[]; delivered: Record<string, unknown>[]; receipts: { credential?: string; card?: AgentCard }[]; last?: { key: string; reply: Record<string, unknown> } }>();
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

  const s: Specialist = await specialist<{ kind: string } & Record<string, unknown>>(o, 'Arbiter', 'Rules on trades (SPEC §6.5) from signed evidence alone: send { kind: "arbitrate", cart, seller_card, evidence: [signed messages { card, envelope }…], receipt?: { credential, card }, delivered?: <the trade.deliver payload you sent, or a list of them: the first and its revisions> }. It checks the seller\'s cart, the payments agent\'s receipt, the seller\'s signed delivery and the buyer\'s signed receipt of it, and answers with a signed ruling on those facts. It reads no free text and judges no quality.', 'arbiter', async (p, from) => {
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
    const kept = pool.get(cart.hash) ?? { evidence: [], fromBuyer: [], delivered: [], receipts: [] };
    pool.set(cart.hash, kept);
    const filed = ((Array.isArray(p.evidence) ? p.evidence : []) as Signed[]).slice(0, 20);
    kept.evidence.push(...filed);
    if (from === cart.buyer) kept.fromBuyer.push(...filed);
    // The deliveries as the seller sent them: the first and any revisions (SPEC §6.5), each a separate trade.deliver.
    kept.delivered.push(...((Array.isArray(p.delivered) ? p.delivered : [p.delivered]) as unknown[]).slice(0, 10).filter((d): d is Record<string, unknown> => !!d && typeof d === 'object'));
    if (p.receipt && typeof p.receipt === 'object') kept.receipts.push(p.receipt as { credential?: string; card?: AgentCard });
    const facts: string[] = [];
    // Paid: a receipt from a payments agent this arbiter trusts, or one the seller named in its signed cart (that very key:
    // the seller counts its receipts, wherever it runs), naming this very cart, for its total.
    let paid = false;
    for (const r of kept.receipts) {
      if (paid) break;
      if (!r?.credential || !r.card) continue;
      try {
        const signer = await verifyLakeCard(r.card);
        if (!payments.includes(signer.ownerDomain) && !(await isParty(signer, cart.payments))) throw new Error(`${signer.ownerDomain} is not a payments agent this arbiter trusts or the cart names`);
        const vc = await verifyCredential(r.credential, signer.publicJwk);
        const sub = vc.credentialSubject as unknown as { id: string; payer?: string; amount: { value: number; currency?: string }; cart?: { id: string; hash: string } };
        const status = await checkCredentialStatus(vc as never).catch(() => ({ checked: false as const }));
        if (status.checked && status.revoked) throw new Error('the receipt was revoked');
        // Paid to the seller, or to the payee the seller named in the cart (a house its assistant sells for).
        paid = sub.cart?.hash === cart.hash && sub.id === (cart.payee?.webId ?? cart.seller) && sub.payer === cart.buyer && Math.round(sub.amount.value * 100) === Math.round(cart.total.value * 100) && (sub.amount.currency ?? 'USD') === cart.total.currency;
        if (paid) facts.push(`paid: ${cart.total.currency} ${cart.total.value}, receipt signed by ${signer.ownerDomain}`);
      } catch {
        // a receipt that doesn't check is simply not proof of payment
      }
    }
    if (!paid) facts.push(kept.receipts.length ? 'no receipt shown pays this cart' : 'no receipt shown');
    // Delivered: the seller's own signed delivery, or the plain delivery the seller sent plus the buyer's signed receipt of it.
    const evidence = await Promise.all(kept.evidence.slice(-60).map(said));
    // A seller-signed delivery the buyer itself holds (and filed) reached the buyer.
    const heldByBuyer = new Set((await Promise.all(kept.fromBuyer.slice(-60).map(said))).filter((x) => x?.by === cart.seller && x.payload.kind === 'trade.deliver').map((x) => sha256(canonicalize(x!.payload))));
    const fromSeller = evidence.filter((x) => x?.by === cart.seller && x.payload.kind === 'trade.deliver' && x.payload.cart === cart.id);
    const deliveries = [...fromSeller.map((x) => x!.payload), ...kept.delivered.filter((d) => d.kind === 'trade.deliver' && d.cart === cart.id)];
    const acks = evidence.filter((x) => x?.by === cart.buyer && x.payload.kind === 'received' && typeof x.payload.digest === 'string');
    // A revision is a delivery like any other, numbered: the ruling goes by the latest one the buyer acknowledged, else the
    // latest the seller signed.
    const revision = (d: Record<string, unknown>) => (Number.isInteger(d.revision) && Number(d.revision) > 1 ? Number(d.revision) : 1);
    let delivered: { sha256: string; content: string; acknowledged: boolean; signedBySeller: boolean; revision: number } | null = null;
    const shown = new Set<string>();
    let empty = false;
    for (const d of deliveries) {
      const content = typeof d.content === 'string' ? d.content : JSON.stringify(d.content ?? null);
      // Nothing is not a delivery, however well signed (run 36: "it arrived (0 characters)" released a disputed payment).
      if (!content.trim() || content === 'null') { empty = true; continue; }
      // Arrived: the buyer's connector signed that exactly this came, or the buyer itself filed the seller's signed delivery.
      const acknowledged = acks.some((a) => a!.payload.digest === sha256(canonicalize(d))) || heldByBuyer.has(sha256(canonicalize(d)));
      const signedBySeller = fromSeller.some((x) => x!.payload === d);
      // A plain delivery counts only when the buyer's signed receipt names it; the seller's own signature counts by itself.
      if (!acknowledged && !signedBySeller) continue;
      shown.add(sha256(content));
      if (!delivered || (acknowledged && !delivered.acknowledged) || (acknowledged === delivered.acknowledged && revision(d) > delivered.revision)) delivered = { sha256: sha256(content), content, acknowledged, signedBySeller, revision: revision(d) };
    }
    const size = (c: string) => `${c.length} character${c.length === 1 ? '' : 's'}, ${c.split('\n').length} line${c.split('\n').length === 1 ? '' : 's'}`;
    if (delivered) facts.push(delivered.acknowledged ? `delivered: it reached the buyer, as signed (content sha256 ${delivered.sha256}; ${size(delivered.content)})` : `the seller signed this delivery (content sha256 ${delivered.sha256}; ${size(delivered.content)}); nothing shows it reached the buyer`);
    else facts.push('no delivery shown that the seller signed or the buyer acknowledged');
    if (empty) facts.push('an empty delivery was shown: an empty delivery is not a delivery');
    // The counts the cart's signed terms name are facts too (run 36): words and lines, never quality.
    const counts = !!(cart.delivery?.words || cart.delivery?.lines);
    const misses = delivered && counts ? deliveryMisses(delivered.content, cart.delivery) : [];
    if (delivered && counts) facts.push(misses.length ? `it misses the cart's signed terms: ${misses.join('; ')}` : 'it meets the counts the cart\'s signed terms name');
    if (delivered && shown.size > 1) facts.push(`${shown.size} different deliveries of this cart shown (a first and its revisions): the facts above are about revision ${delivered.revision}`);
    const verdicts = evidence.filter((x) => x?.by === cart.buyer && x.payload.kind === 'trade.verdict' && x.payload.cart === cart.id).sort((a, b) => String(a!.at).localeCompare(String(b!.at)));
    const firstAccept = verdicts.find((v) => v!.payload.verdict === 'accepted');
    if (firstAccept) facts.push(`the buyer signed "accepted" at ${firstAccept.at}`);
    // What the buyer's latest dispute is about, in its own signed words: whether it arrived, or whether it is what was ordered.
    const disputeCode = [...verdicts].reverse().find((v) => v!.payload.verdict === 'disputed')?.payload.code;
    if (disputeCode) facts.push(`the buyer's dispute: ${String(disputeCode)}`);
    // The ruling: only what the signatures settle.
    const ruling = !paid ? 'Not shown paid: the seller owes nothing on this cart.'
      : !delivered ? 'Paid, not shown delivered: the seller should deliver or refund.'
      : firstAccept ? 'Paid, delivered and accepted: the trade is closed. A later dispute does not reopen it.'
      : delivered.acknowledged ? (disputeCode === 'not_received' || !disputeCode ? `Paid, and it arrived (${size(delivered.content)}): a dispute that nothing arrived fails. Whether it is what was ordered is not a fact this arbiter rules on: the content and the cart's items are attached for a person to read.`
        : misses.length ? `Paid, and it arrived (${size(delivered.content)}), but it misses the cart's signed terms (${misses.join('; ')}): the buyer's dispute stands on that.`
        : `Paid, and it arrived (${size(delivered.content)}). The buyer's dispute is that it isn't what was ordered: ${counts ? 'it meets the counts the cart names, and beyond them that' : 'that'} is not a fact this arbiter rules on, so this ruling moves no money. The content and the cart's items are attached for a person to read.`)
      : 'Paid, and the seller signed a delivery the buyer has not acknowledged: ask the buyer for its signed receipt before ruling that it arrived.';
    // Nothing new since the last ruling on this cart: the same ruling, not a second one on the record.
    const key = JSON.stringify({ paid, delivered: delivered && { sha256: delivered.sha256, acknowledged: delivered.acknowledged }, facts, ruling });
    if (kept.last?.key === key) return kept.last.reply as never;
    const credential = await s.vc('LakeRuling', { id: `urn:ap2:cart:${cart.id}`, cart: { id: cart.id, hash: cartHash((p.cart as CartMandate).contents) }, seller: cart.seller, buyer: cart.buyer, paid, delivered: delivered ? { sha256: delivered.sha256, acknowledged: delivered.acknowledged, ...(delivered.revision > 1 ? { revision: delivered.revision } : {}), ...(counts ? { meets_terms: !misses.length } : {}) } : null, facts, ruling }, 3650);
    // On the record, so a ruling can't be denied or rewritten later; but only for a cart that was paid. A ruling on a cart
    // nobody paid settles nothing (run 33 farmed "not delivered" marks, and a "delivered" one from unsolicited content,
    // on carts nobody paid): it is answered, and goes on nobody's record.
    const logged = paid ? await o.log?.(credential, 'ruling').then(({ index, origin }) => ({ index, origin })).catch(() => undefined) : undefined;
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
    const reply = { kind: 'ruling', ...(logged ? { logged } : {}), ...(paid ? {} : { note: 'not on the record: no payment shown for this cart' }), cart: cart.id, items: cart.items.map((i) => i.label), paid, delivered: delivered ? { sha256: delivered.sha256, acknowledged: delivered.acknowledged, ...(delivered.revision > 1 ? { revision: delivered.revision } : {}), ...(counts ? { meets_terms: !misses.length } : {}), content: delivered.content.slice(0, 4000) } : null, facts, ruling, credential };
    kept.last = { key, reply };
    return reply;
  });
  return s;
}
