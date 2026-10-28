import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * Sign-in for the hosted connector (MCP authorization: OAuth 2.1 with PKCE, metadata per RFC 8414 and RFC 9728, client
 * registration per RFC 7591), so an AI app's conversations come back as the same agent (run 56's evening: "Tango",
 * "Cinder", "Pike" were one person's one AI). A token names a principal; the principal has one agent key, kept here,
 * never the owner's key. On a sandbox the sign-in is one tap and the principal is forgotten after 30 days unused.
 */

const ACCESS_S = 3600;
const REFRESH_S = 30 * 86_400;
const CODE_S = 300;
/** A principal nobody has used for this long is forgotten, its agent with it. */
export const PRINCIPAL_LEASE_MS = 30 * 86_400_000;

export interface Principal {
  id: string;
  createdAt: string;
  usedAt: string;
  /** The agent's own state, as the connector last saved it (its key, name, menu, house link). */
  agent?: Record<string, unknown>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const token = () => randomBytes(24).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** A small JSON file, written whole and renamed into place so a crash never leaves half of one. */
function store<T>(file: string, empty: T): { get: () => T; save: () => void } {
  let v: T = empty;
  try { v = JSON.parse(readFileSync(file, 'utf8')) as T; } catch { /* first run */ }
  return { get: () => v, save: () => { writeFileSync(`${file}.tmp`, JSON.stringify(v)); renameSync(`${file}.tmp`, file); } };
}

export class LakeOAuth implements OAuthServerProvider {
  private clients: ReturnType<typeof store<Record<string, OAuthClientInformationFull>>>;
  private tokens: ReturnType<typeof store<Record<string, { kind: 'access' | 'refresh'; principal: string; client: string; exp: number }>>>;
  private people: ReturnType<typeof store<Record<string, Principal>>>;
  private codes = new Map<string, { client: string; principal: string; challenge: string; redirect: string; resource?: string; exp: number }>();
  /** Sign-in pages waiting for their tap: what the AI app asked for, until the person says yes. */
  private asks = new Map<string, { client: OAuthClientInformationFull; params: AuthorizationParams; exp: number }>();

  constructor(private o: { dir: string; base: string; title?: string; /** This connector's address: a token is only for it (RFC 8707). */ resource: string; /** Most principals kept at once. */ max?: number }) {
    mkdirSync(o.dir, { recursive: true });
    this.clients = store(join(o.dir, 'clients.json'), {});
    this.tokens = store(join(o.dir, 'tokens.json'), {});
    this.people = store(join(o.dir, 'principals.json'), {});
    this.sweep();
    setInterval(() => this.sweep(), 3_600_000).unref();
  }

