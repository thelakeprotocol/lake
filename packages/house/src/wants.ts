import { createHash } from 'node:crypto';
import { cartHash, checkCart, looksLikeInjection, makeWant, MAX_WANTS, signPaymentMandate, type AgentCard, type CartMandate, type Identity, type LakeProfile, type PostalAddress, type Want } from '@thelakeprotocol/core';

/** One shop's offer for a want, as the house keeps it: the signed cart, what it checked, and how it went. */
export interface WantOfferRecord {
  id: string;
  at: string;
  seller: { name: string; webId: string; url: string; domain: string };
  cart: CartMandate;
  total: { currency: string; value: number };
  items: { label: string; amount: { currency: string; value: number } }[];
  expires: string;
  matched?: string[];
  delivery?: string;
  note?: string;
  /** Over what the owner said they'd pay: kept, folded away, never told to the shop. */
  over?: boolean;
  state: 'open' | 'paid' | 'shipped' | 'arrived';
  hold?: string;
  receipt?: string;
  shipped?: { note: string; sha256?: string; at: string };
  /** Bought with the owner's delivery address sent to this seller (the address itself stays in the pod). */
  addressSent?: boolean;
}
export interface WantRecord { want: Want; limit?: { amount: number; currency: string }; offers: WantOfferRecord[]; closed?: string; bought?: string; at: string; /** The assistant that posted it (its key): it follows its own want's offers. */ by?: string }

const MAX_OFFERS = 10;
const short = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * What the owner is looking for (SPEC §6.8), kept in their pod: each want, the most they'd pay (only here), and the
 * offers shops sent, each a cart the shop signed. Open wants go on the house's card; buying one is the owner's tap on
 * their phone, paid by the house under a signature for that cart only, held until they say it arrived.
 */
