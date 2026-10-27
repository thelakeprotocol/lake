import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import {
  allowanceDraft, availabilityProblems, consentRecord, freeSlots, parseRules, digestSRI, isCurrency, makeEvent, PURPOSES, readAccessGrant, ReplayGuard, statusEntry, STATUS_LIST_LENGTH, verifyCredential, verifyMessage,
  type AgentCard, type Availability, type JWK, type LakeEvent, type Signed, type Study,
} from '@thelakeprotocol/core';

/** When the owner was last at their desk, as a visitor waiting on an ask hears it: a bucket, never a time (SPEC §5). */
export type OwnerActive = 'within the hour' | 'today' | 'this week' | 'not this week' | 'no owner';

/** An offer the rules couldn't settle: waiting for the owner's tap. */
export interface PendingRequest {
  id: string;
  offerId: string;
  visitor: { webId: string; domain: string; name: string };
  purpose: string;
  fields: string[];
  retention: string;
  priceUsd: number;
  study: string | null;
  question?: string;
  /** What to look at twice: identifying or unknown fields, keeping data for years (SPEC §5). */
  warnings?: string[];
  /** The visitor's own note to the owner: their words, unchecked, shown quoted and never read by the rules. */
  note?: string;
  /** How many times the same agent has asked exactly this; one request, however many knocks. */
  asked?: number;
  /** Its earlier requests for the same purpose that this one replaced (withdrawn, not stacked). */
  replaces?: string[];
  recommendation: string;
  /** The grant the owner's device signs to allow it: a Solid Access Grant drafted by the house, dated and signed on the device. */
  grantDraft?: unknown;
  requestedAt: string;
  status: 'pending' | 'allowed' | 'denied';
  grant?: string;
}

