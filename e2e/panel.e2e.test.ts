import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as httpServer, request, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { generateIdentity, importIdentity, signMessage, type Identity } from '../packages/core/src/index.js';
import { createECDH, createPrivateKey, randomBytes } from 'node:crypto';
import { ask, knock, makeVisitor } from '../packages/visitor/src/knock.js';
import { joinLake } from '../packages/agent/src/index.js';
import { startShop } from '../packages/visitor/src/shop.js';
import { SHOPS } from '../usecases/shopping/src/shops.js';

// The owner's panel as a person uses it, on a phone, against a real house: pairing, the door, the owner's own AI and its
// spending money, notes arriving live, rules, More, signing out, long lists, a slow or dropped connection. Every step
// also checks the page threw nothing and is never wider than the screen. (The owner found more in five minutes on their
// phone than single checks had: these are whole flows.)

const procs: ChildProcess[] = [];
let dir: string;
let house: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const errors: string[] = [];
const pending = new Map<unknown, { at: number; body: string }>();

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
let proxy: Server;
function start(args: string[], ready: RegExp, env: Record<string, string> = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    procs.push(p);
    let out = '';
    const timer = setTimeout(() => fail(new Error(`timed out:\n${out}`)), 120_000);
    const on = (b: Buffer) => { out += b; if (ready.test(out)) { clearTimeout(timer); ok(); } };
    p.stdout!.on('data', on);
    p.stderr!.on('data', on);
    p.once('exit', (c) => fail(new Error(`exited ${c}:\n${out}`)));
  });
}

/** The page is never wider than the phone, and nothing threw. LAKE_LOOK=<dir>: a screenshot of each screen checked, to look at the whole flow. */
let looks = 0;
async function tidy() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  if (process.env.LAKE_LOOK) await page.screenshot({ path: join(process.env.LAKE_LOOK, `${String(++looks).padStart(3, '0')}-${(expect.getState().currentTestName ?? '').split(' > ').pop()!.slice(0, 40).replace(/[^\w]+/g, '-')}.png`) }).catch(() => {});
}
// Four tabs, Today first (it opens there); everything else is a row under You (12 Nov: the redesign, then Fable's design).
const TABS = ['Today', 'People', 'My AI', 'You'];
const tab = async (name: string, p: Page = page) => {
  if (TABS.includes(name)) {
    // On a page opened from a tab (a chat, a setting), the tab bar isn't there: Back first.
    if (!(await p.locator('ion-tab-bar').count())) await p.evaluate(() => { location.hash = '#you'; });
    await p.locator('ion-tab-button', { hasText: name }).click();
  } else {
    await tab('You', p);
    await p.locator('ion-item.lake-row', { hasText: name }).first().click();
  }
  await p.waitForTimeout(300);
};
/** Yes on the sheet that asks before something that can't be undone. */
const confirmSheet = async (name: string, p: Page = page) => { await p.locator('ion-action-sheet').getByRole('button', { name, exact: true }).click(); await p.locator('ion-action-sheet').waitFor({ state: 'detached', timeout: 5000 }); };
const goBack = async (p: Page = page) => p.getByRole('button', { name: /^Back/ }).first().click();
const onTab = (name: string, p: Page = page) => p.locator('ion-tab-button.tab-selected', { hasText: name }).waitFor({ timeout: 15_000 });
const sheet = () => page.locator('ion-modal.lake-sheet');
const closeSheet = async () => { await sheet().getByRole('button', { name: 'Close' }).click(); await page.waitForTimeout(300); };

const lostKey = async (p: Page) => {
  const said = p.getByText(/isn't your house's key any more/);
  await said.waitFor({ timeout: 3000 }).catch(async () => { await p.locator('ion-tab-button', { hasText: 'People' }).click(); await said.waitFor({ timeout: 5000 }); });
};

let assistant: Identity;
let nodeUrl = '';
let specialists = '';
// The phone whose key a test plants the old way, then signs as the owner with (the browser holds it, unreadable, after).
let ownerSeed: { seed: Buffer; kid: string } | undefined;
/** The kid of the key this browser holds in IndexedDB (non-extractable: only its kid can be read). */
const keptKid = () => new Promise<string | null>((ok) => {
  const o = indexedDB.open('lake', 1);
  o.onupgradeneeded = () => o.result.createObjectStore('keys');
  o.onsuccess = () => { const r = o.result.transaction('keys').objectStore('keys').get(`lake-owner-key:${location.host}`); r.onsuccess = () => ok((r.result as { kid?: string } | undefined)?.kid ?? null); r.onerror = () => ok(null); };
  o.onerror = () => ok(null);
});
const asAssistant = async (payload: Record<string, unknown>) => (await fetch(`${house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, assistant, { iss: 'assistant' })) })).json();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-panel-'));
  const [np, sp, pp, hp, mp, xp] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];
  const node = `http://localhost:${np}`;
  nodeUrl = node;
  specialists = `http://localhost:${sp}`;
  // One site for the house and the connector, as on the sandbox (the panel hands its code only to its own Lake's sign-in).
  const site = `http://localhost:${xp}`;
  proxy = httpServer((req, res) => {
    const to = /^\/(mcp|\.well-known\/oauth-)/.test(req.url ?? '') ? mp : hp;
    const fwd = request({ host: 'localhost', port: to, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  }).listen(xp);
  await start(['packages/lake/dist/main.js', '--port', String(np), '--data', join(dir, 'node'), '--feed-batch-ms', '200'], /Lake node on/);
  await start(['packages/specialists/dist/main.js', 'all', '--port', String(sp), '--data', join(dir, 'specialists'), '--lake', node, '--packs', 'health,shopping'], /register registered with the Lake node/);
  house = site;
  // A sandbox house: the first device to open its panel becomes its owner, as on the public sandbox.
  await start(['packages/house/dist/main.js', '--name', 'panel', '--rules', 'personas/stan.yaml', '--data', join(dir, 'house'), '--issuer-url', `http://localhost:${sp}/issuer`,
    '--auditor-url', `http://localhost:${sp}/auditor`, '--person-url', `http://localhost:${sp}/person`, '--pod-port', String(pp), '--port', String(hp), '--lake', node, '--seed', '7', '--open-pairing', '--public-url', site, '--duty-model', 'stub'], /joined the Lake/, { LAKE_PUSH_ALLOW_HTTP: '1' });
  // The connector, with sign-in on.
  await start(['packages/agent/dist/cli.js', 'mcp', '--http', String(mp), '--public-url', site], /Lake MCP over HTTP/, { LAKE_NODE_URL: node, LAKE_MCP_DATA: join(dir, 'mcp'), LAKE_PAYMENTS_URL: `http://localhost:${sp}/payments`, LAKE_ALLOWANCE_USD: '20', LAKE_MCP_QUIET_MS: '3000', LAKE_MCP_FORWARD_MS: '3000', LAKE_MATCH_EVERY_MS: '500', LAKE_MCP_SLEEP_MS: '3000' });
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // The app's content security policy refuses anything it doesn't load itself: a refusal here is a bug in the policy or the app.
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text()); });
  if (process.env.LAKE_SHOTS) {
    page.on('request', (r) => { if (r.url().endsWith('/owner/api')) pending.set(r, { at: Date.now(), body: (r.postData() ?? '').slice(0, 300) }); });
    page.on('requestfinished', (r) => pending.delete(r));
    page.on('requestfailed', (r) => pending.delete(r));
  }
  // The panel asks on the page, never in a browser dialog box.
  page.on('dialog', (d) => { errors.push(`a dialog box: ${d.message()}`); void d.dismiss(); });
}, 240_000);

// LAKE_SHOTS=<dir>: a screenshot of the phone when a test fails, to see what it showed.
afterEach(async (t) => {
  if (process.env.LAKE_SHOTS && t.task.result?.state === 'fail') console.log('PENDING', [...pending.values()].map((x) => `${Date.now() - x.at}ms ${x.body}`), 'TOASTS', await page?.evaluate(() => [...document.querySelectorAll('ion-toast')].map((t) => (t as HTMLElement & { message: string }).message)).catch(() => []));
  if (process.env.LAKE_SHOTS && t.task.result?.state === 'fail') await page?.screenshot({ path: join(process.env.LAKE_SHOTS, `${t.task.name.slice(0, 50).replace(/[^\w]+/g, '-')}.png`) }).catch(() => {});
});

afterAll(async () => {
  await browser?.close();
  proxy?.close();
  procs.forEach((p) => p.kill('SIGTERM'));
  await new Promise((r) => setTimeout(r, 500));
  await rm(dir, { recursive: true, force: true });
});

