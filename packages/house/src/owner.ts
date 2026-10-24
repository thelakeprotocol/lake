import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import {
  makeEvent, readAccessGrant, ReplayGuard, verifyCredential, verifyMessage,
  type JWK, type LakeEvent, type Signed, type Study,
} from '@thelakeprotocol/core';

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
  activity(): unknown[];
  agents(): unknown[];
  money(): Promise<unknown>;
  data(): Promise<unknown>;
  exportAll(): Promise<unknown>;
  /** What the owner is looking for, and the offers priced for them in this house. */
  market(): Promise<unknown>;
  openIntent(pack: string, terms: Record<string, string | number>): Promise<unknown>;
  closeIntent(pack: string): Promise<unknown>;
  acceptOffer(id: string): Promise<unknown>;
  /** One person, one house (SPEC §6.4): ask the person checker for a stamp, with the owner's signed consent. */
  requestPersonhood(consent: unknown, ownerJwk: JWK): Promise<unknown>;
  /** Sign a pledge on a blind tally, from this house, with its person stamp. */
  signPledge(tally: string, id: string): Promise<unknown>;
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
export interface AssistantKey { kid: string; jwk: JWK; label: string; addedAt: string }
export interface Suggestion { id: string; from: string; text: string; request?: string; at: string }
const ASSISTANT_MAY = new Set(['list', 'panel.overview', 'panel.rules', 'panel.activity', 'panel.agents', 'panel.money', 'panel.data', 'panel.market', 'assistant.suggest']);

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
      saveRevoked: (ids: string[]) => Promise<void>;
      loadRevoked: () => Promise<string[]>;
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

  /** Back to nobody's: keys revoked, requests dropped, owner forgotten, house reset. Anyone can claim it again. */
  async release() {
    await this.revoke('all');
    this.pending.clear();
    this.assistants.clear();
    this.suggestions = [];
    await this.o.saveAssistants?.([]);
    this.ownerJwk = null;
    await this.o.clearOwnerKey?.();
    this.token = await secret(join(this.o.dataDir, 'pairing-token'), true);
    await this.o.onRelease?.();
  }

  async init() {
    this.ownerJwk = await this.o.readOwnerKey();
    if (this.o.leaseHours) {
      const check = () => { const until = this.leaseUntil(); if (until && until.getTime() <= Date.now()) void this.release(); };
      check();
      setInterval(check, 60_000).unref();
    }
    this.token = await secret(join(this.o.dataDir, 'pairing-token'));
    this.operatorToken = await secret(join(this.o.dataDir, 'operator-token'));
    for (const id of await this.o.loadRevoked()) this.revokedIds.add(id);
    for (const a of (await this.o.loadAssistants?.().catch(() => [])) ?? []) this.assistants.set(a.kid, a);
    return { paired: !!this.ownerJwk, token: this.token };
  }

  private revokedIds = new Set<string>();
  isRevoked(id: string) {
    return this.revokedIds.has(id) || !!this.grants.get(id)?.revoked;
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
    const req: PendingRequest = { ...r, id: r.offerId, status: 'pending', requestedAt: new Date().toISOString() };
    this.pending.set(req.id, req);
    return req;
  }

  /** A visitor takes back its own request before the owner answers it. */
  withdraw(offerId: string, visitorWebId: string): boolean {
    const req = this.pending.get(offerId);
    if (!req || req.visitor.webId !== visitorWebId || req.status !== 'pending') return false;
    this.pending.delete(offerId);
    return true;
  }

  /** What one agent asked this house lately, any purpose: lets the owner see a visitor trying another label. */
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
    for (const id of ids) {
      const g = this.grants.get(id);
      if (g && !g.revoked) { g.revoked = true; n++; }
      this.revokedIds.add(id);
    }
    await this.o.saveRevoked([...this.revokedIds]);
    if (n) this.o.emit(makeEvent('grant.revoked', this.o.actor, undefined, { count: n }));
    return n;
  }

  /** /owner: the approvals app (static) and its API. */
  router(appDir?: string): express.Router {
    const r = express.Router();
    r.use(express.json({ limit: '64kb' }));

    r.post('/pair', async (req, res) => {
      const { publicJwk, token } = req.body ?? {};
      if (!publicJwk?.x || publicJwk.crv !== 'Ed25519') return void res.status(400).json({ error: 'send an Ed25519 public key' });
      if (this.ownerJwk && this.ownerJwk.x === publicJwk.x) return void res.json({ paired: true, webId: this.o.webId });
      const firstCome = this.o.openPairing && !this.ownerJwk;
      if (!firstCome && token !== this.token) return void res.status(403).json({ error: this.ownerJwk ? 'this house already has an owner' : 'wrong or missing pairing token' });
      this.ownerJwk = { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid: String(publicJwk.kid ?? 'owner'), alg: 'EdDSA', ...(this.o.leaseHours ? { claimedAt: Date.now() } : {}) } as JWK;
      await this.o.saveOwnerKey(this.ownerJwk);
      this.token = await secret(join(this.o.dataDir, 'pairing-token'), true); // one use only
      res.json({ paired: true, webId: this.o.webId, until: this.leaseUntil()?.toISOString() });
    });

    // The owner's assistant pairs with a one-time code the owner made in the panel; its key can look and suggest only.
    r.post('/assistant', async (req, res) => {
      const { publicJwk, code, label } = req.body ?? {};
      if (!publicJwk?.x || publicJwk.crv !== 'Ed25519' || !publicJwk.kid) return void res.status(400).json({ error: 'send an Ed25519 public key with a kid' });
      const invite = this.invites.get(String(code ?? ''));
      if (!invite || invite.until < Date.now()) return void res.status(403).json({ error: 'wrong or expired code: ask your human for a new one' });
      this.invites.delete(String(code));
      const kid = String(publicJwk.kid);
      if (kid === this.ownerJwk?.kid) return void res.status(400).json({ error: 'that is the owner\'s own key' });
      const a: AssistantKey = { kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid, alg: 'EdDSA' } as JWK, label: String(label ?? invite.label).slice(0, 60), addedAt: new Date().toISOString() };
      this.assistants.set(kid, a);
      await this.o.saveAssistants?.([...this.assistants.values()]);
      res.json({ paired: true, role: 'assistant', webId: this.o.webId, may: [...ASSISTANT_MAY] });
    });

    // Public: is this house taken? (For the sandbox's list of houses to claim.)
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
      if (assistant) {
        if (!ASSISTANT_MAY.has(p.kind)) return void res.status(403).json({ error: `an assistant may look and suggest; only your human's key can do ${p.kind}` });
        if (p.kind === 'assistant.suggest') {
          const q = p as unknown as { text?: string; request?: string; replaces?: string };
          const text = String(q.text ?? '').trim().slice(0, 1500);
          // An assistant that got something wrong takes its own note back; an empty text with replaces just withdraws it.
          const old = q.replaces ? this.suggestions.find((x) => x.id === q.replaces && x.from === assistant.label) : undefined;
          if (q.replaces && !old) return void res.status(404).json({ error: 'no note of yours with that id' });
          if (old) this.suggestions = this.suggestions.filter((x) => x !== old);
          if (!text) return void (old ? res.json({ ok: true, withdrawn: old.id }) : res.status(400).json({ error: 'suggest something: text' }));
          // A note about a request must point at a real one: a unique prefix is enough, anything else is refused.
          let request: string | undefined;
          if (q.request) {
            const hits = [...this.pending.keys()].filter((k) => k === q.request || k.startsWith(String(q.request)));
            if (hits.length !== 1) return void res.status(404).json({ error: hits.length ? 'that matches several requests; give more of the id' : 'no waiting request with that id' });
            request = hits[0];
          }
          const sug: Suggestion = { id: randomBytes(6).toString('hex'), from: assistant.label, text, ...(request ? { request } : {}), at: new Date().toISOString() };
          this.suggestions = [sug, ...this.suggestions].slice(0, 50);
          return void res.json({ ok: true, id: sug.id, ...(old ? { replaced: old.id } : {}), note: 'your human sees it in their control panel' });
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
        const gone = kid === 'all' ? this.assistants.size : Number(this.assistants.delete(kid));
        if (kid === 'all') this.assistants.clear();
        await this.o.saveAssistants?.([...this.assistants.values()]);
        return void res.json({ revoked: gone });
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
          'panel.rules.set': () => panel.setRules(String(q.text ?? '')),
          'panel.activity': async () => panel.activity(),
          'panel.agents': async () => panel.agents(),
          'panel.money': () => panel.money(),
          'panel.data': () => panel.data(),
          'panel.export': () => panel.exportAll(),
          'panel.market': () => panel.market(),
          'panel.intent.open': () => panel.openIntent(String(q.pack ?? ''), q.terms ?? {}),
          'panel.intent.close': () => panel.closeIntent(String(q.pack ?? '')),
          'panel.offer.accept': () => panel.acceptOffer(String(q.offer ?? '')),
          'panel.person.request': () => panel.requestPersonhood((q as { consent?: unknown }).consent, this.ownerJwk!),
          'panel.pledge.sign': () => panel.signPledge(String((q as { tally?: string }).tally ?? ''), String((q as { id?: string }).id ?? '')),
        } as Record<string, () => Promise<unknown>>)[p.kind]?.().catch((e: Error) => ({ error: e.message }));
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
      assistants: [...this.assistants.values()].map(({ kid, label, addedAt }) => ({ kid, label, addedAt })),
      suggestions: this.suggestions,
      keys: [...this.grants.values()].filter((g) => !g.revoked && Date.parse(g.until) > Date.now()).map(({ jws: _, ...g }) => g),
    };
  }

  private async answer(id: string, answer: string, grant?: string) {
    const req = this.pending.get(id);
    if (!req || req.status !== 'pending') return { error: 'no such pending request' };
    if (answer === 'deny') {
      req.status = 'denied';
      this.o.emit(makeEvent('approval.answered', this.o.actor, `agent:${req.visitor.domain}`, { answer: 'Deny' }));
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
      until > Date.now() && until <= Date.now() + MAX_GRANT_MS + 60_000;
    if (!ok) return { error: 'grant does not match the request you were shown' };
    await this.o.writeGrant(req.offerId, grant);
    this.record({ id: req.offerId, jws: grant, visitor: req.visitor.domain, fields: s!.fields, purpose: s!.purpose, until: new Date(until).toISOString(), authorizedBy: 'owner, live' });
    req.status = 'allowed';
    req.grant = grant;
    this.o.emit(makeEvent('approval.answered', this.o.actor, `agent:${req.visitor.domain}`, { answer: 'Allow' }));
    this.o.emit(makeEvent('grant.issued', this.o.actor, `agent:${req.visitor.domain}`, { hours: Math.round((until - Date.now()) / 3_600_000) }));
    return { ok: true };
  }
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
