import { randomUUID } from 'node:crypto';
import {
  auditProgram, checkAttachment, verifyCredential, GROUP_SIZE, makeEvent, pack as packOf, packId, programId, runProgram, sendLake, signMessage, verifyLakeCard, verifyLakeData,
  type AgentCard, type Attachment, type Claim, type Identity, type LakeData, type LakeEvent, type LakeLinks, type LakePack, type LakeProfile, type QuoteProgram, type QuoteResult,
} from '@thelakeprotocol/core';
import type { RecordPaths, Trust } from './record.js';

/**
 * The owner's side of a market (SPEC §12). The owner says what they're looking for (an intent); the house
 * tells authorised agents, and nobody else; each agent sends a certified program; the house runs it on the
 * owner's own data and keeps the result for the owner. The agent learns only that its quote was delivered.
 * Nothing leaves until the owner taps Accept, and then only the files the pack names, to that one agent.
 */
export interface Intent {
  pack: string; terms: Record<string, string | number>; group: string; members: number; openedAt: string;
  /**
   * When the owner accepted an offer for it: no more quotes are asked for, but the house still counts in its group for a
   * day, as group buying locks the price for the window (run 39: the last neighbour to decide was priced at a group of 2).
   */
  acceptedAt?: string;
}

/** How long a house that accepted still counts in its group. */
const COUNTS_AFTER_ACCEPT_MS = 24 * 3_600_000;
const open = (i: Intent) => !i.acceptedAt;

export interface StoredOffer {
  id: string;
  pack: string;
  quoter: { name: string; domain: string; webId: string; url: string };
  title: string;
  program: string;
  result: QuoteResult;
  labels: QuoteProgram['labels'];
  fee?: number;
  currency?: string;
  groupSize: number;
  at: string;
  status: 'open' | 'accepted' | 'paid';
  answer?: Record<string, unknown>;
  /** What the owner's assistant paid for it, under their allowance, by the payments agent's receipt. */
  paid?: { amount: number; currency: string; at: string };
}

/**
 * Why an open intent has no offers yet, in plain facts for the owner and their assistant. Run 32: three grocers were
 * told every minute for 26 minutes, the house turned every quote away (its own record had stopped checking out), and
 * all anyone saw was an empty offers board.
 */
export interface IntentStatus {
  /** Authorised agents that have heard about it since it opened (on this run of the house). */
  agentsTold: number;
  /** The latest agents that got no offer in, newest first: a quote this house refused, or an agent it couldn't tell. */
  turnedAway: TurnedAway[];
  /** This house's own record can't price anything for this pack: no agent's quote can run until it's fixed. */
  warning?: string;
}
export interface TurnedAway { agent: string; domain?: string; code: string; why: string; at: string }

/** A handful per intent is enough to say why; more would be a log. */
const TURNED_AWAY_KEPT = 6;

interface Ctx {
  /** Which of the owner's assistants pays an accepted offer, in its currency: the quoter makes its cart out to it. */
  payer?: (currency?: string) => { webId: string; url: string } | undefined;
  actor: string;
  webId: string;
  id: Identity;
  card: AgentCard;
  sandbox: boolean;
  trust: () => Trust;
  links: () => LakeLinks | null;
  nodes: string[];
  records: { pack: LakePack; paths: RecordPaths }[];
  claims: (fields: string[]) => Promise<Claim[]>;
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  verifyRecord: (fields: string[]) => Promise<{ ok: true } | { ok: false; why: string; transient?: boolean }>;
  emit: (e: LakeEvent) => void;
  say: (msg: string) => void;
}

export class Market {
  readonly intents = new Map<string, Intent>();
  readonly offers = new Map<string, StoredOffer>();
  /** Who carries an authorisation, as last checked: a yes is kept; a no is asked again later; a failed ask isn't kept at all. */
  private authorised = new Map<string, { ok: Promise<boolean>; until: number }>();
  /** The certified programs behind open offers, so a growing group can be re-priced here without asking anyone. */
  private programs = new Map<string, QuoteProgram>();
  /** Per open intent: who was told, who got no offer in and why (by card URL), and what the owner was already told. */
  private heard = new Map<string, { told: Set<string>; away: Map<string, TurnedAway & { telling?: true }>; said: Set<string> }>();
  private refreshedAt = 0;
  private announcedAt = 0;