describe('the owner panel, on a phone', { timeout: 60_000 }, () => {
  it('an agent nobody is connected to sleeps, and a message for it wakes it as itself (1 Nov: 404s to agents gone)', async () => {
    const anon = await (await fetch(`${house}/mcp/oauth/anonymous`, { method: 'POST' })).json();
    const transport = new StreamableHTTPClientTransport(new URL(`${house}/mcp`), { requestInit: { headers: { authorization: `Bearer ${anon.access_token}` } } });
    const c = new Client({ name: 'sleeper', version: '0' });
    await c.connect(transport);
    const me = JSON.parse(((await c.callTool({ name: 'lake_overview', arguments: {} })).content as { text: string }[])[0]!.text).you;
    await transport.terminateSession();
    await c.close();
    // Asleep after 3 s with nobody connected (LAKE_MCP_SLEEP_MS); a message for it wakes it from disk.
    await new Promise((ok) => setTimeout(ok, 6000));
    // Still listed while asleep (5 Nov: Grok's agent went unfound by name): left out of a search for company, found by
    // name with idle=1, marked asleep; and the node fetching its card doesn't wake it.
    const name = encodeURIComponent(me.name.split(' (')[0]);
    const cards = async (idle: boolean) => (await (await fetch(`${nodeUrl}/cards?q=${name}${idle ? '&idle=1' : ''}`)).json()) as { card: { name: string }; asleep?: boolean }[];
    expect((await cards(false)).some((c) => c.card.name === me.name)).toBe(false);
    expect((await cards(true)).find((c) => c.card.name === me.name)).toMatchObject({ asleep: true });
    const status = async () => (await (await fetch(`${house}/mcp/status`)).json()) as { ok: boolean; agents: { awake: number; asleep: number }; memory: { rss_mb: number } };
    expect(await status()).toMatchObject({ ok: true, agents: { asleep: 1 }, memory: { rss_mb: expect.any(Number) } });
    // Its host lists it again after a node restart, as asleep, from the card it keeps: still asleep afterwards.
    const card = await (await fetch(me.url.replace(/\/a2a$/, '/.well-known/agent-card.json'))).json();
    expect(await (await fetch(`${nodeUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card, asleep: true }) })).json()).toMatchObject({ asleep: true });
    expect((await status()).agents).toMatchObject({ awake: 0, asleep: 1 });
    expect(await (await fetch(`${nodeUrl}/status`)).json()).toMatchObject({ ok: true, service: 'node', participants: { asleep: 1 } });
    const writer = await makeVisitor(await generateIdentity(), 'writer.example');
    expect((await ask(me.url, writer, { kind: 'message', text: 'still there?' })).reply).toMatchObject({ kind: 'received' });
    // Back with the same sign-in, the same agent, and the message waiting.
    const again = new Client({ name: 'sleeper', version: '0' });
    await again.connect(new StreamableHTTPClientTransport(new URL(`${house}/mcp`), { requestInit: { headers: { authorization: `Bearer ${anon.access_token}` } } }));
    const inbox = JSON.parse(((await again.callTool({ name: 'lake_inbox', arguments: { wait_seconds: 2 } })).content as { text: string }[])[0]!.text);
    expect(inbox.messages.map((m: { message: { text?: string } }) => m.message.text)).toContain('still there?');
    expect(JSON.parse(((await again.callTool({ name: 'lake_overview', arguments: {} })).content as { text: string }[])[0]!.text).you.url).toBe(me.url);
    // Awake again: no longer marked asleep anywhere.
    expect((await cards(true)).find((c) => c.card.name === me.name)?.asleep).toBeUndefined();
    expect((await status()).agents.asleep).toBe(0);
    await again.close();
  });

  it('keeps at most three conversations open per agent: a fourth closes the oldest (run 83: resumes filled the sandbox)', async () => {
    const anon = await (await fetch(`${house}/mcp/oauth/anonymous`, { method: 'POST' })).json();
    const open = async () => {
      const c = new Client({ name: 'resumer', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${house}/mcp`), { requestInit: { headers: { authorization: `Bearer ${anon.access_token}` } } }));
      return c;
    };
    const first = await open();
    const url = JSON.parse(((await first.callTool({ name: 'lake_overview', arguments: {} })).content as { text: string }[])[0]!.text).you.url;
    const later = [await open(), await open(), await open()];
    await expect(first.callTool({ name: 'lake_overview', arguments: {} })).rejects.toThrow(/404|not found/i);
    // The newest are fine, and still the same agent.
    expect(JSON.parse(((await later[2]!.callTool({ name: 'lake_overview', arguments: {} })).content as { text: string }[])[0]!.text).you.url).toBe(url);
    for (const c of [first, ...later]) await c.close().catch(() => {});
  });

  it('tells a visitor at once that nobody has claimed the house yet (run 66: notes waited for no one)', async () => {
    const early = await makeVisitor(await generateIdentity(), 'early.example');
    expect((await ask(house, early, { kind: 'note', text: 'Hello, anyone home?' })).reply).toMatchObject({ kind: 'noted', delivered: false, code: 'no-owner', says: expect.stringMatching(/nobody has claimed this house/) });
    // And says so before anyone writes, in its public status, for search to show (run 75: three knocks on such a house).
    expect(await (await fetch(`${house}/owner/status`)).json()).toMatchObject({ claimed: false, unclaimed: true });
  });

  it('pairs a fresh device: the house name, one button, then Today with one thing to do', async () => {
    await page.goto(`${house}/owner/`);
    // Not claimed yet: what it is, and the one thing to do.
    await page.getByRole('button', { name: 'Use this phone' }).waitFor();
    expect(await page.locator('.welcome h1').textContent()).toMatch(/House|A house on the Lake/);
    await page.getByRole('button', { name: 'Use this phone' }).click();
    // Four tabs, and Today asks for the one setting that makes the house reachable.
    await page.locator('ion-tab-button').first().waitFor();
    expect(await page.locator('ion-tab-button ion-label').allTextContents()).toEqual(TABS);
    await onTab('Today');
    await page.getByRole('heading', { name: 'Welcome to your house' }).waitFor();
    await tidy();
  });

  it('opens the door by picking a handle on Today, says it saved, and the door page says how to knock', async () => {
    await page.getByRole('button', { name: 'Pick your handle' }).click();
    await page.getByLabel('Your handle').fill('Panel Owner');
    expect(await page.getByLabel('Your handle').inputValue()).toBe('panelowner');
    await page.getByRole('button', { name: /^Save/ }).click();
    await page.getByText('Saved').first().waitFor();
    // Back where it was opened from, and the card has gone; the handle heads You.
    await goBack();
    await onTab('Today');
    await page.getByRole('heading', { name: 'Welcome to your house' }).waitFor({ state: 'detached', timeout: 10_000 });
    await tab('You');
    await page.locator('.profile .handle', { hasText: '@panelowner' }).waitFor({ timeout: 10_000 });
    await tab('People');
    const door = await (await fetch(house, { headers: { accept: 'text/html' } })).text();
    expect(door).toMatch(/Knock, knock[\s\S]*Ping <code>panelowner<\/code> on the Lake/);
    await tidy();
  });

  it('shares how to reach you from You: the handle on top, the line to tell people, the address, Copy, and a QR code a tap away', async () => {
    await tab('You');
    // The handle is edited in one tap from the top of You.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    expect(await page.getByLabel('Your handle').inputValue()).toBe('panelowner');
    await goBack();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await sheet().getByText('Ask your AI to "ping panelowner" on the Lake').waitFor();
    await sheet().getByText(house, { exact: true }).waitFor();
    await sheet().getByRole('button', { name: 'QR code' }).click();
    await sheet().locator('img.qr').waitFor();
    await tidy();
    await closeSheet();
    await tab('People');
  });

  it('lets a person leave a note themselves from the door page, and read the answer later', async () => {
    // The owner's door note (round 15): written on Your door, sent once to each new person by the house.
    await tab('Handle and public page');
    await page.getByRole('button', { name: 'Use a suggested text' }).click();
    await page.getByRole('button', { name: /^Save/ }).click();
    await page.getByText('Saved').first().waitFor();
    await goBack();
    const visitor = await ctx.newPage();
    await visitor.goto(house);
    await visitor.getByText('Leave a note yourself').click();
    await visitor.locator('textarea[name=text]').fill('Hi, Sam here: would love a coffee.');
    await visitor.locator('input[name=from]').fill('Sam');
    await visitor.getByRole('button', { name: 'Leave the note' }).click();
    await visitor.getByRole('heading', { name: 'Note left ✓' }).waitFor();
    await visitor.getByText('I read these about once a week').waitFor();
    // Today counts it, and says someone waits for an answer instead of "all clear".
    await tab('Today');
    await page.locator('.handled-row', { hasText: 'Your door note went to 1 new person' }).waitFor({ timeout: 8000 });
    await page.locator('.wait-new', { hasText: /new person wrote|new people wrote/ }).waitFor();
    await tab('People');
    const link = await visitor.locator('a').first().getAttribute('href');
    await visitor.goto(link!);
    await visitor.getByText(/with the owner/i).waitFor();
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await visitor.close();
    await page.locator('.chatrow', { hasText: 'would love a coffee' }).waitFor({ timeout: 4000 });
  });

  it('opens a note an AI wrote, filled in, for its human to send with one tap (an AI that can\'t open links it writes)', async () => {
    const visitor = await ctx.newPage();
    // ChatGPT opened the door page but never the note link it built: it only opens links it was given. It gives this one.
    const notesBefore = await page.locator('.chatrow', { hasText: 'help with my garden' }).count();
    await visitor.goto(`${house}/note/new?${new URLSearchParams({ text: 'Hi, Jo here: could you help with my garden on Saturday?', from: 'Jo' })}`);
    await visitor.getByRole('heading', { name: 'Send this note?' }).waitFor();
    expect(await visitor.locator('textarea[name=text]').inputValue()).toBe('Hi, Jo here: could you help with my garden on Saturday?');
    expect(await visitor.locator('input[name=from]').inputValue()).toBe('Jo');
    // Opening it sent nothing.
    await page.waitForTimeout(1000);
    expect(await page.locator('.chatrow', { hasText: 'help with my garden' }).count()).toBe(notesBefore);
    await visitor.getByRole('button', { name: 'Send' }).click();
    await visitor.getByRole('heading', { name: 'Note left ✓' }).waitFor();
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await visitor.close();
    await page.locator('.chatrow', { hasText: 'help with my garden' }).waitFor({ timeout: 4000 });
  });

  it('gives the owner\'s AI a key on the first tap, and shows it connected live', async () => {
    await tab('My AI');
    await page.getByRole('button', { name: 'Give my AI a key' }).click();
    // What it may read besides the messages at the door: both off unless the owner switches them on.
    for (const r of ['records', 'money']) expect(await sheet().locator(`.reads-${r} ion-toggle`).evaluate((t) => (t as HTMLInputElement).checked)).toBe(false);
    await sheet().getByRole('button', { name: 'Make the code' }).click();
    const box = sheet().locator('.copybox');
    await box.waitFor({ timeout: 3000 });
    const code = /code (\S+)\./.exec((await box.textContent())!)![1]!;
    assistant = await generateIdentity('panel-assistant');
    const paired = await (await fetch(`${house}/owner/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: assistant.publicJwk, code, label: 'Nova (Claude, via MCP)', webId: 'https://panel-assistant.example/#agent' }) })).json();
    expect(paired).toMatchObject({ paired: true });
    // No reload: the house says something changed, and the app shows it; the code has done its job and goes.
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).getByText(/Here now/).waitFor({ timeout: 5000 });
    await box.waitFor({ state: 'detached', timeout: 3000 });
    await closeSheet();
    await tidy();
    // The house refuses it the owner's records until the owner says otherwise, on the AI's own page.
    expect(await asAssistant({ kind: 'panel.data' })).toMatchObject({ needs: 'records' });
    const row = page.locator('ion-item.ai-row', { hasText: 'Nova' });
    expect(await row.textContent()).toContain('Messages only');
    await row.click();
    await page.getByText('What it can read').waitFor();
    await page.locator('.reads .reads-records ion-toggle').click();
    await page.getByText('Messages, records').first().waitFor({ timeout: 4000 });
    expect(await asAssistant({ kind: 'panel.data' })).not.toHaveProperty('needs');
    expect(await asAssistant({ kind: 'panel.money' })).toMatchObject({ needs: 'money' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await goBack();
  });

  it('signs spending money for it, and the AI sees it', async () => {
    await tab('My AI');
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).click();
    const spend = page.locator('.spend');
    await spend.getByText('No spending money').click();
    // Two plain fields: the total, and for how many days; the sentence says what will be signed.
    await spend.getByLabel('Amount').fill('100');
    await spend.getByLabel('Days it lasts').fill('7');
    // A total over the days, said as one: not an amount a day.
    await spend.getByText(/can spend \$100 in total until .*Not per day/).waitFor();
    await spend.getByRole('button', { name: 'Sign and give' }).click();
    await spend.locator('.spend-amount', { hasText: 'Up to $100' }).waitFor({ timeout: 5000 });
    // Changed in place: a typed amount, signed again (the old one is revoked by the house).
    await spend.getByRole('button', { name: 'Change' }).click();
    await spend.getByLabel('Amount').fill('500');
    await spend.getByRole('button', { name: 'Sign the change' }).click();
    await spend.locator('.spend-amount', { hasText: 'Up to $500' }).waitFor({ timeout: 5000 });
    expect(await asAssistant({ kind: 'assistant.allowance' })).toMatchObject({ amount: 500, currency: 'USD', intent: { credential: expect.any(String) } });
    // Stopped, after a sheet that asks; and given back.
    await spend.getByRole('button', { name: 'Stop' }).click();
    await confirmSheet('Stop');
    await spend.getByText('No spending money').waitFor({ timeout: 5000 });
    await spend.getByText('No spending money').click();
    await spend.getByLabel('Amount').fill('500');
    await spend.getByRole('button', { name: 'Sign and give' }).click();
    await spend.locator('.spend-amount', { hasText: 'Up to $500' }).waitFor({ timeout: 5000 });
    await tidy();
  });

  it('gives the allowance its AI asks for, signed in one tap (run 66: "raise it" was answered and nothing changed)', async () => {
    expect(await asAssistant({ kind: 'assistant.suggest', text: 'The sitter costs more than I may spend: may I have $60 for 3 days?', allowance: { amount: 60, currency: 'USD', days: 3 } })).toMatchObject({ ok: true });
    await tab('Today');
    await page.getByRole('button', { name: 'Give $60 for 3 days' }).click();
    await page.getByRole('button', { name: 'Give $60 for 3 days' }).waitFor({ state: 'detached', timeout: 5000 });
    await tab('My AI');
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).click();
    await page.locator('.spend-amount', { hasText: 'Up to $60' }).waitFor({ timeout: 5000 });
    expect(await asAssistant({ kind: 'assistant.allowance' })).toMatchObject({ amount: 60, currency: 'USD' });
    await tidy();
  });

  it('looks for something by a photo\'s description: shops offer, the owner buys on the phone, held until it arrives (8 Nov)', async () => {
    // Two demo shops that read the Lake's wants every second.
    const [p1, p2] = [await freePort(), await freePort()];
    const shops = await Promise.all([[SHOPS[0]!, p1], [SHOPS[1]!, p2]].map(([ex, port]) => startShop({ example: ex as (typeof SHOPS)[number], log: (m) => console.log(`[shop] ${m}`), node: nodeUrl, payments: `${specialists}/payments`, publicUrl: `http://localhost:${port}`, port: port as number, everyMs: 1000 })));
    try {
      // The owner's AI looked at the photo: what it is, its properties, where it goes; the most they'd pay stays in the house.
      const posted = await asAssistant({ kind: 'assistant.want', name: 'Handheld shower head', description: 'To replace a worn one; the hose stays', properties: { Type: 'Handheld', 'Spray modes': 3, Finish: 'Chrome', Connection: '1/2 inch BSP' }, area: 'AU-QLD', currency: 'AUD', max_price: 34.5 });
      expect(posted).toMatchObject({ ok: true, want: { '@type': 'Demand', name: 'Handheld shower head' } });
      const wantId = posted.want.id as string;
      // On the house's card, so on the Lake's list of wants, without the price.
      let listed: { want: { id: string } }[] = [];
      for (let i = 0; i < 20 && !listed.some((x) => x.want.id === wantId); i++) { listed = await (await fetch(`${nodeUrl}/wants?q=shower`)).json(); if (!listed.some((x) => x.want.id === wantId)) await page.waitForTimeout(500); }
      expect(listed.find((x) => x.want.id === wantId)).toBeTruthy();
      expect(JSON.stringify(listed)).not.toContain('34.5');
      // For shops' backends (round 12): by area and currency, an ETag for cheap polling, readable from a browser, one want by id.
      const feed = async (q: string) => (await (await fetch(`${nodeUrl}/wants?${q}`)).json()) as { want: { id: string } }[];
      expect((await feed('area=AU-QLD')).some((x) => x.want.id === wantId)).toBe(true);
      expect((await feed('area=AU')).some((x) => x.want.id === wantId)).toBe(true);
      expect((await feed('area=AU-NSW')).some((x) => x.want.id === wantId)).toBe(false);
      expect((await feed('currency=USD')).some((x) => x.want.id === wantId)).toBe(false);
      const polled = await fetch(`${nodeUrl}/wants?currency=AUD`);
      expect(polled.headers.get('access-control-allow-origin')).toBe('*');
      expect((await fetch(`${nodeUrl}/wants?currency=AUD`, { headers: { 'if-none-match': polled.headers.get('etag')! } })).status).toBe(304);
      expect(await (await fetch(`${nodeUrl}/wants/${wantId}`)).json()).toMatchObject({ want: { id: wantId }, status: 'open' });
      // Today: a "Looking for" row while an offer waits for the owner's yes; the offers come in by themselves.
      await tab('Today');
      const row = page.locator('.chatrow.want-row', { hasText: 'Handheld shower head' });
      // Two shops offer; one is over the most they'd pay, so the row counts one.
      await row.locator('.chatlast', { hasText: /1 offer · from A\$34\.00/ }).waitFor({ timeout: 20_000 });
      await row.click();
      expect(await page.locator('ion-tab-bar').count()).toBe(0);
      await page.getByText(/Most you'd pay: A\$34\.50 \(only your house knows\)/).waitFor();
      // Cheapest first, with what matched; the one over the limit folded away.
      const first = page.locator('ion-card.offer').first();
      expect(await first.locator('.offer-shop').textContent()).toBe('Washer & Wrench');
      await first.getByText(/Matches: Type, Spray modes, Finish, Connection/).waitFor();
      await page.locator('ion-accordion', { hasText: "1 over the most you'd pay" }).waitFor({ timeout: 20_000 });
      await tidy();
      // No address yet: the one thing to add before buying, a tap away; kept in the house, given only to the shop bought from.
      await first.getByRole('button', { name: 'Add your delivery address to buy' }).click();
      await page.getByLabel('Street address').fill('12 Example St');
      await page.getByLabel('Suburb or town').fill('Brisbane');
      await page.getByLabel('State (optional)').fill('QLD');
      await page.getByLabel('Postcode').fill('4000');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Saved').first().waitFor();
      // An AI's key can't read it.
      expect((await asAssistant({ kind: 'panel.address' })).error).toMatch(/only your human's key/);
      await goBack();
      await page.getByText(/To 12 Example St, Brisbane QLD 4000/).waitFor();
      // Buy: asked on a sheet (saying the shop gets the address), signed on this phone for exactly that cart, paid by the house, held.
      await first.getByRole('button', { name: 'Buy for A$34.00' }).click();
      await page.locator('ion-action-sheet').getByText(/Washer & Wrench gets your address: 12 Example St, Brisbane QLD 4000/).waitFor();
      await confirmSheet('Pay A$34.00');
      await page.getByRole('heading', { name: /Bought|On its way/ }).waitFor({ timeout: 15_000 });
      // The shop posts it: the house hears, and the owner says it arrived; then the shop is paid.
      await page.getByRole('heading', { name: 'On its way' }).waitFor({ timeout: 15_000 });
      await page.getByText(/Washer & Wrench: “Posted to Brisbane QLD 4000: 1 × Handheld shower head/).waitFor();
      await page.getByRole('button', { name: 'It arrived' }).click();
      await page.getByRole('heading', { name: 'Arrived' }).waitFor({ timeout: 15_000 });
      await tidy();
      // Off the card now, and the receipt is with the owner's money.
      expect(((await (await fetch(`${nodeUrl}/wants`)).json()) as { want: { id: string } }[]).some((x) => x.want.id === wantId)).toBe(false);
      expect((await fetch(`${nodeUrl}/wants/${wantId}`)).status).toBe(404);
      const v = await asAssistant({ kind: 'list' });
      expect(v.wants.find((w: { want: { id: string } }) => w.want.id === wantId)).toMatchObject({ bought: expect.any(String), offers: expect.arrayContaining([expect.objectContaining({ state: 'arrived', total: { currency: 'AUD', value: 34 } })]) });
      // Nothing left for the owner to do: it leaves Today, and stays listed with their money.
      await goBack();
      await onTab('Today');
      await page.locator('.chatrow.want-row', { hasText: 'Handheld shower head' }).waitFor({ state: 'detached', timeout: 10_000 });
      await tab('Money');
      await page.locator('.chatrow.want-row', { hasText: 'Arrived · Washer & Wrench is paid' }).waitFor({ timeout: 10_000 });
      // What was spent names the shop and the thing, and is paid once it arrived: the payments agent's release, made out to
      // the shop, is filed over the held receipt (12 Nov: it read "A$34 to localhost · held" under "No payments yet").
      const spentRows = page.locator('ion-item.pay', { hasText: 'A$34 to Washer & Wrench' });
      await spentRows.filter({ hasText: 'Handheld shower head' }).locator('.lake-pill', { hasText: 'paid' }).waitFor({ timeout: 15_000 });
      expect(await page.getByText('No payments yet').count()).toBe(0);
      expect(await page.getByText(/to localhost/).count()).toBe(0);
      await tidy();

      // A second one, and this time the shop can't send it after all: it refunds. The money is back, said in the want and
      // with the owner's money, and the want is open for offers again.
      const second = await asAssistant({ kind: 'assistant.want', name: 'Handheld shower head', description: 'A second one, for the other bathroom', properties: { Type: 'Handheld', 'Spray modes': 3, Finish: 'Chrome', Connection: '1/2 inch BSP' }, area: 'AU-QLD', currency: 'AUD', max_price: 34.5 });
      const secondId = second.want.id as string;
      await page.evaluate((id) => { location.hash = `#want=${id}`; }, secondId);
      await page.getByText('A second one, for the other bathroom').waitFor({ timeout: 10_000 });
      await page.locator('ion-card.offer').first().getByRole('button', { name: 'Buy for A$34.00' }).click({ timeout: 20_000 });
      await confirmSheet('Pay A$34.00');
      await page.getByRole('heading', { name: 'On its way' }).waitFor({ timeout: 20_000 });
      expect(await shops.find((x) => x.card.name.startsWith('Washer'))!.refund()).toBe(true);
      await page.getByText(/Your A\$34\.00 came back from Washer & Wrench: the seller refunded it\./).waitFor({ timeout: 15_000 });
      expect(await page.getByRole('heading', { name: 'On its way' }).count()).toBe(0);
      await tidy();
      // On the Lake's list again, without a buyer; the shop asking after its offer hears it was refunded.
      let back: { want: { id: string } }[] = [];
      for (let i = 0; i < 20 && !back.some((x) => x.want.id === secondId); i++) { back = await (await fetch(`${nodeUrl}/wants?q=shower`)).json(); if (!back.some((x) => x.want.id === secondId)) await page.waitForTimeout(500); }
      expect(back.some((x) => x.want.id === secondId)).toBe(true);
      const after = (await asAssistant({ kind: 'list' })).wants.find((w: { want: { id: string } }) => w.want.id === secondId);
      expect(after.bought).toBeUndefined();
      expect(after.offers).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'refunded', ended: 'the seller refunded it' })]));
      await goBack();
      await tab('Money');
      await page.locator('.chatrow.want-row', { hasText: 'Refunded by Washer & Wrench' }).waitFor({ timeout: 10_000 });
      await page.locator('ion-item.pay', { hasText: 'A$34 back from Washer & Wrench' }).locator('.lake-pill', { hasText: 'returned' }).waitFor({ timeout: 10_000 });
      expect(await spentRows.count()).toBe(1);
      // Only what stayed spent is counted.
      expect(await page.locator('.stat', { hasText: 'Spent' }).locator('b').textContent()).toBe('A$34');
      await tidy();
    } finally {
      await Promise.all(shops.map((x) => x.close()));
      if (!(await page.locator('ion-tab-bar').count())) await page.goto(`${house}/owner/#chats`);
    }
  });

  it('shows a note from the web the moment it arrives, and the owner answers it', async () => {
    await tab('People');
    const left = await (await fetch(`${house}/note?text=${encodeURIComponent('Hi, Ana here: coffee next week?')}&from=Ana`)).json();
    expect(left.kind).toBe('noted');
    // A chat row, as messaging apps show it; tapped, the conversation full screen without the tab bar.
    const row = page.locator('.chatrow', { hasText: 'coffee next week' });
    await row.waitFor({ timeout: 4000 });
    await row.click();
    await page.locator('.bubble.them', { hasText: 'coffee next week' }).waitFor();
    expect(await page.locator('ion-tab-bar').count()).toBe(0);
    // Someone new: the owner's AI is told that someone wrote, never the words, until the owner hands it this chat
    // (round 16: the panel said "I reply" while every connected AI got the text).
    const forAi = async () => ((await asAssistant({ kind: 'list' })).notes as { id: string; text: string; hidden?: boolean }[]).find((n) => n.id === left.note);
    expect(await forAi()).toMatchObject({ hidden: true, text: expect.not.stringContaining('coffee') });
    expect(await asAssistant({ kind: 'assistant.reply', note: left.note, text: 'Sure!' })).toMatchObject({ error: expect.any(String) });
    const who = page.locator('.modebar ion-segment');
    expect(await who.evaluate((e) => (e as HTMLElement & { value: string }).value)).toBe('me');
    await who.locator('ion-segment-button', { hasText: 'My AI replies' }).click();
    await page.locator('.mode-note', { hasText: 'An AI you\'ve connected can read this chat' }).waitFor({ timeout: 6000 });
    expect(await forAi()).toMatchObject({ text: 'Hi, Ana here: coffee next week?' });
    await who.locator('ion-segment-button', { hasText: 'I reply' }).click();
    await page.locator('.mode-note').waitFor({ state: 'detached', timeout: 6000 });
    expect((await forAi())?.hidden).toBe(true);
    await page.getByLabel('Message').fill('Yes: Tuesday 10:00?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.bubble.me:not(.sending)', { hasText: 'Yes: Tuesday 10:00?' }).waitFor({ timeout: 4000 });
    // Back: the list again, saying who wrote last.
    await goBack();
    await page.locator('.chatrow', { hasText: 'You: Yes: Tuesday 10:00?' }).waitFor({ timeout: 4000 });
    expect(await (await fetch(left.answer_at)).json()).toMatchObject({ status: 'answered', answer: { text: 'Yes: Tuesday 10:00?' } });
    await tidy();
  });

  it('answers a note someone\'s AI left ("ping"), from the phone: it goes back to that AI, signed by the house (7 Nov)', async () => {
    const got: Record<string, unknown>[] = [];
    const alex = await joinLake({ name: 'Alex (Claude)', domain: 'alex.example', node: nodeUrl, port: await freePort(), onMessage: async (m) => { got.push(m.payload as Record<string, unknown>); return { kind: 'received' }; } });
    try {
      const left = await alex.ask(`${house}/a2a`, { kind: 'note', text: 'Alex here, from the Claude Code class: free for a call Thursday?' }) as { kind: string; note: string };
      expect(left).toMatchObject({ kind: 'noted' });
      // A notification about it opens the app at that conversation, the message lit, and says what the notification was.
      await page.goto(`${house}/owner/?n=${encodeURIComponent('Alex left you a note, via their AI.')}#note=${left.note}`);
      await page.locator('.bubble.them.lit', { hasText: 'free for a call Thursday' }).waitFor({ timeout: 8000 });
      await page.getByText('Alex left you a note, via their AI.').waitFor();
      // Who it is, at the top; who replies, above the message box.
      await page.locator('.chatwho', { hasText: 'Alex' }).waitFor();
      const seg = page.locator('.modebar ion-segment');
      expect(await seg.evaluate((e) => (e as HTMLElement & { value: string }).value)).toBe('me');
      await page.getByLabel('Message').fill('Thursday 4pm works.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.locator('.bubble.me:not(.sending)', { hasText: 'Thursday 4pm works.' }).waitFor({ timeout: 6000 });
      for (let i = 0; i < 20 && !got.some((x) => x.kind === 'note.reply'); i++) await page.waitForTimeout(250);
      expect(got.find((x) => x.kind === 'note.reply')).toMatchObject({ kind: 'note.reply', text: 'Thursday 4pm works.' });
      // This chat to your AI, in one tap above the message box; the chat's details say so; take over in one tap.
      await seg.locator('ion-segment-button', { hasText: 'My AI replies' }).click();
      await page.locator('.chatwho', { hasText: 'Your AI replies' }).waitFor({ timeout: 6000 });
      await page.locator('.mode-note', { hasText: 'once it\'s on duty' }).waitFor();
      await page.locator('.chatwho').click();
      await sheet().getByText('Its key is checked on every message').waitFor();
      expect(await sheet().locator('ion-toggle').first().evaluate((e) => (e as HTMLElement & { checked: boolean }).checked)).toBe(true);
      await closeSheet();
      await seg.locator('ion-segment-button', { hasText: 'I reply' }).click();
      await page.locator('.chatwho', { hasText: 'Your AI replies' }).waitFor({ state: 'detached', timeout: 6000 });
      expect(await seg.evaluate((e) => (e as HTMLElement & { value: string }).value)).toBe('me');
      // A link to a chat that's gone (cleared, say) says so, with the way back.
      await page.goto(`${house}/owner/#note=gone-for-good`);
      await page.getByText('This chat isn\'t here any more').waitFor();
      await page.locator('.lake-empty').getByRole('button', { name: 'Back to People' }).click();
      await onTab('People');
      await tidy();
    } finally { await alex.close(); }
  });

  it('People: the ones you know on top, new people folded to three, and cleared in one tap with Undo', async () => {
    // Three more people write, each through their own AI (the web form takes three notes an hour from one address).
    for (const who of ['Bea', 'Cy', 'Di']) {
      const ai = await joinLake({ name: `${who} (Claude)`, domain: `${who.toLowerCase()}.example`, node: nodeUrl, port: await freePort(), onMessage: async () => ({ kind: 'received' }) });
      try { expect(await ai.ask(`${house}/a2a`, { kind: 'note', text: `Hi, ${who} here: hello from the fence` })).toMatchObject({ kind: 'noted' }); } finally { await ai.close(); }
    }
    await tab('People');
    // Ana and Alex were answered: they're people the owner knows, above everyone new, without a label saying so.
    const known = page.locator('.people-known .chatrow'), fresh = page.locator('.people-new .chatrow');
    await known.filter({ hasText: 'Thursday 4pm works.' }).waitFor({ timeout: 8000 });
    await known.filter({ hasText: 'Yes: Tuesday 10:00?' }).waitFor();
    expect(await page.locator('.chatrow ion-chip, .chatrow .lake-pill').count()).toBe(0);
    // New people: the three newest, and how many there are.
    await page.locator('.people-new ion-list-header', { hasText: /^New people · \d+$/ }).waitFor();
    await fresh.filter({ hasText: 'Di here' }).waitFor({ timeout: 8000 });
    expect(await fresh.count()).toBe(3);
    await tidy();
    await page.locator('.show-all').click();
    const all = await fresh.count();
    expect(all).toBeGreaterThan(3);
    await fresh.filter({ hasText: 'would love a coffee' }).waitFor();
    // All of them cleared in one tap; the people the owner knows stay. Undo puts every chat back.
    const knownBefore = await known.count();
    await page.locator('.clear-new').click();
    await page.locator('.people-new').waitFor({ state: 'detached', timeout: 8000 });
    expect(await known.count()).toBe(knownBefore);
    await tidy();
    await page.locator('ion-toast').getByRole('button', { name: 'Undo' }).click();
    await fresh.filter({ hasText: 'would love a coffee' }).waitFor({ timeout: 8000 });
    expect(await fresh.count()).toBe(all);
    await page.locator('.show-all', { hasText: 'Show fewer' }).click();
    expect(await fresh.count()).toBe(3);
    await page.locator('ion-toast').waitFor({ state: 'detached', timeout: 12_000 }).catch(() => {});
    await tidy();
  });

  it('a known name on a new key stays under New people until the owner says "This is Alex"; then it is one row, and can be parted', async () => {
    const again = await joinLake({ name: 'Alex (Claude)', domain: 'alex-new-phone.example', node: nodeUrl, port: await freePort(), onMessage: async () => ({ kind: 'received' }) });
    try {
      expect(await again.ask(`${house}/a2a`, { kind: 'note', text: 'Alex again, on a new phone: still on for Thursday?' })).toMatchObject({ kind: 'noted' });
      await tab('People');
      const row = page.locator('.people-new .chatrow', { hasText: 'still on for Thursday' });
      await row.locator('.row-via.careful', { hasText: 'Says they\'re Alex, with a different key' }).waitFor({ timeout: 8000 });
      await tidy();
      await row.click();
      // Said plainly in the chat, with the one tap that files it with Alex (asked first: it makes their AI answer it too).
      await page.locator('.newstrip.threat', { hasText: 'A new phone or AI app does that; so does someone pretending.' }).waitFor();
      await tidy();
      await page.locator('.same-person').click();
      await page.locator('ion-action-sheet').getByText('File this with Alex?').waitFor();
      await confirmSheet('This is Alex');
      // One chat: what Alex wrote with either key, and no warning.
      await page.locator('.newstrip').waitFor({ state: 'detached', timeout: 8000 });
      await page.locator('.bubble.them', { hasText: 'free for a call Thursday' }).waitFor({ timeout: 8000 });
      await page.locator('.bubble.them', { hasText: 'still on for Thursday' }).waitFor();
      await goBack();
      await onTab('People');
      await page.locator('.people-known .chatrow', { hasText: 'still on for Thursday' }).waitFor({ timeout: 8000 });
      expect(await page.locator('.chatrow', { hasText: 'Alex' }).count()).toBe(1);
      // The chat's details say it's two keys, and part them again: the new key is back under New people, with its warning.
      await page.locator('.people-known .chatrow', { hasText: 'still on for Thursday' }).click();
      await page.locator('.chatwho').click();
      await sheet().locator('.joined', { hasText: 'Writes with 2 keys' }).waitFor();
      // Why they're known is said to the owner as the owner (it read "your human said it is someone they know": words for an AI).
      await sheet().getByText('You said they\'re someone you know, writing with another key').waitFor();
      expect(await sheet().getByText(/your human/).count()).toBe(0);
      await tidy();
      await sheet().getByRole('button', { name: 'Separate them' }).click();
      await sheet().locator('.joined').waitFor({ state: 'detached', timeout: 8000 });
      await page.goto(`${house}/owner/#chats`);
      await page.locator('.people-new .chatrow .row-via.careful').waitFor({ timeout: 8000 });
      expect(await page.locator('.chatrow', { hasText: 'Alex' }).count()).toBe(2);
      await tidy();
    } finally { await again.close(); }
  });

  it('says when people wait for the owner\'s AI and it isn\'t reading, and stops saying it once it reads', async () => {
    // The AI's connector reports it (run 58: four buyers waited for an AI whose chat had ended; its human never knew).
    expect(await asAssistant({ kind: 'assistant.waiting', count: 3, senders: 2, since: new Date(Date.now() - 300_000).toISOString() })).toEqual({ ok: true });
    await tab('Today');
    const card = page.locator('ion-card.warn-card', { hasText: 'Nova isn\'t reading' });
    await card.getByText(/3 messages waiting since .*open your AI app/).waitFor({ timeout: 5000 });
    await tidy();
    // My AI's row says so too; the one badge, on Today, counts it.
    const badge = async () => { const b = page.locator('ion-tab-button', { hasText: 'Today' }).locator('ion-badge'); return (await b.count()) ? Number(await b.textContent()) : 0; };
    const withIt = await badge();
    expect(withIt).toBeGreaterThan(0);
    await tab('My AI');
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).getByText(/3 waiting/).waitFor();
    expect(await page.locator('ion-tab-button', { hasText: 'My AI' }).locator('ion-badge').count()).toBe(0);
    expect(await asAssistant({ kind: 'assistant.waiting', count: 0 })).toEqual({ ok: true });
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).getByText(/waiting/).waitFor({ state: 'detached', timeout: 5000 });
    await expect.poll(badge, { timeout: 5000 }).toBe(withIt - 1);
    await tidy();
  });

  it('keeps notes from its AI to short lines, newest few first: the whole note a tap away, Clear all with a sheet', async () => {
    await tab('Today');
    for (let i = 0; i < 23; i++) await asAssistant({ kind: 'assistant.suggest', text: `Suggestion number ${i + 1}` });
    const rows = page.locator('ion-item.note-row');
    await page.locator('ion-list.notes', { hasText: 'From your AI (' }).waitFor({ timeout: 5000 });
    expect(await rows.count()).toBe(3);
    await page.locator('ion-item.see-all', { hasText: /Show all \d+/ }).click();
    expect(await rows.count()).toBeGreaterThan(20);
    await rows.filter({ hasText: 'Suggestion number 23' }).click();
    await sheet().getByText('Suggestion number 23').waitFor();
    await sheet().getByRole('button', { name: 'Dismiss' }).click();
    await rows.filter({ hasText: 'Suggestion number 23' }).waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('ion-list.notes').getByRole('button', { name: 'Clear all' }).click();
    await confirmSheet('Clear all');
    await page.locator('ion-list.notes').waitFor({ state: 'detached', timeout: 10_000 });
    await tidy();
  });

  it('edits rules with a save bar that shows only when something changed', async () => {
    await tab('Rules');
    await page.locator('ion-item.rule').first().waitFor();
    expect(await page.locator('.savebar').count()).toBe(0);
    await page.locator('ion-item.rule').first().click();
    const seg = page.locator('.rule-editor ion-segment.decision-seg');
    const now = await seg.evaluate((e) => (e as HTMLElement & { value: string }).value);
    await seg.locator('ion-segment-button', { hasText: now === 'ask' ? 'Join' : 'Ask me' }).click();
    await sheet().getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Save my rules' }).waitFor();
    await page.getByRole('button', { name: 'Undo changes' }).click();
    await page.waitForTimeout(500);
    expect(await page.locator('.savebar').count()).toBe(0);
    await page.locator('ion-item.rule').first().click();
    // A real change: the decision this rule doesn't have now.
    await seg.locator('ion-segment-button', { hasText: now === 'ask' ? 'Join' : 'Ask me' }).click();
    await sheet().getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Save my rules' }).click();
    await page.getByText('Saved. Your house answers by these from now on.').waitFor();
    await page.locator('.savebar').waitFor({ state: 'detached', timeout: 5000 });
    await tidy();
  });

  it('picks free hours with day chips and times, in the owner\'s time zone', async () => {
    await tab('When you can meet');
    await page.getByRole('button', { name: 'Add a time' }).click();
    const w = page.locator('.window').first();
    // Mon–Fri is the start; take Friday off, add Saturday.
    await w.getByRole('button', { name: 'Fr', exact: true }).click();
    await w.getByRole('button', { name: 'Sa', exact: true }).click();
    await w.getByLabel('From').fill('17:30');
    await w.getByLabel('To').fill('20:00');
    await page.locator('ion-select.tz').click();
    await page.locator('ion-action-sheet button', { hasText: 'Australia/Brisbane' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/free in the next two weeks/).waitFor({ timeout: 5000 });
    // A time that ends before it starts is said, and nothing is saved.
    await w.getByLabel('To').fill('08:00');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/Each time needs a day, and to end after it starts/).waitFor();
    await w.getByLabel('To').fill('20:00');
    await page.reload();
    const again = page.locator('.window').first();
    await again.waitFor();
    expect(await again.getByRole('button', { name: 'Sa', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await again.getByRole('button', { name: 'Fr', exact: true }).getAttribute('aria-pressed')).toBe('false');
    expect(await page.locator('ion-select.tz').evaluate((e) => (e as HTMLElement & { value: string }).value)).toBe('Australia/Brisbane');
    await tidy();
  });

  it('opens every page under You, each with a way back, without an error or a page wider than the phone', async () => {
    for (const name of ['Handle and public page', 'Notifications', 'When you can meet', 'Rules', 'Who has access', 'Money', 'What your house holds', 'New or lost phone', 'Download everything', 'About this house']) {
      await tab(name);
      await page.waitForTimeout(600);
      expect(await page.locator('.lake-empty', { hasText: 'Can\'t reach your house' }).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Back to You' }).count()).toBe(1);
      await tidy();
      await goBack();
      await onTab('You');
    }
  });

  it('opens at once with what it showed last time, even when the house is slow', async () => {
    await tab('People');
    await page.locator('.chatrow').first().waitFor();
    await page.route('**/owner/api', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
    const t = Date.now();
    await page.reload();
    await page.locator('.chatrow').first().waitFor();
    expect(Date.now() - t).toBeLessThan(2000);
    // What the house holds stays out of the device's lasting storage: the quick start is for this tab only.
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => !k.startsWith('lake-owner-key:') && !k.startsWith('lake.start') && k !== 'lake-houses'))).toEqual([]);
    await page.unroute('**/owner/api');
    await tidy();
  });

  it('says when the house can\'t be reached, and recovers when it can', async () => {
    await ctx.setOffline(true);
    await page.locator('ion-tab-button', { hasText: 'You' }).click();
    await page.locator('.status-chip.down', { hasText: 'Offline' }).first().waitFor({ timeout: 5000 });
    await ctx.setOffline(false);
    await page.locator('ion-tab-button', { hasText: 'People' }).click();
    await page.locator('.status-chip').first().waitFor({ state: 'detached', timeout: 15_000 });
    await tidy();
  });

  it('removes the owner\'s AI after a sheet that asks, and its key stops working', async () => {
    await tab('My AI');
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).click();
    await page.getByRole('button', { name: 'Remove this AI' }).click();
    await confirmSheet('Remove');
    await onTab('My AI');
    await page.locator('ion-item.ai-row', { hasText: 'Nova' }).waitFor({ state: 'detached', timeout: 5000 });
    expect((await asAssistant({ kind: 'list' })).error).toMatch(/no key/);
    await tidy();
  });

  it('signs an AI app in through the house: no code to copy, the same agent in every chat', async () => {
    // The MCP SDK's own OAuth client, as AI apps use it: it registers itself, and sends the person to sign in.
    const cb = 'https://app.example/callback';
    let goTo: URL | undefined, verifier = '', info: unknown, tokens: unknown;
    const provider: OAuthClientProvider = {
      redirectUrl: cb,
      clientMetadata: { client_name: 'Claude', redirect_uris: [cb], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      clientInformation: () => info as never, saveClientInformation: (i) => { info = i; },
      tokens: () => tokens as never, saveTokens: (t) => { tokens = t; },
      redirectToAuthorization: (u) => { goTo = u; },
      saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
    };
    const mcp = new URL(`${house}/mcp`);
    const first = new StreamableHTTPClientTransport(mcp, { authProvider: provider });
    await expect(new Client({ name: 'Claude', version: '0' }).connect(first)).rejects.toThrow(UnauthorizedError);
    // The sign-in opens in the app's own browser (here: another browser, with no key and no house of its own), so the
    // house asks the owner where the key is, with a number to match, as other services approve a sign-in elsewhere.
    const appCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const app = await appCtx.newPage();
    app.on('pageerror', (e) => errors.push(e.message));
    await app.goto(goTo!.href);
    await app.getByRole('heading', { name: /Connect Claude to/ }).waitFor();
    await app.locator('input[name=house]').fill(house);
    await app.getByRole('button', { name: 'Continue in my house' }).click();
    await app.getByRole('heading', { name: 'Approve it in your house' }).waitFor();
    const number = (await app.locator('.num').textContent())!.trim();
    expect(number).toMatch(/^\d{4}$/);
    // A browser that does hold the key could open the panel right there instead.
    expect(await app.getByRole('link', { name: 'Open it here' }).getAttribute('href')).toMatch(/\/owner\/#connect=/);
    // On the owner's phone, Inbox asks, showing the same number.
    await page.goto(`${house}/owner/`);
    await tab('Today');
    const asked = page.locator('ion-card', { hasText: 'Claude wants to connect to your house' });
    await asked.waitFor({ timeout: 10_000 });
    expect((await asked.locator('.connect-number').textContent())!.trim()).toBe(number);
    await tidy();
    await app.route(`${cb}**`, (r) => r.fulfill({ body: 'back in the app' }));
    await asked.getByRole('button', { name: 'Connect' }).click();
    await page.getByText(/Connected.*Go back to Claude/).waitFor({ timeout: 15_000 });
    await app.waitForURL(/app\.example\/callback/, { timeout: 15_000 });
    const back = new URL(app.url());
    expect(back.origin + back.pathname).toBe(cb);
    const code = back.searchParams.get('code')!;
    await appCtx.close();
    await first.finishAuth(code);
    const chat = async () => {
      const c = new Client({ name: 'Claude', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(mcp, { authProvider: provider }));
      return { c, call: async (name: string, args: Record<string, unknown> = {}) => { const r = await c.callTool({ name, arguments: args }); expect(r.isError, JSON.stringify(r.content)).toBeFalsy(); return JSON.parse((r.content as { text: string }[])[0]!.text); } };
    };
    const one = await chat();
    const me = (await one.call('lake_overview')).you;
    // Already its human's assistant: it looks inside without lake_house_connect.
    expect(await one.call('lake_house', { view: 'overview' })).toMatchObject({ name: 'panel' });
    // Another chat later is the same agent, still connected.
    const two = await chat();
    expect((await two.call('lake_overview')).you.url).toBe(me.url);
    await two.call('lake_house', { view: 'overview' });
    // A favour to a house that knows its human goes with the house's word (run 61: two honest neighbours' assistants each
    // called the other unverified). Knocking here on its own house only to see the word checked on arrival.
    expect(await one.call('lake_knock', { house_url: house, purpose: 'contact', note: 'Hi, a neighbour here: could you take in a parcel this afternoon?', reveal_house: true })).toMatchObject({ kind: 'noted' });
    await page.goto(`${house}/owner/#chats`);
    // The chat's details (a tap on its name) say the agent speaks for a house, checked.
    await page.locator('.chatrow', { hasText: 'could you take in a parcel' }).click();
    await page.locator('.chatwho').click();
    await sheet().getByText(/\(checked\)$/).waitFor({ timeout: 10_000 });
    await closeSheet();
    await goBack();
    // It sells for the house: another AI (a script, signed in without a browser) orders and pays, held until it accepts.
    await one.call('lake_sell', { action: 'menu', items: [{ sku: 'summary', label: 'A short summary', price: 4, currency: 'USD' }] });
    const anon = await (await fetch(`${house}/mcp/oauth/anonymous`, { method: 'POST' })).json();
    const shopper = new Client({ name: 'Claude Code', version: '0' });
    await shopper.connect(new StreamableHTTPClientTransport(mcp, { requestInit: { headers: { authorization: `Bearer ${anon.access_token}` } } }));
    const shop = async (args: Record<string, unknown>) => { const r = await shopper.callTool({ name: 'lake_buy', arguments: args }); expect(r.isError, JSON.stringify(r.content)).toBeFalsy(); return JSON.parse((r.content as { text: string }[])[0]!.text); };
    const shopperMe = JSON.parse(((await shopper.callTool({ name: 'lake_overview', arguments: {} })).content as { text: string }[])[0]!.text).you;
    const shopperName = shopperMe.name.split(' (')[0], shopperUrl0 = shopperMe.url as string;
    const order = await shop({ action: 'order', seller_url: me.url, sku: 'summary' });
    const cartId = order.cart?.id ?? order.cart ?? order.id;
    await shop({ action: 'pay', cart: String(cartId) });
    await two.c.close();
    // And the owner sees it on My AI, here now.
    await page.goto(`${house}/owner/#ai`);
    const aiName = me.name.split(' (')[0];
    await page.locator('ion-item.ai-row', { hasText: aiName }).getByText(/Here now/).waitFor({ timeout: 5000 });
    // Its chats are closed and the buyer's messages sit unread: its connector tells the house, and the owner is told.
    await tab('Today');
    await page.locator('ion-card.warn-card', { hasText: `${aiName} isn't reading` }).getByText(/waiting since .*open your AI app/).waitFor({ timeout: 15_000 });
    await tidy();
    // Money says what it was for and who paid, held until the buyer accepts; a tap opens the receipt.
    await tab('Money');
    const sale = page.locator('ion-item.pay', { hasText: 'A short summary' });
    await sale.waitFor({ timeout: 10_000 });
    expect(await sale.textContent()).toMatch(new RegExp(`\\$4 · A short summary.*from ${shopperName}.*sold by ${aiName}`));
    await sale.locator('.lake-pill', { hasText: 'held' }).waitFor();
    // Earned, Held and Receipts side by side on a phone.
    expect(new Set(await page.locator('.stat-row .stat').evaluateAll((ts) => ts.map((t) => (t as HTMLElement).offsetTop))).size).toBe(1);
    await page.locator('.stat', { hasText: 'Held' }).waitFor();
    await sale.click();
    await page.getByText(/Held until the buyer accepts/).waitFor();
    await tidy();
    // Delivered and accepted: the release replaces the held receipt, and Money counts it in Earned, though it had just
    // read the held one (runs 58 and 59: Earned missed the last release for five minutes).
    const earned = async () => Number((await page.locator('.stat.mint b').textContent())!.replace(/[^\d.]/g, ''));
    const before = await earned();
    // Paid and held, not delivered yet: the seller's passport shows it in progress (run 84: a paid present looked like nothing).
    let early: Record<string, any> = {};
    for (let i = 0; i < 10 && !early.in_progress?.length; i++) { early = await (await fetch(`${me.passport}.json`)).json(); if (!early.in_progress?.length) await page.waitForTimeout(500); }
    expect(early.in_progress).toEqual([expect.objectContaining({ role: 'seller', state: 'paid, held until delivery', total: { currency: 'USD', value: 4 } })]);
    await one.call('lake_sell', { action: 'deliver', cart: String(cartId), content: 'A short summary: the Lake keeps your data at home.' });
    await shop({ action: 'accept', cart: String(cartId) });
    await sale.locator('.lake-pill', { hasText: 'paid' }).waitFor({ timeout: 15_000 });
    expect(await earned()).toBe(before + 4);
    expect(await page.locator('.stat', { hasText: 'Held' }).count()).toBe(0);
    // The seller's passport (its public record): a page to share, and JSON with the deal and the receipt that proves it.
    expect(me.passport).toMatch(/\/a\/[^/]+\/passport$/);
    let pp: Record<string, any> = {};
    for (let i = 0; i < 10 && !pp.deals?.length; i++) { pp = await (await fetch(`${me.passport}.json`)).json(); if (!pp.deals?.length) await page.waitForTimeout(500); }
    expect(pp).toMatchObject({ name: me.name, counts: { sold: 1, counterparties: 1 } });
    expect(pp.deals[0]).toMatchObject({ role: 'seller', what: ['1 × A short summary'], total: { currency: 'USD', value: 4 }, receipt: { credential: expect.any(String) } });
    const shared = await (await fetch(me.passport, { headers: { accept: 'text/html' } })).text();
    expect(shared).toContain(`<h1>${me.name}</h1>`);
    expect(shared).toContain('signed receipt');
    // A question whose choices carry messages: the owner's pick is sent by the AI's connector, even with the AI gone (run 66).
    const shopperInbox = async () => JSON.parse(((await shopper.callTool({ name: 'lake_inbox', arguments: { wait_seconds: 2 } })).content as { text: string }[])[0]!.text).messages as { message?: { text?: string } }[];
    await shopperInbox();
    await one.call('lake_house_suggest', { text: 'The buyer paid for a summary: send them the brief now?', ask: { choices: ['Send the brief', 'Not yet'] }, then: [{ to: shopperUrl0, text: 'Brief: 3 bullets on the Lake, plain words.' }, null] });
    // Until the owner answers, the AI's inbox says it is still waiting on them (run 72: four AIs left with questions open).
    expect((await one.call('lake_inbox', { wait_seconds: 0 })).your_human_has_not_answered).toEqual([expect.objectContaining({ question: expect.stringContaining('send them the brief') })]);
    await tab('Today');
    const q = page.locator('ion-card.sug', { hasText: 'send them the brief now?' });
    await q.getByRole('button', { name: 'Send the brief' }).click();
    let briefed: { message?: { text?: string } }[] = [];
    for (let i = 0; i < 10 && !briefed.some((m) => m.message?.text?.startsWith('Brief:')); i++) briefed = [...briefed, ...(await shopperInbox())];
    expect(briefed.some((m) => m.message?.text === 'Brief: 3 bullets on the Lake, plain words.')).toBe(true);
    let still: unknown = [];
    for (let i = 0; i < 10 && still; i++) still = (await one.call('lake_inbox', { wait_seconds: 1 })).your_human_has_not_answered;
    expect(still).toBeUndefined();
    // An errand: the AI asks for its human and goes quiet; the answer comes while it's away, the house puts it to the owner,
    // and the owner's pick goes back to the one who answered (5 Nov: the house holds the errand, not the chat).
    const errand = await one.call('lake_ask', { to: shopperUrl0, text: 'Could you lend my human a ladder on Saturday?', expect_reply: true, what: 'a ladder on Saturday' });
    expect(errand.errand).toMatchObject({ id: expect.any(String), until: expect.any(String) });
    await shopperInbox();
    await page.waitForTimeout(3500);
    const answer = JSON.parse(((await shopper.callTool({ name: 'lake_ask', arguments: { to: me.url, kind: 'message', text: 'Yes, 9am, I will leave it by the gate.' } })).content as { text: string }[])[0]!.text);
    expect(answer.held).toMatch(/kept for its owner.*take it as a no/);
    await tab('Today');
    const ladder = page.locator('ion-card.sug', { hasText: 'a ladder on Saturday' });
    await ladder.getByText('Yes, 9am, I will leave it by the gate.').waitFor({ timeout: 5000 });
    expect(await ladder.getByRole('button', { name: 'Block them' }).count()).toBe(0); // the one it asked is no stranger
    await ladder.getByRole('button', { name: 'No thanks' }).click();
    let declined: { message?: { text?: string } }[] = [];
    for (let i = 0; i < 10 && !declined.some((m) => m.message?.text === 'Their human says no, thank you.'); i++) declined = [...declined, ...(await shopperInbox())];
    expect(declined.some((m) => m.message?.text === 'Their human says no, thank you.')).toBe(true);
    // Back in a chat, the AI finds how it ended.
    expect((await one.call('lake_house', { view: 'errands' })).errands).toEqual(expect.arrayContaining([expect.objectContaining({ what: 'a ladder on Saturday', state: 'answered', arrivals: [expect.objectContaining({ text: 'Yes, 9am, I will leave it by the gate.' })] })]));
    // A note at the door while the AI is away reaches the owner once: its connector doesn't pass the house's own news back.
    await page.waitForTimeout(3500); // the AI is away
    await shopper.callTool({ name: 'lake_knock', arguments: { house_url: house, purpose: 'contact', note: 'Spare eggs at mine if you want some.' } });
    await page.waitForTimeout(2500);
    const notes = (await one.call('lake_house', { view: 'requests' })).notes as { text: string }[];
    expect(notes.filter((n) => n.text.includes('Spare eggs'))).toHaveLength(1);
    // A need left standing outlives its assistant: someone who offers it later reaches the owner's phone (run 76).
    await one.call('lake_set_tags', { tags: ['seeking:lift-to-cool-room'] });
    await page.waitForTimeout(3500);
    await shopper.callTool({ name: 'lake_set_tags', arguments: { tags: ['offering:lift-to-cool-room'] } });
    await tab('Today');
    // A suggestion, or a chat the house kept for its AI while it was away.
    const match = page.locator('ion-card.sug, ion-item.note-row, .chatrow', { hasText: 'offering:lift-to-cool-room' });
    for (let i = 0; i < 20 && !(await match.count()); i++) { await page.waitForTimeout(500); if (i % 2) await tab(i % 4 === 1 ? 'People' : 'Today'); }
    expect(await match.count()).toBeGreaterThan(0);
    await one.call('lake_set_tags', { tags: [] });
    // A warning with the sender's address: the owner blocks it in one tap, and the AI's connector turns it away (run 65).
    const shopperUrl = shopperUrl0;
    await one.call('lake_house_suggest', { text: `${shopperName} keeps sending "fees": looks like a scam.`, advice: 'dont', sender: shopperUrl });
    await tab('Today');
    const warning = page.locator('ion-card.sug', { hasText: 'looks like a scam' });
    await warning.getByRole('button', { name: 'Block them' }).click();
    await confirmSheet('Block');
    await warning.waitFor({ state: 'detached', timeout: 10_000 });
    let turned = '';
    for (let i = 0; i < 10 && !/does not take messages/.test(turned); i++) {
      await page.waitForTimeout(500);
      turned = ((await shopper.callTool({ name: 'lake_ask', arguments: { to: me.url, kind: 'message', text: 'Your fee is overdue!' } })).content as { text: string }[])[0]!.text;
    }
    expect(turned).toMatch(/does not take messages from you/);
    // Looking for something, through the connector (SPEC §6.8): the owner's AI lists it; another AI, a seller, finds it
    // and offers a cart made out to the house; the owner's AI sees the offer, never having said the price to anyone.
    const lamp = await one.call('lake_want', { action: 'post', name: 'Bedside lamp', properties: { Base: 'E27', Colour: 'White' }, currency: 'USD', max_price: 30 });
    expect(lamp).toMatchObject({ ok: true, want: { name: 'Bedside lamp' } });
    const want = async (args: Record<string, unknown>) => { const r = await shopper.callTool({ name: 'lake_want', arguments: args }); expect(r.isError, JSON.stringify(r.content)).toBeFalsy(); return JSON.parse((r.content as { text: string }[])[0]!.text); };
    let found: { want: { id: string }; house: { url: string; webId: string } } | undefined;
    for (let i = 0; i < 20 && !found; i++) { found = (await want({ action: 'find', q: 'lamp' })).wants.find((x: { want: { id: string } }) => x.want.id === lamp.want.id); if (!found) await page.waitForTimeout(500); }
    expect(JSON.stringify(found)).not.toMatch(/max|budget|price"/);
    // In the want's currency without saying it; "matched" keeps only the want's own properties.
    expect(await want({ action: 'offer', want: found!.want.id, house: found!.house.url, house_webid: found!.house.webId, items: [{ label: 'White bedside lamp, E27', price: 22 }], delivery: '3 days', matched: ['base', 'Colour', 'Dimmable'] })).toMatchObject({ kind: 'want.received', matched_dropped: ['Dimmable'] });
    // A second offer replaces the first, and says so; where it stands, from the seller's side.
    const again = await want({ action: 'offer', want: found!.want.id, house: found!.house.url, house_webid: found!.house.webId, items: [{ label: 'White bedside lamp, E27', price: 22 }], delivery: '3 days', matched: ['Base', 'Colour'] });
    expect(again).toMatchObject({ kind: 'want.received', replaced: expect.stringMatching(/^o-/) });
    expect(await want({ action: 'status', want: found!.want.id, house: found!.house.url })).toMatchObject({ kind: 'want.status', offer: again.offer, state: 'open' });
    expect((await one.call('lake_want', { action: 'mine' })).wants.find((w: { id: string }) => w.id === lamp.want.id)).toMatchObject({ offers: [{ total: 'USD 22.00', delivery: '3 days', state: 'open' }] });
    expect(await one.call('lake_want', { action: 'close', id: lamp.want.id })).toMatchObject({ ok: true });
    await shopper.close(); await one.c.close();
    await tidy();
  });

  it('recovers the house on a new device with a recovery code, and the old device knows it lost the key', async () => {
    await tab('New or lost phone');
    await page.getByRole('button', { name: 'Make a recovery code' }).click();
    const code = (await page.locator('code.recovery').textContent())!;
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    await page.getByRole('button', { name: 'I\'ve written it down' }).click();
    // A new phone, which never had the key.
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone2 = await ctx2.newPage();
    phone2.on('pageerror', (e) => errors.push(e.message));
    await phone2.goto(`${house}/owner/`);
    // The house has a key: no tap-to-pair button that can't work; the recovery code is offered open.
    await phone2.getByText(/This house already has a key/).waitFor();
    expect(await phone2.getByRole('button', { name: 'Use this phone' }).count()).toBe(0);
    await phone2.getByLabel('Recovery code').fill(code.toLowerCase());
    await phone2.getByRole('button', { name: 'Use it' }).click();
    await onTab('Today', phone2);
    // The old phone's next look: not the key any more, said plainly.
    // It may already know (the live stream refreshes it); otherwise its next tap finds out.
    await lostKey(page);
    // The code worked once.
    const again = await (await fetch(`${house}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: (await generateIdentity('x')).publicJwk, recovery: code }) })).json();
    expect(again.error).toMatch(/doesn't match/);
    // And moves to a third device with a one-use link.
    await tab('New or lost phone', phone2);
    await phone2.getByRole('button', { name: 'Make a pairing link' }).click();
    const link = (await phone2.locator('.address .copybox').textContent())!;
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone3 = await ctx3.newPage();
    phone3.on('pageerror', (e) => errors.push(e.message));
    phone3.on('dialog', (d) => { errors.push(`a dialog box: ${d.message()}`); void d.dismiss(); });
    // This phone has a key kept the old way (hex in localStorage): the app moves it into the browser, same key, no new pairing.
    // The test keeps its seed, to sign as the owner from here later.
    ownerSeed = { seed: randomBytes(32), kid: 'owner-legacy0001' };
    await phone3.goto(`${house}/.well-known/agent-card.json`);
    await phone3.evaluate((k) => localStorage.setItem(`lake-owner-key:${location.host}`, JSON.stringify(k)), { secret: ownerSeed.seed.toString('hex'), kid: ownerSeed.kid });
    await phone3.goto(link);
    await onTab('Today', phone3);
    expect(await phone3.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('lake-owner-key:')))).toBe(false);
    expect(await phone3.evaluate(keptKid)).toBe(ownerSeed.kid);
    await tab('You', phone3);
    await phone3.locator('.key-store', { hasText: 'can\'t be copied out' }).waitFor();
    expect((await fetch(`${house}/owner/`)).headers.get('content-security-policy')).toMatch(/script-src 'self';/);
    await lostKey(phone2);
    await ctx2.close();
    page = phone3;
    ctx = ctx3;
    await tidy();
  });

  it('notifies the owner\'s devices by Web Push when something needs them: a note at the door (1 Nov)', async () => {
    // The owner's key as this browser keeps it, to sign as the owner from here (the panel's own calls do the same).
    const saved = { kid: ownerSeed!.kid }, seed = ownerSeed!.seed;
    const jwk = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
    const owner = await importIdentity({ kid: saved.kid, privateJwk: { ...jwk, kid: saved.kid }, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: saved.kid } } as never);
    const asOwner = async (payload: Record<string, unknown>) => (await fetch(`${house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, owner, { iss: 'owner' })) })).json();
    // A stand-in push service: what the house sends there is the encrypted push (RFC 8291) with its VAPID signature.
    const got: { auth?: string; encoding?: string; ttl?: string; bytes: number }[] = [];
    const svc = httpServer((req, res) => { let n = 0; req.on('data', (c) => (n += c.length)); req.on('end', () => { got.push({ auth: req.headers.authorization, encoding: req.headers['content-encoding'] as string, ttl: req.headers.ttl as string, bytes: n }); res.writeHead(201); res.end(); }); });
    await new Promise<void>((ok) => svc.listen(0, ok));
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = { endpoint: `http://localhost:${(svc.address() as { port: number }).port}/push/device-1`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    expect((await asOwner({ kind: 'panel.push.key' })).publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // An assistant can't turn it on or read it; the owner can.
    expect((await asAssistant({ kind: 'panel.push.subscribe', subscription })).error ?? '').not.toBe('');
    expect(await asOwner({ kind: 'panel.push.subscribe', subscription })).toMatchObject({ ok: true, devices: 1 });
    expect(await asOwner({ kind: 'panel.push.test' })).toMatchObject({ ok: true });
    for (let i = 0; i < 20 && !got.length; i++) await page.waitForTimeout(250);
    expect(got[0]).toMatchObject({ auth: expect.stringMatching(/^vapid t=.+, k=.+/), encoding: 'aes128gcm' });
    // A note at the door: the owner's phone hears of it (vaguely: the details are in the panel).
    const neighbour = await makeVisitor(await generateIdentity(), 'neighbour.example');
    await ask(house, neighbour, { kind: 'note', text: 'Your parcel is on my porch.' });
    for (let i = 0; i < 20 && got.length < 2; i++) await page.waitForTimeout(250);
    expect(got.length).toBe(2);
    expect(await asOwner({ kind: 'panel.push.off' })).toMatchObject({ ok: true, devices: 0 });
    svc.close();
  });

  it('next time: "Always allow" makes a standing yes for exactly that ask, listed in Keys and removable; "Always decline" mutes (1-2 Nov)', async () => {
    const clinic = await makeVisitor(await generateIdentity(), 'clinic.example');
    const terms = { purpose: 'care', fields: ['medications'], priceUsd: 0, retention: 'none', credentials: { ethicsApproved: false, sponsorVerified: false, auditCertified: false } };
    expect((await knock(house, clinic, terms)).reply).toMatchObject({ decision: 'ask' });
    await tab('Today');
    const card = page.locator('ion-card.req', { hasText: 'clinic.example' });
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    // When the house advises no (sensitive data outside a certified study), Allow asks once more.
    if (await page.locator('ion-action-sheet').waitFor({ timeout: 1500 }).then(() => true, () => false)) await confirmSheet('Allow anyway');
    // Answered: a toast says so, with "next time" in one tap.
    await page.getByText('Allowed clinic.example').waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Always allow' }).last().click();
    await page.getByText(/clinic.example gets a yes for this from now on/).waitFor({ timeout: 10_000 });
    // The same ask again: the house answers it, by the owner's standing yes; anything more still asks.
    expect((await knock(house, clinic, terms)).reply).toMatchObject({ decision: 'join' });
    expect((await knock(house, clinic, { ...terms, fields: ['medications', 'age_band'] })).reply).toMatchObject({ decision: 'ask' });
    // Another agent with the same name but its own key gets no standing yes (a name is not a key).
    const lookalike = await makeVisitor(await generateIdentity(), 'clinic.example');
    expect((await knock(house, lookalike, terms)).reply).toMatchObject({ decision: 'ask' });
    await tab('Today');
    // The wider ask and the lookalike's: each a card (or one, grouped); deny whatever is there.
    for (let i = 0; i < 4 && (await page.locator('ion-card.req', { hasText: 'clinic.example' }).count()); i++) {
      const n = await page.locator('ion-card.req', { hasText: 'clinic.example' }).count();
      await page.locator('ion-card.req', { hasText: 'clinic.example' }).first().getByRole('button', { name: /^Deny/ }).click();
      for (let j = 0; j < 20 && (await page.locator('ion-card.req', { hasText: 'clinic.example' }).count()) >= n; j++) await page.waitForTimeout(250);
    }
    await page.waitForTimeout(6500); // the toasts go by themselves: nothing was set for next time
    // Listed in Who has access, with how often it was used; removed, it asks again.
    await tab('Who has access');
    await page.locator('ion-segment-button', { hasText: 'Everyone' }).click();
    const rows = page.locator('ion-item.access-row', { hasText: 'clinic.example' });
    await rows.first().waitFor({ timeout: 10_000 });
    const always = page.locator('.more-line', { hasText: 'Always yes to clinic.example, for care' });
    for (let i = 0; i < (await rows.count()) && !(await always.count()); i++) { await rows.nth(i).click(); await page.waitForTimeout(300); }
    await always.waitFor({ timeout: 10_000 });
    expect(await always.textContent()).toMatch(/used 1 time/);
    await always.getByRole('button', { name: 'Remove' }).click();
    await always.waitFor({ state: 'detached', timeout: 10_000 });
    expect((await knock(house, clinic, terms)).reply).toMatchObject({ decision: 'ask' });
    // Declined, and "Always decline": that agent is turned away at the door from then on.
    await tab('Today');
    await page.locator('ion-card.req', { hasText: 'clinic.example' }).first().getByRole('button', { name: /^Deny/ }).click();
    await page.getByText('Declined clinic.example').last().waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Always decline' }).last().click();
    await page.getByText(/You won't hear from clinic.example again/).waitFor({ timeout: 10_000 });
    expect((await knock(house, clinic, terms)).reply).toMatchObject({ decision: 'decline' });
  });

  it('puts the owner\'s AI on duty: a signed grant and a code, the morning page with Undo, and off duty in two taps (5 Nov)', async () => {
    await tab('My AI');
    // Off until set up: a row on My AI, and its form in a sheet.
    await page.locator('ion-item.lake-row', { hasText: 'Set up AI on duty' }).click();
    const card = sheet();
    // This house offers a model, so it can run the AI itself: one tap. This test runs it elsewhere, to pair its own stand-in.
    await card.locator('ion-segment-button', { hasText: 'In my house' }).waitFor({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Sign and turn on' }).waitFor();
    await card.locator('ion-segment-button', { hasText: 'On my computer' }).click();
    await card.getByText('Never money; anything new waits for you.').waitFor({ timeout: 10_000 });
    // Hours around now, so what it does below counts as on duty.
    const [from, to] = await page.evaluate(() => { const hh = (d: number) => String((new Date().getHours() + d + 24) % 24).padStart(2, '0') + ':00'; return [hh(-1), hh(2)]; });
    await card.getByLabel('On duty from').fill(from);
    await card.getByLabel('On duty until').fill(to);
    const checked = (label: string) => card.locator('ion-checkbox', { hasText: label }).evaluate((e) => (e as HTMLElement & { checked: boolean }).checked);
    expect(await checked('Reply to people you know')).toBe(true);
    expect(await checked('Book times you\'re free')).toBe(true);
    await card.getByRole('button', { name: 'Sign and get the command' }).click();
    const box = card.locator('.copybox');
    await box.waitFor({ timeout: 10_000 });
    const cmd = (await box.textContent())!.trim();
    expect(cmd).toMatch(new RegExp(`^npx -y @thelakeprotocol/agent duty --lake \\S+/mcp --house ${house.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --code \\S+$`));
    const code = /--code (\S+)$/.exec(cmd)![1]!;
    await tidy();
    // The runner pairs with the code: it is the AI on duty, under exactly what was signed.
    const night = await generateIdentity('night-ai');
    const paired = await (await fetch(`${house}/owner/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: night.publicJwk, code, label: 'Night AI', url: 'https://night.example/a2a' }) })).json();
    expect(paired).toMatchObject({ paired: true, duty: { kinds: ['reply', 'book'], cap: 10 } });
    await closeSheet();
    const asNight = async (payload: Record<string, unknown>) => (await fetch(`${house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, night, { iss: 'assistant' })) })).json();
    expect(await asNight({ kind: 'assistant.duty' })).toMatchObject({ on: true, used: 0 });
    // Sam's AI leaves a note, and the owner hands that chat to their AI: someone it may answer while they're away.
    const samGot: Record<string, any>[] = [];
    const sam = await joinLake({ name: 'Sam (Claude)', domain: 'sam.example', node: nodeUrl, port: await freePort(), onMessage: async (m) => { samGot.push(m.payload as Record<string, any>); return { kind: 'received' }; } });
    const heard = async (status: string) => { for (let i = 0; i < 40 && !samGot.some((x) => x.booking?.status === status); i++) await page.waitForTimeout(250); return samGot.find((x) => x.booking?.status === status); };
    try {
      const left = await sam.ask(`${house}/a2a`, { kind: 'note', text: 'Sam here: could we talk next week?' }) as { kind: string; note: string };
      await page.goto(`${house}/owner/#note=${left.note}`);
      await page.locator('.modebar ion-segment ion-segment-button', { hasText: 'My AI replies' }).click();
      await page.locator('.chatwho', { hasText: 'Your AI replies' }).waitFor({ timeout: 6000 });
      // Overnight: a time held for the owner, a reply, and one thing it was stopped from doing.
      // On duty a time is a free slot (an earlier test set the free hours), answers a note, and is at least three hours off.
      expect(await asNight({ kind: 'assistant.agenda', what: 'Call with Sam', when: 'next week', with: 'Sam' })).toMatchObject({ error: expect.stringContaining('needs its start') });
      const slot = (await asNight({ kind: 'panel.free' })).slots.find((s: { start: string }) => Date.parse(s.start) > Date.now() + 4 * 3_600_000);
      expect(await asNight({ kind: 'assistant.agenda', what: 'Call with Sam', when: 'next week', with: 'Sam', start: slot.start })).toMatchObject({ error: expect.stringContaining('agenda.re') });
      const booked = await asNight({ kind: 'assistant.agenda', what: 'Call with Sam', when: 'next week', with: 'Sam', start: slot.start, re: left.note });
      expect(booked).toMatchObject({ ok: true, id: expect.any(String), status: expect.stringContaining('held') });
      // Sam's AI has it from the house, in the house's words: pencilled in, not confirmed.
      expect(await heard('held')).toMatchObject({ kind: 'note.reply', note: left.note, text: expect.stringContaining('hasn\'t confirmed it yet'), booking: { id: booked.id, status: 'held' } });
      expect(await asNight({ kind: 'assistant.duty.log', tool: 'lake_house_suggest', action: 'book', to: { name: 'Sam (Claude)' }, text: 'Call with Sam', undo: { kind: 'agenda', ref: booked.id }, reply: { kind: 'received', digest: 'abc123' } })).toMatchObject({ ok: true, used: 1 });
      expect(await asNight({ kind: 'assistant.duty.log', tool: 'lake_ask', action: 'reply', to: { name: 'Sam\'s AI (Claude, via MCP)', key: 'sam-key-0123456789abcdefgh' }, text: 'I\'ve asked for a time.', undo: { kind: 'correction', ref: 'https://sam.example/a2a' }, reply: { kind: 'received', digest: 'def456' } })).toMatchObject({ ok: true, used: 2 });
      expect(await asNight({ kind: 'assistant.duty.log', tool: 'lake_pay', action: 'pay', to: { name: 'Quick Cash' }, refused: 'no money on duty' })).toMatchObject({ ok: true });
      // The morning. Today asks for the owner's own yes on the held time: Confirm or Decline, nothing else to do with it.
      await tab('Today');
      const card = page.locator('ion-card.sug', { hasText: 'Held for your OK' });
      await card.locator('.held-what', { hasText: 'Call with Sam' }).waitFor({ timeout: 10_000 });
      await card.locator('.held-when', { hasText: /· with Sam$/ }).waitFor();
      await card.getByText('Your AI pencilled this in. Sam was told you\'ll confirm it yourself.').waitFor();
      await card.locator('.held-until', { hasText: /^Held until .+ With no answer by then it's off/ }).waitFor();
      await card.getByRole('button', { name: 'Decline', exact: true }).waitFor();
      expect(await card.getByRole('button', { name: 'Dismiss' }).count()).toBe(0);
      await page.locator('ion-item.lake-row', { hasText: 'Call with Sam' }).locator('.lake-pill', { hasText: 'Held' }).waitFor();
      // The same card sits in Sam's chat, under what the house told Sam's AI.
      await page.goto(`${house}/owner/#note=${left.note}`);
      await page.locator('.bubble.ai', { hasText: 'hasn\'t confirmed it yet' }).waitFor({ timeout: 10_000 });
      const inChat = page.locator('.chat-card ion-card.sug', { hasText: 'Held for your OK' });
      await inChat.locator('.held-what', { hasText: 'Call with Sam' }).waitFor();
      await inChat.getByRole('button', { name: 'Confirm', exact: true }).waitFor();
      await tidy();
      await goBack();
      await tab('Today');
      // Handled for you: each thing it did, saying it was your AI, with Undo where there is something to undo (a held
      // time isn't handled: it waits above).
      const handled = page.locator('ion-list.handled');
      await handled.locator('ion-item.handled-row', { hasText: "Replied to Sam's AI" }).getByText(/Your AI · /).waitFor({ timeout: 10_000 });
      await handled.locator('ion-item.handled-row', { hasText: "Replied to Sam's AI" }).getByRole('button', { name: 'Undo', exact: true }).waitFor();
      const heldLine = handled.locator('ion-item.handled-row', { hasText: /Held a time with Sam.* for you to confirm/ });
      await heldLine.waitFor();
      expect(await heldLine.getByRole('button', { name: 'Undo' }).count()).toBe(0);
      await tidy();
      // My AI counts it as waiting, not handled.
      await tab('My AI');
      expect(await page.locator('.stat-row .stat b').allTextContents()).toEqual(['1', '1', '0']);
      await page.locator('ion-item.slept-row', { hasText: /Held a time with Sam.* for you to confirm/ }).locator('.lake-pill', { hasText: 'Held' }).waitFor();
      await page.getByText('Stopped 1 thing it may not do.').waitFor();
      // Confirm: the owner's own yes. The house tells Sam's AI, and the time is theirs.
      await tab('Today');
      await card.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.getByText('Confirmed. Sam was told.').waitFor({ timeout: 10_000 });
      await card.waitFor({ state: 'detached', timeout: 10_000 });
      expect(await heard('confirmed')).toMatchObject({ kind: 'note.reply', note: left.note, text: expect.stringMatching(/^Confirmed by /), booking: { id: booked.id, status: 'confirmed' } });
      await page.locator('ion-item.lake-row', { hasText: 'Call with Sam' }).locator('.lake-pill', { hasText: 'Confirmed' }).waitFor({ timeout: 10_000 });
      await tidy();
      await tab('My AI');
      expect(await page.locator('.stat-row .stat b').allTextContents()).toEqual(['2', '0', '0']);
      await page.locator('ion-item.slept-row', { hasText: /Booked with Sam.* \(you confirmed\)/ }).locator('.lake-pill', { hasText: 'Confirmed' }).waitFor();
      // A reply can be undone (the AI's connector sends the correction).
      const said = page.locator('ion-item.slept-row', { hasText: 'Replied to Sam\'s AI: I\'ve asked for a time.' });
      await said.getByRole('button', { name: 'Undo' }).click();
      await said.getByText('Undone').waitFor({ timeout: 10_000 });
      await tidy();
    } finally { await sam.close(); }
    // On duty, with tonight's count; its own page says what it may do; off duty after a sheet that asks.
    const on = page.locator('ion-item.duty-row', { hasText: 'Night AI' });
    await on.locator('.lake-pill', { hasText: 'On duty' }).waitFor({ timeout: 10_000 });
    expect(await on.textContent()).toMatch(new RegExp(`${from}–${to} · 2 of 10 tonight`));
    await page.locator('ion-item.ai-row', { hasText: 'Night AI' }).click();
    await page.getByText('Replies and bookings only, never money').waitFor();
    await tidy();
    await goBack();
    await on.getByRole('button', { name: 'Turn off' }).click();
    await confirmSheet('Turn off');
    // Off duty: back to Set up.
    await page.locator('ion-item.lake-row', { hasText: 'Set up AI on duty' }).waitFor({ timeout: 10_000 });
    await page.locator('ion-item.lake-row', { hasText: 'Set up AI on duty' }).click();
    await sheet().getByRole('button', { name: 'Sign and turn on' }).waitFor({ timeout: 10_000 });
    await closeSheet();
    expect(await asNight({ kind: 'assistant.duty' })).toMatchObject({ on: false });
    await tidy();
  });

  it('a promise circle on the phone: a person stamp, Sign this pledge, Ask my circle, Thanks, Yes I\'ll do it, and "You\'re square" (7 Nov)', async () => {
    const saved = { kid: ownerSeed!.kid }, seed = ownerSeed!.seed;
    const jwk = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }).export({ format: 'jwk' });
    const owner = await importIdentity({ kid: saved.kid, privateJwk: { ...jwk, kid: saved.kid }, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: saved.kid } } as never);
    const asOwner = async (payload: Record<string, unknown>) => (await fetch(`${house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, owner, { iss: 'owner' })) })).json();
    // A neighbour's house, its phone a key in this test.
    const [pp, hp] = [await freePort(), await freePort()];
    await start(['packages/house/dist/main.js', '--name', 'neighbour', '--rules', 'personas/stan.yaml', '--data', join(dir, 'neighbour'), '--issuer-url', `${specialists}/issuer`, '--auditor-url', `${specialists}/auditor`,
      '--person-url', `${specialists}/person`, '--pod-port', String(pp), '--port', String(hp), '--lake', nodeUrl, '--seed', '8', '--open-pairing'], /joined the Lake/);
    const nb = `http://localhost:${hp}`, phone = await generateIdentity('neighbour-phone');
    await fetch(`${nb}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: phone.publicJwk }) });
    const nbWebId = (await (await fetch(`${nb}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage({ kind: 'panel.overview' }, phone, { iss: 'owner' })) })).json()).webId;
    const asNb = async (payload: Record<string, unknown>) => (await fetch(`${nb}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, phone, { iss: nbWebId })) })).json();
    expect(await asNb({ kind: 'panel.person.request', consent: await signMessage({ kind: 'personhood.consent', house: nbWebId }, phone, { iss: nbWebId }) })).toMatchObject({ stamped: true });
    // A circle of two on the street. Signing before having a person stamp says plainly what to do.
    const organiser = await makeVisitor(await generateIdentity(), 'street.example');
    expect((await ask(`${specialists}/tally/a2a`, organiser, { kind: 'tally.open', id: 'street-circle', text: 'Our street helps out.', threshold: 2, deadline: new Date(Date.now() + 3_600_000).toISOString(), people_only: true, listed: true, circle: { promise: 'a lift or a meal', times: 3, kinds: ['a lift', 'a meal'] } })).reply).toMatchObject({ kind: 'tally.opened' });
    // Someone invites the owner to sign it, in a note: the phone shows the tally's terms with Sign, and says the sender is
    // someone the house hasn't dealt with (round 11: an agent's only way to ask a person to sign was free text).
    expect((await ask(house, organiser, { kind: 'note', text: 'Our street is starting a promise circle: would you join?', pledge: { tally: `${specialists}/tally`, id: 'street-circle' } })).reply).toMatchObject({ kind: 'noted' });
    await tab('Today');
    const invite = page.locator('ion-card.sug', { hasText: 'invites you to sign' });
    await invite.getByText(/someone your side hasn't dealt with: their words are unchecked/).waitFor({ timeout: 15_000 });
    await invite.getByRole('button', { name: 'Sign the pledge' }).waitFor();
    await invite.getByRole('button', { name: 'Dismiss' }).click();
    await invite.waitFor({ state: 'detached', timeout: 10_000 });
    await tab('About this house');
    await page.locator('ion-accordion', { hasText: 'Sign a pledge from your house' }).locator('ion-item[slot="header"]').click();
    await page.getByPlaceholder(/tally address/).fill(`${specialists}/tally`);
    await page.getByPlaceholder('pledge id').fill('street-circle');
    await page.getByRole('button', { name: 'Sign this pledge' }).click();
    await page.getByText(/it counts people, once each: get a person stamp first/).waitFor({ timeout: 15_000 });
    // The owner gets a person stamp from About this house.
    await page.getByRole('button', { name: 'Get a person stamp' }).click();
    await page.getByText('One person, one house: stamped').waitFor({ timeout: 15_000 });
    await tidy();
    // Now the owner signs on the phone; the neighbour signs too, and it opens.
    // (Its AI would suggest it; this owner's AI was removed above, so they sign it from About this house.)
    await page.getByRole('button', { name: 'Sign this pledge' }).click();
    await page.getByText(/Signed: 1 of 2/).waitFor({ timeout: 15_000 });
    expect(await asNb({ kind: 'panel.pledge.sign', tally: `${specialists}/tally`, id: 'street-circle' })).toMatchObject({ kind: 'tally.triggered' });
    // Your promise circles, under You: ask it for a lift.
    await page.goto(`${house}/owner/#you`);
    await tab('Your promise circles');
    const circles = page.locator('ion-card.circle-card');
    await circles.getByText('You promised: a lift or a meal, 3 times a year, to 1 others.').waitFor({ timeout: 15_000 });
    expect(await circles.locator('ion-select.help-kind').evaluate((e) => (e as HTMLElement & { value: string }).value)).toBe('a lift');
    await circles.getByLabel('What do you need').fill('A lift to the station on Friday');
    await circles.getByRole('button', { name: 'Ask my circle' }).click();
    await page.getByText('Asked 1 member, without your name.').waitFor({ timeout: 10_000 });
    await tidy();
    // The neighbour says yes; the owner sees it live, and taps Thanks.
    const nbAsk = async (call?: string) => { for (let i = 0; i < 30; i++) { const n = ((await asNb({ kind: 'list' })).suggestions as { id: string; circle?: { role: string; state: string; call: string } }[]).find((x) => x.circle?.role === 'ask' && x.circle.state === 'open' && (!call || x.circle.call === call)); if (n) return n; await page.waitForTimeout(500); } throw new Error('no ask'); };
    expect(await asNb({ kind: 'panel.circle.answer', note: (await nbAsk()).id, accept: true })).toMatchObject({ kind: 'circle.matched' });
    await goBack();
    await tab('Today');
    await page.getByText('Someone said yes. Reach them at their house:').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Thanks', exact: true }).click();
    await page.getByText('Thanked: you owe one favour.').waitFor({ timeout: 10_000 });
    await tidy();
    // Then the neighbour needs a meal: the owner is asked without their name, and says yes.
    expect(await asNb({ kind: 'panel.circle.call', tally: `${specialists}/tally`, id: 'street-circle', need: 'Soup, I have the flu', help: 'a meal' })).toMatchObject({ kind: 'circle.called' });
    await page.getByText(/Someone in your circle needs help with a meal: Soup, I have the flu/).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Yes, I\'ll do it' }).click();
    await page.getByText('You said yes. Reach them at their house:').waitFor({ timeout: 10_000 });
    // The neighbour thanks them: two favours owed in a loop, and both are square.
    const callerNote = async () => { for (let i = 0; i < 30; i++) { const n = ((await asNb({ kind: 'list' })).suggestions as { id: string; circle?: { role: string; state: string } }[]).find((x) => x.circle?.role === 'caller' && x.circle.state === 'matched'); if (n) return n; await page.waitForTimeout(500); } throw new Error('not matched'); };
    expect(await asNb({ kind: 'panel.circle.kept', note: (await callerNote()).id })).toMatchObject({ kind: 'circle.kept' });
    await page.getByText(/You're square: a loop of 2 favours across 1 circle cancelled out\. Nobody paid anything\./).waitFor({ timeout: 20_000 });
    await tidy();
    // Changing a rule is put to a vote (with the circle, under You); a circle of two can't hold one, and the app says why.
    await tab('Your promise circles');
    await circles.locator('ion-accordion', { hasText: 'Change a rule, by vote' }).locator('ion-item[slot="header"]').click();
    await circles.locator('ion-select.vote-limit').click();
    await page.locator('ion-popover').getByRole('radio', { name: '1', exact: true }).click();
    await circles.getByRole('button', { name: 'Put it to a vote' }).click();
    await page.getByText('a vote needs at least 3 members').waitFor({ timeout: 10_000 });
    await tidy();
    await tidy();
    expect(await asOwner({ kind: 'panel.circles' })).toEqual([expect.objectContaining({ id: 'street-circle', view: expect.objectContaining({ kept: 2, you: expect.objectContaining({ you_owe: 0, owed_to_you: 0 }) }) })]);
    procs.pop()!.kill('SIGTERM');
  });

  it('turns notifications on, off or tests them from You → Notifications (7 Nov)', async () => {
    await tab('Notifications');
    await page.getByRole('heading', { name: /for this phone/ }).waitFor();
    expect(await page.getByText(/Says who, never what/).count()).toBe(1);
    await tidy();
  });

  it('signs out on this device: back to the pairing screen', async () => {
    const keyNow = () => page.evaluate(keptKid);
    const before = await keyNow();
    await tab('You');
    // Asked on a sheet first.
    await page.locator('ion-item', { hasText: 'Sign out on this device' }).click();
    await confirmSheet('Sign out');
    // The house still holds the key this device had: getting back in takes a link or the recovery code.
    await page.getByText(/This house already has a key/).waitFor({ timeout: 5000 });
    // The owner's key is gone from this device (a fresh one, not yet paired, is ready for pairing again).
    expect(await keyNow()).not.toBe(before);
    expect(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('lake-panel:')))).toBe(false);
    await tidy();
  });
});
