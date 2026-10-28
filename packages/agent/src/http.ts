import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { LakeAgent, LakeAgentOptions } from './index.js';
import { lakeMcpAgent, type AgentSnapshot, type LakeMcpAgent } from './mcp.js';
import { LakeOAuth } from './auth.js';

/**
 * The Lake MCP connector over HTTP, for assistants that can't run a local command: add
 * `https://<lake>/mcp` as a custom connector in Claude (web, desktop, phone) or any MCP client.
 * With a data folder, an AI signs in once (OAuth, see auth.ts) and every conversation it opens is the same signed agent,
 * kept across chats and restarts; without one, every conversation becomes its own agent and leaves after half an hour idle.
 * Each agent's card is served from here so the node can verify it.
 */
// Short, distinct names (no two share a first letter), so a reader can tell four agents apart at a glance.
const CREATURES = ['Atlas', 'Blaze', 'Cinder', 'Delta', 'Echo', 'Fable', 'Gale', 'Halo', 'Indigo', 'Juno', 'Kite', 'Lumen', 'Moss', 'Nova', 'Onyx', 'Pike', 'Quill', 'Rook', 'Sable', 'Tango'];
/** A signed-in agent nobody has used for a day is put to sleep (memory), and woken from disk on its next use. */
const SLEEP_MS = 24 * 3_600_000;

type Live = { id: string; principal?: string; agent: LakeMcpAgent; sessions: Set<string>; seen: number };

