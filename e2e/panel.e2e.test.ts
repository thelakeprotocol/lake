import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { generateIdentity, signMessage, type Identity } from '../packages/core/src/index.js';

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

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
function start(args: string[], ready: RegExp): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    const timer = setTimeout(() => fail(new Error(`timed out:\n${out}`)), 120_000);
    const on = (b: Buffer) => { out += b; if (ready.test(out)) { clearTimeout(timer); ok(); } };
    p.stdout!.on('data', on);
    p.stderr!.on('data', on);
    p.once('exit', (c) => fail(new Error(`exited ${c}:\n${out}`)));
  });
}

/** The page is never wider than the phone, and nothing threw. */
async function tidy() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}
const tab = async (name: string) => {
  const main = page.locator('#nav > button', { hasText: name });
  if (await main.count()) await main.click();
  else { await page.locator('#nav .more-btn').click(); await page.locator('#nav .more-menu button', { hasText: name }).click(); }
  await page.waitForTimeout(300);
};

const lostKey = async (p: Page) => {
  const said = p.getByText(/isn't your house's key any more/);
  await said.waitFor({ timeout: 3000 }).catch(async () => { await p.locator('#nav > button', { hasText: 'Home' }).click(); await said.waitFor({ timeout: 5000 }); });
};

let assistant: Identity;
const asAssistant = async (payload: Record<string, unknown>) => (await fetch(`${house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, assistant, { iss: 'assistant' })) })).json();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-panel-'));
  const [np, sp, pp, hp] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const node = `http://localhost:${np}`;
  await start(['packages/lake/dist/main.js', '--port', String(np), '--data', join(dir, 'node'), '--feed-batch-ms', '200'], /Lake node on/);
  await start(['packages/specialists/dist/main.js', 'all', '--port', String(sp), '--data', join(dir, 'specialists'), '--lake', node, '--packs', 'health,shopping'], /register registered with the Lake node/);
  house = `http://localhost:${hp}`;
  // A sandbox house: the first device to open its panel becomes its owner, as on the public sandbox.
  await start(['packages/house/dist/main.js', '--name', 'panel', '--rules', 'personas/stan.yaml', '--data', join(dir, 'house'), '--issuer-url', `http://localhost:${sp}/issuer`,
    '--auditor-url', `http://localhost:${sp}/auditor`, '--pod-port', String(pp), '--port', String(hp), '--lake', node, '--seed', '7', '--open-pairing'], /joined the Lake/);
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // The panel asks on the page, never in a browser dialog box.
  page.on('dialog', (d) => { errors.push(`a dialog box: ${d.message()}`); void d.dismiss(); });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  procs.forEach((p) => p.kill('SIGTERM'));
  await new Promise((r) => setTimeout(r, 500));
  await rm(dir, { recursive: true, force: true });
});

