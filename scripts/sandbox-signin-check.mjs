#!/usr/bin/env node
// A live check of connector sign-in on a running Lake (the sandbox by default), as a person and their AI app go through
// it: claim a free house on a phone-sized browser, sign an app in through that house (the MCP SDK's own OAuth client),
// see it act as the house's assistant in two chats, sell to a script that signs in without a browser, find the sale on
// the Money screen, and hand the house back. Run after a deploy:  node scripts/sandbox-signin-check.mjs [lake-url]
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const lake = (process.argv[2] ?? 'https://sandbox.lake.doneinfifty.com').replace(/\/$/, '');
const mcp = new URL(`${lake}/mcp`);
const steps = [];
const ok = (what) => { steps.push(what); console.log(`ok   ${what}`); };
const must = (cond, what) => { if (!cond) throw new Error(what); ok(what); };

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let claimed = false;
try {
  // A free house, claimed by this browser.
  await page.goto(`${lake}/t/`);
  const claim = page.getByRole('link', { name: 'Claim it' }).first();
  const href = await claim.getAttribute('href').catch(() => null);
  must(!!href, 'a free sandbox house to claim');
  const house = new URL(href, `${lake}/t/`).href.replace(/\/owner\/?$/, '');
  await page.goto(`${house}/owner/`);
  await page.getByRole('button', { name: 'Pair this device' }).click();
  await page.locator('#nav').waitFor({ timeout: 15_000 });
  claimed = true;
  ok(`claimed ${house}`);

  // The app asks without a token and is sent to sign in.
  const cb = 'https://app.example/callback';
  let goTo, verifier = '', info, tokens;
  const provider = {
    redirectUrl: cb,
    clientMetadata: { client_name: 'Sign-in check', redirect_uris: [cb], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    clientInformation: () => info, saveClientInformation: (i) => { info = i; },
    tokens: () => tokens, saveTokens: (t) => { tokens = t; },
    redirectToAuthorization: (u) => { goTo = u; },
    saveCodeVerifier: (v) => { verifier = v; }, codeVerifier: () => verifier,
  };
  const first = new StreamableHTTPClientTransport(mcp, { authProvider: provider });
  await new Client({ name: 'Sign-in check', version: '0' }).connect(first).then(() => { throw new Error('connected without signing in'); }, (e) => { if (!(e instanceof UnauthorizedError)) throw e; });
  must(!!goTo, 'no token: sent to the sign-in page (discovery, registration)');
  await page.goto(goTo.href);
  await page.getByRole('heading', { name: /Connect Sign-in check to/ }).waitFor();
  must((await page.locator('input[name=house]').inputValue()) === house, 'the sign-in page knows this browser\'s house');
  await page.getByRole('button', { name: 'Continue in my house' }).click();
  await page.getByRole('heading', { name: 'Approve it in your house' }).waitFor({ timeout: 15_000 });
  const number = (await page.locator('.num').textContent()).trim();
  ok(`the sign-in page shows a number to match (${number})`);
  // The owner's panel, in another tab of the browser that holds the key, asks with the same number.
  const panel = await page.context().newPage();
  await panel.goto(`${house}/owner/`);
  const asked = panel.locator('li.item', { hasText: 'Sign-in check wants to connect to your house' });
  await asked.waitFor({ timeout: 20_000 });
  must((await asked.locator('.connect-number').textContent()).trim() === number, 'the house\'s panel asks, with the same number');
  await page.route(`${cb}**`, (r) => r.fulfill({ body: 'back in the app' }));
  await asked.getByRole('button', { name: 'Connect' }).click();
  await page.waitForURL(/app\.example\/callback/, { timeout: 30_000 });
  const back = new URL(page.url());
  must(back.origin + back.pathname === cb && back.searchParams.get('code'), 'back to the app with a code');
  await panel.close();
  await first.finishAuth(back.searchParams.get('code'));
  ok('code exchanged for tokens (PKCE)');

  const chat = async () => {
    const c = new Client({ name: 'Sign-in check', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(mcp, { authProvider: provider }));
    const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return JSON.parse(r.content[0].text); };
    return { c, call };
  };
  const one = await chat();
  const me = (await one.call('lake_overview')).you;
  ok(`signed in as ${me.name}`);
  await one.call('lake_house', { view: 'overview' });
  ok('already the house\'s assistant (no code pasted)');
  const two = await chat();
  must((await two.call('lake_overview')).you.url === me.url, 'a second chat is the same agent');

  // It sells for the house; a script signs in without a browser and buys.
  await one.call('lake_sell', { action: 'menu', items: [{ sku: 'check', label: 'Sign-in check item', price: 1, currency: 'USD' }] });
  const anon = await (await fetch(`${lake}/mcp/oauth/anonymous`, { method: 'POST' })).json();
  must(!!anon.access_token, 'a script signs in without a browser');
  const shopper = new Client({ name: 'Sign-in check buyer', version: '0' });
  await shopper.connect(new StreamableHTTPClientTransport(mcp, { requestInit: { headers: { authorization: `Bearer ${anon.access_token}` } } }));
  const buy = async (args) => { const r = await shopper.callTool({ name: 'lake_buy', arguments: args }); if (r.isError) throw new Error(`lake_buy ${args.action}: ${r.content[0].text}`); return JSON.parse(r.content[0].text); };
  const order = await buy({ action: 'order', seller_url: me.url, sku: 'check' });
  await buy({ action: 'pay', cart: String(order.cart?.id ?? order.cart ?? order.id) });
  ok('bought and paid (held)');
  await shopper.close(); await one.c.close(); await two.c.close();

  // The owner finds it on Money, with what it was for and who paid.
  await page.goto(`${house}/owner/`);
  await page.locator('#nav .more-btn').click();
  await page.locator('#nav .more-menu button', { hasText: 'Money' }).click();
  const sale = page.locator('li.pay', { hasText: 'Sign-in check item' });
  // A receipt reaches the house from the payments agent and is read from the pod: allow a slow server a minute,
  // looking again (the screen refetches when it opens).
  for (let i = 0; i < Number(process.env.WAIT_TRIES ?? 6) && !(await sale.isVisible()); i++) {
    await page.waitForTimeout(10_000);
    await page.locator('#nav > button', { hasText: 'Home' }).click();
    await page.locator('#nav .more-btn').click();
    await page.locator('#nav .more-menu button', { hasText: 'Money' }).click();
  }
  if (!(await sale.isVisible())) throw new Error(`the sale isn't on Money; it shows: ${(await page.locator('#view').innerText()).slice(0, 600)}`);
  must(/from .*sold by /.test(await sale.locator('summary').textContent()), 'Money says what for, who paid and who sold');
  await sale.locator('summary').click();
  await sale.getByText(/Held until the buyer accepts/).waitFor();
  ok('a tap opens the receipt');
  must(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  // Hand the house back for the next person.
  if (claimed) {
    await page.goto(page.url().replace(/#.*$/, '')).catch(() => {});
    // Under "About your house" on Home.
    await page.getByText('About your house').click({ timeout: 15_000 }).catch(() => {});
    const hand = page.getByRole('button', { name: 'Hand it back now' });
    if (await hand.waitFor({ timeout: 15_000 }).then(() => true, () => false)) { await hand.click(); await page.getByRole('button', { name: /Tap again/ }).click(); await page.waitForTimeout(1500); console.log('ok   handed the house back'); }
    else console.log('note the house was not handed back: do it from its panel');
  }
  await browser.close();
}
console.log(`\n${steps.length} steps ok`);
