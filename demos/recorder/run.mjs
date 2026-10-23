// Records a demo: local, unmodified Claude Code sessions (headless) with one MCP connector to the sandbox
// Lake, a page showing the live map beside their transcripts, and an mp4 at the end.
//   npm run connect4        (needs: claude, Google Chrome, ffmpeg)
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv[2];
const config = JSON.parse(readFileSync(join(root, demo, 'demo.json'), 'utf8'));
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
const run = join(root, 'runs', `${demo}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(run, { recursive: true });
writeFileSync(join(run, 'mcp.json'), JSON.stringify({ mcpServers: { lake: { type: 'http', url: `${lake}/mcp` } } }));

// Each player gets its own empty folder: whatever it builds, it builds there.
const blueprints = process.env.LAKE_BLUEPRINTS ?? 'https://lake.doneinfifty.com/blueprints';
const fill = (text) => text.replaceAll('{{lake}}', lake).replace(/\{\{blueprint_url:([\w.-]+)\}\}/g, (_, f) => `${blueprints}/${f}`).replace(/\{\{blueprint:([\w.-]+)\}\}/g, (_, f) => readFileSync(join(root, '..', 'spec', 'blueprints', f), 'utf8').trim());
for (const p of config.players) {
  mkdirSync(join(run, p.id), { recursive: true });
  writeFileSync(join(run, `${p.id}.jsonl`), '');
}

const port = 4990;
const server = serve({ page: join(root, demo, 'page.html'), run, port });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const [width, height] = config.viewport ?? [1920, 1080];
const ctx = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: join(run, 'video'), size: { width, height } } });
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(4000);

const t0 = Date.now();
const procs = config.players.map((p, i) => new Promise((done) => setTimeout(() => {
  const prompt = fill(readFileSync(join(root, demo, p.prompt), 'utf8'));
  writeFileSync(join(run, p.id, 'PROMPT.md'), prompt);
  const c = spawn('claude', ['-p', prompt, '--mcp-config', join(run, 'mcp.json'), '--strict-mcp-config', '--allowedTools', ...(config.tools ?? ['mcp__lake']), '--output-format', 'stream-json', '--verbose'],
    { cwd: join(run, p.id), stdio: ['ignore', 'pipe', 'inherit'] });
  // Each transcript line gets "_t": seconds since the run began, so a narrator can tell when things happened.
  let rest = '';
  c.stdout.on('data', (d) => {
    const lines = (rest + d).split('\n');
    rest = lines.pop();
    for (const l of lines) if (l.trim()) { try { appendFileSync(join(run, `${p.id}.jsonl`), JSON.stringify({ ...JSON.parse(l), _t: Math.round((Date.now() - t0) / 1000) }) + '\n'); } catch { appendFileSync(join(run, `${p.id}.jsonl`), l + '\n'); } }
  });
  const limit = setTimeout(() => c.kill(), (config.minutes ?? 20) * 60_000);
  c.on('exit', (code) => { clearTimeout(limit); done(code); });
}, (p.delay ?? i * 2) * 1000)));
const codes = await Promise.all(procs);
await page.waitForTimeout(12000);
await ctx.close();

// A narrator reads everything they did and writes the story, true to the transcripts; the video ends on it.
let story = null;
if (config.narrator) {
  mkdirSync(join(run, 'story'), { recursive: true });
  const prompt = fill(readFileSync(join(root, demo, config.narrator), 'utf8')).replaceAll('{{players}}', config.players.map((p) => p.id).join(', '));
  await new Promise((done) => spawn('claude', ['-p', prompt, '--allowedTools', 'Read', 'Glob', 'Grep', 'Write(story/STORY.md)', 'Bash(python3:*)', '--output-format', 'text'],
    { cwd: run, stdio: ['ignore', 'inherit', 'inherit'] }).on('exit', done));
  if (readdirSync(join(run, 'story')).includes('STORY.md')) {
    const card = await (await browser.newContext({ viewport: { width, height } })).newPage();
    await card.goto(`http://localhost:${port}/?story`, { waitUntil: 'load' });
    await card.waitForTimeout(2500);
    story = join(run, 'story', 'story.png');
    await card.screenshot({ path: story });
  }
}
await browser.close();
server.close();

// Speed up the long middle, keep the ending at real speed.
const webm = join(run, 'video', readdirSync(join(run, 'video'))[0]);
const out = join(run, `${demo}.mp4`);
const speed = config.speed ?? 1;
const ffmpeg = (args) => new Promise((ok) => spawn('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }).on('exit', ok));
const probe = await new Promise((ok) => { let s = ''; spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webm]).stdout.on('data', (d) => (s += d)).on('end', () => ok(Number(s))); });
const tail = Math.max(1, probe - 12);
const hold = config.storySeconds ?? 24;
const card = story ? ['-loop', '1', '-t', String(hold), '-i', story] : [];
const end = story ? `[1:v]scale=${width}:${height},setsar=1,fps=30,fade=t=in:st=0:d=0.8[c];[a][b][c]concat=n=3:v=1,fps=30,format=yuv420p[v]` : '[a][b]concat=n=2:v=1,fps=30,format=yuv420p[v]';
await ffmpeg(['-i', webm, ...card, '-filter_complex', `[0:v]trim=0:${tail},setpts=(PTS-STARTPTS)/${speed}[a];[0:v]trim=${tail},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2[b];${end}`, '-map', '[v]', '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-movflags', '+faststart', out]);
console.log(`players exited ${codes.join(', ')} · ${out}`);
