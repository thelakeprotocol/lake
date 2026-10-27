import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { LakeAgent, LakeAgentOptions } from './index.js';
import { createLakeMcpServer } from './mcp.js';

/**
 * The Lake MCP connector over HTTP, for assistants that can't run a local command: add
 * `https://<lake>/mcp` as a custom connector in Claude (web, desktop, phone) or any MCP client.
 * Every conversation becomes its own signed agent on the Lake, with a fresh key and its own card,
 * served from here so the node can verify it. Sessions idle for half an hour leave.
 */
// Short, distinct names (no two share a first letter), so a reader can tell four agents apart at a glance.
const CREATURES = ['Atlas', 'Blaze', 'Cinder', 'Delta', 'Echo', 'Fable', 'Gale', 'Halo', 'Indigo', 'Juno', 'Kite', 'Lumen', 'Moss', 'Nova', 'Onyx', 'Pike', 'Quill', 'Rook', 'Sable', 'Tango'];

export function lakeMcpHttpApp(o: Omit<LakeAgentOptions, 'name' | 'domain' | 'port' | 'publicUrl' | 'mount'> & { publicUrl: string; path?: string; maxSessions?: number; log?: (msg: string) => void }): express.Express {
  const path = o.path ?? '/mcp';
  const base = o.publicUrl.replace(/\/$/, '');
  const app = express();
  app.use(path, express.json({ limit: '256kb' }));
  const sessions = new Map<string, { id: string; transport: StreamableHTTPServerTransport; agent?: LakeAgent; seen: number }>();
  const cards = new Map<string, express.Express>();
  // Names in use by live conversations, so no two agents here answer to the same one.
  const named = new Map<string, string>();
  // And names already on cards the node lists, this Lake's and the ones it follows (run 48: two "Lumen"s, one per Lake,
  // and "a different name looks like an impostor" read the other way round). Refreshed as a conversation starts.
  let listedNames = new Set<string>();
  const refreshListed = async () => {
    const seen = new Set<string>();
    for (const n of o.node.split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean)) {
      const found = (await fetch(`${n}/cards?idle=1`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => [])) as { card?: { name?: string } }[];
      for (const f of Array.isArray(found) ? found : []) if (f.card?.name) seen.add(f.card.name.split(' (')[0]!.trim());
    }
    if (seen.size) listedNames = seen;
  };
  const nameFor = (id: string) => {
    const taken = new Set([...named.values(), ...listedNames]);
    const start = parseInt(id, 16) % CREATURES.length;
    for (let k = 0; k < CREATURES.length; k++) {
      const n = CREATURES[(start + k) % CREATURES.length]!;
      if (!taken.has(n)) { named.set(id, n); return n; }
    }
    const n = `${CREATURES[start]} ${id.slice(0, 3)}`;
    named.set(id, n);
    return n;
  };

  // Each session's agent card and A2A door, at <path>/a/<id>/.
  app.use(`${path}/a/:id`, (req, res, next) => {
    const sub = cards.get(String(req.params.id));
    return sub ? sub(req, res, next) : void res.status(404).json({ error: 'no such agent (its conversation ended)' });
  });

  const end = async (sid: string) => {
    const s = sessions.get(sid);
    sessions.delete(sid);
    if (s) named.delete(s.id);
    await s?.agent?.close().catch(() => {});
  };
  setInterval(() => { for (const [sid, s] of sessions) if (Date.now() - s.seen > 30 * 60_000) void end(sid); }, 60_000).unref();

  app.post(path, async (req, res) => {
    const sid = req.get('mcp-session-id');
    let s = sid ? sessions.get(sid) : undefined;
    if (!s) {
      if (sid || !isInitializeRequest(req.body)) return void res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'unknown or missing session; start with initialize' }, id: null });
      if (sessions.size >= (o.maxSessions ?? 40)) return void res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'the sandbox is full right now; try again in a few minutes' }, id: null });
      const id = randomBytes(4).toString('hex');
      await refreshListed();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => { sessions.set(newSid, entry); },
      });
      const entry: { id: string; transport: StreamableHTTPServerTransport; agent?: LakeAgent; seen: number } = { id, transport, seen: Date.now() };
      transport.onclose = () => { if (transport.sessionId) void end(transport.sessionId); cards.delete(id); named.delete(id); };
      const server = createLakeMcpServer(
        { ...o, name: '', domain: '', publicUrl: `${base}${path}/a/${id}`, mount: (agentApp) => cards.set(id, agentApp) },
        {
          // Named after the assistant that connected, plus a name of its own, so four Claudes aren't four "Claude"s:
          // "Atlas (Claude, via MCP)", claude-ai-3f9a.mcp.example.
          identity: (client) => {
            const who = (client?.name ?? 'assistant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'assistant';
            const label = /claude/i.test(client?.name ?? '') ? 'Claude' : client?.name ?? 'an assistant';
            return { name: `${nameFor(id)} (${label}, via MCP)`, domain: `${who}-${id}.mcp.example` };
          },
          onAgent: (agent) => { entry.agent = agent; o.log?.(`${agent.domain} joined over MCP`); },
        },
      );
      await server.connect(transport);
      s = entry;
    }
    s.seen = Date.now();
    await s.transport.handleRequest(req, res, req.body);
  });

  const stream = async (req: express.Request, res: express.Response) => {
    const s = sessions.get(req.get('mcp-session-id') ?? '');
    if (!s) return void res.status(400).send('unknown session');
    s.seen = Date.now();
    await s.transport.handleRequest(req, res);
  };
  app.get(path, stream);
  app.delete(path, stream);
  app.get('/health', (_req, res) => void res.json({ ok: true, sessions: sessions.size }));
  return app;
}