  constructor(private c: Ctx) {
    // Groups grow. Every so often, check; a busy pod or an unreachable node just means next time.
    setInterval(() => void this.refresh().catch((e) => this.c.say(`market refresh: ${(e as Error).message}`)), 10_000).unref();
  }

  /**
   * Learn the current group sizes. When a group has changed, run the programs this house already holds again
   * with the new size: the group discount is part of each certified program, so nobody needs to be asked again.
   */
  async refresh() {
    this.refreshedAt = Date.now();
    // An accepted intent counts in its group for a day, then goes.
    const done = [...this.intents.values()].filter((i) => i.acceptedAt && Date.now() - Date.parse(i.acceptedAt) > COUNTS_AFTER_ACCEPT_MS);
    for (const i of done) this.intents.delete(i.pack);
    if (done.length) await this.save();
    const before = new Map([...this.intents.values()].map((i) => [i.pack, i.members]));
    await this.publish();
    for (const i of this.intents.values()) {
      if (!open(i) || i.members === before.get(i.pack)) continue;
      await this.save();
      await this.reprice(i);
    }
    // An authorised agent that hasn't priced an open intent hears about it again, about once a minute: one lost message
    // mustn't leave the owner without its offer. One that has an open offer here isn't asked again (it would replace it).
    if (Date.now() - this.announcedAt > 60_000 && this.intents.size) {
      this.announcedAt = Date.now();
      for (const i of [...this.intents.values()].filter(open)) {
        const p = packOf(i.pack);
        if (p) void this.announce(p, i, new Set([...this.offers.values()].filter((o) => o.pack === i.pack && o.status === 'open').map((o) => o.quoter.url)));
      }
    }
  }

  private async reprice(intent: Intent) {
    for (const offer of this.offers.values()) {
      const p = this.programs.get(offer.id);
      if (!p || offer.pack !== intent.pack || offer.status !== 'open' || offer.groupSize === intent.members) continue;
      offer.result = runProgram(p, await this.c.claims(p.inputs), { ...intent.terms, [GROUP_SIZE]: intent.members });
      offer.groupSize = intent.members;
      offer.at = new Date().toISOString();
      await this.c.write(`offers/${offer.id}.json`, JSON.stringify(offer));
    }
  }

  /**
   * Open (or replace) an intent. `auto` terms are worked out here, from the owner's own claims. It opens even when this
   * house's record can't price it (the owner may be fixing it), but says so at once rather than leave an empty board.
   */
  async open(id: string, terms: Record<string, string | number>): Promise<Intent & { warning?: string }> {
    const p = packOf(id);
    if (!p?.intent) throw new Error(`no pack here takes intents called ${id}`);
    const resolved = { ...terms };
    if (Object.values(resolved).includes('auto') && p.intent.auto) {
      const auto = p.intent.auto(await this.c.claims(Object.keys(p.fields)));
      for (const [k, x] of Object.entries(resolved)) if (x === 'auto' && auto[k] !== undefined) resolved[k] = auto[k]!;
    }
    for (const [k, spec] of Object.entries(p.intent.terms)) {
      if (resolved[k] === undefined) continue;
      if (!spec.options.map(String).includes(String(resolved[k]))) throw new Error(`${k}: pick one of ${spec.options.join(', ')}`);
    }
    for (const k of Object.keys(resolved)) if (!p.intent.terms[k]) delete resolved[k];
    const group = p.intent.groupBy.map((k) => `${k}=${resolved[k] ?? 'any'}`).join(';');
    const intent: Intent = { pack: packId(p), terms: resolved, group, members: 1, openedAt: new Date().toISOString() };
    this.intents.set(intent.pack, intent);
    this.heard.delete(intent.pack);
    await this.publish();
    await this.save();
    void this.announce(p, intent);
    const warning = await this.recordWarning(intent.pack);
    if (warning) this.c.say(`market: ${intent.pack}: ${warning}`);
    return warning ? { ...intent, warning } : intent;
  }