export async function openWants(o: { load: () => Promise<WantRecord[]>; save: (list: WantRecord[]) => Promise<void> }) {
  let list = await o.load().catch(() => [] as WantRecord[]);
  let writing = Promise.resolve();
  const save = () => (writing = writing.then(() => o.save(list)).catch(() => {}));
  const live = (r: WantRecord) => !r.closed && !r.bought && Date.parse(r.want.availabilityEnds) > Date.now();
  const find = (id: string) => list.find((r) => r.want.id === id);
  return {
    /** The wants on the card: open, not bought, not past their date. */
    open: (): Want[] => list.filter(live).map((r) => r.want),
    all: () => list,
    find,
    async post(input: Parameters<typeof makeWant>[0], limit?: { amount: number; currency: string }, by?: string) {
      if (list.filter(live).length >= MAX_WANTS) throw new Error(`at most ${MAX_WANTS} open wants: close one first`);
      const want = makeWant(input);
      list = [...list.filter((r) => live(r) || Date.parse(r.at) > Date.now() - 30 * 86_400_000), { want, ...(limit ? { limit } : {}), offers: [], at: new Date().toISOString(), ...(by ? { by } : {}) }].slice(-50);
      await save();
      return want;
    },
    async close(id: string) {
      const r = find(id);
      if (!r) return false;
      r.closed = new Date().toISOString();
      await save();
      return true;
    },
    /** A shop's offer: its cart checked against its key, made out to this house, for an open want. One per shop: a new one replaces it. */
    async offerIn(p: Record<string, unknown>, profile: LakeProfile, card: AgentCard, houseWebId: string): Promise<{ ok: true; offer: WantOfferRecord; want: Want; replaced?: string; dropped?: string[] } | { ok: false; why: string }> {
      const r = find(String(p.want ?? ''));
      if (!r) return { ok: false, why: 'this house has no want with that id: check the house (lake_want find says which house each want is on)' };
      if (!live(r)) return { ok: false, why: 'that want is no longer open here (closed, bought or past its date)' };
      let c;
      try { c = await checkCart(p.cart as CartMandate, profile.publicJwk); } catch (e) { return { ok: false, why: (e as Error).message }; }
      if (c.seller !== profile.webId) return { ok: false, why: 'the cart is signed for another seller' };
      if (c.buyer !== houseWebId) return { ok: false, why: `make the cart out to this house (${houseWebId}): it pays` };
      if (r.want.priceCurrency && c.total.currency !== r.want.priceCurrency) return { ok: false, why: `offers for this want are in ${r.want.priceCurrency}` };
      if (Date.parse(c.expires) < Date.now() + 15 * 60_000) return { ok: false, why: 'the cart must stay good for at least 15 minutes: the owner answers on their phone' };
      // A shop's words are data: shown as theirs, never acted on (a note that gives orders isn't shown at all).
      const note = short(p.note, 200);
      // "Matched" can only name the want's own properties: anything else would show the owner a match that isn't one.
      const props = new Map(r.want.itemOffered.additionalProperty.map((x) => [x.name.toLowerCase(), x.name]));
      const said = Array.isArray(p.matched) ? (p.matched as unknown[]).slice(0, 12).map((m) => short(m, 40)).filter(Boolean) : undefined;
      const matched = said?.map((m) => props.get(m.toLowerCase())).filter((m): m is string => !!m);
      const dropped = said?.filter((m) => !props.has(m.toLowerCase()));
      const offer: WantOfferRecord = {
        // The seller's key is in the id: two shops can't make offers with the same id by choosing the same cart id (round 8).
        id: `o-${createHash('sha256').update(`${profile.webId}|${c.id}`).digest('hex').slice(0, 20)}`, at: new Date().toISOString(),
        seller: { name: short(card.name, 80), webId: profile.webId, url: String(card.supportedInterfaces?.[0]?.url ?? ''), domain: profile.ownerDomain },
        cart: p.cart as CartMandate, total: c.total, items: c.items, expires: c.expires,
        ...(matched ? { matched: [...new Set(matched)] } : {}),
        ...(p.delivery ? { delivery: short(p.delivery, 80) } : {}),
        ...(note && !looksLikeInjection(note) ? { note } : {}),
        ...(r.limit && r.limit.currency === c.total.currency && c.total.value > r.limit.amount ? { over: true } : {}),
        state: 'open',
      };
      const before = r.offers.findIndex((x) => x.seller.webId === profile.webId && x.state === 'open');
      if (before < 0 && r.offers.length >= MAX_OFFERS) return { ok: false, why: `${MAX_OFFERS} offers already: this want is full` };
      const replaced = before >= 0 ? r.offers[before]!.id : undefined;
      if (before >= 0) r.offers[before] = offer; else r.offers.push(offer);
      await save();
      return { ok: true, offer, want: r.want, ...(replaced ? { replaced } : {}), ...(dropped?.length ? { dropped } : {}) };
    },
    /**
     * Where a shop's own offer for a want stands. Never whether it is over the owner's limit (that stays in the house), nor
     * anything about other shops' offers: only "no longer open" once someone else's was bought.
     */
    statusFor(wantId: string, sellerWebId: string): Record<string, unknown> {
      const r = find(wantId);
      if (!r) return { kind: 'refused', problems: ['this house has no want with that id'] };
      const mine = r.offers.find((x) => x.seller.webId === sellerWebId && (x.id === r.bought || x.state === 'open'));
      const open = live(r);
      if (!mine) return { kind: 'want.status', want: wantId, offer: null, want_open: open, says: open ? 'no offer of yours is open on it' : 'no offer of yours, and it is no longer open' };
      const state = mine.id === r.bought ? mine.state : !open ? 'not_bought' : Date.parse(mine.expires) < Date.now() ? 'expired' : 'open';
      const says = { open: 'open: the owner sees it on their phone; you hear if they buy', expired: 'your cart has run out: send a new offer to stay in', not_bought: 'the want closed without buying yours', paid: `bought, held until they say it arrived: send it to the address in the receipt, then lake_want shipped`, shipped: 'sent: paid when they say it arrived, or after the cart\'s review time', arrived: 'arrived: the payment is released to you' }[state as string] ?? state;
      return { kind: 'want.status', want: wantId, offer: mine.id, cart: mine.cart.contents.id, state, total: mine.total, expires: mine.expires, says };
    },
    /** The shop says it sent it: from the shop that was paid, about that cart. */
    async shippedIn(p: Record<string, unknown>, profile: LakeProfile) {
      const r = find(String(p.want ?? ''));
      const offer = r?.offers.find((x) => x.id === r.bought && x.seller.webId === profile.webId);
      if (!r || !offer || offer.state !== 'paid') return { ok: false as const, why: 'nothing of yours is paid and waiting to be sent for that want' };
      offer.state = 'shipped';
      offer.shipped = { note: short(p.note, 200) || 'Sent.', ...(/^[0-9a-f]{64}$/.test(String(p.sha256 ?? '')) ? { sha256: String(p.sha256) } : {}), at: new Date().toISOString() };
      await save();
      return { ok: true as const, offer, want: r.want };
    },
    /** Pays an offer with the owner's signature for its cart: held at the Lake's payments agent until the owner says it arrived. */
    async buy(wantId: string, offerId: string, signed: { credential: string; owner: string }, x: { id: Identity; webId: string; card: AgentCard; payments: string; deliverTo?: PostalAddress; send: (url: string, payload: Record<string, unknown>) => Promise<{ payload: Record<string, any>; card?: AgentCard }> }) {
      const r = find(wantId);
      const offer = r?.offers.find((o) => o.id === offerId);
      if (!r || !offer) return { error: 'no such offer' };
      if (offer.state !== 'open' || r.bought) return { error: 'this want is bought already' };
      const sellerCard = await fetch(offer.seller.url.replace(/\/a2a\/?$/, '/.well-known/agent-card.json')).then((res) => res.json() as Promise<AgentCard>).catch(() => null);
      if (!sellerCard) return { error: `can't reach ${offer.seller.name} now: nothing was paid` };
      const c = offer.cart.contents;
      const payment = await signPaymentMandate(x.id, x.webId, { payee: offer.seller.webId, amount: offer.total.value, currency: offer.total.currency, intentMandate: signed.credential, agreement: `urn:ap2:cart:${c.id}`, cart: { detailsId: c.payment_request.details.id, hash: cartHash(c) } });
      const { payload: paid, card: paymentsCard } = await x.send(x.payments, { kind: 'settle', intent: { credential: signed.credential, card: x.card, owner: signed.owner }, payments: [payment], cart: { mandate: offer.cart, card: sellerCard }, hold: true });
      if (paid.kind !== 'settled') return { error: `the payments agent: ${((paid.problems as string[]) ?? [String(paid.kind)]).join('; ')}` };
      const receipt = String((paid.receipts as { credential: string }[])[0]?.credential ?? '');
      let hold = '';
      try { hold = String(JSON.parse(Buffer.from(receipt.split('.')[1] ?? '', 'base64url').toString()).credentialSubject?.settlementId ?? ''); } catch { /* no id */ }
      offer.state = 'paid'; offer.hold = hold; offer.receipt = receipt; if (x.deliverTo) offer.addressSent = true;
      r.bought = offer.id;
      await save();
      // The shop hears it's paid, with the receipt (held: it reaches the shop when the owner says it arrived), and where
      // to send it: the owner's address goes to this one seller, now, and to nobody else.
      await x.send(offer.seller.url, { kind: 'receipt', receipt: { credential: receipt, card: paymentsCard }, amount: offer.total.value, currency: offer.total.currency, cart: c.id, want: r.want.id, hold, ...(x.deliverTo ? { deliverTo: x.deliverTo } : {}) }).catch(() => {});
      return { ok: true, offer, want: r.want, receipt };
    },
    /** The owner says it arrived: the held payment goes to the shop. */
    async arrived(wantId: string, x: { payments: string; send: (url: string, payload: Record<string, unknown>) => Promise<{ payload: Record<string, any> }> }) {
      const r = find(wantId);
      const offer = r?.offers.find((o) => o.id === r.bought);
      if (!r || !offer?.hold) return { error: 'nothing bought for that want' };
      if (offer.state === 'arrived') return { ok: true, offer };
      const { payload } = await x.send(x.payments, { kind: 'capture', hold: offer.hold, ...(offer.shipped?.sha256 ? { sha256: offer.shipped.sha256 } : {}) });
      if (payload.kind === 'refused') return { error: `the payments agent: ${((payload.problems as string[]) ?? ['refused']).join('; ')}` };
      offer.state = 'arrived';
      await save();
      return { ok: true, offer };
    },
  };
}
export type Wants = Awaited<ReturnType<typeof openWants>>;