export function lakeMcpHttpApp(o: Omit<LakeAgentOptions, 'name' | 'domain' | 'port' | 'publicUrl' | 'mount'> & {
  publicUrl: string; path?: string; maxSessions?: number; log?: (msg: string) => void;
  /** Where signed-in agents are kept: turns sign-in on (and requires it). */
  data?: string;
  /** A secret that encrypts the agents' keys at rest, so a copy of the folder alone gives none away. */
  kek?: string;
}): express.Express {
  const path = o.path ?? '/mcp';
  const base = o.publicUrl.replace(/\/$/, '');
  const resource = `${base}${path}`;
  const app = express();
  // The rate limits on the sign-in endpoints count by address: the proxy in front says whose.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  const sessions = new Map<string, { live: Live; principal?: string; transport: StreamableHTTPServerTransport; seen: number }>();
  const live = new Map<string, Live>();
  const cards = new Map<string, express.Express>();
  // Names in use by agents here, so no two answer to the same one.
  const named = new Map<string, string>();
  // And names already on cards the node lists, this Lake's and the ones it follows (run 48: two "Lumen"s, one per Lake,
  // and "a different name looks like an impostor" read the other way round). Refreshed as an agent starts.
  let listedNames = new Set<string>();
  const refreshListed = async () => {
    const seen = new Set<string>();
    for (const n of o.node.split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean)) {
      const found = (await fetch(`${n}/cards?idle=1`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => [])) as { card?: { name?: string } }[];
      for (const f of Array.isArray(found) ? found : []) if (f.card?.name) seen.add(f.card.name.split(' (')[0]!.trim());
    }
    if (seen.size) listedNames = seen;
  };
  const nameFor = (id: string) => {
    const taken = new Set([...named.values(), ...listedNames]);
    const start = parseInt(id.slice(0, 8), 16) % CREATURES.length;
    for (let k = 0; k < CREATURES.length; k++) {
      const n = CREATURES[(start + k) % CREATURES.length]!;
      if (!taken.has(n)) { named.set(id, n); return n; }
    }
    // More agents than names: the name and a few letters of its own.
    const n = `${CREATURES[start]} ${id.slice(0, 3)}`;
    named.set(id, n);
    return n;
  };

  // Each agent's card and A2A door, at <path>/a/<id>/: open to anyone (the node fetches cards), never behind sign-in.
  app.use(`${path}/a/:id`, (req, res, next) => {
    const sub = cards.get(String(req.params.id));
    return sub ? sub(req, res, next) : void res.status(404).json({ error: 'no such agent (its conversation ended)' });
  });

  // ---- Sign-in (OAuth 2.1 for MCP): only with a data folder ----
  const auth = o.data ? new LakeOAuth({ dir: join(o.data, 'auth'), base: resource, resource, title: 'the Lake sandbox' }) : undefined;
  const kek = o.kek ? createHash('sha256').update(o.kek).digest() : undefined;
  // An agent's saved state, sealed with AES-256-GCM when there's a key to seal it with.
  const seal = (s: AgentSnapshot): Record<string, unknown> => {
    if (!kek) return s as unknown as Record<string, unknown>;
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', kek, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(s)), c.final()]);
    return { sealed: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
  };
  const unseal = (v?: Record<string, unknown>): AgentSnapshot | undefined => {
    if (!v) return undefined;
    if (typeof v.sealed !== 'string') return v as unknown as AgentSnapshot;
    if (!kek) return undefined;
    const b = Buffer.from(v.sealed, 'base64'), d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    try { return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as AgentSnapshot; } catch { return undefined; }
  };
  let bearer: express.RequestHandler | undefined;
  if (auth) {
    const meta = {
      issuer: resource,
      authorization_endpoint: `${resource}/oauth/authorize`,
      token_endpoint: `${resource}/oauth/token`,
      registration_endpoint: `${resource}/oauth/register`,
      revocation_endpoint: `${resource}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    };
    // Where clients look (RFC 9728 and RFC 8414, path-inserted for an issuer with a path; some look under the issuer too).
    // The Lake node holds the root (/register is its own), so the endpoints live under <path>/oauth/.
    app.use(`/.well-known/oauth-protected-resource${path}`, metadataHandler({ resource, authorization_servers: [resource], resource_name: 'The Lake', bearer_methods_supported: ['header'] }));
    app.use(`/.well-known/oauth-authorization-server${path}`, metadataHandler(meta));
    app.use(`${path}/.well-known/oauth-authorization-server`, metadataHandler(meta));
    app.use(`${path}/oauth/authorize`, authorizationHandler({ provider: auth }));
    app.use(`${path}/oauth/token`, tokenHandler({ provider: auth }));
    app.use(`${path}/oauth/register`, clientRegistrationHandler({ clientsStore: auth.clientsStore, rateLimit: { windowMs: 3_600_000, limit: 30 } }));
    app.use(`${path}/oauth/revoke`, revocationHandler({ provider: auth }));
    const page = (res: express.Response, status: number, title: string, text: string) => void res.status(status).set('cache-control', 'no-store').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#070B12;color:#E8EEF4;font:16px/1.5 system-ui,-apple-system,sans-serif}main{max-width:440px;margin:0 auto;padding:36px 20px}p{color:#93A3B6}</style></head><body><main><h1>${title}</h1><p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p></main></body></html>`);
    const form = express.urlencoded({ extended: false, limit: '4kb' });
    // Through the person's house. The sign-in may be in an AI app's own browser, which doesn't hold the owner's key, so the
    // house is asked and its panel, wherever the key is, shows the request with a number to match (as other services
    // approve a sign-in on a device that's already signed in). A browser that holds the key can open the panel here too.
    const pending = new Map<string, { house: string; number: string; state: 'waiting' | 'done' | 'refused' | 'failed'; redirect?: string; error?: string; at: number }>();
    const sweepPending = () => { for (const [k, x] of pending) if (Date.now() - x.at > 20 * 60_000) pending.delete(k); };
    app.post(`${path}/oauth/house`, form, async (req, res) => {
      const ask = String(req.body?.ask ?? ''), asked = auth.asked(ask);
      if (!asked) return page(res, 400, 'Start again', 'This sign-in page has expired: start again from your AI app.');
      let house: URL;
      try { house = new URL(String(req.body?.house ?? '').trim()); } catch { return page(res, 400, 'Not an address', 'Paste your house\'s address, like https://sandbox.lake.doneinfifty.com/t/your-house.'); }
      if (!/^https?:$/.test(house.protocol)) return page(res, 400, 'Not an address', 'A house\'s address starts with https://.');
      const base = `${house.origin}${house.pathname.replace(/\/(a2a|owner\/?.*)?$/, '').replace(/\/$/, '')}`;
      const number = String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
      const told = await fetch(`${base}/owner/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ask, app: asked.app, from: asked.back, number, back: `${resource}/oauth/house/answer` }), signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const said = told ? ((await told.json().catch(() => ({}))) as { error?: string }) : { error: 'it didn\'t answer' };
      if (!told?.ok) return page(res, 400, 'Not connected', `Your house said: ${said.error ?? told?.status}.`);
      sweepPending();
      pending.set(ask, { house: base, number, state: 'waiting', at: Date.now() });
      const here = `${base}/owner/#${new URLSearchParams({ connect: ask, app: asked.app, from: asked.back, back: `${resource}/oauth/approve` })}`;
      const nonce = randomBytes(12).toString('base64url');
      res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'` });
      res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve in your house</title><style>
body{margin:0;background:#070B12;color:#E8EEF4;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}main{max-width:440px;margin:0 auto;padding:36px 20px}
h1{font-size:26px;line-height:1.2;margin:0 0 10px}p{color:#93A3B6}.num{font:700 44px ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#E8EEF4;margin:18px 0}
a{color:#3DDC97}.small{font-size:13px;color:#5C6B7E}#state{color:#E8EEF4}</style></head><body><main>
<h1>Approve it in your house</h1>
<p>Open your house's panel where you usually do (your phone's browser) and tap <b>Connect</b> on the request from ${asked.app.replace(/[&<>"']/g, '')}. It shows this number:</p>
<div class="num" aria-label="Number to match">${number}</div>
<p id="state">Waiting for your OK…</p>
<p class="small">Is your house's key in this browser? <a href="${here.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Open it here</a> instead. The request lasts 15 minutes.</p>
</main><script nonce="${nonce}">
(function(){var u=${JSON.stringify(`${resource}/oauth/house/status?ask=${encodeURIComponent(ask)}`)},s=document.getElementById('state');
function look(){fetch(u,{cache:'no-store'}).then(function(r){return r.json()}).then(function(x){
if(x.redirect){s.textContent='Approved. Back to your app…';location.href=x.redirect;return}
if(x.state==='refused'){s.textContent='Your house said no. You can close this.';return}
if(x.state==='failed'){s.textContent='It didn\u2019t work: '+(x.error||'try again from your app');return}
if(x.state==='gone'){s.textContent='This sign-in has expired: start again from your app.';return}
setTimeout(look,2000)}).catch(function(){setTimeout(look,4000)})}look()})();
</script></body></html>`);
    });
    // The house's answer, from the house itself (the owner tapped Connect or No in their panel).
    app.post(`${path}/oauth/house/answer`, express.json({ limit: '4kb' }), async (req, res) => {
      const q = (req.body ?? {}) as { ask?: string; house?: string; code?: string; refused?: boolean };
      const w = pending.get(String(q.ask ?? ''));
      if (!w || w.state !== 'waiting') return void res.status(404).json({ error: 'no sign-in waiting for that' });
      if (String(q.house ?? '').replace(/\/$/, '') !== w.house) return void res.status(403).json({ error: 'that sign-in asked another house' });
      if (q.refused) { w.state = 'refused'; auth.cancel(String(q.ask)); return void res.json({ ok: true }); }
      const r = auth.approve(String(q.ask));
      if ('error' in r) { w.state = 'failed'; w.error = r.error; return void res.status(400).json({ error: r.error }); }
      try {
        const l = await agentFor(r.principal);
        const { name } = await l.agent.connectHouse(w.house, String(q.code ?? ''), r.app);
        w.state = 'done';
        w.redirect = r.redirect;
        res.json({ ok: true, name });
      } catch (e) {
        const l = live.get(r.principal);
        if (l) await sleep(l);
        auth.forget(r.principal);
        w.state = 'failed';
        w.error = (e as Error).message;
        res.status(400).json({ error: (e as Error).message });
      }
    });
    app.get(`${path}/oauth/house/status`, (req, res) => {
      const w = pending.get(String(req.query.ask ?? ''));
      res.set('cache-control', 'no-store').json(w ? { state: w.state, ...(w.redirect ? { redirect: w.redirect } : {}), ...(w.error ? { error: w.error } : {}) } : { state: 'gone' });
    });
    app.post(`${path}/oauth/approve`, form, async (req, res) => {
      const r = auth.approve(String(req.body?.ask ?? ''));
      if ('error' in r) return page(res, 400, 'Not connected', r.error);
      // From the house: its panel made a one-time assistant code with the owner's key; this agent takes it now.
      const house = typeof req.body?.house === 'string' ? req.body.house : '', code = typeof req.body?.code === 'string' ? req.body.code : '';
      if (house && code) {
        try {
          const l = await agentFor(r.principal);
          await l.agent.connectHouse(house, code, r.app);
        } catch (e) {
          const l = live.get(r.principal);
          if (l) await sleep(l);
          auth.forget(r.principal);
          return page(res, 400, 'Not connected', `Your house said: ${(e as Error).message}. Start again from your AI app.`);
        }
      }
      res.redirect(302, r.redirect);
    });
    // For scripts and simulations, which have no browser to tap in: the sandbox's one-tap sign-in, without the tap.
    const anonCount = new Map<string, number[]>();
    app.post(`${path}/oauth/anonymous`, (req, res) => {
      const ip = req.ip ?? '', hour = (anonCount.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
      if (hour.length >= 20) return void res.status(429).json({ error: 'too many sign-ins from here this hour' });
      anonCount.set(ip, [...hour, Date.now()]);
      const r = auth.anonymous();
      if ('error' in r) return void res.status(503).json(r);
      res.json(r);
    });
    bearer = requireBearerAuth({ verifier: auth, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource${path}` });
  }
  app.use(path, express.json({ limit: '256kb' }));

  /** The agent for a principal (awake, woken from disk, or new), or a fresh one for an unsigned conversation. */
  const agentFor = async (principal?: string): Promise<Live> => {
    const awake = principal ? live.get(principal) : undefined;
    if (awake) return awake;
    if (live.size >= (o.maxSessions ?? 40)) throw new Error('the sandbox is full right now; try again in a few minutes');
    const id = principal ? principal.replace(/^p-/, '') : randomBytes(4).toString('hex');
    const saved = principal ? unseal(auth!.principal(principal)?.agent) : undefined;
    if (saved?.who) named.set(id, saved.who.name.split(' (')[0]!);
    await refreshListed();
    const entry: Live = { id, principal, sessions: new Set(), seen: Date.now(), agent: undefined as unknown as LakeMcpAgent };
    entry.agent = lakeMcpAgent(
      { ...o, name: '', domain: '', publicUrl: `${resource}/a/${id}`, mount: (agentApp) => cards.set(id, agentApp) },
      {
        // Named after the assistant that connected, plus a name of its own, so four Claudes aren't four "Claude"s:
        // "Atlas (Claude, via MCP)", claude-ai-3f9a.mcp.example.
        identity: (client) => {
          const who = (client?.name ?? 'assistant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'assistant';
          const label = /claude/i.test(client?.name ?? '') ? 'Claude' : client?.name ?? 'an assistant';
          return { name: `${nameFor(id)} (${label}, via MCP)`, domain: `${who}-${id}.mcp.example` };
        },
        onAgent: (agent: LakeAgent) => { o.log?.(`${agent.domain} joined over MCP${principal ? ' (signed in)' : ''}`); },
        ...(principal ? { saved, save: (s: AgentSnapshot) => auth!.saveAgent(principal, seal(s)) } : {}),
      },
    );
    if (principal) live.set(principal, entry);
    return entry;
  };
  const sleep = async (l: Live) => {
    if (l.principal) live.delete(l.principal);
    cards.delete(l.id);
    named.delete(l.id);
    await l.agent.close().catch(() => {});
  };
  const endSession = (sid: string) => {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    s.live.sessions.delete(sid);
    // An unsigned agent lives as long as its one conversation; a signed-in one stays for the next.
    if (!s.live.principal && !s.live.sessions.size) void sleep(s.live);
  };
  setInterval(() => {
    for (const [sid, s] of sessions) if (Date.now() - s.seen > 30 * 60_000) { void s.transport.close().catch(() => {}); endSession(sid); }
    for (const l of live.values()) if (!l.sessions.size && Date.now() - l.seen > SLEEP_MS) void sleep(l);
  }, 60_000).unref();

  const principalOf = (req: express.Request) => (req as express.Request & { auth?: { extra?: { principal?: string } } }).auth?.extra?.principal;
  const signedIn: express.RequestHandler[] = bearer ? [bearer] : [];

  app.post(path, ...signedIn, async (req, res) => {
    const sid = req.get('mcp-session-id');
    const principal = principalOf(req);
    let s = sid ? sessions.get(sid) : undefined;
    // A conversation belongs to whoever opened it: another sign-in's token can't use it.
    if (s && s.principal !== principal) return void res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'this conversation belongs to another sign-in' }, id: null });
    if (!s) {
      if (sid || !isInitializeRequest(req.body)) return void res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'unknown or missing session; start with initialize' }, id: null });
      if (sessions.size >= (o.maxSessions ?? 40) * 2) return void res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'the sandbox is full right now; try again in a few minutes' }, id: null });
      let l: Live;
      try { l = await agentFor(principal); } catch (e) { return void res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: (e as Error).message }, id: null }); }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => { sessions.set(newSid, entry); l.sessions.add(newSid); },
      });
      const entry = { live: l, principal, transport, seen: Date.now() };
      transport.onclose = () => { if (transport.sessionId) endSession(transport.sessionId); };
      await l.agent.session().connect(transport);
      s = entry;
    }
    s.seen = s.live.seen = Date.now();
    if (principal) auth!.touch(principal);
    await s.transport.handleRequest(req, res, req.body);
  });

  const stream = async (req: express.Request, res: express.Response) => {
    const s = sessions.get(req.get('mcp-session-id') ?? '');
    if (!s || s.principal !== principalOf(req)) return void res.status(400).send('unknown session');
    s.seen = s.live.seen = Date.now();
    await s.transport.handleRequest(req, res);
  };
  app.get(path, ...signedIn, stream);
  app.delete(path, ...signedIn, stream);
  app.get('/health', (_req, res) => void res.json({ ok: true, sessions: sessions.size, agents: live.size }));
  // Saved as they are, on the way down (a deploy): signed-in agents come back as themselves.
  const down = async () => { await Promise.all([...live.values()].map((l) => l.agent.close().catch(() => {}))); process.exit(0); };
  if (auth) { process.once('SIGTERM', () => void down()); process.once('SIGINT', () => void down()); }
  return app;
}
