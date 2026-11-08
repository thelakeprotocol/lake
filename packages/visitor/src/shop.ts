import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import {
  buildCard, cartParty, cardUrlFor, deliversTo, generateIdentity, lakeAgentApp, LakeLinks, loadOrCreateIdentity, ReplayGuard, signCard, signCart, signMessage, verifyLakeData, wantFit,
  type AgentCard, type CartParty, type LakeData, type ShopExample, type Want,
} from '@thelakeprotocol/core';
import { ask, type Visitor } from './knock.js';

/**
 * A demo shop that answers wants (SPEC §6.8). Every little while it reads the Lake's open wants; for each it hasn't
 * answered, it offers its closest item, if one fits well enough, as a cart it signs for that house, with its delivery.
 * Paid (held until the owner says it arrived), it "posts" it: a dispatch note to the house, filed with the payments
 * agent so the hold can release. It never sees what the person would pay; it offers its own price.
 */
export interface ShopOptions {
  example: ShopExample;
  node: string;
  payments: string;
  /** Other Lakes' payments agents its carts also name (base URLs, without /a2a). */
  acceptPayments?: string[];
  /** Where houses reach it, without /a2a. */
  publicUrl: string;
  port?: number;
  mount?: (app: import('express').Express) => void;
  keyFile?: string;
  sandbox?: boolean;
  everyMs?: number;
  log?: (msg: string) => void;
}
export interface Shop { card: AgentCard; webId: string; offered: () => number; look: () => Promise<number>; close: () => Promise<void> }

/** How well an item must fit a want before the shop offers it. */
const MIN_FIT = 0.5;

