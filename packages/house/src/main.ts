#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { page } from './page.js';
import { describe, HANDLE, keepAliveBehindProxy, parseCli, parseRules, seedFrom, type LakeEvent } from '@thelakeprotocol/core';
import { randomBytes } from 'node:crypto';

import { startHouse, type House } from './house.js';
import { loadPacks } from './packs.js';
import { closePodRoot, externalSession, ownerSession, startPod, startProvider, tenantSessions, type OwnerSession } from './pod.js';

const { values: a } = parseCli({
  name: 'lake-house',
  about: 'A Lake house: your Solid pod and the housekeeper that answers by your rules (https://lake.doneinfifty.com/docs/join).',
  usage: 'lake-house --name <you> [--data <dir>] [--rules <rules.yaml>] [--lake <node url>] [--join <lake url>] [--relay] …',
  example: 'NODE_ENV=production lake-house --name you --data ./my-house --rules personas/research.yaml --lake http://localhost:7000 --issuer-url http://localhost:4300/issuer --auditor-url http://localhost:4300/auditor',
  notes: { name: 'your house\'s name (its pod and WebID)', data: 'where the pod, its keys and the house\'s state live: back this folder up', rules: 'your rules.yaml', port: 'the house\'s HTTP port (A2A, panel at /owner/, page at /)', 'pod-port': 'the Solid pod\'s port', lake: 'the Lake node(s) to announce to, comma-separated', join: 'a Lake that serves its specialists under /s/ (the sandbox does): node, issuer and auditor in one', 'issuer-url': 'where your pack\'s demo records come from', 'auditor-url': 'who certifies the converter', relay: 'reached through the node: nothing to open on your router', handle: 'open your door under this handle', tenants: 'host this many houses in one process', 'public-url': 'the address others reach this house at', connector: 'the Lake\'s MCP connector, for an AI on duty the house runs (default: this site\'s /mcp)', 'duty-model': 'a model this house offers owners for their AI on duty: stub, anthropic or anthropic:<model> (an operator\'s ANTHROPIC_API_KEY)' },
  options: {
    name: { type: 'string' },
    rules: { type: 'string', default: process.env.LAKE_RULES ?? '/rules.yaml' },
    data: { type: 'string', default: process.env.LAKE_DATA ?? '/data' },
    port: { type: 'string', default: process.env.LAKE_PORT ?? '4000' },
    'pod-port': { type: 'string', default: process.env.LAKE_POD_PORT ?? '3000' },
    'public-url': { type: 'string', default: process.env.LAKE_PUBLIC_URL },
    // The owner's AI on duty, run by the house: the Lake's connector, and a model the operator offers ("stub", "anthropic").
    connector: { type: 'string', default: process.env.LAKE_MCP_URL },
    'duty-model': { type: 'string', default: process.env.LAKE_DUTY_MODEL },
    'pod-url': { type: 'string', default: process.env.LAKE_POD_URL },
    // The use cases this house takes part in, by pack id (each one is a package: @thelakeprotocol/usecase-<id>).
    packs: { type: 'string', default: process.env.LAKE_PACKS ?? 'health' },
    // Each pack's issuer: health=http://…,mortgage=http://… (--issuer-url sets the first pack's, as before).
    issuers: { type: 'string', default: process.env.LAKE_ISSUERS },
    'issuer-url': { type: 'string', default: process.env.LAKE_ISSUER_URL },
    lake: { type: 'string', default: process.env.LAKE_NODE_URL },
    'auditor-url': { type: 'string', default: process.env.LAKE_AUDITOR_URL },
    // The person checker this house asks for its stamp (one person, one house); none by default.
    'person-url': { type: 'string', default: process.env.LAKE_PERSON_URL },
    // The tellers this operator vouches for, by address: where domains aren't proven (a sandbox), houses trust tellers only here.
    tellers: { type: 'string', default: process.env.LAKE_TELLERS },
    join: { type: 'string', default: process.env.LAKE_JOIN },
    // A house at home with its door open under a handle from the start: anyone's AI can "ping" it.
    handle: { type: 'string', default: process.env.LAKE_HANDLE },
    // Bring your own pod (any Solid server): your WebID and client credentials registered with its identity provider.
    webid: { type: 'string', default: process.env.LAKE_WEBID },
    'client-id': { type: 'string', default: process.env.LAKE_CLIENT_ID },
    'client-secret': { type: 'string', default: process.env.LAKE_CLIENT_SECRET },
    pod: { type: 'string', default: process.env.LAKE_POD },
    'oidc-issuer': { type: 'string', default: process.env.LAKE_OIDC_ISSUER },
    'pod-folder': { type: 'string', default: process.env.LAKE_POD_FOLDER ?? 'lake' },
    seed: { type: 'string', default: process.env.LAKE_SEED },
    'owner-url': { type: 'string', default: process.env.LAKE_OWNER_URL },
    'open-pairing': { type: 'boolean', default: process.env.LAKE_OPEN_PAIRING === '1' },
    domain: { type: 'string', default: process.env.LAKE_DOMAIN },
    // The demo specialists' domain(s) on this deployment (SPEC §5.1): trusted by default on a sandbox. Comma-separated.
    'demo-domain': { type: 'string', default: process.env.LAKE_DEMO_DOMAIN ?? 'lake.local' },
    production: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    tenants: { type: 'string', default: process.env.LAKE_TENANTS },
    // How many hosted houses start (and join) at once: a small machine starting ten pods together runs out of memory.
    'start-concurrency': { type: 'string', default: process.env.LAKE_START_CONCURRENCY ?? '8' },
    'tenant-prefix': { type: 'string', default: process.env.LAKE_TENANT_PREFIX },
    'personas-dir': { type: 'string', default: process.env.LAKE_PERSONAS ?? '/personas' },
    relay: { type: 'boolean', default: process.env.LAKE_RELAY === '1' },
    // With --open-pairing, how long a claim lasts before the house resets for the next person (0: forever).
    'lease-hours': { type: 'string', default: process.env.LAKE_LEASE_HOURS },
    // Hosted houses kept for someone (comma-separated names): no lease, not on the claim list, paired only with the token
    // in the house's data folder, which the operator hands to its owner.
    kept: { type: 'string', default: process.env.LAKE_KEPT },
    // Invites (a hosted Lake): each owner may bring this many people in, each with a house of their own, up to a total.
    'invites-each': { type: 'string', default: process.env.LAKE_INVITES_EACH ?? '5' },
    'max-houses': { type: 'string', default: process.env.LAKE_MAX_HOUSES ?? '20' },
  },
});
// Its data folder first: outside Docker the default /data usually isn't writable, and the error was a stack trace.
try { mkdirSync(a.data!, { recursive: true }); accessSync(a.data!, constants.W_OK); } catch (e) {
  console.error(`lake-house: can't write to ${a.data} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): pass --data ./my-house (or LAKE_DATA). In Docker, /data is the volume.`);
  process.exit(2);
}