  /** What the owner and their assistant see next to an open intent while it waits for offers. */
  async status(pack: string): Promise<IntentStatus> {
    const h = this.heard.get(pack);
    const warning = await this.recordWarning(pack);
    return {
      agentsTold: h?.told.size ?? 0,
      turnedAway: [...(h?.away.values() ?? [])].reverse().map(({ telling: _, ...t }) => t),
      ...(warning ? { warning } : {}),
    };
  }

  /** A busy pod is no reason to alarm anyone: only a record that is missing or fails its checks gets a warning. */
  private async recordWarning(pack: string): Promise<string | undefined> {
    const p = packOf(pack);
    const chain = p ? await this.c.verifyRecord(Object.keys(p.fields)) : null;
    if (!chain || chain.ok || chain.transient) return undefined;
    return `offers can't be priced until this house's record is fixed: ${chain.why}`;
  }

  private track(pack: string) {
    let h = this.heard.get(pack);
    if (!h) this.heard.set(pack, (h = { told: new Set(), away: new Map(), said: new Set() }));
    return h;
  }

  /** The latest reason per agent, oldest dropped first. `telling`: it never got as far as quoting (it wasn't told). */
  private turnAway(pack: string, url: string, t: Omit<TurnedAway, 'at'>, telling?: true) {
    if (!this.intents.has(pack)) return;
    const away = this.track(pack).away;
    away.delete(url);
    away.set(url, { ...t, at: new Date().toISOString(), ...(telling ? { telling } : {}) });
    for (const k of away.keys()) if (away.size > TURNED_AWAY_KEPT) away.delete(k);
  }

  async close(id: string) {
    const p = packOf(id);
    if (p) {
      this.intents.delete(packId(p));
      this.heard.delete(packId(p));
    }
    await this.publish();
    await this.save();
  }

  /** The house is someone else's now: the last owner's intents and offers were theirs, not the next owner's (run 28). */
  async reset() {
    this.intents.clear();
    this.offers.clear();
    this.programs.clear();
    this.heard.clear();
    await this.publish();
    await this.save();
  }

  /** Tell the nodes (who keep it privately) and learn how big each group is. */
  private async publish() {
    const groups = await this.c.links()?.intents([...this.intents.values()].map((i) => ({ pack: i.pack, group: i.group })));
    for (const g of groups ?? []) {
      const i = this.intents.get(g.pack);
      if (i && i.group === g.group) i.members = g.members;
    }
  }

  /** Every authorised agent that quotes for this pack hears about the intent; an unauthorised one never does. */
  private async announce(p: LakePack, intent: Intent, skip = new Set<string>()) {
    const seen = new Set<string>(skip);
    for (const node of this.c.nodes) {
      let found: { card: AgentCard }[] = [];
      try {
        found = (await (await fetch(`${node}/cards?skill=${p.id}-quote`, { signal: AbortSignal.timeout(5000) })).json()) as { card: AgentCard }[];
      } catch {
        continue;
      }
      await Promise.all(found.map(async ({ card }) => {
        const url = card.supportedInterfaces?.[0]?.url;
        if (!url || seen.has(url)) return;
        seen.add(url);
        let profile: LakeProfile | undefined;
        try {
          profile = await verifyLakeCard(card);
          if (!(await this.isAuthorised(url, profile, intent.pack))) {
            return this.turnAway(intent.pack, url, { agent: card.name, domain: profile.ownerDomain, code: 'unauthorised', why: 'carries no authorisation for this from a regulator my owner trusts, so it was not told' }, true);
          }
          await this.send(url, { kind: 'intent', pack: intent.pack, terms: intent.terms, group: intent.group, members: intent.members });
          const h = this.track(intent.pack);
          h.told.add(url);
          // Told now: an older "couldn't tell it" is no longer true. A refused quote stays until it quotes again.
          if (h.away.get(url)?.telling) h.away.delete(url);
        } catch (e) {
          // An agent that's down or misbehaving just doesn't hear about it; the owner can see that it didn't.
          this.turnAway(intent.pack, url, { agent: card.name, domain: profile?.ownerDomain, code: profile ? 'unreachable' : 'bad-card', why: (e as Error).message.slice(0, 120) }, true);
        }
      }));
    }
  }

