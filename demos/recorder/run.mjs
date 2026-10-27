// Records a demo: local, unmodified Claude Code sessions (headless) with one MCP connector to the sandbox
// Lake, a page showing the live map beside their transcripts, and an mp4 at the end.
//   npm run connect4        (needs: claude, Google Chrome, ffmpeg)
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv[2];
const config = JSON.parse(readFileSync(join(root, demo, 'demo.json'), 'utf8'));
const lake = process.env.LAKE_SANDBOX ?? 'https://sandbox.lake.doneinfifty.com';
// A demo is a folder here (connect4) or anywhere else (an exploration written for one run); the run is named after it.
const run = join(root, 'runs', `${basename(demo)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(run, { recursive: true });
writeFileSync(join(run, 'mcp.json'), JSON.stringify({ mcpServers: { lake: { type: 'http', url: `${lake}/mcp` } } }));

// Each player gets its own empty folder: whatever it builds, it builds there.
const blueprints = process.env.LAKE_BLUEPRINTS ?? 'https://lake.doneinfifty.com/blueprints';
const fill = (text) => text.replaceAll('{{lake}}', lake).replace(/\{\{blueprint_url:([\w.-]+)\}\}/g, (_, f) => `${blueprints}/${f}`).replace(/\{\{blueprint:([\w.-]+)\}\}/g, (_, f) => readFileSync(join(root, '..', 'spec', 'blueprints', f), 'utf8').trim());
// The folder itself lives outside the repo, linked back into the run: a player started inside the checkout read the
// project's CLAUDE.md and AGENTS.md, and its git log (run 48: a commit message named the blackout before it came).
const outside = join(process.env.LAKE_RUNS_OUTSIDE ?? join(homedir(), '.lake-runs'), basename(run));
for (const p of config.players) {
  mkdirSync(join(outside, p.id), { recursive: true });
  symlinkSync(join(outside, p.id), join(run, p.id), 'dir');
  writeFileSync(join(run, `${p.id}.jsonl`), '');
}

// An optional setup step (e.g. claim a house) whose JSON output fills {{name}} in the prompts; teardown undoes it.
const vars = config.setup ? JSON.parse(execFileSync(process.execPath, [join(root, demo, config.setup), run], { encoding: 'utf8' })) : {};
const fillVars = (text) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, String(v)), text);

// video: false runs the players and the narrator only (explorations): no page, no browser, no mp4.
const video = config.video !== false;
const port = 4990;
const server = video ? serve({ page: join(root, demo, 'page.html'), run, port }) : null;
const browser = video ? await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' }) : null;
const [width, height] = config.viewport ?? [1920, 1080];
const ctx = video ? await browser.newContext({ viewport: { width, height }, recordVideo: { dir: join(run, 'video'), size: { width, height } } }) : null;
const page = ctx ? await ctx.newPage() : null;
if (page) {
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
}

const t0 = Date.now();
const procs = config.players.map((p, i) => new Promise((done) => setTimeout(() => {
  const prompt = fillVars(fill(readFileSync(join(root, demo, p.prompt), 'utf8'))).replaceAll('{{start}}', new Date().toTimeString().slice(0, 8));
  writeFileSync(join(run, p.id, 'PROMPT.md'), prompt);
  // `tools` only pre-approves; `deny` takes tools out of a player's sight altogether (a control that mustn't see a door);
  // `model` runs this player on another model (opus, sonnet, haiku, fable), so look-alike agents can differ.
  // `lake` puts this player on another Lake (cross-Lake runs on the two local staging Lakes): its own connector.
  const mcp = p.lake ? join(run, `mcp-${p.id}.json`) : join(run, 'mcp.json');
  if (p.lake) writeFileSync(mcp, JSON.stringify({ mcpServers: { lake: { type: 'http', url: `${p.lake.replace(/\/$/, '')}/mcp` } } }));
  const c = spawn('claude', ['-p', prompt, '--mcp-config', mcp, '--strict-mcp-config', ...(p.model ? ['--model', p.model] : []), ...(p.deny?.length ? ['--disallowedTools', ...p.deny] : []), '--allowedTools', ...(p.tools ?? config.tools ?? ['mcp__lake']), '--output-format', 'stream-json', '--verbose'],
    { cwd: join(outside, p.id), stdio: ['ignore', 'pipe', 'inherit'] });
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
if (config.teardown) try { execFileSync(process.execPath, [join(root, demo, config.teardown), run], { stdio: 'inherit' }); } catch (e) { console.log(`teardown: ${e.message}`); }
if (page) {
  await page.waitForTimeout(12000);
  await ctx.close();
}

// A narrator reads everything they did and writes the story, true to the transcripts; the video ends on it.
let story = null;
if (config.narrator) {
  mkdirSync(join(run, 'story'), { recursive: true });
  const prompt = fill(readFileSync(join(root, demo, config.narrator), 'utf8')).replaceAll('{{players}}', config.players.map((p) => p.id).join(', '));
  await new Promise((done) => spawn('claude', ['-p', prompt, ...(config.narratorModel ? ['--model', config.narratorModel] : []), '--allowedTools', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash(python3:*)', '--output-format', 'text'],
    { cwd: run, stdio: ['ignore', 'inherit', 'inherit'] }).on('exit', done));
  // The story can end the video as two cards, or just be the text that goes with it (storyCards: false).
  if (video && config.storyCards !== false && readdirSync(join(run, 'story')).includes('STORY.md')) {
    // Two cards: what they did, then how it played out.
    story = [];
    for (const n of [1, 2]) {
      const card = await (await browser.newContext({ viewport: { width, height } })).newPage();
      await card.goto(`http://localhost:${port}/?story=${n}`, { waitUntil: 'load' });
      await card.waitForTimeout(2500);
      story.push(join(run, 'story', `story-${n}.png`));
      await card.screenshot({ path: story.at(-1) });
    }
  }
}
if (!video) {
  console.log(`players exited ${codes.join(', ')} · ${run}`);
  process.exit(0);
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
const holds = [config.statsSeconds ?? 9, config.storySeconds ?? 24];
const card = story ? story.flatMap((png, i) => ['-loop', '1', '-t', String(holds[i]), '-i', png]) : [];
const end = story ? `${story.map((_, i) => `[${i + 1}:v]scale=${width}:${height},setsar=1,fps=30,fade=t=in:st=0:d=0.6[c${i}];`).join('')}[a][b]${story.map((_, i) => `[c${i}]`).join('')}concat=n=${2 + story.length}:v=1,fps=30,format=yuv420p[v]` : '[a][b]concat=n=2:v=1,fps=30,format=yuv420p[v]';
await ffmpeg(['-i', webm, ...card, '-filter_complex', `[0:v]trim=0:${tail},setpts=(PTS-STARTPTS)/${speed}[a];[0:v]trim=${tail},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2[b];${end}`, '-map', '[v]', '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-movflags', '+faststart', out]);
console.log(`players exited ${codes.join(', ')} · ${out}`);
