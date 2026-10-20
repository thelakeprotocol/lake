// Serves a demo's page, each player's transcript (Claude's stream-json) as an event stream, and files the
// players write in their own folders (their local copies), so the page can show them live.
import { createServer } from 'node:http';
import { existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

export function serve({ page, run, port }) {
  return createServer((req, res) => {
    const ev = req.url.match(/^\/events\/([a-z0-9]+)$/);
    if (ev) {
      const log = join(run, `${ev[1]}.jsonl`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let pos = 0, buf = '';
      const t = setInterval(() => {
        if (!existsSync(log)) return;
        const size = statSync(log).size;
        if (size <= pos) return;
        const b = Buffer.alloc(size - pos);
        readSync(openSync(log, 'r'), b, 0, b.length, pos);
        pos = size;
        buf += b.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) if (l.trim()) res.write(`data: ${l}\n\n`);
      }, 200);
      req.on('close', () => clearInterval(t));
      return;
    }
    const file = req.url.match(/^\/file\/([a-z0-9]+)\/([\w.-]+)$/);
    if (file) {
      const path = normalize(join(run, file[1], file[2]));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      return void res.end(path.startsWith(run) && existsSync(path) ? readFileSync(path) : '');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(page));
  }).listen(port);
}