// `--join https://sandbox.lake.example`: one flag for a house at home. That Lake's node, its issuer and
// auditor (at /s/issuer, /s/auditor, as a sandbox serves them), reached through its relay.
if (a.join) {
  const lake = a.join.replace(/\/$/, '');
  a.lake ??= lake;
  a['auditor-url'] ??= `${lake}/s/auditor`;
  a['person-url'] ??= `${lake}/s/person`;
  a.tellers ??= `${lake}/s/teller-a/a2a,${lake}/s/teller-b/a2a`;
  a.relay = true;
}
const port = Number(a.port);
const podPort = Number(a['pod-port']);
// In Docker, other containers reach us by our hostname (set it with --hostname); elsewhere, localhost.
const inDocker = existsSync('/.dockerenv');
// Joining from home, only you open this address (your control panel); everyone else comes through the relay.
const baseUrl = (a['public-url'] ?? `http://${inDocker && !a.join ? hostname() : 'localhost'}:${port}`).replace(/\/$/, '');
const podUrl = (a['pod-url'] ?? `http://localhost:${podPort}`).replace(/\/?$/, '/');
// Solid-OIDC only trusts HTTPS issuers, or plain HTTP on localhost (solid.github.io/solid-oidc/#security-tls).
const podHost = new URL(podUrl);
if (podHost.protocol === 'http:' && podHost.hostname.split('.').pop() !== 'localhost') {
  console.error(`--pod-url ${podUrl}: Solid-OIDC needs HTTPS here, or plain HTTP on localhost. Put TLS in front of the pod, or leave --pod-url unset.`);
  process.exit(2);
}
const sandbox = !a.production;
const packs = await loadPacks(a.packs!.split(','), (n) => import(n));
// A pack's issuer: named explicitly, or the joined Lake's (/s/<path>), or the demo compose service (<path>:4300).
const named = Object.fromEntries((a.issuers ?? '').split(',').filter((x) => x.includes('=')).map((x) => x.split('=').map((y) => y.trim()) as [string, string]));
const issuerUrls = Object.fromEntries(packs.filter((p) => p.source).map((p, i) => [p.id,
  (named[p.id] ?? (i === 0 ? a['issuer-url'] : undefined) ?? (a.join ? `${a.join.replace(/\/$/, '')}/s/${p.source!.issuer.path}` : `http://${p.source!.issuer.path}:4300`)).replace(/\/$/, '')]));
