// One family on camera: their AI brings them the pledge, they answer privately and later sign on their phone (recorded
// at phone size from the house's own control panel).
//   LAKE=… node feature.mjs assistant | suggest | record <name> <step>   (step: answer | sign | look)
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { Client } from '../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { chromium } from 'playwright-core';
import { importIdentity, signMessage } from '../../../packages/core/dist/index.js';

const LAKE = process.env.LAKE ?? 'http://lake-a.localhost:8081';
const TALLY = `${LAKE}/s/tally`;
const dir = new URL('.', import.meta.url).pathname, stateFile = `${dir}/state-${new URL(LAKE).hostname}.json`;
const st = JSON.parse(readFileSync(stateFile, 'utf8'));
const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 1), { mode: 0o600 });
const f = st.people.find((p) => p.featured) ?? st.people.find((p) => p.answer === 3);
f.featured = true;
const ownerCall = async (payload) => (await fetch(`${f.house}/owner/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signMessage(payload, await importIdentity(f.ownerKey), { iss: f.webId })) })).json();
const ai = async () => {
  const c = new Client({ name: 'family-ai', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${LAKE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${f.token}` } } }));
  return async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; if (r.isError) throw new Error(`${name}: ${t}`); return JSON.parse(t); };
};

const cmd = process.argv[2];
if (cmd === 'assistant') {
  const { code } = await ownerCall({ kind: 'panel.assistant.invite', label: 'My AI' });
  f.token = (await (await fetch(`${LAKE}/mcp/oauth/anonymous`, { method: 'POST' })).json()).access_token;
  const call = await ai();
  console.log(JSON.stringify(await call('lake_house_connect', { code, house_url: f.house })).slice(0, 300));
  save();
} else if (cmd === 'suggest') {
  const call = await ai();
  const opened = st.pledge.id;
  const c = await call('lake_pledge', { action: 'count', tally: `${TALLY}/a2a`, id: opened });
  const text = c.state === 'gathering'
    ? 'Hillside parents are trying to hold off smartphones until high school, together. Nobody wants their kid to be the only one without, so first everyone says privately how many families would have to join before they would. I won\'t see your answer.'
    : `Enough families would join: the phone pledge is open, and binds only if ${c.threshold} sign by ${new Date(c.deadline).toLocaleString('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Nobody is shown as signing until everyone is.`;
  console.log(JSON.stringify(await call('lake_house_suggest', { text, pledge: { tally: TALLY, id: opened }, advice: 'your_call' })).slice(0, 300));
  save();
} else if (cmd === 'pick') {
  // A family on camera with nothing else on its phone: a fresh one whose answer is "100".
  for (const x of st.people) delete x.featured;
  const g = st.people.find((x) => x.answer === 3 && !x.token && !x.wasFeatured);
  g.featured = true; g.wasFeatured = true;
  save();
  console.log('featured', g.house);
} else if (cmd === 'record') {
  // The phone: the panel at phone size, with this family's key, recorded as video.
  const [name, step] = [process.argv[3] ?? 'clip', process.argv[4] ?? 'look'];
  const key = f.ownerKey;
  const secret = Buffer.from(key.privateJwk.d, 'base64url').toString('hex');
  mkdirSync(`${dir}/video`, { recursive: true });
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, recordVideo: { dir: `${dir}/video`, size: { width: 780, height: 1688 } } });
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [`lake-owner-key:${new URL(LAKE).host}`, JSON.stringify({ secret, kid: key.kid })]);
  const p = await ctx.newPage();
  await p.goto(`${f.house}/owner/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const note = p.locator('li.item', { hasText: 'smartphone' }).first();
  await note.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(2500);
  if (step === 'answer') { await note.getByRole('button', { name: 'If at least 100 do' }).click(); await p.waitForTimeout(4000); }
  if (step === 'sign') { await note.getByRole('button', { name: 'Sign the pledge' }).click(); await p.waitForTimeout(5000); }
  await p.screenshot({ path: `${dir}/video/${name}.png` });
  const v = await p.video().path();
  await ctx.close(); await b.close();
  renameSync(v, `${dir}/video/${name}.webm`);
  console.log('recorded', name);
}
process.exit(0);
