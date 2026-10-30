import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import {
  buildCard, generateIdentity, GROUP_SIZE, lakeAgentApp, LakeLinks, loadOrCreateIdentity, pack as packOf, ReplayGuard, runProgram, sendLake, signCard, signIntentMandate, signMessage,
  signPaymentMandate, verifyCredential, verifyLakeCard, verifyLakeData, signCart, cartParty, cardUrlFor, type CartParty,
  type AgentCard, type Badge, type Claim, type Attachment, type Identity, type LakeData, type QuoterExample,
} from '@thelakeprotocol/core';
import { ask, type Visitor } from './knock.js';
import { makeHuman } from './dispatch.js';

/**
 * A quoter: an agent that prices intents for one pack (a lender for mortgages, an insurer, an energy
 * supplier…). It gets authorised by the pack's authority and its program certified by an auditor once;
 * then, for every intent a house sends it, it sends back its program to run inside that house. It never
 * sees the result unless the owner accepts; then it checks the released original with its issuer, confirms,
 * and pays the owner its fee, in its currency, under its own human's spending mandate.
 */
export interface QuoterOptions {
  example: QuoterExample;
  node: string;
  auditor: string;
  authority: string;
  payments?: string;
  /**
   * Other Lakes' payments agents its carts also name (base URLs, without /a2a): a buyer on a federated Lake pays through
   * its own (run 68: a lake-b shop's cart named only lake-b's, and a lake-a buyer's money had nowhere to go).
   */
  acceptPayments?: string[];
  /** Where houses reach it, without /a2a. */
  publicUrl: string;
  port?: number;
  mount?: (app: import('express').Express) => void;
  keyFile?: string;
  sandbox?: boolean;
  log?: (msg: string) => void;
  /**
   * Its WebID. Default: its own address (`<publicUrl>/#agent`), so the same demo quoter run by two deployments is two
   * agents, not one WebID with two keys (a node keeps one card per WebID: two federated Lakes each saw only their own).
   * Its domain (ownerDomain) stays the pack's, which is what a register lists.
   */
  webId?: string;
  /** How long to keep asking for the authorisation at start while the authority isn't up yet (ms). Default 3 minutes. */
  authoriseWithinMs?: number;
}

export interface Quoter { card: AgentCard; webId: string; quotes: () => number; close: () => Promise<void> }

