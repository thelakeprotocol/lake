// "Nobody goes first", at scale: a school's families find their quorum in secret, then sign blind and are revealed at once.
// Real houses (each a Solid pod with its own keys, a person stamp, the panel's own calls); simulated owners: their
// "phones" are this script, holding their keys, with synthetic answers. One organiser's AI opens the pledge.
//   LAKE=http://lake-a.localhost:8081 node run.mjs setup <n> | open <closeMin> <deadlineMin> | answer | sign | status
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Client } from '../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { exportIdentity, generateIdentity, importIdentity, signMessage } from '../../../packages/core/dist/index.js';

const LAKE = process.env.LAKE ?? 'http://lake-a.localhost:8081';
const TALLY = `${LAKE}/s/tally`;
const dir = new URL('.', import.meta.url).pathname, stateFile = `${dir}/state-${new URL(LAKE).hostname}.json`;
const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { people: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 1), { mode: 0o600 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The question, and how 300 synthetic families answer it (Granovetter: a few would go alone, most wait for others).
const OPTIONS = ['Even if nobody else does', 'If at least 25 families do', 'If at least 50 do', 'If at least 100 do', 'If at least 150 do', 'If at least 200 do', 'If at least 250 do', 'Not at all'];
const AT_LEAST = [1, 25, 50, 100, 150, 200, 250, null];
const MIX = [12, 18, 30, 55, 50, 40, 25, 70];
const TEXT = 'No smartphones before high school: the families of Hillside Primary together. Basic phones are fine.';

const keys = new Map();
const keyOf = async (p) => { if (!keys.has(p.house)) keys.set(p.house, await importIdentity(p.ownerKey)); return keys.get(p.house); };
const ownerCall = async (p, payload) => (await fetch(`${p.house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, await keyOf(p), { iss: p.webId })) })).json();
const pool = async (xs, n, f) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const x = xs[i++]; await f(x); } })); };
const mcp = async (token) => {
  const c = new Client({ name: 'quorum-organiser', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${LAKE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; if (r.isError) throw new Error(`${name}: ${t}`); return JSON.parse(t); };
};

const cmd = process.argv[2];
if (cmd === 'setup') {
  // Free tenant houses, each claimed by a new owner key and stamped as one person; each family gets its answer.
  const n = Number(process.argv[3] ?? 300);
  const taken = new Set(st.people.map((p) => p.house));
  const free = [];
  for (let k = 0; free.length + st.people.length < n && k < n + 400; k++) {
    const h = `sb-${k}`;
    if (taken.has(`${LAKE}/t/${h}`)) continue;
    const s = await (await fetch(`${LAKE}/t/${h}/owner/status`)).json().catch(() => null);
    if (s && !s.claimed) free.push(h);
  }
  log('claiming', free.length);
  let done = 0;
  await pool(free, Number(process.env.CONCURRENCY ?? 6), async (h) => {
    try {
      const house = `${LAKE}/t/${h}`, owner = await generateIdentity(`family-${h}`);
      const pair = await (await fetch(`${house}/owner/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: owner.publicJwk }) })).json();
      if (!pair.paired) throw new Error(JSON.stringify(pair));
      const p = { house, webId: pair.webId, ownerKey: await exportIdentity(owner) };
      const stamp = await ownerCall(p, { kind: 'panel.person.request', consent: await signMessage({ kind: 'personhood.consent', house: p.webId }, owner, { iss: p.webId }) });
      if (!stamp.stamped) throw new Error(`stamp: ${JSON.stringify(stamp)}`);
      st.people.push(p);
      if (++done % 25 === 0) { save(); log('claimed', done); }
    } catch (e) { log('skip', h, String(e.message).slice(0, 160)); }
  });
  // Answers dealt out in a fixed shuffle, so a rerun gives the same families the same answers.
  const answers = MIX.flatMap((m, i) => Array(m).fill(i));
  st.people.forEach((p, i) => { p.answer = answers[(i * 7919) % answers.length] ?? 7; });
  save();
  log('families', st.people.length, 'answers', JSON.stringify(MIX));
} else if (cmd === 'open') {
  // The organiser (a parent at the school) asks their AI to open it; the AI has its own Lake sign-in.
  const [closeMin, deadlineMin] = [Number(process.argv[3] ?? 15), Number(process.argv[4] ?? 30)];
  st.token ??= (await (await fetch(`${LAKE}/mcp/oauth/anonymous`, { method: 'POST' })).json()).access_token;
  const call = await mcp(st.token);
  const id = `phone-free-${Date.now().toString(36).slice(-4)}`;
  const r = await call('lake_pledge', { action: 'open', tally: `${TALLY}/a2a`, id, text: TEXT, threshold: 100, deadline: new Date(Date.now() + deadlineMin * 60_000).toISOString(), listed: true, quorum: { options: OPTIONS, at_least: AT_LEAST, closes: new Date(Date.now() + closeMin * 60_000).toISOString() } });
  st.pledge = { id, opened: r };
  save();
  log('opened', id, r.kind, r.state, JSON.stringify(r.quorum ?? r.problems ?? r).slice(0, 300));
} else if (cmd === 'answer') {
  // Each family answers on its phone; its house sends the answer as two shares to the tellers.
  let n = 0;
  await pool(st.people.filter((p) => !p.answered && !p.featured), Number(process.env.CONCURRENCY ?? 6), async (p) => {
    const r = await ownerCall(p, { kind: 'panel.pledge.quorum', tally: TALLY, id: st.pledge.id, choice: OPTIONS[p.answer] }).catch((e) => ({ kind: 'error', problems: [e.message] }));
    if (r.kind === 'quorum.answered') p.answered = true; else log(p.house.split('/t/')[1], r.kind, JSON.stringify(r.problems ?? r.error ?? r).slice(0, 200));
    if (++n % 25 === 0) { save(); log('answered', n); }
  });
  save();
  log('answered', st.people.filter((p) => p.answered).length);
} else if (cmd === 'sign') {
  // Once it opens: the families whose threshold it met sign blind; a few who said 250 sign too, having seen it open.
  const c = await (await mcp(st.token))('lake_pledge', { action: 'count', tally: `${TALLY}/a2a`, id: st.pledge.id });
  if (c.state !== 'open' && c.state !== 'triggered') { log('not open:', c.state, JSON.stringify(c.quorum?.result ?? {})); process.exit(0); }
  const k = c.threshold;
  const who = st.people.filter((p) => p.answered && !p.signed && !p.featured && AT_LEAST[p.answer] !== null && (AT_LEAST[p.answer] <= k || (AT_LEAST[p.answer] === 250 && st.people.indexOf(p) % 4 === 0)));
  log('opens at', k, 'signing', who.length);
  let n = 0;
  await pool(who, Number(process.env.CONCURRENCY ?? 4), async (p) => {
    const r = await ownerCall(p, { kind: 'panel.pledge.sign', tally: TALLY, id: st.pledge.id }).catch((e) => ({ kind: 'error', problems: [e.message] }));
    if (r.kind === 'tally.signed' || r.kind === 'tally.triggered') p.signed = true; else log(p.house.split('/t/')[1], r.kind, JSON.stringify(r.problems ?? r.error ?? r).slice(0, 200));
    if (++n % 25 === 0) { save(); log('signed', n, r.count ?? ''); }
  });
  save();
  log('signed', st.people.filter((p) => p.signed).length);
} else if (cmd === 'status') {
  const c = await (await mcp(st.token))('lake_pledge', { action: 'count', tally: `${TALLY}/a2a`, id: st.pledge.id });
  console.log(JSON.stringify(c, null, 1).slice(0, 2500));
}
process.exit(0);