export async function startShop(o: ShopOptions): Promise<Shop> {
  const ex = o.example;
  const id = o.keyFile ? await loadOrCreateIdentity(o.keyFile) : await generateIdentity();
  const webId = `${o.publicUrl.replace(/\/$/, '')}/#agent`;
  const card = await signCard(buildCard({
    name: ex.name, description: ex.description, url: `${o.publicUrl}/a2a`,
    skills: [{ id: 'wants', name: 'Answers wants', description: 'Reads what people are looking for on the Lake and offers what fits, as a signed cart, held until it arrives.' }],
    profile: { role: 'agent', webId, ownerDomain: ex.domain, tags: ['shop', 'answers-wants'] },
  }, id), id);
  const me: Visitor = { id, card, webId, domain: ex.domain };
  const log = o.log ?? (() => {});
  const reply = async (body: Record<string, unknown>): Promise<LakeData> => ({ lake: '0.1', card, envelope: (await signMessage(body, id, { iss: webId })) as LakeData['envelope'] });
  const replay = new ReplayGuard();
  // Wants answered (house + want), and carts sold, waiting to be paid.
  const answered = new Set<string>();
  const sold = new Map<string, { house: string; want: string; label: string }>();
  let count = 0;

  async function cartParties(): Promise<CartParty[]> {
    const all = await Promise.all([o.payments, ...(o.acceptPayments ?? [])].map((u) => fetch(cardUrlFor(`${u.replace(/\/$/, '')}/a2a`)).then(async (r) => cartParty((await r.json()) as AgentCard)).catch(() => null)));
    if (!all[0]) throw new Error('our payments agent did not answer');
    return all.filter((x): x is CartParty => !!x);
  }

  /** Our closest item for a want, if it fits: by its words and properties, in our currency, where we deliver. */
  const bestFor = (w: Want) => {
    if (w.priceCurrency && w.priceCurrency !== ex.currency) return null;
    if (!deliversTo(w.areaServed, ex.regions)) return null;
    const scored = ex.items.map((item) => ({ item, ...wantFit(w, item) })).filter((x) => x.score >= MIN_FIT).sort((a, b) => b.score - a.score || a.item.price - b.item.price);
    return scored[0] ?? null;
  };

  async function offer(w: Want, house: { url: string; webId: string }) {
    const best = bestFor(w);
    if (!best) { log(`${ex.name}: nothing of ours fits "${w.name}"${deliversTo(w.areaServed, ex.regions) ? '' : ` (we don't deliver to ${w.areaServed})`}`); return false; }
    const qty = w.eligibleQuantity?.value ?? 1;
    const label = `${qty} × ${best.item.label}`;
    const items = [{ label, amount: { currency: ex.currency, value: Math.round(best.item.price * qty * 100) / 100 } }, ...(ex.delivery.fee > 0 ? [{ label: `Delivery, ${ex.delivery.days} day${ex.delivery.days === 1 ? '' : 's'}`, amount: { currency: ex.currency, value: ex.delivery.fee } }] : [])];
    const cart = await signCart({ seller: id, sellerWebId: webId, sellerName: ex.name, buyerWebId: house.webId, items, minutes: 24 * 60, payments: await cartParties(), delivery: { within_hours: Math.max(24, ex.delivery.days * 24), review_hours: 168 } });
    const { reply: r } = await ask(house.url, me, { kind: 'want.offer', want: w.id, cart, matched: best.matched, delivery: ex.delivery.days === 1 ? 'next day' : `${ex.delivery.days} days${ex.delivery.fee ? '' : ', free'}` });
    if (r.kind === 'want.received') { sold.set(cart.contents.id, { house: house.url, want: w.id, label }); count++; log(`${ex.name}: offered ${label} for "${w.name}"`); return true; }
    log(`${ex.name}: offer for "${w.name}" refused: ${(r.problems ?? [r.why ?? r.kind]).join('; ')}`);
    return false;
  }

  /** One look at the Lake's wants: an offer for each new one we can answer. Returns how many it offered. */
  async function look(): Promise<number> {
    const wants = await fetch(`${o.node.split(',')[0]!.replace(/\/$/, '')}/wants`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ want: Want; house: { url: string; webId: string } }[]>).catch(() => []);
    let n = 0;
    for (const { want, house } of wants) {
      const key = `${house.webId}|${want.id}`;
      if (answered.has(key) || !house.url) continue;
      answered.add(key);
      if (await offer(want, house).catch((e: Error) => { answered.delete(key); log(`${ex.name}: ${e.message}`); return false; })) n++;
    }
    return n;
  }

  /** Paid, held: we post it, tell the house with a dispatch note, and file the note's digest with the payments agent. */
  async function ship(cartId: string, s: { house: string; want: string; label: string }, receipt: string) {
    const vc = JSON.parse(Buffer.from(receipt.split('.')[1] ?? '', 'base64url').toString()) as { iss?: string; issuer?: string | { id?: string }; credentialSubject?: { settlement?: string; settlementId?: string } };
    const issuer = typeof vc.issuer === 'string' ? vc.issuer : (vc.issuer?.id ?? vc.iss);
    const tracking = `DEMO-${createHash('sha256').update(cartId).digest('hex').slice(0, 8).toUpperCase()}`;
    const note = `Posted: ${s.label}. Tracking ${tracking} (a demo: nothing is really sent). About ${ex.delivery.days === 1 ? 'a day' : `${ex.delivery.days} days`}.`;
    const sha256 = createHash('sha256').update(note).digest('hex');
    await ask(s.house, me, { kind: 'want.shipped', want: s.want, cart: cartId, note, sha256 });
    if (vc.credentialSubject?.settlement === 'held' && vc.credentialSubject.settlementId) {
      const holder = (await cartParties()).find((x) => x.webId === issuer)?.url ?? `${o.payments}/a2a`;
      await ask(holder, me, { kind: 'delivered', hold: vc.credentialSubject.settlementId, sha256 });
    }
    sold.delete(cartId);
  }

  const app = lakeAgentApp(card, async (data) => {
    const v = await verifyLakeData<Record<string, unknown>>(data as LakeData<Record<string, unknown>>, { replay, sandbox: o.sandbox ?? true });
    if (!v.ok) return reply({ kind: 'rejected', code: v.rejection.code, why: v.rejection.why });
    const m = v.payload;
    if (m.kind === 'receipt') {
      const s = typeof m.cart === 'string' ? sold.get(m.cart) : undefined;
      const credential = (m.receipt as { credential?: string } | undefined)?.credential;
      if (s && credential) setTimeout(() => void ship(String(m.cart), s, credential).catch((e: Error) => log(`${ex.name}: could not post it: ${e.message}`)), 500);
      return reply({ kind: 'received', note: s ? 'thank you: it goes in the post today' : 'thank you' });
    }
    return reply({ kind: 'rejected', code: 'malformed', why: 'we answer wants: tell your human\'s house what you are looking for (lake_want), and we offer if we have it' });
  }, id, { replay });

  let server: Server | undefined;
  if (o.mount) o.mount(app);
  else server = app.listen(o.port ?? 0);
  const link = new LakeLinks({ nodeUrls: o.node.split(',').map((u) => u.trim()), card, identity: id, webId, log });
  await link.register(20);
  // Checked in every 15 s, as every agent that stays: a node drops a card it hasn't heard from (the shops vanished from searches).
  link.keepAlive(15_000);
  const timer = setInterval(() => void look().catch(() => {}), o.everyMs ?? 20_000);
  timer.unref();
  return { card, webId, offered: () => count, look, close: async () => { clearInterval(timer); link.stop(); await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())); } };
}