export async function startQuoter(o: QuoterOptions): Promise<Quoter> {
  const ex = o.example;
  const p = packOf(ex.program.pack);
  if (!p) throw new Error(`no pack ${ex.program.pack} loaded`);
  const id: Identity = o.keyFile ? await loadOrCreateIdentity(o.keyFile) : await generateIdentity();
  const webId = o.webId ?? `${o.publicUrl.replace(/\/$/, '')}/#agent`;
  const cardWith = (badges?: Badge[]) => signCard(buildCard({
    name: ex.name, description: `Quotes for ${p.title.toLowerCase()} intents. Its program runs inside your house; only you see the result.`,
    url: `${o.publicUrl}/a2a`, skills: [{ id: `${p.id}-quote`, name: `${p.title} quotes`, description: ex.program.title }],
    profile: { role: 'agent', webId, ownerDomain: ex.domain, tags: [p.id, ...(ex.menu?.length ? ['shop'] : [])], ...(ex.menu?.length ? { menu: ex.menu } : {}), ...(badges ? { badges } : {}) },
  }, id), id);
  let card = await cardWith();
  const me: Visitor = { id, card, webId, domain: ex.domain };
  const log = o.log ?? (() => {});

  // Once: the authority's authorisation, and the auditor's certificate for the program. Started together with the
  // specialists, the authority may not be up yet ("fetch failed"): asked again with backoff, never on a refusal.
  const authorised = await untilReachable(() => ask(`${o.authority}/a2a`, me, { kind: 'authorise', pack: ex.program.pack }), o.authoriseWithinMs ?? 180_000, (e, wait) => log(`${ex.name}: the authority isn't answering yet (${e.message.slice(0, 80)}); again in ${Math.round(wait / 1000)} s`));
  if (authorised.reply.kind !== 'approved') throw new Error(`${ex.name} not authorised: ${(authorised.reply.problems ?? []).join('; ')}`);
  const authorisation: Attachment = { credential: authorised.reply.credential, card: await cardOf(o.authority) };
  // On its card too, as a badge: anyone searching sees the register vouches for it, not just a house that asks (run 23:
  // anyone could tag itself a grocer).
  card = await cardWith([{ credential: authorised.reply.credential, issuer: `${o.authority}/a2a` }]);
  me.card = card;
  const certified = await untilReachable(() => ask(`${o.auditor}/a2a`, me, { kind: 'audit-program', program: ex.program }), o.authoriseWithinMs ?? 180_000, () => {});
  if (certified.reply.kind !== 'certified') throw new Error(`${ex.name}'s program not certified: ${(certified.reply.problems ?? []).join('; ')}`);
  const certificate: Attachment = { credential: certified.reply.credential, card: await cardOf(o.auditor) };

  const currency = ex.currency ?? 'USD';
  const human = await makeHuman(await generateIdentity(), ex.domain);
  const mandate = await signIntentMandate(human.id, human.webId, {
    id: webId, natural_language_description: `${ex.name}: fees to applicants who accept our offers`, study: `urn:lake:quoter:${ex.domain}`,
    budget: { currency, amount: 1_000_000 }, intent_expiry: new Date(Date.now() + 365 * 86_400_000).toISOString(), user_cart_confirmation_required: false,
  });
  let quotes = 0;

  const reply = async (body: Record<string, unknown>): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, id, { iss: webId })) as LakeData['envelope'] });
  const replay = new ReplayGuard();
  const app = lakeAgentApp(card, async (data) => {
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox ?? true });
    if (!v.ok) return reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    const house = (data as LakeData).card.supportedInterfaces?.[0]?.url;
    const m = v.payload;
    if (m.kind === 'authorisation') return reply({ kind: 'authorisation', authorisation });
    if (m.kind === 'intent' && m.pack === ex.program.pack && house) {
      // Answer at once; quote right after, as a request of our own to the house.
      setTimeout(() => enqueue(house), 10);
      return reply({ kind: 'received' });
    }
    if (m.kind === 'accept' && house) return reply(await accepted(m, v.profile.webId, house));
    // A single item from our menu (run 67: six of ten everyday wants were one thing to buy, and an order got "malformed"):
    // a cart signed for the buyer, held until we ship. Something we don't sell is said plainly, with what we do.
    if (m.kind === 'trade.order') {
      const item = ex.menu?.find((x) => x.sku === m.sku);
      const stocked = (ex.menu ?? []).map((x) => `${x.label} (${x.sku}, ${x.price.currency} ${x.price.value})`).join('; ');
      if (!item) return reply({ kind: 'rejected', code: 'not-stocked', why: `we don't sell "${String(m.sku ?? '')}"${stocked ? `. On our menu: ${stocked}` : ''}. Weekly shops: we price them inside your house, from its intent` });
      if (!house || !o.payments) return reply({ kind: 'rejected', code: 'unavailable', why: 'we can\'t take orders just now' });
      const qty = Number.isInteger(m.qty) && Number(m.qty) >= 1 && Number(m.qty) <= 20 ? Number(m.qty) : 1;
      const payments = await cartParties();
      const label = `${qty} × ${item.label}`;
      const cart = await signCart({ seller: id, sellerWebId: webId, sellerName: card.name, buyerWebId: v.profile.webId, items: [{ label, amount: { currency: item.price.currency, value: Math.round(item.price.value * qty * 100) / 100 } }], minutes: 60, payments, menu: { items: ex.menu!, sku: item.sku }, delivery: item.delivery ?? { within_hours: 48, review_hours: 72 } });
      const cartId = String((cart.contents as { id: string }).id);
      ourCarts.set(cartId, { buyer: { webId: v.profile.webId, url: house }, label });
      return reply({ kind: 'trade.cart', cart, pay: `lake_buy { action: "pay", cart: "${cartId}" }: the money is held until it arrives` });
    }
    // Paid for an order: the payment's receipt arrives like any message; acknowledge it, naming the order. A cart of ours
    // paid with the money held: we "ship" (a dispatch note to the buyer) and file the delivery, so the hold can release.
    if (m.kind === 'receipt') {
      const sold = typeof m.cart === 'string' ? ourCarts.get(m.cart) : undefined;
      if (sold) setTimeout(() => void ship(String(m.cart), sold, (m.receipt as { credential?: string } | undefined)?.credential).catch((e: Error) => log(`${ex.name}: could not file the delivery: ${e.message}`)), 300);
      return reply({ kind: 'received', note: `payment received${m.order ? ` for order ${String(m.order)}` : ''}; thank you${sold ? ': your order is on its way' : ''}` });
    }
    // A question before accepting (run 24: "do you do halal beef?"): the answer is the certified program itself, which is
    // public: what it reads, what it says when it can't serve you, what the owner sees. Facts it stands behind, not chat.
    if (m.kind === 'question' || m.kind === 'note') {
      const pr = ex.program as typeof ex.program & { notes?: { say: string }[]; labels?: Record<string, { label: string; unit?: string }> };
      return reply({ kind: 'answer', from: ex.name, program: { title: pr.title, reads: pr.inputs, terms: pr.terms ?? [], says_when_it_cannot: (pr.notes ?? []).map((n) => n.say), shows: Object.fromEntries(Object.entries(pr.labels ?? {}).map(([k, v]) => [k, v.label + (v.unit ? ` (${v.unit})` : '')])) },
        note: 'what we offer is this certified program, run in your house on your data: it answers for us. Anything it doesn\'t say, it doesn\'t promise.' });
    }
    return reply({ kind: 'rejected', code: 'malformed', why: `send an intent, an authorisation request, an acceptance, or a question (answered with our certified program)${ex.menu?.length ? ', or an order from our menu: { kind: "trade.order", sku, qty }' : ''}` });
  }, id, { replay });

  // A few quotes at a time, and another try for a house that was busy: a hundred homes asking at once is normal.
  const queue: string[] = [];
  let active = 0;
  function enqueue(house: string) {
    if (house && !queue.includes(house)) queue.push(house);
    while (active < 4 && queue.length) {
      active++;
      void sendQuote(queue.shift()!).finally(() => { active--; enqueue(''); });
    }
  }
  // What each house last said when it turned a quote away: logged when it changes, not every minute it says it again.
  const refusedBy = new Map<string, string>();
  async function sendQuote(house: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        const envelope = await signMessage({ kind: 'quote', program: ex.program, certificate, authorisation, fee: ex.feeOnAccept, currency }, id, { iss: webId });
        const raw = await sendLake(house, { lake: '0.1', card, envelope: envelope as LakeData['envelope'] }, { me: id, timeoutMs: 20_000 });
        // A reply is not a yes (run 32: three grocers took a day of refusals for quotes delivered). A refusal isn't retried:
        // the house will say the same until something changes, and it tells us again with its next intent.
        const v = raw ? await verifyLakeData<Record<string, unknown>>(raw as LakeData<Record<string, unknown>>, { sandbox: o.sandbox ?? true }) : null;
        const r = v?.ok ? v.payload : { kind: 'rejected', code: 'unreadable', why: v ? `its reply did not verify: ${v.rejection.why}` : 'no reply we could open' };
        if (r.kind === 'rejected') {
          const said = `${String(r.code)}: ${String(r.why)}`;
          if (refusedBy.get(house) !== said) log(`${ex.name}: ${house} turned our quote away (${said})`);
          refusedBy.set(house, said);
          return;
        }
        refusedBy.delete(house);
        quotes++;
        return;
      } catch (e) {
        if (attempt >= 3) return log(`${ex.name}: could not quote ${house}: ${(e as Error).message}`);
        await new Promise((ok) => setTimeout(ok, 2000 * attempt));
      }
    }
  }

  // Carts we signed for accepted offers, by id: who pays, and what, until the delivery is filed.
  const ourCarts = new Map<string, { buyer: { webId: string; url: string }; label: string }>();
  /**
   * An accepted offer, paid through a cart we sign (run 66: shops were paid outright, with nothing held until delivery):
   * made out to the assistant the house names as payer, for exactly the offer's price, with our delivery terms.
   */
  async function cartFor(m: Record<string, unknown>, outputs: Record<string, number>): Promise<{ id: string } | undefined> {
    const payer = m.payer as { webId?: unknown; url?: unknown } | undefined;
    const total = ex.program.price ? outputs[ex.program.price] : undefined;
    if (!o.payments || typeof payer?.webId !== 'string' || typeof payer.url !== 'string' || typeof total !== 'number' || !(total > 0)) return undefined;
    const payments = await cartParties();
    const label = `${ex.name}: ${ex.acceptedAs ?? 'your order'}`;
    const cart = await signCart({ seller: id, sellerWebId: webId, sellerName: card.name, buyerWebId: payer.webId, items: [{ label, amount: { currency, value: Math.round(total * 100) / 100 } }], minutes: 24 * 60, payments, delivery: { within_hours: 48, review_hours: 72 } });
    const cartId = String((cart.contents as { id: string }).id);
    ourCarts.set(cartId, { buyer: { webId: payer.webId, url: payer.url }, label });
    // Sent once our acceptance is on its way back, so the house tells its assistant of the accept first.
    setTimeout(() => void ask(String(payer.url), me, { kind: 'trade.cart', cart, note: `${label}: pay with hold, and the money waits until it arrives` }).catch((e: Error) => log(`${ex.name}: could not send the cart: ${e.message}`)), 500);
    return { id: cartId };
  }
  /** The payments agents our carts name: ours first, then the other Lakes' we take; one that can't be reached is left out. */
  async function cartParties(): Promise<CartParty[]> {
    const all = await Promise.all([o.payments!, ...(o.acceptPayments ?? [])].map((u) => fetch(cardUrlFor(`${u.replace(/\/$/, '')}/a2a`)).then(async (r) => cartParty((await r.json()) as AgentCard)).catch(() => null)));
    if (!all[0]) throw new Error('our payments agent did not answer');
    return all.filter((x): x is CartParty => !!x);
  }
  /** Shipped: the dispatch note to the buyer, and its digest filed with the payments agent holding the money. */
  async function ship(cartId: string, sold: { buyer: { webId: string; url: string }; label: string }, receipt?: string) {
    const vc = receipt ? (JSON.parse(Buffer.from(receipt.split('.')[1] ?? '', 'base64url').toString()) as { iss?: string; issuer?: string | { id?: string }; credentialSubject?: { settlement?: string; settlementId?: string } }) : undefined;
    const issuer = typeof vc?.issuer === 'string' ? vc.issuer : (vc?.issuer?.id ?? vc?.iss);
    const said = vc?.credentialSubject;
    if (said?.settlement !== 'held' || !said.settlementId) return;
    const content = `Dispatched: ${sold.label}. It arrives within two days; accept it when it does.`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    await ask(sold.buyer.url, me, { kind: 'trade.deliver', cart: cartId, content, sha256 });
    // Filed with the payments agent holding the money: whichever of the cart's issued the receipt.
    const holder = (await cartParties()).find((x) => x.webId === issuer)?.url ?? `${o.payments}/a2a`;
    await ask(holder, me, { kind: 'delivered', hold: said.settlementId, sha256 });
    ourCarts.delete(cartId);
  }

  /** The owner said yes: check the released original with its issuer, confirm conditionally, pay the fee. */
  async function accepted(m: Record<string, unknown>, houseWebId: string, house: string): Promise<Record<string, unknown>> {
    const release = m.release as { original?: string; credential?: string; issuer?: { recordId: string; card: AgentCard }; claims?: Claim[] } | undefined;
    const terms = { ...(m.terms as Record<string, string | number>), [GROUP_SIZE]: Number((m.terms as Record<string, unknown>)?.[GROUP_SIZE] ?? 1) };
    const agreed = (outputs: Record<string, number>, paid = 0) => ({ kind: 'agreed', what: ex.acceptedAs ?? 'conditional approval', outputs, feePaid: paid, next: ex.next ?? 'a full application, with the documents you choose to send', order: String(m.ref) });
    // A pack that sends only the facts it names (a shopping list): the owner's own word, priced again as offered.
    if (p!.release?.includes('claims')) {
      if (!Array.isArray(release?.claims)) return { kind: 'rejected', code: 'malformed', why: `expected the claims for ${(p!.releaseFields ?? []).join(', ')}` };
      const result = runProgram(ex.program, release.claims.filter((c) => p!.releaseFields?.includes(c.field)), terms);
      if (!result.eligible) return { kind: 'declined', why: 'that list no longer fits our offer' };
      const cart = await cartFor(m, result.outputs).catch((e: Error) => { log(`${ex.name}: no cart: ${e.message}`); return undefined; });
      return { ...agreed(result.outputs), ...(cart ? { cart: cart.id, next: 'we have sent your assistant a signed cart for exactly this: pay it with the money held, and it is ours only once you accept the delivery' } : {}) };
    }
    if (!release?.original || !release.credential || !release.issuer) return { kind: 'rejected', code: 'malformed', why: 'expected the original record, its credential and its issuer' };
    try {
      const issuer = await verifyLakeCard(release.issuer.card);
      if (issuer.ownerDomain !== p!.source?.issuer.domain && !(o.sandbox ?? true)) throw new Error(`we don't accept records from ${issuer.ownerDomain}`);
      const vc = await verifyCredential(release.credential, issuer.publicJwk, { id: release.issuer.recordId, bytes: release.original });
      if (vc.credentialSubject.id !== houseWebId) throw new Error('that record belongs to someone else');
    } catch (e) {
      return { kind: 'declined', why: `the record did not check out: ${(e as Error).message}` };
    }
    // Same rules, now on the verified original: the conditional approval stands, or it doesn't.
    const result = runProgram(ex.program, p!.source!.convert(release.original), terms);
    let paid: number | undefined;
    if (result.eligible && ex.feeOnAccept && o.payments) {
      try {
        const payment = await signPaymentMandate(id, webId, { payee: houseWebId, amount: ex.feeOnAccept, intentMandate: mandate, agreement: `urn:lake:offer:${String(m.ref)}`, currency });
        const settled = await ask(`${o.payments}/a2a`, me, { kind: 'settle', intent: { credential: mandate, card: human.card }, payments: [payment] });
        const receipt = settled.reply.receipts?.[0];
        if (receipt) {
          await ask(house, me, { kind: 'receipt', receipt: { credential: receipt.credential, card: await cardOf(o.payments) } });
          paid = ex.feeOnAccept;
        }
      } catch (e) {
        log(`${ex.name}: fee not paid: ${(e as Error).message}`);
      }
    }
    return result.eligible
      ? agreed(result.outputs, paid ?? 0)
      : { kind: 'declined', why: 'the verified record does not meet our rules after all' };
  }

  let server: Server | null = null;
  if (o.mount) o.mount(app);
  else server = app.listen(o.port ?? 0);
  const link = new LakeLinks({ nodeUrls: o.node.split(',').map((u) => u.trim()), card, identity: id, webId, log });
  await link.register(20);
  link.keepAlive(15_000);
  log(`${ex.name} quoting for ${ex.program.pack} at ${o.publicUrl}`);
  return {
    card, webId, quotes: () => quotes,
    close: async () => { link.stop(); await link.flush(); if (server) await new Promise((ok) => server!.close(ok)); },
  };
}

/** Retries what fails to reach its peer (a refused connection, a timeout), with backoff, until `withinMs` has passed. */
async function untilReachable<T>(fn: () => Promise<T>, withinMs: number, onRetry: (e: Error, waitMs: number) => void): Promise<T> {
  const end = Date.now() + withinMs;
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() + wait > end) throw e;
      onRetry(e as Error, wait);
      await new Promise((ok) => setTimeout(ok, wait));
    }
  }
}

const cards = new Map<string, Promise<AgentCard>>();
function cardOf(base: string): Promise<AgentCard> {
  let c = cards.get(base);
  if (!c) {
    c = fetch(`${base}/.well-known/agent-card.json`).then((r) => r.json() as Promise<AgentCard>);
    cards.set(base, c);
  }
  return c;
}