const common = { packs, issuerUrls, auditorUrl: a['auditor-url'] ?? 'http://auditor:4400', personUrl: a['person-url'], tellerUrls: (a.tellers ?? '').split(',').map((u) => u.trim()).filter(Boolean), lakeUrl: a.lake, seed: a.seed, sandbox, domain: a.domain,
  demoDomains: a['demo-domain']!.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean), connector: a.connector, dutyModel: a['duty-model'] };

if (a.tenants) await hosted(Number(a.tenants));
else await single();

/** One house: its own pod server, its own port. `docker run lake-house --name you`. */
async function single() {
  const fileRules = await readFile(a.rules!, 'utf8').catch(() => readFile(new URL('../../../personas/stan.yaml', import.meta.url), 'utf8'));
  // --handle: the door open under it, unless the rules already open one (the owner's own rules, later, win).
  const handle = a.handle?.trim().toLowerCase();
  if (handle && !HANDLE.test(handle)) throw new Error('--handle: 2 to 30 lowercase letters, digits or dashes, starting with a letter');
  const rulesText = handle && !parseRules(fileRules).door?.handle ? `${fileRules.replace(/^door:.*$/m, '')}\ndoor: { handle: ${handle} }\n` : fileRules;
  const rules = parseRules(rulesText);
  const name = (a.name ?? rules.owner ?? hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const actor = `house:${name}`;
  const emit = (e: LakeEvent) => console.log(a.json ? JSON.stringify(e) : `[${actor}] ${describe(e)}`);
  const say = (msg: string) => console.log(a.json ? JSON.stringify({ at: new Date().toISOString(), actor, msg }) : `[${actor}] ${msg}`);

  const podOpts = { dataDir: `${a.data}/${name}`, port: podPort, baseUrl: podUrl, owner: name };
  let pod: { stop: () => void } | null = null;
  let owner: OwnerSession;
  if (a.webid) {
    if (!a['client-id'] || !a['client-secret']) throw new Error('--webid needs --client-id and --client-secret: register an app with your Solid identity provider');
    const x = await externalSession({ webId: a.webid, clientId: a['client-id'], clientSecret: a['client-secret'], podRoot: a.pod, oidcIssuer: a['oidc-issuer'], folder: a['pod-folder'] });
    owner = x;
    await mkdir(podOpts.dataDir, { recursive: true }); // the owner's desk keeps its pairing state here
    say(`your own pod: ${owner.podRoot} (WebID ${owner.webId}, logged in at ${x.oidcIssuer})`);
  } else {
    say(`starting pod for ${name}`);
    pod = await startPod(podOpts);
    owner = await ownerSession(podOpts);
    if (await closePodRoot(owner)) say('closed the pod\'s top folder to strangers');
    say(`pod up: ${owner.podRoot} (WebID ${owner.webId})`);
  }

  if (a.relay && !a.lake) throw new Error('--relay needs at least one Lake node (--lake or LAKE_NODE_URL) to relay through');
  const house = await startHouse({ ...common, name, rulesText, owner, dataDir: podOpts.dataDir, publicUrl: baseUrl, ownerUrl: a['owner-url'], openPairing: a['open-pairing'], leaseHours: a['open-pairing'] && a['lease-hours'] ? Number(a['lease-hours']) || undefined : undefined, emit, say, quiet: a.json, relay: a.relay ? { localPort: port } : undefined });
  const server = house.app.listen(port, async () => {
    say(a.relay ? `reached through the Lake's relay: ${house.card.supportedInterfaces.map((i) => i.url).join(' · ')}` : `A2A on ${baseUrl}/a2a · card at ${baseUrl}/.well-known/agent-card.json${sandbox ? ' · sandbox Lake' : ''}`);
    await house.join();
  });
  keepAliveBehindProxy(server);
  const stop = async () => {
    await house.leave();
    server.close();
    pod?.stop();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/**
 * Many houses in one process, like a pod provider: `lake-house --tenants 250`. Each is still its own
 * WebID, pod, wallet, signed card and rules file; only the process (and one pod server) is shared.
 */
async function hosted(n: number) {
  const t0 = Date.now();
  const prefix = (a['tenant-prefix'] ?? `${hostname().replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}-`).replace(/[^a-z0-9-]/g, '');
  const kept = new Set((a.kept ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9-]{2,30}$/.test(x)));
  const dataDir = join(a.data!, 'hosted');
  // Houses people were invited into: kept (no lease), and back after a restart. Invites: one-time codes, a few per owner.
  type Invite = { code: string; by: string; at: string; used?: string };
  const invitedFile = join(dataDir, 'invited.json'), invitesFile = join(dataDir, 'invites.json');
  const invited: { name: string; by: string; at: string }[] = existsSync(invitedFile) ? JSON.parse(await readFile(invitedFile, 'utf8')) : [];
  const invites: Invite[] = existsSync(invitesFile) ? JSON.parse(await readFile(invitesFile, 'utf8')) : [];
  for (const i of invited) kept.add(i.name);
  // An invited house is open to pair until its new owner's phone pairs it (then it's theirs, with no lease).
  const isInvited = (name: string) => invited.some((i) => i.name === name) || invites.some((i) => i.used === name);
  const names = [...Array.from({ length: n }, (_, i) => `${prefix}${i}`), ...kept];
  const log = (msg: string) => console.log(`[hosted ${prefix}*] ${msg}`);
  // One process holds every hosted house: a slip in one (a pod write that timed out) must not take down the rest.
  process.on('unhandledRejection', (e) => log(`unhandled: ${(e as Error)?.message ?? e}`));

  log(`starting one pod server for ${n} houses`);
  const pods = await startProvider({ dataDir, port: podPort, baseUrl: podUrl, names });
  const sessions = await tenantSessions({ dataDir, baseUrl: podUrl, names });
  let closed = 0;
  await pool([...sessions.values()], 8, async (o) => { if (await closePodRoot(o).catch(() => false)) closed++; });
  if (closed) log(`closed ${closed} pods' top folders to strangers`);
  log(`${n} pods up, ${n} owners logged in (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const personas = await loadPersonas(a['personas-dir']!);
  const TAGS = ['research-volunteers', 'carers', 'renters', 'energy-buyers', 'cyclists'];
  const app = express();
  const houses: House[] = [];
  let warnings = 0;
  const at = Math.max(1, Number(a['start-concurrency']) || 8);
  const startOne = async (name: string, door?: { handle: string; name?: string }) => {
    // Each hosted house gets its own rules file: a persona, its own owner name, one or two interests.
    const h = seedFrom(name);
    // Personas are picked by their `# weight:`, the same one every time for the same house; `{{pick:a,b}}` picks a choice the same way.
    const total = personas.reduce((n, p) => n + p.weight, 0);
    let at = h % total;
    const persona = personas.find((p) => (at -= p.weight) < 0)!.text;
    let k = 0;
    const filled = persona.replace(/\{\{pick:([^}]+)\}\}/g, (_, list: string) => { const xs = list.split(','); return xs[seedFrom(`${name}|${k++}`) % xs.length]!.trim(); });
    const tags = [TAGS[h % TAGS.length]!, ...(h % 3 === 0 ? [TAGS[(h >> 3) % TAGS.length]!] : [])];
    const rulesText = filled.replace(/^owner: .*$/m, `owner: ${name}`).replace(/^tags: .*$/m, '').replace(/^door:.*$/m, '') + `\ntags: [${[...new Set(tags)].join(', ')}]\n` + (door ? `door: { handle: ${door.handle}${door.name ? `, name: ${JSON.stringify(door.name)}` : ''} }\n` : '');
    const houseDir = join(dataDir, 'houses', name);
    await mkdir(houseDir, { recursive: true });
    await writeFile(join(houseDir, 'rules.yaml'), rulesText);
    const house = await startHouse({
      ...common, name, rulesText, owner: sessions.get(name)!, dataDir: houseDir, publicUrl: `${baseUrl}/t/${name}`, openPairing: a['open-pairing'] && (!kept.has(name) || isInvited(name)),
      leaseHours: a['open-pairing'] && !kept.has(name) ? Number(a['lease-hours'] ?? 24) || undefined : undefined,
      emit: () => {}, say: (msg) => { if (/WARNING|BROKEN/.test(msg)) { warnings++; log(`${name}: ${msg}`); } }, quiet: true, invite: () => inviteFor(name)(),
    });
    app.use(`/t/${name}`, house.app);
    houses.push(house);
    return house;
  };
  // An owner's invite: a one-time link to a house of their own, if the owner has some left and the Lake has room.
  const inviteFor = (by: string) => async () => {
    // Only a house that stays someone's invites: a house claimed for a day could otherwise fill the Lake.
    if (!kept.has(by)) return { error: 'only a house that stays yours can invite (one you were invited into, or kept for you); a house claimed for a day can\'t' };
    const mine = invites.filter((x) => x.by === by).length, each = Number(a['invites-each']) || 0;
    if (mine >= each) return { error: `you have used your ${each} invites` };
    if (houses.length + invites.filter((x) => !x.used).length >= (Number(a['max-houses']) || 0)) return { error: 'this Lake is full for now: they can run a house of their own (lake.doneinfifty.com/docs/join)' };
    const code = randomBytes(9).toString('base64url');
    invites.push({ code, by, at: new Date().toISOString() });
    await writeFile(invitesFile, JSON.stringify(invites));
    return { link: `${baseUrl}/t/join/${code}`, left: each - mine - 1 };
  };
  // The door opens before the houses do: each answers as soon as it's up, and one still starting says so (503 with
  // Retry-After) where a proxy in front would say "bad gateway" (12 Nov: fifteen houses took 340 s on the sandbox's one
  // core, and nobody's house answered until the last was up).
  const starting = new Set(names), failed = new Set<string>();
  app.use('/t/:name', (req, res, next) => {
    const name = String(req.params.name);
    if (failed.has(name)) return void res.status(503).json({ error: 'this house could not start; whoever runs this server can see why in its log' });
    if (starting.has(name)) return void res.status(503).set('Retry-After', '20').json({ error: 'this house is starting; try again in a moment' });
    next();
  });
  app.get('/health', (_req, res) => void res.json({ ok: !starting.size && !failed.size, houses: houses.length, starting: starting.size, failed: failed.size }));
  // An invite's link: pick a handle, and a house of your own starts for you (yours to pair, kept, no lease).
  // Who sent it, as they're known on the Lake: their door's name, else their handle.
  const inviterOf = (by: string) => { const d = houses.find((x) => x.name === by)?.keeper.rules.door; return d?.name ?? d?.handle ?? ''; };
  const invitePage = (code: string, why = '', by = '') => page('Your invite to the Lake', `<p class="eyebrow"><i></i>The Lake</p><h1>${by ? `${by.replace(/[<>&"]/g, '')} invited you to the Lake` : 'You\'re invited to the Lake'}</h1>
<p class="lead">Want people to reach you through their AI too? Pick a handle, your name on the Lake: anyone can then ask their AI to message it, and it lands on your phone.</p>
${why ? `<p class="chip">${why.replace(/[<>&]/g, '')}</p>` : ''}
<form method="post" action="${code}" style="display:grid;gap:14px;margin-top:18px">
<label style="display:grid;gap:6px"><b>Handle</b><input name="handle" required maxlength="30" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="e.g. alex" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,'')" style="width:100%;font-size:17px;padding:10px"><span class="small">Lowercase letters, numbers and dashes, starting with a letter.</span></label>
<label style="display:grid;gap:6px"><b>Your name</b> <span class="small">(optional)</span><input name="name" maxlength="60" placeholder="e.g. Alex" style="width:100%;font-size:17px;padding:10px"><span class="small">Shown to people who ping you.</span></label>
<button class="btn primary" type="submit" style="font-size:17px;padding:12px">Continue</button></form>
<p class="small" style="margin-top:18px">Next, this phone becomes the only key to your house. Sandbox: synthetic data, play money, real signatures.</p>`);
  app.get('/t/join/:code', (req, res) => {
    const inv = invites.find((x) => x.code === req.params.code);
    if (!inv || inv.used) return void res.status(404).type('html').send(page('Invite', '<h1>This invite has been used, or never was</h1><p class="lead">Ask whoever sent it for a new one.</p>'));
    res.type('html').send(invitePage(inv.code, '', inviterOf(inv.by)));
  });
  app.post('/t/join/:code', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
    const inv = invites.find((x) => x.code === req.params.code);
    const wantsJson = req.is('application/json');
    const fail = (status: number, why: string) => void (wantsJson ? res.status(status).json({ error: why }) : res.status(status).type('html').send(invitePage(String(req.params.code), why, inv ? inviterOf(inv.by) : '')));
    if (!inv || inv.used) return fail(404, 'this invite has been used, or never was');
    const handle = String(req.body?.handle ?? '').trim().toLowerCase(), shown = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!HANDLE.test(handle)) return fail(400, 'a handle: 2 to 30 lowercase letters, digits or dashes, starting with a letter');
    const taken = await fetch(`${String(a.lake ?? '').split(',')[0]!.trim().replace(/\/$/, '')}/handles/${handle}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
    if (taken) return fail(409, `"${handle}" is taken on this Lake; choose another`);
    inv.used = `h-${randomBytes(4).toString('hex')}`;
    await writeFile(invitesFile, JSON.stringify(invites));
    try {
      await tenantSessions({ dataDir, baseUrl: podUrl, names: [inv.used] }).then((m) => sessions.set(inv.used!, m.get(inv.used!)!));
      await closePodRoot(sessions.get(inv.used)!).catch(() => false);
      kept.add(inv.used);
      const house = await startOne(inv.used, { handle, ...(shown ? { name: shown } : {}) });
      await house.join();
      invited.push({ name: inv.used, by: inv.by, at: new Date().toISOString() });
      await writeFile(invitedFile, JSON.stringify(invited));
      log(`${inv.by} invited ${inv.used} (${handle})`);
      const panel = `${baseUrl}/t/${inv.used}/owner/`;
      return void (wantsJson ? res.json({ house: `${baseUrl}/t/${inv.used}`, panel, handle }) : res.redirect(303, panel));
    } catch (e) {
      log(`invite ${inv.code}: ${(e as Error).message}`);
      return fail(500, 'the house could not start just now; try again in a minute');
    }
  });
  // Which houses are free to claim right now, and when the taken ones free up.
  app.get('/t/', (_req, res) => {
    const rows = houses.filter((h) => !kept.has(h.name)).sort((x, y) => x.name.localeCompare(y.name, 'en', { numeric: true })).map((h) => ({ name: h.name, until: h.desk.ownerJwk ? h.desk.leaseUntil()?.toISOString() ?? 'kept' : null }));
    if (_req.accepts(['html', 'json']) === 'json') return void res.json(rows);
    // The same look as the house's own pages and the owner's panel.
    const li = rows.map((r) => r.until
      ? `<li><span>House ${r.name}</span><span class="chip">${r.until === 'kept' ? 'taken' : `taken until ${r.until.slice(11, 16)} UTC`}</span></li>`
      : `<li><span>House ${r.name}</span><a class="btn primary small" href="${r.name}/owner/">Claim it</a></li>`).join('');
    const hours = Number(a['lease-hours'] ?? 24) || 0;
    res.type('html').send(page('Claim a house', `<p class="eyebrow"><i></i>The Lake sandbox</p><h1>Claim a house</h1>
<p class="lead">Free to try: synthetic data, simulated money, real signatures. Open one and tap <b>Use this phone</b>: your phone becomes its key.</p>
<ul class="list">${li}</ul>
<details><summary>What happens next</summary><ul class="small"><li>Pick a handle: then anyone can ask their AI to ping you, and the note reaches your phone. You answer there, or let your own AI answer.</li><li>Give your own AI a key, and it can also look for things you need and suggest; you decide.</li><li>${hours ? `A claim lasts ${hours} hours, then the house resets for the next person.` : 'A claim lasts until you hand it back.'} You can hand it back any time.</li></ul></details>`));
  });

  const server = app.listen(port, async () => {
    // Houses that are someone's come first (kept or invited: a person is waiting on them), then the ones free to claim.
    const order = [...names.filter((x) => kept.has(x)), ...names.filter((x) => !kept.has(x))];
    let mine = 0;
    const took: number[] = [];
    await pool(order, at, async (name) => {
      const t = Date.now();
      try {
        const house = await startOne(name);
        starting.delete(name);
        took.push(Date.now() - t);
        await house.join();
      } catch (e) {
        // One house that can't start (its pod didn't answer) doesn't keep the others shut.
        starting.delete(name);
        failed.add(name);
        warnings++;
        log(`${name}: could not start: ${(e as Error).message}`);
      }
      if (kept.has(name) && ++mine === kept.size) log(`${mine} kept houses up after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    });
    took.sort((x, y) => x - y);
    const secs = (ms: number) => (ms / 1000).toFixed(1);
    log(`${houses.length} houses joined in ${secs(Date.now() - t0)}s${took.length ? ` (a house took ${secs(took[took.length >> 1]!)}s to start, the slowest ${secs(took[took.length - 1]!)}s, ${at} at a time)` : ''}${warnings ? ` (${warnings} warnings)` : ''}; each at ${baseUrl}/t/<name>/a2a`);
  });
  keepAliveBehindProxy(server);
  const stop = async () => {
    await Promise.all(houses.map((h) => h.leave()));
    server.close();
    pods.stop();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Every persona in the folder (personas/*.yaml), with its `# weight:` (default 1). */
async function loadPersonas(dir: string): Promise<{ name: string; text: string; weight: number }[]> {
  const from = existsSync(dir) ? dir : new URL('../../../personas/', import.meta.url).pathname;
  const files = (await readdir(from)).filter((f) => f.endsWith('.yaml')).sort();
  return Promise.all(files.map(async (f) => {
    const text = await readFile(join(from, f), 'utf8');
    return { name: f.replace(/\.yaml$/, ''), text, weight: Number(text.match(/^# weight: (\d+)/m)?.[1] ?? 1) };
  }));
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}