/** The control panel's view of a house. Every call is signed by the owner's key. */
export interface PanelProvider {
  overview(tzOffset?: number): Promise<unknown>;
  rules(): Promise<{ text: string; rules: unknown }>;
  setRules(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The house's door (SPEC §9.0): open or not, its line, the address to give out, and its A2A address. */
  door?(): { open: boolean; about?: string; name?: string; address: string; a2a: string };
  /** Opens or closes it, written into the owner's rules like any other setting. */
  setDoor?(d: { open: boolean; about?: string; name?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  availability?(): Availability | null;
  setAvailability?(a: Availability | null): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Newest first; with `since` (a seq from an earlier look, or a time), only what came after it. */
  activity(since?: number | string): { seq: number }[];
  agents(): unknown[];
  money(): Promise<unknown>;
  /** The owner's consent records (one beside each agreement), newest first, each with where it stands now. */
  consents(): Promise<unknown>;
  data(): Promise<unknown>;
  exportAll(): Promise<unknown>;
  /** What the owner is looking for, and the offers priced for them in this house. */
  market(): Promise<unknown>;
  openIntent(pack: string, terms: Record<string, string | number>): Promise<unknown>;
  closeIntent(pack: string): Promise<unknown>;
  acceptOffer(id: string): Promise<unknown>;
  /** What accepting an offer costs, where its program names a price. */
  offerPrice?(id: string): { amount: number; currency: string } | undefined;
  /** One person, one house (SPEC §6.4): ask the person checker for a stamp, with the owner's signed consent. */
  requestPersonhood(consent: unknown, ownerJwk: JWK): Promise<unknown>;
  /** Sign a pledge on a blind tally, from this house, with its person stamp. */
  signPledge(tally: string, id: string): Promise<unknown>;
  /** Reveal this house on a blind pledge that has filled. */
  revealPledge(tally: string, id: string): Promise<unknown>;
}

export interface GrantRecord {
  id: string;
  jws: string;
  visitor: string;
  fields: string[];
  purpose: string;
  until: string;
  authorizedBy: string;
  revoked: boolean;
  /** Used up: a single-use key whose one use has happened. */
  spent?: boolean;
}

const MAX_GRANT_MS = 48 * 3_600_000;

/**
 * Your own AI agent, inside your house: a second key the owner hands out from the panel. It may look (requests,
 * offers, activity, data, rules) and suggest; it may never Allow, change rules, accept, revoke or export. Only
 * the owner's key cuts keys.
 */
export interface AssistantKey { kid: string; jwk: JWK; label: string; addedAt: string; /** Its Lake WebID, for an allowance to name. */ webId?: string; /** Its A2A endpoint: where the house tells it what its human decided. */ url?: string }
/** What the owner lets one assistant spend for them (SPEC §6.2): their signed AP2 Intent Mandate, with its bit on the status list. */
export interface Allowance { kid: string; credential: string; statusId: string; amount: number; currency: string; until: string; at: string }
/** A note from an assistant to its human; it may point at a waiting request or at an offer to accept. */
export interface Suggestion {
  id: string; from: string; text: string; request?: string; offer?: string; /** A pledge to sign: the owner's panel puts a Sign button on the note. */ pledge?: { tally: string; id: string };
  /** A note at the door it is about; mute: the assistant proposes not hearing from its sender again (the owner's tap). */
  note?: string;
  mute?: boolean;
  /** What the assistant advises on the request, offer or pledge it names, as a field: nobody (no panel, no bot) reads it out of the words (run 39). */
  advice?: Advice;
  /** A question for the owner, with the choices to tap (a neighbour's favour, say); the house tells the assistant the answer. */
  ask?: { choices: string[]; recommend?: number; answered?: string };
  /** The owner's own words back to the assistant. */
  reply?: string;
  /** New rules (the whole text) the assistant proposes: the owner's panel shows an Apply button. */
  rules?: string;
  /** A new line for the door (run 47: "plants free, sofa gone" took a whole rules file): an Apply tap, the rest kept. */
  door?: { about: string };
  at: string;
}
export const ADVICE = ['do', 'dont', 'your_call'] as const;
/**
 * Something the owner agreed to, in their agenda. Who agreed on the other side is what it rests on (run 47: a visitor's
 * agent wrote "Sam confirms" without asking Sam): `agreed` is their signed message, as the assistant's connector checked
 * it, and whether that agent showed it speaks for a house; without it the entry is only proposed (iCalendar: TENTATIVE).
 */
export interface AgendaItem {
  id: string; what: string; when: string; /** When it starts, for the owner's calendar. */ start?: string; where?: string; with?: string;
  /** The assistant's own words to the owner about it ("I assumed your first week starts Monday"). */ note?: string;
  agreed?: { by: string; domain: string; said: string; at: string; speaks_for?: { house: string; checked: boolean } };
  by: string; at: string;
}
/** Who left a note: as its card says, whether its domain is proved, and whether the house it says it speaks for says so. */
export interface NoteSender { name: string; domain: string; webId: string; url?: string; checked: boolean; /** Its key id: what a mute holds. */ key?: string; speaks_for?: { house: string; checked: boolean; why?: string } }
export type Advice = (typeof ADVICE)[number];
const ASSISTANT_MAY = new Set(['list', 'panel.overview', 'panel.rules', 'panel.activity', 'panel.agents', 'panel.money', 'panel.consents', 'panel.data', 'panel.market', 'assistant.suggest', 'assistant.allowance', 'assistant.spent', 'assistant.badge', 'assistant.forward', 'assistant.agenda', 'panel.free']);
// Play money on a sandbox (in whichever currency); a real Lake would take the cap from the owner's own settings.
const MAX_ALLOWANCE = 500;
const MAX_ALLOWANCE_DAYS = 31;

/**
 * The owner's side of the house. The owner's key is made on their own device and never leaves it;
 * the house only ever holds its public half. Live Allow is the one path that mints a grant outside a
 * standing rule, and the grant it mints is signed by the owner, not the housekeeper.
 */
export class OwnerDesk {
  ownerJwk: JWK | null = null;
  readonly pending = new Map<string, PendingRequest>();
  readonly grants = new Map<string, GrantRecord>();
  private replay = new ReplayGuard();
  private token = '';
  private operatorToken = '';
  readonly assistants = new Map<string, AssistantKey>();
  private invites = new Map<string, { label: string; until: number }>();
  suggestions: Suggestion[] = [];
  /** When the owner's own key last called the desk (the panel polls while open; answers come through it too). */
  private ownerSeen = 0;
  private ownerSeenSaved = 0;

  constructor(
    private o: {
      dataDir: string;
      webId: string;
      actor: string;
      openPairing: boolean;
      emit: (e: LakeEvent) => void;
      readOwnerKey: () => Promise<JWK | null>;
      /** What the control panel shows and changes, beyond requests and keys. */
      panel?: PanelProvider;
      saveOwnerKey: (jwk: JWK) => Promise<void>;
      writeGrant: (id: string, jws: string) => Promise<void>;
      /** The consent record beside an agreement (ISO/IEC TS 27560 in DPV terms): written on Allow, marked withdrawn on revoke. */
      writeConsent?: (id: string, record: Record<string, unknown>) => Promise<void>;
      withdrawConsent?: (id: string, at: string) => Promise<void>;
      saveRevoked: (ids: string[]) => Promise<void>;
      loadRevoked: () => Promise<string[]>;
      /** Each key's bit on the house's public status list (SPEC §6), kept with the agreements. */
      saveStatus?: (indexes: Record<string, number>) => Promise<void>;
      /** Spending allowances the owner signed for their assistants, kept in the wallet. */
      saveAllowances?: (a: Allowance[]) => Promise<void>;
      loadAllowances?: () => Promise<Allowance[]>;
      /** The house's word that a key is its owner's (for a payments agent), its card, and its status list's address. */
      vouchOwner?: (ownerJwk: JWK) => Promise<string>;
      /** The house's word that a paired assistant may sell for it (a LakeAssistantKey), with its bit on the status list. */
      vouchAssistant?: (a: { webId: string; jwk: JWK }, status: unknown) => Promise<string>;
      card?: () => AgentCard;
      statusUrl?: () => string;
      loadStatus?: () => Promise<Record<string, number>>;
      /**
       * Sandbox houses anyone can claim: a claim is a lease, not a deed. When it ends (or the owner hands
       * the house back), every key is revoked, the house forgets its owner, and `onRelease` resets it.
       */
      leaseHours?: number;
      clearOwnerKey?: () => Promise<void>;
      onRelease?: () => Promise<void>;
      /** Where the owner's assistant keys are kept (the pod's wallet). */
      saveAssistants?: (keys: AssistantKey[]) => Promise<void>;
      loadAssistants?: () => Promise<AssistantKey[]>;
      /** Sends a signed message from the house to an agent (an assistant's inbox). */
      tell?: (url: string, payload: Record<string, unknown>) => Promise<void>;
      /** The offers priced for the owner, to check an assistant's note names a real one. */
      offerIds?: () => string[];
      /** Files a receipt for what an assistant paid under the owner's allowance, and marks the order it names paid. */
      spent?: (receipt: { credential?: string; card?: AgentCard }, allowanceDigest: string, payerWebId: string) => Promise<{ filed: string; offer?: string }>;
    },
  ) {}

  /** When the current owner's lease ends, if this house is leased. */
  /** When the current owner claimed a leased house: what they see starts there, not with the last owner's. */
  claimedAt(): number | null {
    return (this.ownerJwk as (JWK & { claimedAt?: number }) | null)?.claimedAt ?? null;
  }

  leaseUntil(): Date | null {
    const at = (this.ownerJwk as (JWK & { claimedAt?: number }) | null)?.claimedAt;
    return this.o.leaseHours && at ? new Date(at + this.o.leaseHours * 3_600_000) : null;
  }

  /** Whether anyone is likely to look at a parked request: coarse, so a visitor can't learn the owner's habits. */
  ownerActive(now = Date.now()): OwnerActive {
    if (!this.ownerJwk) return 'no owner';
    const ago = now - this.ownerSeen;
    return ago < 3_600_000 ? 'within the hour' : ago < 86_400_000 ? 'today' : ago < 7 * 86_400_000 ? 'this week' : 'not this week';
  }

  private seen() {
    this.ownerSeen = Date.now();
    // Kept across restarts, written at most every ten minutes: the finest bucket is an hour wide.
    if (this.ownerSeen - this.ownerSeenSaved < 600_000) return;
    this.ownerSeenSaved = this.ownerSeen;
    void writeFile(join(this.o.dataDir, 'owner-seen'), String(this.ownerSeen)).catch(() => {});
  }

  /** Back to nobody's: keys revoked, requests dropped, owner forgotten, house reset. Anyone can claim it again. */
  async release() {
    await this.revoke('all');
    this.pending.clear();
    this.assistants.clear();
    this.suggestions = [];
    // The last owner's notes, mutes and agenda were theirs: the next one starts with none, and a new calendar address.
    this.notes = [];
    this.closedNotes.clear();
    this.muted.clear();
    await writeFile(join(this.o.dataDir, 'muted.json'), '[]').catch(() => {});
    this.agenda = [];
    await this.saveAgenda();
    this.feedKey = await secret(join(this.o.dataDir, 'agenda-feed-key'), true);
    await this.o.saveAssistants?.([]);
    this.ownerJwk = null;
    this.ownerSeen = 0;
    await this.o.clearOwnerKey?.();
    this.token = await secret(join(this.o.dataDir, 'pairing-token'), true);
    await this.o.onRelease?.();
  }

  async init() {
    this.ownerJwk = await this.o.readOwnerKey();
    this.ownerSeen = this.ownerSeenSaved = Number(await readFile(join(this.o.dataDir, 'owner-seen'), 'utf8').catch(() => '')) || 0;
    for (const k of JSON.parse(await readFile(join(this.o.dataDir, 'muted.json'), 'utf8').catch(() => '[]')) as string[]) this.muted.add(k);
    this.agenda = JSON.parse(await readFile(join(this.o.dataDir, 'agenda.json'), 'utf8').catch(() => '[]'));
    this.feedKey = await secret(join(this.o.dataDir, 'agenda-feed-key'));
    if (this.o.leaseHours) {
      const check = () => { const until = this.leaseUntil(); if (until && until.getTime() <= Date.now()) void this.release(); };
      check();
      setInterval(check, 60_000).unref();
    }
    this.token = await secret(join(this.o.dataDir, 'pairing-token'));
    this.operatorToken = await secret(join(this.o.dataDir, 'operator-token'));
    for (const id of await this.o.loadRevoked()) this.revokedIds.add(id);
    for (const [id, i] of Object.entries((await this.o.loadStatus?.().catch(() => ({}))) ?? {})) this.statusIndexes.set(id, Number(i));
    for (const a of (await this.o.loadAssistants?.().catch(() => [])) ?? []) this.assistants.set(a.kid, a);
    // Allowances saved before they had a currency were in dollars.
    for (const a of (await this.o.loadAllowances?.().catch(() => [])) ?? []) this.allowances.set(a.kid, { ...a, amount: a.amount ?? (a as unknown as { amountUsd: number }).amountUsd, currency: a.currency ?? 'USD' });
    return { paired: !!this.ownerJwk, token: this.token };
  }

  private revokedIds = new Set<string>();
  readonly allowances = new Map<string, Allowance>();
  private allowanceDrafts = new Map<string, { kid: string; statusId: string; draft: Record<string, unknown> }>();
  private saveAllowances = () => this.o.saveAllowances?.([...this.allowances.values()]);
  /** An allowance still good: not taken back, not past its date. */
  allowanceFor(kid: string): Allowance | undefined {
    const a = this.allowances.get(kid);
    return a && !this.isRevoked(a.statusId) && Date.parse(a.until) > Date.now() ? a : undefined;
  }
  isRevoked(id: string) {
    return this.revokedIds.has(id) || !!this.grants.get(id)?.revoked;
  }

  /** Each key's bit on the house's public status list: a random place, so where it sits says nothing about it. */
  private statusIndexes = new Map<string, number>();
  async statusIndex(id: string): Promise<number> {
    let i = this.statusIndexes.get(id);
    if (i === undefined) {
      const used = new Set(this.statusIndexes.values());
      do i = randomInt(0, STATUS_LIST_LENGTH); while (used.has(i));
      this.statusIndexes.set(id, i);
      await this.o.saveStatus?.(Object.fromEntries(this.statusIndexes));
    }
    return i;
  }
  /** The bits to set: every key taken back or used up. */
  revokedIndexes(): number[] {
    return [...this.statusIndexes].filter(([id]) => this.isRevoked(id)).map(([, i]) => i);
  }

  record(g: Omit<GrantRecord, 'revoked'>) {
    this.grants.set(g.id, { ...g, revoked: this.revokedIds.has(g.id) });
  }

  /**
   * One request per ask: the same agent asking exactly the same thing again is the same request (asked twice), not a
   * new card for the owner. Returns the request on file, so the visitor gets its id to check or withdraw.
   */
  ask(r: Omit<PendingRequest, 'id' | 'status' | 'requestedAt'>): PendingRequest {
    const same = (x: PendingRequest) => x.status === 'pending' && x.visitor.webId === r.visitor.webId && x.purpose === r.purpose && x.retention === r.retention
      && x.priceUsd === r.priceUsd && x.study === r.study && [...x.fields].sort().join() === [...r.fields].sort().join();
    const known = [...this.pending.values()].find(same);
    if (known) {
      known.asked = (known.asked ?? 1) + 1;
      if (r.note) known.note = r.note;
      return known;
    }
    // The same visitor asking again for the same purpose, changed (a field more, another retention or price): the new one
    // replaces the old, which is withdrawn, not stacked beside it (run 44: three waiting requests for one field). Not edited
    // in place: the old one's grant draft and status bit are its own.
    const older = [...this.pending.values()].filter((x) => x.status === 'pending' && x.visitor.webId === r.visitor.webId && x.purpose === r.purpose && x.fields.some((f) => r.fields.includes(f)));
    for (const o of older) {
      this.pending.delete(o.id);
      this.news({ about: 'request.withdrawn', request: o.id, by: o.visitor.domain, note: `replaced by its newer request ${r.offerId}` });
    }
    const req: PendingRequest = { ...r, id: r.offerId, status: 'pending', requestedAt: new Date().toISOString(), ...(older.length ? { replaces: older.map((o) => o.id) } : {}) };
    this.pending.set(req.id, req);
    // The assistant hears of it as it waits (run 44: three requests sat two minutes, found only by polling), with the
    // house's own advice on it.
    this.news({ about: 'request.waiting', request: req.id, by: r.visitor.domain, purpose: r.purpose, fields: r.fields, retention: r.retention, price_usd: r.priceUsd, ...(r.recommendation ? { house_says: r.recommendation } : {}), ...(r.warnings?.length ? { warnings: r.warnings } : {}), note: 'waiting for your human\'s tap: suggest an answer (lake_house_suggest with request and advice) if you have one' });
    return req;
  }

  /** Requests waiting for the owner that ask for exactly these fields for this purpose, from anyone. */
  pendingLike(purpose: string, fields: string[]): PendingRequest[] {
    const key = [...fields].sort().join();
    return [...this.pending.values()].filter((x) => x.status === 'pending' && x.purpose === purpose && [...x.fields].sort().join() === key);
  }

  /** A visitor takes back its own request before the owner answers it. */
  withdraw(offerId: string, visitorWebId: string): boolean {
    const req = this.pending.get(offerId);
    if (!req || req.visitor.webId !== visitorWebId || req.status !== 'pending') return false;
    this.pending.delete(offerId);
    this.news({ about: 'request.withdrawn', request: offerId, by: req.visitor.domain, note: 'the visitor took its request back; your human won\'t be asked' });
    return true;
  }

  /**
   * Tells the owner's assistants what happened in the house that they'd otherwise only find by looking again: their
   * human decided, a visitor withdrew, an allowance changed. A signed message in each one's Lake inbox; best effort.
   */
  news(payload: Record<string, unknown>, onlyKid?: string) {
    if (!this.o.tell) return;
    for (const a of this.assistants.values()) {
      if (!a.url || (onlyKid && a.kid !== onlyKid)) continue;
      // A busy network loses a message now and then (run 24's assistant never heard of its allowance): try three times.
      const send = (left: number, wait: number): void => void this.o.tell!(a.url!, { kind: 'house.news', house: this.o.webId, ...payload })
        .catch(() => { if (left > 1) setTimeout(() => send(left - 1, wait * 4), wait).unref(); });
      send(3, 5_000);
    }
  }

  /** What one agent asked this house lately, any purpose: lets the owner see a visitor trying another label. */
  /**
   * Senders the owner doesn't want to hear from again, by key, not name (run 45: a pitch relabelled "contact" got past a
   * rule about marketing). Their notes and knocks are declined at the door.
   */
  readonly muted = new Set<string>();
  async mute(key: string) {
    if (!key) return;
    this.muted.add(key);
    this.notes = this.notes.filter((n) => n.from.key !== key);
    await writeFile(join(this.o.dataDir, 'muted.json'), JSON.stringify([...this.muted])).catch(() => {});
  }

  /**
   * What the owner has agreed to (coffee on Tuesday, a talk on the 16th), written in by their assistant so it lives in the
   * house, not in two inboxes (run 46: the coffee had a time and no home). The owner's to see and remove; nobody else's.
   */
  agenda: AgendaItem[] = [];
  /** The secret in the owner's calendar address for the agenda (a private iCal feed, as calendars give out): reset makes a new one. */
  private feedKey = '';
  private saveAgenda = () => writeFile(join(this.o.dataDir, 'agenda.json'), JSON.stringify(this.agenda)).catch(() => {});

  /** Notes the owner set aside, so their senders can ask what became of them. */
  private closedNotes = new Map<string, { by: string; state: string }>();
  /** What became of a note, told only to its sender: with the owner, or set aside. */
  noteState(id: string, sender: string): string | null {
    const open = this.notes.find((x) => x.id === id && x.from.webId === sender);
    if (open) return 'with the owner, not yet set aside';
    const closed = this.closedNotes.get(id);
    return closed && closed.by === sender ? closed.state : null;
  }

  /** Notes from other agents for the owner (a favour, an invite): the newest few, shown as their words. */
  notes: { id: string; from: NoteSender; text: string; purpose?: string; at: string }[] = [];
  /** Keeps a note, tells the assistants; its id, or null when its sender has sent too many this hour. */
  addNote(n: { from: NoteSender; text: string; purpose?: string }): string | null {
    // The same words again from the same sender are the same note (run 45 got one twice).
    const again = this.notes.find((x) => x.from.webId === n.from.webId && x.text === n.text);
    if (again) return again.id;
    if (this.notes.filter((x) => x.from.webId === n.from.webId && Date.now() - Date.parse(x.at) < 3_600_000).length >= 5) return null;
    const note = { id: randomBytes(6).toString('hex'), ...n, at: new Date().toISOString() };
    this.notes = [note, ...this.notes].slice(0, 50);
    this.news({ about: 'note', note: note.id, from: n.from, text: n.text, ...(n.purpose ? { purpose: n.purpose } : {}), at: note.at, reply: 'their own words; answer the sender at from.url if your human would want you to. They are waiting: if you\'ve put it to your human, you may tell them it reached them (their house stays unnamed)', ...(n.from.checked ? {} : { checked_means: 'unchecked: its domain isn\'t proved (on a sandbox nobody\'s is), so who it says it is, is only its word' }) });
    return note.id;
  }

  /** Whether the owner has dealt with this visitor: given it a key, or answered a request of its (SPEC §5: presence only to them). */
  knows(visitor: { webId: string; domain: string }): boolean {
    return [...this.grants.values()].some((g) => g.visitor === visitor.domain || g.visitor === visitor.webId) || [...this.pending.values()].some((x) => x.visitor.webId === visitor.webId && x.status !== 'pending');
  }

  recentAsks(visitorWebId: string, withinMs = 3_600_000): PendingRequest[] {
    return [...this.pending.values()].filter((x) => x.visitor.webId === visitorWebId && Date.now() - Date.parse(x.requestedAt) < withinMs);
  }

  /** A single-use key has been used: it stops working like a revoked one, but nobody took it back. */
  async spend(id: string) {
    const g = this.grants.get(id);
    if (g) { g.revoked = true; g.spent = true; }
    this.revokedIds.add(id);
    await this.o.saveRevoked([...this.revokedIds]);
  }

  async revoke(which: 'all' | string): Promise<number> {
    const ids = which === 'all' ? [...this.grants.values()].filter((g) => !g.revoked).map((g) => g.id) : [which];
    let n = 0;
    const at = new Date().toISOString();
    const withdrawn: Promise<void>[] = [];
    for (const id of ids) {
      const g = this.grants.get(id);
      // The consent record says it was taken back, and when. A key cut before a restart isn't in memory any more, but
      // its record is still in the pod, and still the owner's to withdraw (the panel's Consents list offers it).
      if (g ? !g.revoked : !this.revokedIds.has(id)) withdrawn.push(this.o.withdrawConsent?.(id, at).catch(() => {}) ?? Promise.resolve());
      if (g && !g.revoked) { g.revoked = true; n++; }
      this.revokedIds.add(id);
    }
    // Awaited, so the panel that asked sees the record withdrawn when it looks again.
    await Promise.all(withdrawn);
    await this.o.saveRevoked([...this.revokedIds]);
    if (n) this.o.emit(makeEvent('grant.revoked', this.o.actor, undefined, { count: n }));
    return n;
  }

  /**
   * A badge for a paired assistant's card (SPEC §6.5): the house's word that it may sell for this house, pinned to its
   * key, with its own bit on the status list, set when the owner takes the assistant's key back.
   */
  private async assistantBadge(a: AssistantKey): Promise<{ credential: string; issuer: string } | undefined> {
    const issuer = this.o.card?.().supportedInterfaces?.[0]?.url;
    if (!a.webId || !this.o.vouchAssistant || !this.o.statusUrl || !issuer) return undefined;
    const status = statusEntry(this.o.statusUrl(), await this.statusIndex(`assistant:${a.kid}`));
    return { credential: await this.o.vouchAssistant({ webId: a.webId, jwk: a.jwk }, status), issuer };
  }

  /** /owner: the approvals app (static) and its API. */
  router(appDir?: string): express.Router {
    const r = express.Router();
    r.use(express.json({ limit: '64kb' }));

    r.post('/pair', async (req, res) => {
      const { publicJwk, token } = req.body ?? {};
      if (!publicJwk?.x || publicJwk.crv !== 'Ed25519') return void res.status(400).json({ error: 'send an Ed25519 public key' });
      if (this.ownerJwk && this.ownerJwk.x === publicJwk.x) return void (this.seen(), res.json({ paired: true, webId: this.o.webId }));
      const firstCome = this.o.openPairing && !this.ownerJwk;
      if (!firstCome && token !== this.token) return void res.status(403).json({ error: this.ownerJwk ? 'this house already has an owner' : 'wrong or missing pairing token' });
      this.ownerJwk = { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid: String(publicJwk.kid ?? 'owner'), alg: 'EdDSA', ...(this.o.leaseHours ? { claimedAt: Date.now() } : {}) } as JWK;
      await this.o.saveOwnerKey(this.ownerJwk);
      this.token = await secret(join(this.o.dataDir, 'pairing-token'), true); // one use only
      this.seen();
      res.json({ paired: true, webId: this.o.webId, until: this.leaseUntil()?.toISOString() });
    });

    // The owner's assistant pairs with a one-time code the owner made in the panel; its key can look and suggest only.
    r.post('/assistant', async (req, res) => {
      const { publicJwk, code, label, webId, url } = req.body ?? {};
      if (!publicJwk?.x || publicJwk.crv !== 'Ed25519' || !publicJwk.kid) return void res.status(400).json({ error: 'send an Ed25519 public key with a kid' });
      const invite = this.invites.get(String(code ?? ''));
      if (!invite || invite.until < Date.now()) return void res.status(403).json({ error: 'wrong or expired code: ask your human for a new one' });
      this.invites.delete(String(code));
      const kid = String(publicJwk.kid);
      if (kid === this.ownerJwk?.kid) return void res.status(400).json({ error: 'that is the owner\'s own key' });
      const a: AssistantKey = { kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid, alg: 'EdDSA' } as JWK, label: String(label ?? invite.label).slice(0, 60), addedAt: new Date().toISOString(), ...(typeof webId === 'string' && /^https?:\/\//.test(webId) ? { webId: webId.slice(0, 300) } : {}), ...(typeof url === 'string' && /^https?:\/\//.test(url) ? { url: url.slice(0, 300) } : {}) };
      this.assistants.set(kid, a);
      await this.o.saveAssistants?.([...this.assistants.values()]);
      const badge = await this.assistantBadge(a).catch(() => undefined);
      res.json({ paired: true, role: 'assistant', webId: this.o.webId, may: [...ASSISTANT_MAY], may_means: 'what you may do in your human\'s control panel (look and suggest); the badge below is what others see: the house\'s word that you answer and sell for it', ...(badge ? { badge, badge_note: 'the house\'s word that you may sell for it: on your card, a cart you sign can name the house as payee, so what you earn is your human\'s' } : {}) });
    });

    // Public: is this house taken? (For the sandbox's list of houses to claim.)
    // The agenda as a private iCal feed (RFC 5545) for the owner's own calendar app: whoever has the address can read it,
    // as with any calendar's secret address, so only the owner's panel shows it.
    r.get('/agenda.ics', (req, res) => {
      if (!this.ownerJwk || !this.feedKey || String(req.query.key ?? '') !== this.feedKey) return void res.status(404).send('no such calendar');
      res.type('text/calendar').send(agendaIcs(this.agenda, this.o.webId));
    });
    r.get('/status', (_req, res) => void res.json({ claimed: !!this.ownerJwk, until: this.leaseUntil()?.toISOString() ?? null, leaseHours: this.o.leaseHours ?? null }));

    r.post('/api', async (req, res) => {
      if (!this.ownerJwk) return void res.status(409).json({ error: 'pair first' });
      let p: Signed<{ kind: string; request?: string; answer?: string; grant?: string; revoke?: string }>['payload'];
      let signer = '';
      try {
        p = await verifyMessage(req.body, async (kid) => { signer = kid; return kid === this.ownerJwk!.kid ? this.ownerJwk : this.assistants.get(kid)?.jwk ?? null; }, { replay: this.replay });
      } catch (e) {
        return void res.status(403).json({ error: (e as Error).message });
      }
      const assistant = signer !== this.ownerJwk.kid ? this.assistants.get(signer) : undefined;
      // The owner's own key only: an assistant reading the panel isn't the owner looking.
      if (!assistant) this.seen();
      if (assistant) {
        if (!ASSISTANT_MAY.has(p.kind)) return void res.status(403).json({ error: `an assistant may look and suggest; only your human's key can do ${p.kind}` });
        if (p.kind === 'assistant.suggest') {
          const q = p as unknown as { text?: string; request?: string; offer?: string; replaces?: string; pledge?: { tally?: string; id?: string }; advice?: string; ask?: { choices?: unknown; recommend?: unknown }; rules?: unknown };
          const text = String(q.text ?? '').trim().slice(0, 1500);
          // An assistant that got something wrong takes its own note back; an empty text with replaces just withdraws it.
          const old = q.replaces ? this.suggestions.find((x) => x.id === q.replaces && x.from === assistant.label) : undefined;
          if (q.replaces && !old) return void res.status(404).json({ error: 'no note of yours with that id' });
          // An answered question stays answered (run 41 asked the owner twice): ask a new one if something changed.
          if (old?.ask?.answered) return void res.status(409).json({ error: `your human already answered that: "${old.ask.answered}"` });
          if (old) this.suggestions = this.suggestions.filter((x) => x !== old);
          if (!text) return void (old ? res.json({ ok: true, withdrawn: old.id }) : res.status(400).json({ error: 'suggest something: text' }));
          // A note about a request must point at a real one: a unique prefix is enough, anything else is refused.
          let request: string | undefined;
          if (q.request) {
            const hits = [...this.pending.keys()].filter((k) => k === q.request || k.startsWith(String(q.request)));
            if (hits.length !== 1) return void res.status(404).json({ error: hits.length ? 'that matches several requests; give more of the id' : 'no waiting request with that id' });
            request = hits[0];
          }
          // Likewise an offer: the owner's panel puts an Accept button on the note, so it must be a real one.
          let offer: string | undefined;
          if (q.offer) {
            const hits = (this.o.offerIds?.() ?? []).filter((k) => k === q.offer || k.startsWith(String(q.offer)));
            if (hits.length !== 1) return void res.status(404).json({ error: hits.length ? 'that matches several offers; give more of the id' : 'no offer with that id (lake_house { view: "offers" })' });
            offer = hits[0];
          }
          // A pledge for the owner to sign: a street's "nobody goes first" plan needs the owner's own signature (run 34b and 38
          // had no way to put one in front of the owner). Signing stays the owner's tap, on the owner's key.
          let pledge: Suggestion['pledge'];
          if (q.pledge) {
            const tally = String(q.pledge.tally ?? '').replace(/\/a2a\/?$/, '').replace(/\/$/, '');
            if (!/^https?:\/\/\S+$/.test(tally) || !q.pledge.id) return void res.status(400).json({ error: 'pledge: { tally: the tally\'s address, id: the pledge\'s id }' });
            pledge = { tally, id: String(q.pledge.id).slice(0, 80) };
          }
          if (q.advice !== undefined && !ADVICE.includes(q.advice as Advice)) return void res.status(400).json({ error: `advice: one of ${ADVICE.join(', ')}` });
          // New rules for the owner to apply with a tap (run 45: they agreed to a change nobody could make): checked now, so
          // the Apply button never fails; applying stays the owner's key.
          let rules: string | undefined;
          if (q.rules !== undefined) {
            try { parseRules(String(q.rules)); rules = String(q.rules); } catch (e) { return void res.status(400).json({ error: `rules: ${(e as Error).message}` }); }
          }
          let door: Suggestion['door'];
          const d = (q as { door?: { about?: unknown } }).door;
          if (d !== undefined) {
            const about = typeof d?.about === 'string' ? d.about.trim() : '';
            if (!about || about.length > 200) return void res.status(400).json({ error: 'door: { about: the new line for your human\'s door, up to 200 characters }' });
            door = { about };
          }
          // Muting a sender is its own choice, never read from advice (run 46: an FYI marked "dont" muted the seller).
          const mute = (q as { mute?: unknown }).mute === true;
          // Or about a note at the door (run 42: "don't answer this one" had nowhere to go).
          const aboutNote = typeof (q as { note?: unknown }).note === 'string' ? this.notes.find((n) => n.id === (q as { note: string }).note)?.id : undefined;
          if ((q as { note?: unknown }).note !== undefined && !aboutNote) return void res.status(404).json({ error: 'no note at the door with that id' });
          if (q.advice !== undefined && !request && !offer && !pledge && !aboutNote && !rules && !door) return void res.status(400).json({ error: 'advice is about a request, an offer, a pledge, a note, rules or a door line: name it' });
          let ask: Suggestion['ask'];
          if (q.ask) {
            // Refused, not cut (run 40 stored "…return fa"): the assistant shortens its own words.
            const choices = Array.isArray(q.ask.choices) ? q.ask.choices.map((c) => String(c).trim()).filter(Boolean) : [];
            if (choices.length < 2 || choices.length > 4 || choices.some((c) => c.length > 80)) return void res.status(400).json({ error: 'ask: { choices: 2 to 4 answers of up to 80 characters, recommend?: the index of the one you advise }' });
            const r = Number(q.ask.recommend);
            // "Your call" means it (run 44: three "your call" questions each carried a recommended choice, and it was taken).
            // The recommendation is dropped, not the question refused (run 45: refused, the assistant reposted it as "do").
            ask = { choices, ...(q.advice !== 'your_call' && Number.isInteger(r) && r >= 0 && r < choices.length ? { recommend: r } : {}) };
          }
          const sug: Suggestion = { id: randomBytes(6).toString('hex'), from: assistant.label, text, ...(request ? { request } : {}), ...(offer ? { offer } : {}), ...(pledge ? { pledge } : {}), ...(aboutNote ? { note: aboutNote, ...(mute ? { mute: true } : {}) } : {}), ...(rules ? { rules } : {}), ...(door ? { door } : {}), ...(q.advice ? { advice: q.advice as Advice } : {}), ...(ask ? { ask } : {}), at: new Date().toISOString() };
          this.suggestions = [sug, ...this.suggestions].slice(0, 50);
          return void res.json({ ok: true, id: sug.id, ...(old ? { replaced: old.id } : {}), note: 'your human sees it in their control panel' });
        }
        if (p.kind === 'assistant.spent') {
          // The assistant hands back the receipt for what it spent: the owner sees it with their money, and the order turns paid.
          const a = this.allowanceFor(assistant.kid);
          if (!a || !assistant.webId || !this.o.spent) return void res.status(400).json({ error: 'you have no allowance from your human here' });
          try {
            return void res.json({ ok: true, ...(await this.o.spent((p as unknown as { receipt?: { credential?: string; card?: AgentCard } }).receipt ?? {}, digestSRI(a.credential), assistant.webId)) });
          } catch (e) {
            return void res.status(400).json({ error: (e as Error).message });
          }
        }
        if (p.kind === 'assistant.agenda') {
          const q = p as unknown as { what?: string; when?: string; start?: string; where?: string; with?: string; note?: string; agreed?: AgendaItem['agreed']; remove?: string };
          if (q.remove) { this.agenda = this.agenda.filter((x) => !(x.id === q.remove && x.by === assistant.label)); await this.saveAgenda(); return void res.json({ ok: true }); }
          const what = String(q.what ?? '').trim().slice(0, 200), when = String(q.when ?? '').trim().slice(0, 80);
          if (!what || !when) return void res.status(400).json({ error: 'agenda: { what, when, start?, where?, with? } (what was agreed, and when)' });
          const start = q.start ? new Date(String(q.start)) : undefined;
          if (start && Number.isNaN(start.getTime())) return void res.status(400).json({ error: 'agenda.start: a date and time (ISO 8601, with its offset), for your human\'s calendar' });
          const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
          const ag = q.agreed;
          const agreed = ag && typeof ag === 'object' ? { by: str(ag.by, 120), domain: str(ag.domain, 200), said: str(ag.said, 300), at: str(ag.at, 40), ...(ag.speaks_for ? { speaks_for: { house: str(ag.speaks_for.house, 300), checked: ag.speaks_for.checked === true } } : {}) } : undefined;
          const item: AgendaItem = { id: randomBytes(6).toString('hex'), what, when, ...(start ? { start: start.toISOString() } : {}), ...(q.where ? { where: str(q.where, 120) } : {}), ...(q.with ? { with: str(q.with, 120) } : {}), ...(q.note ? { note: str(q.note, 500) } : {}), ...(agreed ? { agreed } : {}), by: assistant.label, at: new Date().toISOString() };
          this.agenda = [...this.agenda, item].slice(-100);
          await this.saveAgenda();
          return void res.json({ ok: true, id: item.id, status: agreed ? `agreed: by ${agreed.by}${agreed.speaks_for?.checked ? `, which speaks for ${agreed.speaks_for.house}` : ', an agent that showed no house it speaks for'}` : 'proposed: nothing from their side says they agreed (name their message with agreed_in once they do)', note: 'in your human\'s agenda, in their house' });
        }
        if (p.kind === 'assistant.forward') {
          // Words for the owner that came to their assistant while it was away: shown as a note, the sender's words, marked
          // as passed on by the assistant (its connector, not its judgement).
          const q = p as unknown as { from?: { name?: string; domain?: string; webId?: string; url?: string }; text?: string };
          const text = String(q.text ?? '').trim().slice(0, 1000);
          if (!text || !q.from?.webId) return void res.status(400).json({ error: 'forward: { from: { name, domain, webId, url }, text }' });
          const id = this.addNote({ from: { name: `${String(q.from.name ?? '').slice(0, 80)} (to your assistant, while it was away)`, domain: String(q.from.domain ?? ''), webId: String(q.from.webId), ...(q.from.url ? { url: String(q.from.url) } : {}), checked: false }, text });
          return void res.json(id ? { ok: true, note: id } : { ok: false, error: 'a few notes an hour from one sender' });
        }
        if (p.kind === 'assistant.badge') {
          const badge = await this.assistantBadge(assistant);
          return void res.json(badge ? { badge } : { badge: null, why: 'this house can\'t vouch for you: pair again with your Lake WebID' });
        }
        if (p.kind === 'assistant.allowance') {
          // What this assistant may spend for its human: the owner's signed mandate, the house's card and its word for the
          // owner's key, so a payments agent can check the whole chain. The house signs no money itself.
          const a = this.allowanceFor(assistant.kid);
          if (!a || !this.o.vouchOwner || !this.o.card) return void res.json({ intent: null, why: 'your human has not given you an allowance (control panel: My agent → spending allowance)' });
          return void res.json({ intent: { credential: a.credential, card: this.o.card(), owner: await this.o.vouchOwner(this.ownerJwk!) }, amount: a.amount, currency: a.currency, until: a.until });
        }
      }
      if (p.kind === 'panel.assistant.invite') {
        // Fifteen minutes, one use: long enough to paste into a chat with your agent.
        const code = randomBytes(9).toString('base64url');
        this.invites.set(code, { label: String((p as unknown as { label?: string }).label ?? 'my assistant').slice(0, 60), until: Date.now() + 15 * 60_000 });
        return void res.json({ code, until: new Date(Date.now() + 15 * 60_000).toISOString() });
      }
      if (p.kind === 'panel.assistant.revoke') {
        const kid = String((p as unknown as { kid?: string }).kid ?? '');
        // Its badge goes with its key: the bit on the status list is set, so no payments agent pays the house through it.
        for (const k of kid === 'all' ? [...this.assistants.keys()] : [kid]) if (this.assistants.has(k)) this.revokedIds.add(`assistant:${k}`);
        await this.o.saveRevoked([...this.revokedIds]);
        const gone = kid === 'all' ? this.assistants.size : Number(this.assistants.delete(kid));
        if (kid === 'all') this.assistants.clear();
        await this.o.saveAssistants?.([...this.assistants.values()]);
        return void res.json({ revoked: gone });
      }
      if (p.kind === 'panel.allowance.draft') {
        const q = p as unknown as { kid?: string; amount?: number; amountUsd?: number; currency?: string; days?: number };
        const a = this.assistants.get(String(q.kid ?? ''));
        const amount = Number(q.amount ?? q.amountUsd), days = Number(q.days ?? 7), currency = q.currency ?? 'USD';
        if (!a?.webId) return void res.status(400).json({ error: a ? 'that assistant connected before allowances existed: reconnect it with a new code' : 'no assistant with that key' });
        if (!isCurrency(currency)) return void res.status(400).json({ error: 'currency: a three-letter code, like USD or AUD' });
        if (!(amount > 0 && amount <= MAX_ALLOWANCE)) return void res.status(400).json({ error: `amount: more than 0, at most ${MAX_ALLOWANCE}` });
        if (!(days >= 1 && days <= MAX_ALLOWANCE_DAYS)) return void res.status(400).json({ error: `days: 1 to ${MAX_ALLOWANCE_DAYS}` });
        if (!this.o.statusUrl) return void res.status(501).json({ error: 'this house cannot keep allowances' });
        const statusId = `allowance:${randomBytes(6).toString('hex')}`;
        const draft = allowanceDraft(this.o.webId, a.webId, amount, new Date(Date.now() + days * 86_400_000), statusEntry(this.o.statusUrl(), await this.statusIndex(statusId)), currency);
        this.allowanceDrafts.set(statusId, { kid: a.kid, statusId, draft });
        return void res.json({ id: statusId, draft, note: 'sign it on this device and send it back with panel.allowance.set' });
      }
      if (p.kind === 'panel.allowance.set') {
        const q = p as unknown as { id?: string; credential?: string };
        const d = this.allowanceDrafts.get(String(q.id ?? ''));
        if (!d) return void res.status(404).json({ error: 'no allowance draft with that id: start again' });
        let vc;
        try {
          vc = await verifyCredential(String(q.credential ?? ''), this.ownerJwk);
        } catch {
          return void res.status(403).json({ error: 'the allowance is not signed by your key' });
        }
        // Exactly what was drafted: same assistant, amount, expiry and status bit.
        const same = ['issuer', 'type', 'credentialSubject', 'credentialStatus'].every((k) => JSON.stringify((vc as unknown as Record<string, unknown>)[k]) === JSON.stringify(d.draft[k]));
        if (!same) return void res.status(400).json({ error: 'the allowance does not match its draft' });
        const s = vc.credentialSubject as unknown as { budget: { amount: number; currency: string }; intent_expiry: string };
        const old = this.allowances.get(d.kid);
        if (old) await this.revoke(old.statusId);
        this.allowances.set(d.kid, { kid: d.kid, credential: String(q.credential), statusId: d.statusId, amount: s.budget.amount, currency: s.budget.currency, until: s.intent_expiry, at: new Date().toISOString() });
        this.allowanceDrafts.delete(d.statusId);
        await this.saveAllowances();
        this.news({ about: 'allowance', amount: s.budget.amount, currency: s.budget.currency, until: s.intent_expiry, note: 'your human signed you a spending allowance: lake_pay spends under it, in this currency' }, d.kid);
        return void res.json({ ok: true, amount: s.budget.amount, currency: s.budget.currency, until: s.intent_expiry });
      }
      if (p.kind === 'panel.allowance.revoke') {
        const a = this.allowances.get(String((p as unknown as { kid?: string }).kid ?? ''));
        if (!a) return void res.status(404).json({ error: 'no allowance for that assistant' });
        await this.revoke(a.statusId);
        this.allowances.delete(a.kid);
        await this.saveAllowances();
        this.news({ about: 'allowance', revoked: true, note: 'your human took your spending allowance back' }, a.kid);
        return void res.json({ revoked: true, note: 'its bit is set on your house\'s status list: payments refuse it from now on' });
      }
      if (p.kind === 'panel.assistant.answer') {
        // The owner taps one of the choices a question offered; the assistants hear it (run 39's parcel favour waited
        // 17 minutes with no way to answer).
        // A choice, the owner's own words, or both (run 44: "the panel can't carry free text to me", so the assistant guessed
        // a café and deferred a bio). Words go to the assistant as the owner's; any note can be answered with them.
        const q = p as unknown as { id?: string; choice?: string; text?: string };
        const sug = this.suggestions.find((x) => x.id === q.id);
        const text = typeof q.text === 'string' ? q.text.trim().slice(0, 500) : '';
        if (!sug || (q.choice !== undefined && !sug.ask?.choices.includes(String(q.choice))) || (q.choice === undefined && !text)) return void res.status(400).json({ error: 'answer a note: one of its choices, your own words (text), or both' });
        if (q.choice !== undefined) sug.ask!.answered = String(q.choice);
        if (text) sug.reply = text;
        this.news({ about: 'question.answered', suggestion: sug.id, question: sug.text.slice(0, 300), ...(q.choice !== undefined ? { answer: String(q.choice) } : {}), ...(text ? { text, words: 'your human\'s own words' } : {}) });
        return void res.json({ ok: true, ...(q.choice !== undefined ? { answered: String(q.choice) } : {}), ...(text ? { text } : {}) });
      }
      if (p.kind === 'panel.agenda.feed') {
        // The owner's calendar subscribes to this address; a reset makes the old one stop working.
        if ((p as unknown as { reset?: boolean }).reset) this.feedKey = await secret(join(this.o.dataDir, 'agenda-feed-key'), true);
        const base = this.o.panel?.door?.().address;
        return void res.json({ ok: true, path: `/owner/agenda.ics?key=${this.feedKey}`, ...(base ? { url: `${base}/owner/agenda.ics?key=${this.feedKey}` } : {}) });
      }
      if (p.kind === 'panel.agenda.remove') {
        const id = String((p as unknown as { id?: string }).id ?? '');
        this.agenda = this.agenda.filter((x) => x.id !== id);
        await this.saveAgenda();
        return void res.json({ ok: true });
      }
      if (p.kind === 'panel.note.mute') {
        const note = this.notes.find((x) => x.id === String((p as unknown as { id?: string }).id ?? ''));
        if (!note?.from.key) return void res.status(404).json({ error: 'no note at the door with that id' });
        await this.mute(note.from.key);
        this.news({ about: 'sender.muted', domain: note.from.domain, note: 'your human won\'t hear from this sender again: its notes and knocks are declined at the door' });
        return void res.json({ ok: true, muted: note.from.domain });
      }
      if (p.kind === 'panel.note.dismiss') {
        const id = String((p as unknown as { id?: string }).id ?? '');
        const gone = this.notes.find((x) => x.id === id);
        if (gone) this.closedNotes.set(id, { by: gone.from.webId, state: 'seen and set aside by the owner' });
        this.notes = this.notes.filter((x) => x.id !== id);
        return void res.json({ ok: true });
      }
      if (p.kind === 'panel.assistant.dismiss') {
        const id = String((p as unknown as { id?: string }).id ?? '');
        this.suggestions = this.suggestions.filter((x) => x.id !== id);
        return void res.json({ ok: true });
      }
      if (p.kind === 'list') return void res.json(this.view());
      if (p.kind === 'answer') return void res.json(await this.answer(p.request ?? '', p.answer ?? '', p.grant));
      if (p.kind === 'revoke') return void res.json({ revoked: await this.revoke(p.revoke ?? 'all') });
      if (p.kind === 'release' && this.o.leaseHours) {
        await this.release();
        return void res.json({ released: true });
      }
      const panel = this.o.panel;
      if (panel && p.kind.startsWith('panel.')) {
        const q = p as unknown as { text?: string; pack?: string; terms?: Record<string, string | number>; offer?: string };
        // A panel action that can't be done says why, instead of failing the request.
        const answer = await ({
          'panel.overview': () => panel.overview(Number((q as { tz_offset?: number }).tz_offset)),
          'panel.rules': () => panel.rules(),
          'panel.door': async () => panel.door?.() ?? { error: 'this house has no door' },
          // The owner's free slots, around what is already in their agenda: what their assistant may offer (runs 49-50).
          'panel.free': async () => {
            const av = panel.availability?.();
            if (!av) return { set: false, slots: [], note: 'your human hasn\'t said when they are free to meet (control panel, Rules: When you\'re free): ask them for a time' };
            return { set: true, tz: av.tz, meetings: av.meetings ?? 60, slots: freeSlots(av, this.agenda.filter((x) => x.start).map((x) => ({ start: x.start! }))), note: 'free in their agenda now: offer a few; once the other side agrees, write it in with lake_house_suggest agenda (start, agreed_in)' };
          },
          'panel.availability.set': async () => {
            const av = (q as { availability?: unknown }).availability;
            if (av === null) return panel.setAvailability?.(null) ?? { error: 'this house has no availability' };
            const problems = availabilityProblems(av);
            return problems.length ? { error: problems.join('; ') } : panel.setAvailability?.(av as Availability) ?? { error: 'this house has no availability' };
          },
          'panel.door.set': async () => panel.setDoor?.({ open: (q as { open?: unknown }).open === true, ...(typeof (q as { about?: unknown }).about === 'string' ? { about: String((q as { about: string }).about) } : {}), ...(typeof (q as { name?: unknown }).name === 'string' ? { name: String((q as { name: string }).name) } : {}) }) ?? { error: 'this house has no door' },
          'panel.rules.set': () => panel.setRules(String(q.text ?? '')),
          'panel.activity': async () => panel.activity((q as { since?: number | string }).since),
          'panel.agents': async () => panel.agents(),
          'panel.money': () => panel.money(),
          'panel.consents': () => panel.consents(),
          'panel.data': () => panel.data(),
          'panel.export': () => panel.exportAll(),
          'panel.market': () => panel.market(),
          'panel.intent.open': () => panel.openIntent(String(q.pack ?? ''), q.terms ?? {}),
          'panel.intent.close': () => panel.closeIntent(String(q.pack ?? '')),
          'panel.offer.accept': async () => {
            // Accepting releases the owner's facts at once; a price no assistant may pay leaves them out with nothing bought
            // (run 39: A$157.14 against an A$150 allowance). Said first; the owner may still go ahead.
            const price = panel.offerPrice?.(String(q.offer ?? ''));
            const live = [...this.allowances.values()].filter((a) => a.currency === price?.currency && Date.parse(a.until) > Date.now() && !this.isRevoked(a.statusId));
            const caps = live.map((a) => a.amount);
            // Only where the owner has an assistant pay in that currency: an owner with none pays themselves.
            if (price && caps.length && !(q as { even_over_allowance?: boolean }).even_over_allowance && caps.every((c) => c < price.amount)) {
              const top = live.reduce((x, y) => (y.amount > x.amount ? y : x));
              // Its assistant hears of it (run 48: the shop was refused at the owner's tap, and the assistant reported "no
              // answer yet"); the panel offers to raise that allowance in the same tap.
              this.news({ about: 'offer.over_allowance', offer: String(q.offer ?? ''), price, allowance: top.amount, note: 'your human tapped Accept, but it is more than you may spend: they were asked to raise your allowance or pay it themselves. Nothing is accepted yet' }, top.kid);
              return { error: `${price.currency} ${price.amount} is more than your assistant may spend (${price.currency} ${top.amount}): raise its allowance first, or accept even so (even_over_allowance) and pay it yourself`, code: 'over_allowance', price, allowance: { kid: top.kid, amount: top.amount } };
            }
            return panel.acceptOffer(String(q.offer ?? ''));
          },
          'panel.person.request': () => panel.requestPersonhood((q as { consent?: unknown }).consent, this.ownerJwk!),
          'panel.pledge.sign': () => panel.signPledge(String((q as { tally?: string }).tally ?? ''), String((q as { id?: string }).id ?? '')),
          'panel.pledge.reveal': () => panel.revealPledge(String((q as { tally?: string }).tally ?? ''), String((q as { id?: string }).id ?? '')),
        } as Record<string, () => Promise<unknown>>)[p.kind]?.().catch((e: Error) => ({ error: e.message }));
        if (answer !== undefined && p.kind === 'panel.offer.accept' && !(answer as { error?: string }).error) {
          // The assistant that suggested it is the one to pay: what was accepted, from whom, and the quoter's answer (its order).
          const x = answer as { id: string; title: string; quoter: { name: string; url: string }; result: { outputs: Record<string, number> }; labels?: Record<string, { label: string; unit?: string }>; currency?: string; answer?: Record<string, unknown> };
          this.news({ about: 'offer.accepted', offer: x.id, title: x.title, from: x.quoter, outputs: x.result.outputs, labels: x.labels, currency: x.currency, answer: x.answer, note: 'your human accepted this offer: pay it with lake_pay, naming the order. That pays outright: an accepted offer is no cart, so nothing holds the money, and the delivery itself happens outside the Lake (run 39: assistants promised "held until delivery")' });
        }
        if (answer !== undefined) return void res.status((answer as { error?: string }).error ? 400 : 200).json(answer);
      }
      res.status(400).json({ error: 'unknown request' });
    });

    // The machine's operator (whoever holds the house's data folder) may pull every key at once.
    r.post('/operator/revoke-all', async (req, res) => {
      if (req.get('x-lake-operator') !== this.operatorToken) return void res.status(403).json({ error: 'operator token required' });
      res.json({ revoked: await this.revoke('all') });
    });

    if (appDir) r.use(express.static(appDir, { index: 'approvals.html' }));
    return r;
  }

  view() {
    return {
      webId: this.o.webId,
      until: this.leaseUntil()?.toISOString() ?? null,
      requests: [...this.pending.values()].filter((x) => x.status === 'pending'),
      assistants: [...this.assistants.values()].map(({ kid, label, addedAt, webId }) => { const a = this.allowanceFor(kid); return { kid, label, addedAt, canHaveAllowance: !!webId, ...(a ? { allowance: { amount: a.amount, currency: a.currency, until: a.until } } : {}) }; }),
      suggestions: this.suggestions,
      notes: this.notes,
      agenda: this.agenda,
      keys: [...this.grants.values()].filter((g) => !g.revoked && Date.parse(g.until) > Date.now()).map(({ jws: _, ...g }) => g),
    };
  }

  private async answer(id: string, answer: string, grant?: string) {
    const req = this.pending.get(id);
    if (!req || req.status !== 'pending') return { error: 'no such pending request' };
    if (answer === 'deny') {
      req.status = 'denied';
      this.o.emit(makeEvent('approval.answered', this.o.actor, `agent:${req.visitor.domain}`, { answer: 'Deny' }));
      this.news({ about: 'request.answered', request: id, by: req.visitor.domain, answer: 'deny' });
      return { ok: true };
    }
    if (answer !== 'allow' || !grant) return { error: 'allow needs a grant signed on your device' };
    // The grant must be signed by the owner's key and say exactly what the owner was shown.
    let vc;
    try {
      vc = await verifyCredential(grant, this.ownerJwk!);
    } catch {
      return { error: 'grant is not signed by your key' };
    }
    const s = readAccessGrant(vc);
    const until = Date.parse((vc as { validUntil?: string }).validUntil ?? '');
    const ok = !!s &&
      vc.issuer === this.o.webId && s.owner === this.o.webId && s.grantee === req.visitor.webId && s.offer === req.offerId &&
      s.purpose === req.purpose && (s.study ?? null) === req.study && s.fields.every((f) => req.fields.includes(f)) &&
      // Its bit on the status list is the one the house drafted, so anyone can check it hasn't been revoked.
      JSON.stringify((vc as { credentialStatus?: unknown }).credentialStatus) === JSON.stringify((req.grantDraft as { credentialStatus?: unknown } | undefined)?.credentialStatus) &&
      until > Date.now() && until <= Date.now() + MAX_GRANT_MS + 60_000;
    if (!ok) return { error: 'grant does not match the request you were shown' };
    await this.o.writeGrant(req.offerId, grant);
    await this.o.writeConsent?.(req.offerId, consentRecord({
      id: req.offerId, owner: this.o.webId, visitor: { webId: req.visitor.webId, domain: req.visitor.domain }, purpose: req.purpose, dpvPurpose: PURPOSES[req.purpose]?.dpv ? `dpv:${PURPOSES[req.purpose]!.dpv}` : undefined,
      fields: s!.fields, retention: req.retention, until: new Date(until).toISOString(), method: { live: true }, agreement: req.offerId,
      status: (vc as { credentialStatus?: { id?: string } }).credentialStatus?.id, given: new Date().toISOString(), notice: digestSRI(JSON.stringify(req.grantDraft ?? {})),
    })).catch(() => {});
    this.record({ id: req.offerId, jws: grant, visitor: req.visitor.domain, fields: s!.fields, purpose: s!.purpose, until: new Date(until).toISOString(), authorizedBy: 'owner, live' });
    req.status = 'allowed';
    req.grant = grant;
    this.o.emit(makeEvent('approval.answered', this.o.actor, `agent:${req.visitor.domain}`, { answer: 'Allow' }));
    this.o.emit(makeEvent('grant.issued', this.o.actor, `agent:${req.visitor.domain}`, { hours: Math.round((until - Date.now()) / 3_600_000) }));
    this.news({ about: 'request.answered', request: id, by: req.visitor.domain, answer: 'allow', fields: s!.fields, until: new Date(until).toISOString() });
    return { ok: true };
  }
}

/** The agenda as iCalendar: entries with a start time become events, CONFIRMED when the other side agreed, TENTATIVE if not. */
export function agendaIcs(items: AgendaItem[], house: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const t = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Lake//house agenda//EN', 'X-WR-CALNAME:Agenda'];
  for (const x of items.filter((i) => i.start)) {
    const who = x.agreed ? `Agreed by ${x.agreed.by}${x.agreed.speaks_for?.checked ? ` (speaks for ${x.agreed.speaks_for.house})` : ''}: "${x.agreed.said}"` : 'Proposed: their side has not agreed yet';
    lines.push('BEGIN:VEVENT', `UID:${x.id}@${new URL(house).host}`, `DTSTAMP:${t(x.at)}`, `DTSTART:${t(x.start!)}`, 'DURATION:PT1H', `SUMMARY:${esc(x.what)}`,
      ...(x.where ? [`LOCATION:${esc(x.where)}`] : []), `DESCRIPTION:${esc([x.when, x.with ? `with ${x.with}` : '', who, x.note ?? ''].filter(Boolean).join('\n'))}`,
      `STATUS:${x.agreed ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // Lines end in CRLF, and long ones fold at 75 octets (RFC 5545 §3.1).
  return lines.map((l) => { const out: string[] = []; let s = l; while (Buffer.byteLength(s) > 75) { let n = 75; while (Buffer.byteLength(s.slice(0, n)) > 75) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); }).join('\r\n') + '\r\n';
}

async function secret(path: string, rotate = false): Promise<string> {
  if (!rotate) {
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch {
      // first start
    }
  }
  const s = randomBytes(12).toString('base64url');
  await writeFile(path, s, { mode: 0o600 });
  return s;
}

export type { Study };
