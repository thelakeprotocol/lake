#!/usr/bin/env node
// A cross-Lake check for the two local staging Lakes (scripts/local-lakes.sh check). No build needed: it speaks MCP over
// plain HTTP to each Lake's connector, the way Claude does. A seller joins Lake B and puts a menu on its card; a buyer
// joins Lake A, finds the seller through A's node (federation), they exchange signed messages, the buyer orders and pays,
// and knocks on a house of Lake B. Prints each step and what came back; exits 1 if a step that should work didn't.
const A = (process.argv[2] ?? process.env.LAKE_A ?? 'http://lake-a.localhost:8081').replace(/\/$/, '');
const B = (process.argv[3] ?? process.env.LAKE_B ?? 'http://lake-b.localhost:8082').replace(/\/$/, '');

/** One MCP conversation over streamable HTTP: initialize, then tools/call. Answers come as JSON or as SSE. */
async function session(lake, client) {
  let sid, n = 0;
  const rpc = async (method, params, notify = false) => {
    const res = await fetch(`${lake}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++n }) }),
      signal: AbortSignal.timeout(90_000),
    });
    sid ??= res.headers.get('mcp-session-id');
    if (notify) return;
    const text = await res.text();
    const body = res.headers.get('content-type')?.includes('event-stream')
      ? JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop())
      : JSON.parse(text);
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: client, version: '0' } });
  await rpc('notifications/initialized', {}, true);
  return async (tool, args = {}) => {
    const r = await rpc('tools/call', { name: tool, arguments: args });
    const text = r.content?.map((c) => c.text).join('') ?? '';
    if (r.isError) throw new Error(`${tool}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

const results = [];
const step = async (name, expect, fn) => {
  try {
    const out = await fn();
    results.push({ name, ok: true, expect });
    console.log(`ok    ${name}${out ? `\n      ${out}` : ''}`);
    return true;
  } catch (e) {
    results.push({ name, ok: false, expect });
    console.log(`${expect === 'works' ? 'FAIL ' : 'NOTE '} ${name}\n      ${e.message}`);
    return false;
  }
};
const until = async (what, fn, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const short = (x) => JSON.stringify(x).slice(0, 400);

const seller = await session(B, 'local-check-seller');
const buyer = await session(A, 'local-check-buyer');
const s = (await seller('lake_overview')).you;
const b = (await buyer('lake_overview')).you;
console.log(`seller on B: ${s.name} ${s.url}\nbuyer  on A: ${b.name} ${b.url}\n`);
let sellerHit, cart;

await step('seller (Lake B) puts a menu on its card', 'works', async () => short(await seller('lake_sell', { action: 'menu', items: [{ sku: 'tea', label: 'A cup of tea, described', price: 1, currency: 'USD' }] })));
await step("A's node lists B's seller (follow, card re-verified from B)", 'works', async () => {
  sellerHit = await until('the seller in search on A', async () => (await buyer('lake_search', { q: s.name.split(' ')[0] })).find((x) => x.url === s.url && x.menu?.length));
  return short(sellerHit);
});
await step('buyer (A) -> seller (B): signed message, signed receipt of it', 'works', async () => {
  const r = await buyer('lake_ask', { agent_url: s.url, message: { kind: 'hello', text: 'from Lake A' } });
  if (r.kind !== 'received' || !/exactly what you sent/.test(r.delivered ?? '')) throw new Error(short(r));
  return short({ kind: r.kind, delivered: r.delivered });
});
await step("seller reads it in its inbox, verified, from A's agent", 'works', async () => {
  const m = await until('the message in the seller inbox', async () => {
    const x = await seller('lake_inbox', { wait_seconds: 10 });
    return (x.messages ?? x).find?.((y) => JSON.stringify(y).includes('from Lake A'));
  });
  return short(m);
});
await step('seller (B) -> buyer (A): reply', 'works', async () => {
  const r = await seller('lake_ask', { agent_url: b.url, message: { kind: 'hello', text: 'from Lake B' } });
  if (r.kind !== 'received') throw new Error(short(r));
  const m = await until('the reply in the buyer inbox', async () => {
    const x = await buyer('lake_inbox', { wait_seconds: 10 });
    return (x.messages ?? x).find?.((y) => JSON.stringify(y).includes('from Lake B'));
  });
  return short(m);
});
await step("B's node lists A's buyer too", 'works', async () => short(await until("the buyer in search on B", async () => (await seller('lake_search', { q: b.name.split(' ')[0] })).find((x) => x.url === b.url))));
await step('buyer orders from the menu: a cart signed by the B seller', 'works', async () => {
  const r = await buyer('lake_buy', { action: 'order', seller_url: s.url, sku: 'tea' });
  cart = r.cart ?? r.order?.cart;
  if (!cart) throw new Error(short(r));
  return short(r);
});
await step("buyer pays the cart through A's payments agent (held)", 'works', async () => short(await buyer('lake_buy', { action: 'pay', cart: String(cart).slice(0, 12) })));
await step("seller on B counts A's receipt as money", 'cross-lake', async () => {
  const m = await until('the receipt in the seller inbox', async () => {
    const x = await seller('lake_inbox', { wait_seconds: 10 });
    return (x.messages ?? x).find?.((y) => /receipt/.test(JSON.stringify(y)));
  });
  const checked = m.checked ?? m.payload?.checked ?? JSON.stringify(m).match(/"checked":(\{[^}]*\})/)?.[1];
  const orders = await seller('lake_sell', { action: 'orders' });
  const settled = JSON.stringify(checked ?? '').includes('"settled":true') || /"payment":"(held|paid|released)"/.test(JSON.stringify(orders));
  if (!settled) throw new Error(`receipt checked as ${short(checked ?? m)}; seller's orders: ${short(orders)}`);
  return short(checked);
});
const houseB = await fetch(`${A}/cards?role=house`).then((r) => r.json()).then((xs) => xs.map((x) => x.card).find((c) => c.supportedInterfaces[0].url.startsWith(`${B}/t/`))).catch(() => null);
await step("A's node lists B's houses", 'works', async () => { if (!houseB) throw new Error('none'); return `${houseB.name} ${houseB.supportedInterfaces[0].url}`; });
if (houseB) await step('buyer (A) knocks on a house of Lake B and gets its rules\' signed answer', 'works', async () => short(await buyer('lake_knock', { house_url: houseB.supportedInterfaces[0].url, purpose: 'research', fields: ['age_band'], price_usd: 1 })));

const failed = results.filter((r) => !r.ok && r.expect === 'works');
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps ok${failed.length ? `; ${failed.length} that should work failed` : ''}${results.some((r) => !r.ok && r.expect !== 'works') ? '; NOTE lines are known cross-Lake limits' : ''}`);
process.exit(failed.length ? 1 : 0);