describe('the owner panel, on a phone', { timeout: 60_000 }, () => {
  it('pairs a fresh device: the house name, one button, then Home', async () => {
    await page.goto(`${house}/owner/`);
    // Not claimed yet: what it is, and the one thing to do.
    await page.getByRole('button', { name: 'Pair this device' }).waitFor();
    expect(await page.locator('h1').textContent()).toMatch(/House|A house on the Lake/);
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('heading', { name: 'Get set up' }).waitFor();
    await page.getByRole('heading', { name: 'Needs you' }).waitFor();
    await tidy();
  });

  it('opens the door from Get set up, and its public page says how to knock', async () => {
    await page.locator('.steps li', { hasText: 'Open your door' }).getByRole('button', { name: 'Open it' }).click();
    await page.locator('.steps li.done', { hasText: 'Open your door' }).waitFor();
    const door = await (await fetch(house, { headers: { accept: 'text/html' } })).text();
    expect(door).toMatch(/Knock, knock[\s\S]*Send your AI over[\s\S]*Knock on the door at/);
    await tidy();
  });

  it('shares the door from Home: its address, Copy, and a QR code a tap away', async () => {
    await tab('Home');
    const share = page.locator('section.block', { has: page.getByRole('heading', { name: 'Your door', exact: true }) });
    await share.getByText(house, { exact: true }).waitFor();
    await share.getByRole('button', { name: 'QR code' }).click();
    await share.locator('img.qr').waitFor();
    await tidy();
  });

  it('lets a person leave a note themselves from the door page, and read the answer later', async () => {
    const visitor = await ctx.newPage();
    await visitor.goto(house);
    await visitor.getByText('Leave a note yourself').click();
    await visitor.locator('textarea[name=text]').fill('Hi, Sam here: would love a coffee.');
    await visitor.locator('input[name=from]').fill('Sam');
    await visitor.getByRole('button', { name: 'Leave the note' }).click();
    await visitor.getByRole('heading', { name: 'Note left ✓' }).waitFor();
    const link = await visitor.locator('a').first().getAttribute('href');
    await visitor.goto(link!);
    await visitor.getByText(/with the owner/i).waitFor();
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await visitor.close();
    await page.locator('.item', { hasText: 'would love a coffee' }).waitFor({ timeout: 4000 });
  });

  it('gives the owner\'s AI a key on the first tap, and shows it connected live', async () => {
    await tab('My agent');
    await page.getByRole('button', { name: 'Give my AI a key' }).click();
    const box = page.locator('textarea.copybox');
    await box.waitFor({ timeout: 3000 });
    const code = /code (\S+)\./.exec(await box.inputValue())![1]!;
    assistant = await generateIdentity('panel-assistant');
    const paired = await (await fetch(`${house}/owner/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: assistant.publicJwk, code, label: 'Nova (Claude, via MCP)', webId: 'https://panel-assistant.example/#agent' }) })).json();
    expect(paired).toMatchObject({ paired: true });
    // No reload: the house says something changed, and the panel shows it.
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.item', { hasText: 'Nova' }).locator('.chip', { hasText: 'Here now' }).waitFor({ timeout: 5000 });
    await tidy();
  });

  it('signs spending money for it, and the AI sees it', async () => {
    await page.getByText('Give it spending money').click();
    await page.locator('.item input[type=number]').fill('500');
    await page.getByRole('button', { name: 'Sign and give' }).click();
    await page.getByText(/may spend \$500/).waitFor({ timeout: 5000 });
    expect(await asAssistant({ kind: 'assistant.allowance' })).toMatchObject({ amount: 500, currency: 'USD', intent: { credential: expect.any(String) } });
    await tidy();
  });

  it('shows a note from the web the moment it arrives, and the owner answers it', async () => {
    await tab('Home');
    const left = await (await fetch(`${house}/note?text=${encodeURIComponent('Hi, Ana here: coffee next week?')}&from=Ana`)).json();
    expect(left.kind).toBe('noted');
    const note = page.locator('.item', { hasText: 'coffee next week' });
    await note.waitFor({ timeout: 4000 });
    await note.getByText('Answer').click();
    await note.locator('input').fill('Yes: Tuesday 10:00?');
    await note.getByRole('button', { name: 'Send', exact: true }).click();
    await note.getByText(/You answered: “Yes: Tuesday 10:00\?”/).waitFor({ timeout: 4000 });
    expect(await (await fetch(left.answer_at)).json()).toMatchObject({ status: 'answered', answer: { text: 'Yes: Tuesday 10:00?' } });
    await tidy();
  });

  it('lists long things ten at a time, with Show more', async () => {
    for (let i = 0; i < 23; i++) await asAssistant({ kind: 'assistant.suggest', text: `Suggestion number ${i + 1}` });
    await page.getByText('Suggestion number 23').waitFor({ timeout: 5000 });
    const more = page.locator('.more-items').first();
    await expect(more.textContent()).resolves.toMatch(/Show 10 more of 1[45]/);
    await more.click();
    await expect(page.locator('.more-items').first().textContent()).resolves.toMatch(/Show [45] more/);
    await tidy();
  });

  it('edits rules with a save bar that shows only when something changed', async () => {
    await tab('Rules');
    await page.getByRole('heading', { name: 'Who gets what' }).waitFor();
    expect(await page.locator('.savebar').count()).toBe(0);
    const first = page.locator('details.rule').first();
    await first.evaluate((d) => { (d as HTMLDetailsElement).open = true; });
    await first.locator('.seg button', { hasText: 'Ask me' }).click();
    await page.getByRole('button', { name: 'Save my rules' }).waitFor();
    await page.getByRole('button', { name: 'Undo changes' }).click();
    await page.waitForTimeout(500);
    expect(await page.locator('.savebar').count()).toBe(0);
    await first.evaluate((d) => { (d as HTMLDetailsElement).open = true; });
    // A real change: the decision this rule doesn't have now.
    const now = await first.locator('.seg button[aria-pressed="true"]').textContent();
    await first.locator('.seg button', { hasText: now === 'Ask me' ? 'Join' : 'Ask me' }).click();
    await page.getByRole('button', { name: 'Save my rules' }).click();
    await page.getByText('Saved. Your housekeeper uses these from now on.').waitFor();
    await tidy();
  });

  it('picks free hours with day chips and times, in the owner\'s time zone', async () => {
    await tab('Rules');
    await page.getByRole('button', { name: 'Add a time' }).click();
    const w = page.locator('#free .window').first();
    // Mon–Fri is the start; take Friday off, add Saturday.
    await w.getByRole('button', { name: 'Fr', exact: true }).click();
    await w.getByRole('button', { name: 'Sa', exact: true }).click();
    await w.getByLabel('From').fill('17:30');
    await w.getByLabel('To').fill('20:00');
    await page.locator('#free select.tz').selectOption('Australia/Brisbane');
    await page.locator('#free').getByRole('button', { name: 'Save' }).click();
    await page.getByText(/free in the next two weeks/).waitFor({ timeout: 5000 });
    // A time that ends before it starts is said next to Save, not in a pop-up.
    await w.getByLabel('To').fill('08:00');
    await page.locator('#free').getByRole('button', { name: 'Save' }).click();
    await page.locator('#free .act-err').waitFor();
    await w.getByLabel('To').fill('20:00');
    await page.reload();
    await tab('Rules');
    const again = page.locator('#free .window').first();
    expect(await again.getByRole('button', { name: 'Sa', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await again.getByRole('button', { name: 'Fr', exact: true }).getAttribute('aria-pressed')).toBe('false');
    expect(await page.locator('#free select.tz').inputValue()).toBe('Australia/Brisbane');
    await tidy();
  });

  it('opens every tab under More without an error or a page wider than the phone', async () => {
    for (const name of ['Keys', 'Visitors', 'Money', 'Data', 'Your key', 'Move house']) {
      await tab(name);
      await page.waitForTimeout(600);
      expect(await page.locator('#view').textContent()).not.toMatch(/Couldn't reach your house/);
      await tidy();
    }
  });

  it('opens at once with what it showed last time, even when the house is slow', async () => {
    await tab('Home');
    await page.getByRole('heading', { name: 'Needs you' }).waitFor();
    await page.route('**/owner/api', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
    const t = Date.now();
    await page.reload();
    await page.getByRole('heading', { name: 'Needs you' }).waitFor();
    expect(Date.now() - t).toBeLessThan(2000);
    // What the house holds stays out of the device's lasting storage: the quick start is for this tab only.
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => !k.startsWith('lake-owner-key:') && !k.startsWith('lake.start')))).toEqual([]);
    await page.unroute('**/owner/api');
    await tidy();
  });

  it('says when the house can\'t be reached, and recovers when it can', async () => {
    await ctx.setOffline(true);
    await page.locator('#nav > button', { hasText: 'Requests' }).click();
    await page.locator('.dot.down').waitFor({ timeout: 5000 });
    await ctx.setOffline(false);
    await page.locator('#nav > button', { hasText: 'Home' }).click();
    await page.locator('.dot.live').waitFor({ timeout: 10_000 });
    await tidy();
  });

  it('removes the owner\'s AI with two taps, and its key stops working', async () => {
    await tab('My agent');
    // The agent's own card (its suggestions name it too).
    const card = page.locator('.item', { has: page.getByRole('button', { name: /Remove this AI|Tap again/ }) });
    await card.getByRole('button', { name: 'Remove this AI' }).click();
    await card.getByRole('button', { name: /Tap again/ }).click();
    await card.waitFor({ state: 'detached', timeout: 5000 });
    expect((await asAssistant({ kind: 'list' })).error).toMatch(/no key/);
    await tidy();
  });

  it('recovers the house on a new device with a recovery code, and the old device knows it lost the key', async () => {
    await tab('Your key');
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
    expect(await phone2.getByRole('button', { name: 'Pair this device' }).count()).toBe(0);
    await phone2.locator('input.recovery-input').fill(code.toLowerCase());
    await phone2.getByRole('button', { name: 'Use it' }).click();
    await phone2.getByRole('heading', { name: 'Needs you' }).waitFor();
    // The old phone's next look: not the key any more, said plainly.
    // It may already know (the live stream refreshes it); otherwise its next tap finds out.
    await lostKey(page);
    // The code worked once.
    const again = await (await fetch(`${house}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: (await generateIdentity('x')).publicJwk, recovery: code }) })).json();
    expect(again.error).toMatch(/doesn't match/);
    // And moves to a third device with a one-use link.
    await phone2.locator('#nav .more-btn').click();
    await phone2.locator('#nav .more-menu button', { hasText: 'Your key' }).click();
    await phone2.getByRole('button', { name: 'Make a pairing link' }).click();
    const link = (await phone2.locator('.address code').textContent())!;
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone3 = await ctx3.newPage();
    phone3.on('pageerror', (e) => errors.push(e.message));
    phone3.on('dialog', (d) => { errors.push(`a dialog box: ${d.message()}`); void d.dismiss(); });
    await phone3.goto(link);
    await phone3.getByRole('heading', { name: 'Needs you' }).waitFor();
    await lostKey(phone2);
    await ctx2.close();
    page = phone3;
    ctx = ctx3;
    await tidy();
  });

  it('signs out on this device: back to the pairing screen', async () => {
    const keyNow = () => page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('lake-owner-key:'))?.[1] ?? null);
    const before = await keyNow();
    await page.locator('#nav .more-btn').click();
    // Asked on the button itself: the first tap arms it, the second signs out.
    await page.locator('#nav').getByRole('button', { name: 'Sign out on this device' }).click();
    await page.locator('#nav').getByRole('button', { name: /Tap again/ }).click();
    // The house still holds the key this device had: getting back in takes a link or the recovery code.
    await page.getByText(/This house already has a key/).waitFor({ timeout: 5000 });
    // The owner's key is gone from this device (a fresh one, not yet paired, is ready for pairing again).
    expect(await keyNow()).not.toBe(before);
    expect(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('lake-panel:')))).toBe(false);
    await tidy();
  });
});