  /**
   * An agent must carry an authorisation for this pack from a regulator the owner trusts. A yes is remembered for the day;
   * a no for ten minutes; an ask that failed (the agent busy or down) not at all. Remembering a failed ask for good left
   * every sandbox house deaf to every grocer after one overloaded start (run 28: no offers at all).
   */
  private isAuthorised(url: string, profile: LakeProfile, pack: string): Promise<boolean> {
    const key = `${profile.webId}|${pack}`;
    const known = this.authorised.get(key);
    if (known && known.until > Date.now()) return known.ok;
    const ok = (async () => {
      const r = await this.send(url, { kind: 'authorisation', pack }).catch((e: Error) => {
        this.authorised.delete(key);
        this.c.say(`market: couldn't ask ${profile.ownerDomain} for its authorisation (${e.message.slice(0, 80)}); will ask again`);
        // Not a no: it couldn't be asked, which the owner sees as unreachable.
        throw new Error(`couldn't ask it for its authorisation: ${e.message.slice(0, 80)}`);
      });
      const check = r.authorisation ? await checkAttachment(r.authorisation as Attachment, { trusted: this.c.trust().regulators, type: 'LakeAuthorisation', subject: profile.webId, sandbox: this.c.sandbox }) : null;
      const yes = !!check?.ok && check.vc.credentialSubject.pack === pack;
      this.authorised.set(key, { ok: Promise.resolve(yes), until: Date.now() + (yes ? 86_400_000 : 600_000) });
      return yes;
    })();
    this.authorised.set(key, { ok, until: Date.now() + 60_000 });
    return ok;
  }

  /** A quote: check who sent it and that the program is certified, run it here, keep the result for the owner. */
  async quote(q: { program: QuoteProgram; certificate?: Attachment; authorisation?: Attachment; fee?: number; currency?: string }, profile: LakeProfile, card: AgentCard): Promise<Record<string, unknown>> {
    const p = q.program;
    const intent = p ? this.intents.get(p.pack) : undefined;
    if (intent?.acceptedAt) return { kind: 'rejected', code: 'no-intent', why: 'my owner has accepted an offer already' };
    if (!intent) return { kind: 'rejected', code: 'no-intent', why: 'my owner is not looking for that right now' };
    const url = card.supportedInterfaces[0]!.url;
    // The agent hears why; so does the owner, next to the intent: it's why their board is empty. A stranger this house
    // never told, quoting without an authorisation, isn't why, and mustn't crowd out the agents that are.
    const refuse = (code: string, why: string) => {
      if (code !== 'unauthorised' || this.heard.get(p.pack)?.told.has(url)) this.turnAway(p.pack, url, { agent: card.name, domain: profile.ownerDomain, code, why });
      return { kind: 'rejected', code, why };
    };
    const authorised = await checkAttachment(q.authorisation, { trusted: this.c.trust().regulators, type: 'LakeAuthorisation', subject: profile.webId, sandbox: this.c.sandbox });
    if (!authorised.ok || authorised.vc.credentialSubject.pack !== p.pack) return refuse('unauthorised', `no authorisation from a regulator my owner trusts${authorised.ok ? '' : `: ${authorised.why}`}`);
    const certified = await checkAttachment(q.certificate, { trusted: this.c.trust().auditors, type: 'LakeProgramCertificate', subject: programId(p), sandbox: this.c.sandbox });
    const audit = auditProgram(p);
    // A program without a valid certificate never runs here (SPEC §12).
    if (!certified.ok || !audit.ok) return refuse('uncertified', certified.ok ? audit.problems.join('; ') : certified.why);
    const chain = await this.c.verifyRecord(p.inputs);
    if (!chain.ok) {
      // The house's own problem, not the agent's: said once per intent and reason, not each time an agent tries again.
      const h = this.track(p.pack);
      if (!h.said.has(chain.why)) {
        h.said.add(chain.why);
        this.c.say(`market: ${p.pack}: turning quotes away (${h.told.size} agent(s) told): my record isn't usable (${chain.why})`);
      }
      return refuse('no-record', `my record isn't usable right now (${chain.why})`);
    }
    if (Date.now() - this.refreshedAt > 5_000) await this.refresh();

    const result = runProgram(p, await this.c.claims(p.inputs), { ...intent.terms, [GROUP_SIZE]: intent.members });
    const offer: StoredOffer = {
      id: randomUUID(), pack: p.pack, quoter: { name: card.name, domain: profile.ownerDomain, webId: profile.webId, url },
      title: p.title, program: programId(p), result, labels: p.labels, fee: typeof q.fee === 'number' ? q.fee : undefined,
      currency: typeof q.currency === 'string' && /^[A-Z]{3}$/.test(q.currency) ? q.currency : undefined, groupSize: intent.members, at: new Date().toISOString(), status: 'open',
    };
    // A newer quote from the same agent replaces its open one; accepted ones stay.
    for (const [k, old] of this.offers) if (old.pack === offer.pack && old.quoter.webId === offer.quoter.webId && old.status === 'open') { this.offers.delete(k); this.programs.delete(k); }
    this.offers.set(offer.id, offer);
    this.programs.set(offer.id, p);
    this.heard.get(p.pack)?.away.delete(url);
    await this.c.write(`offers/${offer.id}.json`, JSON.stringify(offer));
    this.c.emit(makeEvent('quote.made', this.c.actor, `agent:${profile.ownerDomain}`, { pack: p.pack }));
    // The same answer whatever the result: the agent learns nothing until the owner accepts.
    return { kind: 'quoted', ref: offer.id };
  }

