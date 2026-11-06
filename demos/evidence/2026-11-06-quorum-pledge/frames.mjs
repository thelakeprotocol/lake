// Crisp phone-size recordings: screenshots at device pixels every `every` ms into frames/<name>/, then an mp4 at that rate.
//   node frames.mjs page <name> <until: state|opened|filled|revealed|secs:N>     the pledge's public page
//   node frames.mjs phone <name> <step: answer|sign|look>                        the featured family's control panel
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
const LAKE = process.env.LAKE ?? 'http://lake-a.localhost:8081';
const dir = new URL('.', import.meta.url).pathname;
const st = JSON.parse(readFileSync(`${dir}/state-${new URL(LAKE).hostname}.json`, 'utf8'));
const [mode, name, arg] = process.argv.slice(2);
const every = Number(process.env.EVERY ?? 200);
const out = `${dir}/frames/${name}`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
let n = 0, stop = false;
const p = await ctx.newPage();
const shoot = (async () => { while (!stop) { const t = Date.now(); await p.screenshot({ path: `${out}/${String(n++).padStart(5, '0')}.png` }).catch(() => {}); await new Promise((ok) => setTimeout(ok, Math.max(0, every - (Date.now() - t)))); } })();
const json = async () => (await fetch(`${LAKE}/s/tally/p/${st.pledge.id}.json`)).json();
if (mode === 'page') {
  await p.goto(`${LAKE}/s/tally/p/${st.pledge.id}`);
  const first = await json(), start = Date.now();
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const v = await json();
    const done = arg === 'state' ? v.state !== first.state : arg === 'opened' ? v.state === 'open' : arg === 'filled' ? v.state === 'triggered' : arg === 'revealed' ? !!v.unveil?.opened : arg.startsWith('secs:') ? Date.now() - start > Number(arg.slice(5)) * 1000 : true;
    if (done) { await new Promise((ok) => setTimeout(ok, 6000)); break; }
    if (Date.now() - start > 900_000) break;
  }
} else {
  const f = st.people.find((x) => x.featured);
  const secret = Buffer.from(f.ownerKey.privateJwk.d, 'base64url').toString('hex');
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [`lake-owner-key:${new URL(LAKE).host}`, JSON.stringify({ secret, kid: f.ownerKey.kid })]);
  await p.goto(`${f.house}/owner/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  // The newest note for this step comes first.
  const note = p.locator('li.item', { hasText: arg === 'sign' ? 'Enough families would join' : 'smartphone' }).first();
  await note.scrollIntoViewIfNeeded().catch(() => {});
  await p.mouse.wheel(0, 120);
  await p.waitForTimeout(2500);
  if (arg === 'answer') { await note.getByRole('button', { name: 'If at least 100 do' }).click(); await p.waitForTimeout(4500); }
  if (arg === 'sign') { await note.getByRole('button', { name: 'Sign the pledge' }).click(); await p.waitForTimeout(9000); }
}
stop = true; await shoot;
await ctx.close(); await b.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(1000 / every), '-i', `${out}/%05d.png`, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', `${dir}/video/${name}.mp4`]);
console.log('recorded', name, n, 'frames');