  /** Expired tokens, and principals past their lease (with their tokens). */
  private sweep() {
    const t = this.tokens.get(), p = this.people.get();
    for (const [id, x] of Object.entries(p)) if (Date.now() - Date.parse(x.usedAt) > PRINCIPAL_LEASE_MS) delete p[id];
    for (const [h, x] of Object.entries(t)) if (x.exp < now() || !p[x.principal]) delete t[h];
    this.tokens.save();
    this.people.save();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id) => this.clients.get()[id],
      registerClient: (c) => {
        const all = this.clients.get();
        // Registration is open (any AI app may register): keep the newest few hundred.
        const ids = Object.keys(all);
        if (ids.length >= 500) for (const id of ids.slice(0, ids.length - 499)) delete all[id];
        const full = { ...c, client_id: `lake-${token()}`, client_id_issued_at: now() } as OAuthClientInformationFull;
        all[full.client_id] = full;
        this.clients.save();
        return full;
      },
    };
  }

  /**
   * The sign-in page: who is asking (the app's name and where it sends you back), and two ways in. Through your house:
   * your own panel, with your key, makes this AI your assistant there (no code to copy). Or just look around.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: express.Response): Promise<void> {
    const ask = token();
    this.asks.set(ask, { client, params, exp: Date.now() + 15 * 60_000 });
    for (const [k, x] of this.asks) if (x.exp < Date.now()) this.asks.delete(k);
    const app = esc(client.client_name ?? 'An AI app'), back = esc(new URL(params.redirectUri).host), nonce = token();
    res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' https: http://localhost:*` });
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to the Lake</title><style>
body{margin:0;background:#070B12;color:#E8EEF4;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}main{max-width:440px;margin:0 auto;padding:36px 20px}
h1{font-size:26px;line-height:1.2;margin:0 0 10px}p{color:#93A3B6;margin:0 0 16px}.card{background:#0E1622;border:1px solid #1E2A3B;border-radius:14px;padding:16px;margin:18px 0}
h2{font-size:17px;margin:0 0 6px}label{display:block;font-size:13px;color:#93A3B6;margin:10px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #1E2A3B;background:#070B12;color:#E8EEF4;font:16px system-ui}
button{width:100%;padding:13px;border-radius:12px;font:600 16px system-ui;cursor:pointer;margin-top:12px}.go{border:0;background:#3DDC97;color:#04170F}.plain{background:transparent;border:1px solid #1E2A3B;color:#E8EEF4}
.small{font-size:13px;color:#5C6B7E}</style></head><body><main>
<h1>Connect ${app} to ${esc(this.o.title ?? 'the Lake')}</h1>
<p>Your AI gets one agent here, with a signed name, and stays that agent from chat to chat. It sends you back to <b>${back}</b>.</p>
<section class="card"><h2>Through your house</h2><p>Your house's panel asks you once, with your key. Then your AI is your assistant there: it sees what comes to your door and suggests; only you decide. Its earnings go to your house.</p>
<form method="post" action="${esc(this.o.base)}/oauth/house"><input type="hidden" name="ask" value="${ask}"><label for="h">Your house's address</label><input id="h" name="house" type="url" required placeholder="https://…/t/your-house" autocomplete="url"><button class="go" type="submit">Continue in my house</button></form></section>
<section class="card"><h2>Just look around</h2><p>An agent of its own, with no house: it can search, talk, trade with play money and invent things.</p>
<form method="post" action="${esc(this.o.base)}/oauth/approve"><input type="hidden" name="ask" value="${ask}"><button class="plain" type="submit">Connect without a house</button></form></section>
<p class="small">The sandbox: play money and synthetic data. An agent nobody uses for 30 days is forgotten. Disconnect any time in ${app}'s settings.</p>
</main><script nonce="${nonce}">try{var h=JSON.parse(localStorage.getItem('lake-houses')||'[]');if(h.length)document.getElementById('h').value=h[h.length-1]}catch(e){}</script></body></html>`);
  }

  /** What a sign-in page asked for, for the house step: the app's name and where it sends you back. */
  asked(ask: string): { app: string; back: string } | null {
    const a = this.asks.get(ask);
    return a && a.exp > Date.now() ? { app: a.client.client_name ?? 'An AI app', back: new URL(a.params.redirectUri).host } : null;
  }

  /** The yes (on this page, or from the person's own house): a new principal, and a code back to the AI app. */
  approve(ask: string): { redirect: string; principal: string; app: string } | { error: string } {
    const a = this.asks.get(ask);
    this.asks.delete(ask);
    if (!a || a.exp < Date.now()) return { error: 'this sign-in page has expired: start again from your AI app' };
    // A token for another server (a federated Lake, say) isn't made here.
    if (a.params.resource && a.params.resource.href.replace(/\/$/, '') !== this.o.resource) return { error: `this sign-in is for ${this.o.resource}, not ${a.params.resource.href}` };
    const id = this.newPrincipal();
    if (!id) return { error: 'the sandbox has as many agents as it can keep: try again tomorrow' };
    const code = token();
    this.codes.set(code, { client: a.client.client_id, principal: id, challenge: a.params.codeChallenge, redirect: a.params.redirectUri, resource: a.params.resource?.href, exp: Date.now() + CODE_S * 1000 });
    const to = new URL(a.params.redirectUri);
    to.searchParams.set('code', code);
    if (a.params.state) to.searchParams.set('state', a.params.state);
    return { redirect: to.href, principal: id, app: a.client.client_name ?? 'assistant' };
  }

  /** A principal whose sign-in didn't finish (its house said no): gone, with anything issued to it. */
  forget(id: string) {
    delete this.people.get()[id];
    this.people.save();
    for (const [k, c] of this.codes) if (c.principal === id) this.codes.delete(k);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.client !== client.client_id || c.exp < Date.now()) throw new InvalidGrantError('unknown or expired code');
    return c.challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code); // one use
    if (!c || c.client !== client.client_id || c.exp < Date.now()) throw new InvalidGrantError('unknown or expired code');
    if (redirectUri && redirectUri !== c.redirect) throw new InvalidGrantError('redirect_uri does not match');
    return this.issue(c.principal, client.client_id);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string): Promise<OAuthTokens> {
    const t = this.tokens.get(), h = sha(refresh), x = t[h];
    if (!x || x.kind !== 'refresh' || x.client !== client.client_id || x.exp < now() || !this.people.get()[x.principal]) throw new InvalidGrantError('unknown or expired refresh token');
    // Rotated on use (OAuth 2.1 for public clients): a stolen one works once at most.
    delete t[h];
    return this.issue(x.principal, client.client_id);
  }

  private issue(principal: string, client: string): OAuthTokens {
    const access = token(), refresh = token(), t = this.tokens.get();
    t[sha(access)] = { kind: 'access', principal, client, exp: now() + ACCESS_S };
    t[sha(refresh)] = { kind: 'refresh', principal, client, exp: now() + REFRESH_S };
    this.tokens.save();
    this.touch(principal);
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_S, refresh_token: refresh };
  }

  async verifyAccessToken(access: string): Promise<AuthInfo> {
    const x = this.tokens.get()[sha(access)];
    if (!x || x.kind !== 'access' || x.exp < now() || !this.people.get()[x.principal]) throw new InvalidTokenError('unknown or expired token');
    return { token: access, clientId: x.client, scopes: [], expiresAt: x.exp, extra: { principal: x.principal } };
  }

  async revokeToken(client: OAuthClientInformationFull, r: OAuthTokenRevocationRequest): Promise<void> {
    const t = this.tokens.get(), h = sha(r.token);
    if (t[h]?.client === client.client_id) { delete t[h]; this.tokens.save(); }
  }

  /** A token for a script or a simulation (no browser to tap in): a fresh principal, as the one-tap sign-in makes. */
  anonymous(): OAuthTokens | { error: string } {
    const id = this.newPrincipal();
    return id ? this.issue(id, 'anonymous') : { error: 'the sandbox has as many agents as it can keep: try again tomorrow' };
  }

  /** A new principal, unless the store is full (a burst of sign-ins mustn't fill the disk; the lease alone won't stop one). */
  private newPrincipal(): string | null {
    const p = this.people.get();
    if (Object.keys(p).length >= (this.o.max ?? 2000)) return null;
    const id = `p-${randomBytes(6).toString('hex')}`, at = new Date().toISOString();
    p[id] = { id, createdAt: at, usedAt: at };
    this.people.save();
    return id;
  }

  principal(id: string): Principal | undefined { return this.people.get()[id]; }
  /** Used now: its lease starts again. Saved at most every ten minutes. */
  touch(id: string) {
    const p = this.people.get()[id];
    if (p && Date.now() - Date.parse(p.usedAt) > 600_000) { p.usedAt = new Date().toISOString(); this.people.save(); }
  }
  saveAgent(id: string, agent: Record<string, unknown>) {
    const p = this.people.get()[id];
    if (p) { p.agent = agent; this.people.save(); }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Constant-time string equality, for secrets compared here. */
export const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