  /** What accepting an offer costs the owner, where its program names a price output, in the offer's currency. */
  priceOf(offerId: string): { amount: number; currency: string } | undefined {
    const offer = this.offers.get(offerId);
    const p = this.programs.get(offerId);
    const amount = p?.price ? offer?.result.outputs?.[p.price] : undefined;
    return offer && typeof amount === 'number' ? { amount, currency: offer.currency ?? 'USD' } : undefined;
  }

  /** The owner tapped Accept: send that one agent the files the pack names, and nothing else. */
  async accept(offerId: string): Promise<StoredOffer> {
    const offer = this.offers.get(offerId);
    if (!offer) throw new Error('no such offer');
    if (offer.status !== 'open' || !offer.result.eligible) throw new Error('that offer is not open');
    const rec = this.c.records.find((r) => packId(r.pack) === offer.pack);
    if (!rec) throw new Error(`no ${offer.pack} record here`);
    const release: Record<string, unknown> = {};
    for (const f of rec.pack.release ?? []) if (f !== 'claims') release[f] = await this.c.read(rec.paths[f]);
    // Only the named facts, when that's all the pack sends: a shopping list, not the receipts behind it.
    if (rec.pack.release?.includes('claims')) release.claims = await this.c.claims(rec.pack.releaseFields ?? []);
    else release.issuer = JSON.parse(await this.c.read(rec.paths.issuer));
    // The terms the offer was priced on, group size included, so the agent checks the same offer the owner saw.
    const terms = { ...(this.intents.get(offer.pack)?.terms ?? {}), [GROUP_SIZE]: offer.groupSize };
    // Who pays (run 66: shops were paid outright): the quoter may answer with a cart made out to this assistant, held until
    // delivery.
    const payer = this.c.payer?.(this.priceOf(offerId)?.currency);
    const answer = await this.send(offer.quoter.url, { kind: 'accept', ref: offer.id, terms, release, ...(payer ? { payer } : {}) });
    offer.status = 'accepted';
    offer.answer = answer;
    await this.c.write(`offers/${offer.id}.json`, JSON.stringify(offer));
    const released = (rec.pack.release ?? []).length;
    await this.c.write(`audit/${Date.now()}-accept.json`, JSON.stringify({ at: new Date().toISOString(), offer: offer.id, to: offer.quoter.webId, released: (rec.pack.release ?? []).map((f) => (f === 'claims' ? `claims: ${(rec.pack.releaseFields ?? []).join(', ')}` : rec.paths[f])), consent: 'owner, live', recordsOut: 0 }));
    this.c.emit(makeEvent('offer.accepted', this.c.actor, `agent:${offer.quoter.domain}`, { pack: offer.pack, released }));
    // Found what they were looking for: stop asking (run 28's grocers quoted the same household again within minutes),
    // but still count in the group for a day, so a neighbour who decides later gets the street's price too.
    const i = this.intents.get(offer.pack);
    if (i) { i.acceptedAt = new Date().toISOString(); this.heard.delete(offer.pack); await this.save(); await this.publish(); }
    return offer;
  }

