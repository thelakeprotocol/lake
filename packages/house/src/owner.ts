import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import {
  makeEvent, ReplayGuard, verifyCredential, verifyMessage,
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
  recommendation: string;
  requestedAt: string;
  status: 'pending' | 'allowed' | 'denied';
  grant?: string;
}

/** The control panel's view of a house. Every call is signed by the owner's key. */
export interface PanelProvider {
  overview(): Promise<unknown>;
  rules(): Promise<{ text: string; rules: unknown }>;
  setRules(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  activity(): unknown[];
  agents(): unknown[];
  money(): Promise<unknown>;
  data(): Promise<unknown>;
  exportAll(): Promise<unknown>;
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
}

const MAX_GRANT_MS = 48 * 3_600_000;

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
    },
  ) {}

  async init() {
    this.ownerJwk = await this.o.readOwnerKey();
    this.token = await secret(join(this.o.dataDir, 'pairing-token'));
    this.operatorToken = await secret(join(this.o.dataDir, 'operator-token'));
    for (const id of await this.o.loadRevoked()) this.revokedIds.add(id);
    return { paired: !!this.ownerJwk, token: this.token };
  }

  private revokedIds = new Set<string>();
  isRevoked(id: string) {
    return this.revokedIds.has(id) || !!this.grants.get(id)?.revoked;
  }

  record(g: Omit<GrantRecord, 'revoked'>) {
    this.grants.set(g.id, { ...g, revoked: this.revokedIds.has(g.id) });
  }

  ask(r: Omit<PendingRequest, 'id' | 'status' | 'requestedAt'>): PendingRequest {
    const req: PendingRequest = { ...r, id: r.offerId, status: 'pending', requestedAt: new Date().toISOString() };
    this.pending.set(req.id, req);
    return req;
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
      this.ownerJwk = { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid: String(publicJwk.kid ?? 'owner'), alg: 'EdDSA' };
      await this.o.saveOwnerKey(this.ownerJwk);
      this.token = await secret(join(this.o.dataDir, 'pairing-token'), true); // one use only
      res.json({ paired: true, webId: this.o.webId });
    });

    r.post('/api', async (req, res) => {
      if (!this.ownerJwk) return void res.status(409).json({ error: 'pair first' });
      let p: Signed<{ kind: string; request?: string; answer?: string; grant?: string; revoke?: string }>['payload'];
      try {
        p = await verifyMessage(req.body, async (kid) => (kid === this.ownerJwk!.kid ? this.ownerJwk : null), { replay: this.replay });
      } catch (e) {
        return void res.status(403).json({ error: (e as Error).message });
      }
      if (p.kind === 'list') return void res.json(this.view());
      if (p.kind === 'answer') return void res.json(await this.answer(p.request ?? '', p.answer ?? '', p.grant));
      if (p.kind === 'revoke') return void res.json({ revoked: await this.revoke(p.revoke ?? 'all') });
      const panel = this.o.panel;
      if (panel && p.kind.startsWith('panel.')) {
        const q = p as unknown as { text?: string };
        const answer = await ({
          'panel.overview': () => panel.overview(),
          'panel.rules': () => panel.rules(),
          'panel.rules.set': () => panel.setRules(String(q.text ?? '')),
          'panel.activity': async () => panel.activity(),
          'panel.agents': async () => panel.agents(),
          'panel.money': () => panel.money(),
          'panel.data': () => panel.data(),
          'panel.export': () => panel.exportAll(),
        } as Record<string, () => Promise<unknown>>)[p.kind]?.();
        if (answer !== undefined) return void res.json(answer);
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
      requests: [...this.pending.values()].filter((x) => x.status === 'pending'),
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
    const s = vc.credentialSubject as { id: string; offer: string; study: string | null; fields: string[]; purpose: string };
    const until = Date.parse((vc as { validUntil?: string }).validUntil ?? '');
    const ok =
      vc.type.includes('LakeAccessGrant') && vc.issuer === this.o.webId && s.id === req.visitor.webId && s.offer === req.offerId &&
      s.purpose === req.purpose && (s.study ?? null) === req.study && s.fields.every((f) => req.fields.includes(f)) &&
      until > Date.now() && until <= Date.now() + MAX_GRANT_MS + 60_000;
    if (!ok) return { error: 'grant does not match the request you were shown' };
    await this.o.writeGrant(req.offerId, grant);
    this.record({ id: req.offerId, jws: grant, visitor: req.visitor.domain, fields: s.fields, purpose: s.purpose, until: new Date(until).toISOString(), authorizedBy: 'owner, live' });
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
