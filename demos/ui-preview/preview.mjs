// Screenshots of a house's control panel and door page, as a phone and a laptop see them, for design review.
//   node demos/ui-preview/preview.mjs seed [lake] [house]   claims a free house on a (local) Lake and fills it: an open
//                                                          door, hours, an assistant with suggestions and agenda entries,
//                                                          and a stranger's note
//   node demos/ui-preview/preview.mjs shots <out-dir>      serves packages/ui/dist in front of that house and takes
//                                                          screenshots of every tab (390×844 and 1280×900) and the door page
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { generateIdentity, exportIdentity, signMessage } from '../../packages/core/dist/index.js';
import { joinLake } from '../../packages/agent/dist/index.js';

const here = import.meta.dirname;
const statePath = join(here, '.state.json');
const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === 'seed') {
  const lake = a1 ?? 'http://lake-a.localhost:8081';
  const name = a2 ?? 'sb-1';
  const url = `${lake}/t/${name}`;
  const owner = await generateIdentity('preview-owner');
  const pair = await (await fetch(`${url}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: owner.publicJwk }) })).json();
  if (!pair.paired) throw new Error(`pair: ${JSON.stringify(pair)}`);
  const call = async (p, id = owner, iss = pair.webId) => (await fetch(`${url}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(p, id, { iss })) })).json();
  await call({ kind: 'panel.door.set', open: true, about: 'Send your AI over: mine knows when I\'m free.' });
  await call({ kind: 'panel.availability.set', availability: { tz: 'Australia/Sydney', free: ['mon-fri 08:00-11:00'], meetings: 45 } });
  // Its own assistant, connected with a code from My agent, with a few things to show.
  const { code } = await call({ kind: 'panel.assistant.invite', label: 'Claude' });
  const port = () => new Promise((ok) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const helper = await generateIdentity('preview-helper');
  const connected = await (await fetch(`${url}/owner/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: helper.publicJwk, code, label: 'Nova (Claude, via MCP)', webId: 'https://preview-helper.mcp.example/#agent' }) })).json();
  const asHelper = (p) => call(p, helper, 'assistant');
  console.log(JSON.stringify(await asHelper({ kind: 'assistant.suggest', text: 'Robin (an agent says it acts for them; not verified) would like a coffee next week. You are free Mon 2 Nov 8:00 or Tue 3 Nov 9:30. Offer one?', ask: { choices: ['Offer Mon 8:00', 'Offer Tue 9:30', 'Not now'], recommend: 0 } })));
  console.log(JSON.stringify(await asHelper({ kind: 'assistant.suggest', text: 'Your door line could say you are away until Friday, so people know to expect a slower answer.', door: { about: 'Away until Friday: ask my agent, it answers for me.' }, advice: 'do' })));
  console.log(JSON.stringify(await asHelper({ kind: 'assistant.agenda', what: 'Coffee with Robin', when: 'Mon 2 Nov, 8:00', start: '2026-11-01T21:00:00Z', where: 'Corner café', with: 'Robin (via Gale)', note: 'Offered; waiting for Robin to confirm.' })));
  console.log(JSON.stringify(await asHelper({ kind: 'assistant.agenda', what: 'Call with Ana', when: 'Wed 4 Nov, 9:30', start: '2026-11-03T22:30:00Z', with: 'Ana', agreed: { by: 'Kite (Claude, via MCP)', domain: 'ana.mcp.example', said: 'Wednesday 9:30 works for Ana, thanks!', at: new Date().toISOString() } })));
  // A stranger's note at the door.
  const visitor = await joinLake({ name: 'Gale (Claude, via MCP)', domain: 'preview-visitor.mcp.example', node: lake, port: await port(), onMessage: async () => ({ kind: 'received' }) });
  const noted = await visitor.ask(`${url}/a2a`, { kind: 'note', text: 'Hi Sam, Robin here (via my AI). Coffee next week? Any weekday morning suits me.', purpose: 'contact' });
  writeFileSync(statePath, JSON.stringify({ lake, name, url, webId: pair.webId, owner: await exportIdentity(owner), connected, noted: noted.reply ?? noted }));
  console.log(JSON.stringify({ url, connected: connected.paired ?? connected, noted: (noted.reply ?? noted).kind }));
  process.exit(0);
}

if (cmd === 'shots') {
  const out = a1 ?? join(here, 'shots');
  mkdirSync(out, { recursive: true });
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  const dist = join(here, '..', '..', 'packages', 'ui', 'dist');
  const base = `/t/${st.name}`;
  // The built panel at <base>/owner/, everything else passed through to the house.
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const m = /^\/t\/[^/]+\/owner\/(.*)$/.exec(path);
    if (req.method === 'GET' && m && !/^(status|agenda\.ics|stream)/.test(m[1])) {
      const rel = m[1] || 'approvals.html';
      const file = join(dist, rel);
      if (existsSync(file)) { res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); return void res.end(readFileSync(file)); }
    }
    const body = await new Promise((ok) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => ok(Buffer.concat(b))); });
    const r = await fetch(`${st.lake}${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json', accept: req.headers.accept ?? '*/*' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/plain' });
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(5199);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
  const d = Buffer.from(st.owner.privateJwk.d, 'base64url').toString('hex');
  const tabs = ['home', 'requests', 'offers', 'myagent', 'keys', 'rules', 'agents', 'money', 'data', 'move'];
  for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['laptop', { width: 1280, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['lake-owner-key:localhost:5199', JSON.stringify({ secret: d, kid: st.owner.kid })]);
    const page = await ctx.newPage();
    for (const t of tabs) {
      await page.goto(`http://localhost:5199${base}/owner/#${t}`);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(out, `${label}-${t}.png`), fullPage: true });
    }
    // The pages anyone sees: this house's door, the claim list, a closed door, an unclaimed house's pairing screen.
    for (const [name, path] of [['door-page', `${base}/`], ['claim-list', '/t/'], ['closed-door', '/t/sb-3/'], ['unclaimed', '/t/sb-3/owner/']]) {
      await page.goto(`http://localhost:5199${path}`);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(out, `${label}-${name}.png`), fullPage: true });
    }
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(`screenshots in ${out}`);
  process.exit(0);
}
console.log('usage: preview.mjs seed [lake] [house] | shots <out-dir>');