  /**
   * The owner's assistant paid under their allowance: file the payments agent's receipt with the owner's money (as spent),
   * and mark the order it names paid. Only a receipt from a payments agent the owner trusts, made out by this assistant,
   * under this very allowance, counts (run 24: two orders were paid and the house never knew).
   */
  async spent(att: { credential?: string; card?: AgentCard }, allowanceDigest: string, payerWebId: string): Promise<{ filed: string; offer?: string }> {
    if (!att?.credential || !att.card) throw new Error('send the receipt as { credential, card }');
    const signer = await verifyLakeCard(att.card);
    if (!this.c.trust().payments.includes(signer.ownerDomain)) throw new Error(`${signer.ownerDomain} is not a payments agent this house trusts`);
    const vc = await verifyCredential(att.credential, signer.publicJwk);
    const s = vc.credentialSubject as unknown as { amount: { currency?: string; value: number }; payer?: string; intentMandate?: string; agreement?: string; settlementId?: string };
    if (!vc.type.includes('LakeReceipt') || s.payer !== payerWebId || s.intentMandate !== allowanceDigest) throw new Error('not a receipt for a payment this assistant made under your human\'s allowance');
    const filed = `receipts/spent-${(s.settlementId ?? randomUUID()).replace(/[^a-zA-Z0-9-]/g, '')}.receipt.jwt`;
    await this.c.write(filed, att.credential);
    const ref = /^urn:(?:lake:order|ap2:cart):(.+)$/.exec(s.agreement ?? '')?.[1];
    const offer = ref ? this.offers.get(ref) : undefined;
    if (offer?.status === 'accepted') {
      offer.status = 'paid';
      offer.paid = { amount: s.amount.value, currency: s.amount.currency ?? 'USD', at: new Date().toISOString() };
      await this.c.write(`offers/${offer.id}.json`, JSON.stringify(offer));
    }
    return { filed, ...(offer ? { offer: offer.id } : {}) };
  }

  /** Signed request from this house to an agent; its signed, verified reply. */
  private async send(url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const envelope = await signMessage(payload, this.c.id, { iss: this.c.webId });
    const reply = await sendLake(url, { lake: '0.1', card: this.c.card, envelope: envelope as LakeData['envelope'] }, { me: this.c.id, timeoutMs: 15_000 });
    const v = await verifyLakeData<Record<string, unknown>>(reply as LakeData<Record<string, unknown>>, { sandbox: this.c.sandbox });
    if (!v.ok) throw new Error(v.rejection.why);
    return v.payload;
  }

  private async save() {
    await this.c.write('offers/intents.json', JSON.stringify([...this.intents.values()]));
  }

  /** After a restart, or once the house has joined: tell the nodes and the agents again. */
  async resume() {
    await this.publish();
    for (const i of [...this.intents.values()].filter(open)) {
      const p = packOf(i.pack);
      if (p) void this.announce(p, i);
    }
  }

  /** After a restart: the owner's open intents and offers are in the pod. */
  async load() {
    try {
      for (const i of JSON.parse(await this.c.read('offers/intents.json')) as Intent[]) this.intents.set(i.pack, i);
    } catch {
      // none yet
    }
  }
}
