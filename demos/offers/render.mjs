// Renders a recorded offers run (run.mjs) into a video, frame by frame, on the map's capture mode:
// a steady 30 fps however busy the machine is.
//
//   node demos/offers/render.mjs demos/runs/offers-<time> [--speed 2] [--width 1440] [--height 900]
//
// Needs `pnpm build` (the map is served from packages/ui/dist), Chrome and ffmpeg.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  speed: { type: 'string', default: '2' }, width: { type: 'string', default: '1440' }, height: { type: 'string', default: '900' },
  fps: { type: 'string', default: '30' }, tail: { type: 'string', default: '7' }, chrome: { type: 'string', default: process.env.CHROME ?? '/usr/bin/google-chrome' },
} });
const run = positionals[0];
if (!run || !existsSync(join(run, 'run.jsonl'))) throw new Error('usage: render.mjs <run folder with run.jsonl>');
const ui = join(here, '..', '..', 'packages', 'ui', 'dist');
const speed = Number(a.speed), fps = Number(a.fps);

// The run's files first (the recording, captions, phone shots), then the built map.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  for (const base of [run, ui]) {
    const f = join(base, path === '/' ? 'index.html' : path);
    if (existsSync(f) && !f.endsWith('/')) { res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }); return void res.end(readFileSync(f)); }
  }
  res.writeHead(404).end();
}).listen(0);
const port = server.address().port;

const lines = readFileSync(join(run, 'run.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const captions = existsSync(join(run, 'captions.json')) ? JSON.parse(readFileSync(join(run, 'captions.json'), 'utf8')) : [];
// Start a little before the first caption; end a few seconds after the scoreboard appears.
const t0 = lines[0].t, from = Math.max(0, (captions[0]?.t ?? t0) - t0 - 2000);
const end = Math.max(lines.at(-1).t, ...captions.map((c) => c.t)) - t0;
// The same clock the page keeps: a caption's speed holds from its time on.
const speedAt = (t) => captions.filter((c) => c.speed && c.t <= t).at(-1)?.speed ?? speed;
let frames = Number(a.tail) * fps;
for (let vt = t0 + from; vt < t0 + end; frames++) vt += (1000 / fps) * speedAt(vt);

const frameDir = join(run, 'frames');
mkdirSync(frameDir, { recursive: true });
const browser = await chromium.launch({ executablePath: a.chrome });
const page = await browser.newPage({ viewport: { width: Number(a.width), height: Number(a.height) }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${port}/?capture&replay=/run.jsonl&captions=/captions.json&from=${from}&speed=${speed}`, { waitUntil: 'networkidle' });
await page.waitForSelector('body[data-ready="1"]');
await page.evaluate(() => document.fonts.ready);
const started = Date.now();
for (let f = 0; f < frames; f++) {
  await page.evaluate((ms) => window.__lakeStep(ms), 1000 / fps);
  await page.screenshot({ path: join(frameDir, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  if (f % 300 === 0) console.log(`frame ${f}/${frames} (${Math.round((Date.now() - started) / 1000)} s)`);
}
await browser.close();
server.close();
const video = join(run, 'offers.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frameDir, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', video]);
console.log(`video: ${video} (${Math.round(frames / fps)} s)`);
