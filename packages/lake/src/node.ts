import { appendFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildCard, describe, EVENT_KINDS, makeEvent, ReplayGuard, signCard, signMessage, verifyLakeCard, verifyMessage,
  type AgentCard, type Identity, type LakeEvent, type Signed,
} from '@thelakeprotocol/core';
import { Registry, type Entry } from './registry.js';

export interface NodeOptions {
  id: Identity;
  /** Public URL of this node. */
  url: string;
  domain: string;
  sandbox: boolean;
  /** Folder with the built map (packages/ui/dist); served at /. */
  uiDir?: string;
  /** A house's approvals app, shown as a QR code on the map so an owner can scan it on stage. */
  approvalsUrl?: string;
  /** Blocks from different reports before an attacker's key is quarantined. Default 3. */
  quarantineAfter?: number;
  /** Houses sharing an interest tag before they count as a guild. Default 3. */
  guildMin?: number;
  /** Intent groups smaller than this aren't published, so a lone household can't be singled out. Default 2. */
  intentMin?: number;
  /** Peer nodes to follow: their cards (re-verified here) and their blocklists. */
  follow?: string[];
  syncMs?: number;
  /** Lets an operator wipe counters, history and quarantines (demo resets). Off unless set. */
  resetToken?: string;
  /** Append every event, with its timing, to this file (JSON lines), for replay. */
  record?: string;
}

/** What a node tells the houses that follow it: keys to drop on sight, and how agents have behaved. */
export interface Signals { kind: 'signals'; blocklist: string[]; reputation: Record<string, number> }

export interface Counters {
  houses: number;
  agents: number;
  conversations: number;
  valueSettled: number;
  attacksBlocked: number;
  recordsMoved: number;
}

type Wire =
  | { type: 'snapshot'; node: string; sandbox: boolean; approvalsUrl?: string; participants: Participant[]; counters: Counters; recent: Line[]; guilds: { tag: string; members: number }[] }
  | { type: 'event'; event: LakeEvent; text: string; counters: Counters; participant?: Participant }
  | { type: 'reset' };
interface Participant { id: string; role: string; label: string; tags: string[]; domain: string; skills: string[] }
interface Line { event: LakeEvent; text: string }

/**
 * A Lake node: routes and records, holds no personal data, makes no decisions (SPEC §1, §8).
 * Events carry ids, kinds and counts only; anything else is dropped at the door.
 */
export async function createNode(o: NodeOptions): Promise<{ server: Server; card: AgentCard; registry: Registry; publish: (e: LakeEvent) => void }> {
  const registry = new Registry({ sandbox: o.sandbox });
  const replay = new ReplayGuard();
  const counters: Counters = { houses: 0, agents: 0, conversations: 0, valueSettled: 0, attacksBlocked: 0, recordsMoved: 0 };
  const recent: Line[] = [];
  const sockets = new Set<WebSocket>();
  const seenVisitors = new Set<string>();
  const nodeId = `node:${o.domain}`;
  // The immune system: blocks per attacker key, quarantined keys, and each verified agent's record.
  const blocks = new Map<string, number>();
  const quarantined = new Set<string>();
  const record = new Map<string, { kept: number; blocked: number }>();
  const guilds = new Map<string, number>();
  const peerBlocked = new Set<string>();
  const reputation = () => Object.fromEntries([...record].map(([d, r]) => [d, Math.round(Math.min(1, Math.max(0, 0.5 + 0.05 * r.kept - 0.15 * r.blocked)) * 100) / 100]));
  const tally = (agent: string | undefined, k: 'kept' | 'blocked') => {
    if (!agent?.startsWith('agent:')) return;
    const r = record.get(agent.slice(6)) ?? { kept: 0, blocked: 0 };
    r[k]++;
    record.set(agent.slice(6), r);
  };

  const card = await signCard(
    buildCard(
      {
        name: `Lake node ${o.domain}`,
        description: 'A Lake node: registry, event stream and map. Holds no personal data.',
        url: `${o.url}/a2a`,
        skills: [{ id: 'lake-registry', name: 'Registry', description: 'Search signed Agent Cards by skill or tag' }],
        profile: { role: 'node', webId: `${o.url}/#node`, ownerDomain: o.domain, tags: ['lake-node'] },
      },
      o.id,
    ),
    o.id,
  );

  // Skill ids let the map tell what an agent does (a quoter docks at the edge); the card is public anyway.
  const participant = (e: Entry): Participant => ({ id: e.id, role: e.profile.role, label: e.label, tags: e.profile.tags, domain: e.profile.ownerDomain, skills: (e.card.skills ?? []).map((s) => s.id).slice(0, 12) });
  const recount = () => {
    const all = registry.all();
    counters.houses = all.filter((e) => e.profile.role === 'house').length;
    counters.agents = all.filter((e) => e.profile.role !== 'house' && e.profile.role !== 'node').length + seenVisitors.size;
  };
  const send = (ws: WebSocket, w: Wire) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(w));

  /** Houses sharing an interest tag form a guild; announce it when one forms or grows. */
  function guildCheck() {
    const byTag = new Map<string, Entry[]>();
    for (const e of registry.all()) if (e.profile.role === 'house') for (const t of e.profile.tags) byTag.set(t, [...(byTag.get(t) ?? []), e]);
    for (const [tag, members] of byTag) {
      if (members.length < (o.guildMin ?? 3) || (guilds.get(tag) ?? 0) >= members.length) continue;
      guilds.set(tag, members.length);
      publish(makeEvent('guild.formed', nodeId, undefined, { tag, members: members.length }));
    }
  }

  function publish(event: LakeEvent, p?: Participant) {
    switch (event.kind) {
      case 'knock': {
        // A registered agent reports its own broadcast (with a count); a house reports each knock it gets.
        // Count a house's report only when the knocker didn't already report its broadcast here.
        const knocker = event.subject && registry.all().some((e) => `agent:${e.profile.ownerDomain}` === event.subject);
        if (event.data?.count !== undefined) counters.conversations += Number(event.data.count);
        else if (!knocker) {
          counters.conversations++;
          if (event.subject) seenVisitors.add(event.subject);
        }
        break;
      }
      case 'attack.blocked': {
        counters.attacksBlocked++;
        if (event.data?.verified) tally(`agent:${event.data.claimed}`, 'blocked');
        const key = event.data?.key ? String(event.data.key) : '';
        if (key && !quarantined.has(key)) {
          const n = (blocks.get(key) ?? 0) + 1;
          blocks.set(key, n);
          if (n >= (o.quarantineAfter ?? 3)) {
            quarantined.add(key);
            queueMicrotask(() => publish(makeEvent('agent.quarantined', nodeId, event.subject, { blocks: n, key, claimed: String(event.data?.claimed ?? '') })));
          }
        }
        break;
      }
      case 'agreement.signed': tally(event.subject, 'kept'); break;
      case 'payment.settled': counters.valueSettled += Number(event.data?.amount ?? 0); break;
      // Computed from what each house's audit log says left it, never assumed.
      case 'compute.done': counters.recordsMoved += Number(event.data?.recordsOut ?? 0); break;
      case 'record.moved': counters.recordsMoved += Number(event.data?.count ?? 1); break;
    }
    recount();
    const name = (id?: string) => (id ? (registry.get(id)?.label ?? id) : id);
    const line = { event, text: describe({ ...event, actor: name(event.actor)!, subject: name(event.subject) }) };
    recent.push(line);
    if (recent.length > 50) recent.shift();
    if (o.record) appendFileSync(o.record, JSON.stringify({ t: Date.now(), ...line, counters, participant: p }) + '\n');
    for (const ws of sockets) send(ws, { type: 'event', ...line, counters, participant: p });
  }

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/.well-known/agent-card.json', (_req, res) => void res.json(card));
  app.get('/health', (_req, res) => void res.json({ ok: true }));

  app.post('/register', async (req, res) => {
    const r = await registry.register(req.body?.card);
    if (!r.ok) {
      publish(makeEvent('attack.blocked', nodeId, String(req.body?.card?.name ?? 'unknown card'), { why: r.refusal.code }));
      return void res.status(400).json(r.refusal);
    }
    for (const old of r.replaced) if (old.profile.role === 'house') publish(makeEvent('house.left', old.id, undefined, { replaced: true }));
    const p = participant(r.entry);
    publish(r.entry.profile.role === 'house' ? makeEvent('house.joined', r.entry.id, undefined, { label: r.entry.label }) : makeEvent('agent.registered', r.entry.id, undefined, { role: r.entry.profile.role, label: r.entry.label }), p);
    if (r.entry.profile.role === 'house') guildCheck();
    res.json({ id: r.entry.id, domainVia: r.entry.domainVia });
  });

  app.get('/cards', (req, res) => {
    const q = { skill: str(req.query.skill), tag: str(req.query.tag), role: str(req.query.role) };
    res.json(registry.search(q).map((e) => ({ id: e.id, card: e.card })));
  });

  const guildList = () => [...guilds].map(([tag, members]) => ({ tag, members }));
  // A demo reset: counters, history, quarantines, reputation and guilds go; houses and specialists stay.
  app.post('/reset', (req, res) => {
    if (!o.resetToken) return void res.status(404).json({ error: 'reset is off on this node' });
    if (req.get('x-lake-reset') !== o.resetToken) return void res.status(403).json({ error: 'wrong reset token' });
    Object.assign(counters, { conversations: 0, valueSettled: 0, attacksBlocked: 0, recordsMoved: 0 });
    recent.length = 0;
    for (const set of [blocks, quarantined, record, guilds, seenVisitors, peerBlocked] as { clear(): void }[]) set.clear();
    for (const e of registry.all()) if (e.profile.role === 'visitor') registry.remove(e.id);
    recount();
    guildCheck();
    for (const ws of sockets) send(ws, { type: 'reset' });
    res.json({ reset: true });
  });

  /** Cheap check for participants: does this node still know you (after a restart or a reset, it may not)? */
  app.get('/registered', (req, res) => {
    const e = registry.byWebId(String(req.query.webId ?? ''));
    if (e) e.lastSeen = Date.now();
    res.json({ registered: !!e });
  });

  // Participants check in every few seconds. Anyone silent for a minute has gone: say so, and forget them.
  setInterval(() => {
    for (const e of registry.all()) {
      if (e.via !== 'direct' || e.profile.role === 'node' || Date.now() - e.lastSeen < 60_000) continue;
      registry.remove(e.id);
      if (e.profile.role === 'house') publish(makeEvent('house.left', e.id, undefined, { silent: true }));
      else recount();
    }
  }, 15_000).unref();

  app.get('/state', (_req, res) => void res.json({ counters, participants: registry.all().map(participant), guilds: guildList() }));

  // Signed, so a house can follow a node's blocklist without trusting the wire. Each house chooses which nodes it follows.
  // A node republishes the blocklists of the peers it chose to follow, alongside its own.
  app.get('/signals', async (_req, res) => {
    const body: Signals = { kind: 'signals', blocklist: [...new Set([...quarantined, ...peerBlocked])], reputation: reputation() };
    res.json(await signMessage(body, o.id, { iss: `${o.url}/#node`, ttl: 60 }));
  });

  // Participants report what happened at their door. Signed by their registered key; the node
  // stamps the actor itself, so nobody can speak for someone else.
  app.post('/events', async (req, res) => {
    const env = req.body as Signed<{ kind: 'events'; events: LakeEvent[] }>;
    const entry = env?.payload?.iss ? registry.byWebId(env.payload.iss) : undefined;
    if (!entry) return void res.status(403).json({ code: 'not-registered', why: 'register your card first' });
    entry.lastSeen = Date.now();
    // The signature must be by the key on the card registered now, not an older one.
    try {
      await verifyMessage(env, async (kid) => (kid === entry.profile.publicJwk.kid ? entry.profile.publicJwk : null), { replay });
    } catch (e) {
      return void res.status(403).json({ code: 'bad-signature', why: (e as Error).message });
    }
    let n = 0;
    for (const raw of env.payload.events ?? []) {
      if (!EVENT_KINDS.includes(raw.kind) || raw.kind === 'house.joined' || raw.kind === 'agent.registered') continue;
      const event: LakeEvent = { ...makeEvent(raw.kind, entry.id, cleanId(raw.subject), cleanData(raw.data)) };
      if (raw.kind === 'house.left') registry.remove(entry.id);
      publish(event);
      n++;
    }
    res.json({ accepted: n });
  });

  // Intents (SPEC §12): a house says what it's looking for. The node keeps who privately and publishes
  // only how many share each group; agents learn a group's size, never its members. In a sandbox the map
  // also shows which house asked, so people can watch it happen.
  const intents = new Map<string, { pack: string; group: string; at: number }[]>();
  const groupSizes = () => {
    const counts = new Map<string, { pack: string; group: string; members: number }>();
    for (const [id, list] of intents) {
      if (!registry.get(id)) { intents.delete(id); continue; }
      for (const x of list) {
        const k = `${x.pack}|${x.group}`;
        const c = counts.get(k) ?? { pack: x.pack, group: x.group, members: 0 };
        c.members++;
        counts.set(k, c);
      }
    }
    return [...counts.values()];
  };
  app.post('/intents', async (req, res) => {
    const env = req.body as Signed<{ kind: 'intents'; intents: { pack: string; group: string }[] }>;
    const entry = env?.payload?.iss ? registry.byWebId(env.payload.iss) : undefined;
    if (!entry) return void res.status(403).json({ code: 'not-registered', why: 'register your card first' });
    try {
      await verifyMessage(env, async (kid) => (kid === entry.profile.publicJwk.kid ? entry.profile.publicJwk : null), { replay });
    } catch (e) {
      return void res.status(403).json({ code: 'bad-signature', why: (e as Error).message });
    }
    const before = new Set((intents.get(entry.id) ?? []).map((x) => `${x.pack}|${x.group}`));
    const list = (env.payload.intents ?? []).slice(0, 8).map((x) => ({ pack: String(x.pack).slice(0, 40), group: String(x.group).slice(0, 120), at: Date.now() }));
    intents.set(entry.id, list);
    const sizes = groupSizes();
    for (const x of list) {
      if (before.has(`${x.pack}|${x.group}`)) continue;
      const members = sizes.find((g) => g.pack === x.pack && g.group === x.group)?.members ?? 1;
      publish(makeEvent('intent.opened', o.sandbox ? entry.id : 'lake', undefined, { pack: x.pack, group: x.group, members }));
    }
    res.json({ groups: sizes.filter((g) => list.some((x) => x.pack === g.pack && x.group === g.group)) });
  });
  app.get('/intents', (req, res) => {
    const pack = str(req.query.pack);
    res.json(groupSizes().filter((g) => (!pack || g.pack === pack) && g.members >= (o.intentMin ?? 2)));
  });

  // Relay (SPEC §9.1): a house behind a home router keeps one outgoing connection here, and knocks for it
  // arrive at /relay/<its key>/… and travel down that connection. Messages stay signed end to end.
  const relay = relayHub(replay);
  app.use('/relay/:kid', (req, res) => void relay.forward(String(req.params.kid), req, res));

  if (o.uiDir) app.use(express.static(o.uiDir));

  // Federation (SPEC §9): follow peers. Their cards are verified again here, from the agents' own endpoints,
  // so a peer can point us at agents but can't vouch for them. A card disappears when its peer drops it.
  const peerKeys = new Map<string, import('@thelakeprotocol/core').JWK>();
  async function syncPeer(peer: string) {
    try {
      const listed = (await (await fetch(`${peer}/cards`, { signal: AbortSignal.timeout(5000) })).json()) as { card: AgentCard }[];
      const seen = new Set<string>();
      for (const { card } of listed) {
        const webId = (card.capabilities?.extensions?.[0]?.params as { webId?: string } | undefined)?.webId;
        if (!webId) continue;
        seen.add(webId);
        const known = registry.byWebId(webId);
        if (known && JSON.stringify(known.card.signatures) === JSON.stringify(card.signatures)) continue;
        if (known?.via === 'direct') continue; // registered here directly: that copy wins
        const r = await registry.register(card, peer);
        if (r.ok) {
          const p = participant(r.entry);
          publish(r.entry.profile.role === 'house' ? makeEvent('house.joined', r.entry.id, undefined, { label: r.entry.label, via: 'peer' }) : makeEvent('agent.registered', r.entry.id, undefined, { role: r.entry.profile.role, label: r.entry.label, via: 'peer' }), p);
          if (r.entry.profile.role === 'house') guildCheck();
        }
      }
      for (const e of registry.all()) {
        if (e.via === peer && !seen.has(e.profile.webId)) {
          registry.remove(e.id);
          publish(makeEvent(e.profile.role === 'house' ? 'house.left' : 'agent.registered', e.id, undefined, { via: 'peer' }));
        }
      }
      if (!peerKeys.has(peer)) peerKeys.set(peer, (await verifyLakeCard(await (await fetch(`${peer}/.well-known/agent-card.json`)).json())).publicJwk);
      const key = peerKeys.get(peer)!;
      const signals = (await verifyMessage(await (await fetch(`${peer}/signals`, { signal: AbortSignal.timeout(5000) })).json(), async () => key)) as unknown as Signals;
      for (const k of signals.blocklist ?? []) peerBlocked.add(k);
    } catch {
      // A peer that's down is just a peer that's down. We carry on.
    }
  }
  for (const peer of o.follow ?? []) {
    const p = peer.replace(/\/$/, '');
    setInterval(() => void syncPeer(p), o.syncMs ?? 5000).unref();
    setTimeout(() => void syncPeer(p), 500).unref();
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const relayWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/events') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else if (path === '/relay') relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit('connection', ws, req));
    else socket.destroy();
  });
  relayWss.on('connection', (ws) => relay.accept(ws));
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    send(ws, { type: 'snapshot', node: o.domain, sandbox: o.sandbox, approvalsUrl: o.approvalsUrl, participants: registry.all().map(participant), counters, recent: recent.slice(-20), guilds: guildList() });
  });
  return { server, card, registry, publish };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const cleanId = (s: unknown) => (typeof s === 'string' ? s.slice(0, 80) : undefined);

/** Events carry numbers and short labels only. Long strings could smuggle record contents, so they are cut. */
function cleanData(d: LakeEvent['data']): LakeEvent['data'] {
  if (!d || typeof d !== 'object') return undefined;
  const out: NonNullable<LakeEvent['data']> = {};
  for (const [k, v] of Object.entries(d).slice(0, 12)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 32)] = v;
    else if (typeof v === 'string') out[k.slice(0, 32)] = v.slice(0, 160);
  }
  return out;
}

/**
 * Replays a recorded run (from --record) through the map at the pace it happened: the stage fallback when
 * live mode fails. No registry, no intake; just the stream.
 */
export async function replayNode(o: { file: string; uiDir?: string; speed?: number; loop?: boolean; domain: string }): Promise<Server> {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(o.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line & { t: number; counters: Counters; participant?: Participant });
  const app = express();
  // The recording itself, for the map's capture mode (frame-by-frame video).
  app.get('/replay.jsonl', (_req, res) => void res.type('application/x-ndjson').send(readFileSync(o.file, 'utf8')));
  if (o.uiDir) app.use(express.static(o.uiDir));
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/events' });
  const sockets = new Set<WebSocket>();
  let participants = new Map<string, Participant>();
  let recent: Line[] = [];
  let counters: Counters = { houses: 0, agents: 0, conversations: 0, valueSettled: 0, attacksBlocked: 0, recordsMoved: 0 };
  const send = (ws: WebSocket, w: Wire) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(w));
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    send(ws, { type: 'snapshot', node: `${o.domain} (replay)`, sandbox: true, participants: [...participants.values()], counters, recent: recent.slice(-20), guilds: [] });
  });
  const play = () => {
    participants = new Map();
    recent = [];
    for (const ws of sockets) send(ws, { type: 'reset' });
    const t0 = lines[0]?.t ?? 0;
    lines.forEach((l, i) => setTimeout(() => {
      if (l.participant) participants.set(l.participant.id, l.participant);
      counters = l.counters;
      recent.push({ event: l.event, text: l.text });
      for (const ws of sockets) send(ws, { type: 'event', event: l.event, text: l.text, counters: l.counters, participant: l.participant });
      if (i === lines.length - 1 && o.loop) setTimeout(play, 5000);
    }, (l.t - t0) / (o.speed ?? 1)));
  };
  setTimeout(play, 1500);
  return server;
}

/** Holds relay connections from houses that can't take incoming connections, and forwards requests to them. */
function relayHub(replay: ReplayGuard) {
  const channels = new Map<string, { ws: WebSocket; pending: Map<string, (r: { status: number; headers: Record<string, string>; body: string }) => void> }>();
  let seq = 0;
  return {
    accept(ws: WebSocket) {
      let kid = '';
      ws.on('message', async (raw) => {
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return ws.close(); }
        if (m.type === 'hello') {
          // Only the holder of the card's key can open its channel.
          try {
            const profile = await verifyLakeCard(m.card);
            const p = await verifyMessage(m.envelope, async (k) => (k === profile.publicJwk.kid ? profile.publicJwk : null), { replay });
            if ((p as unknown as { kind: string }).kind !== 'relay-hello' || p.iss !== profile.webId) throw new Error('bad hello');
            kid = relayId(profile.publicJwk.kid!);
            channels.get(kid)?.ws.close();
            channels.set(kid, { ws, pending: new Map() });
            ws.send(JSON.stringify({ type: 'ready', path: `/relay/${kid}` }));
          } catch {
            ws.close();
          }
        } else if (m.type === 'res' && kid) {
          channels.get(kid)?.pending.get(m.id)?.(m);
        }
      });
      ws.on('close', () => { if (kid && channels.get(kid)?.ws === ws) channels.delete(kid); });
    },
    async forward(kid: string, req: express.Request, res: express.Response) {
      const ch = channels.get(kid);
      if (!ch) return void res.status(502).json({ error: 'that house is not connected to this node right now' });
      const id = String(++seq);
      const done = new Promise<{ status: number; headers: Record<string, string>; body: string }>((ok) => ch.pending.set(id, ok));
      const headers: Record<string, string> = {};
      for (const h of ['content-type', 'a2a-version', 'a2a-extensions', 'x-a2a-extensions', 'accept']) if (req.get(h)) headers[h] = req.get(h)!;
      ch.ws.send(JSON.stringify({ type: 'req', id, method: req.method, path: req.url, headers, body: req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : undefined }));
      const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), 30_000));
      const r = await Promise.race([done, timeout]);
      ch.pending.delete(id);
      if (!r) return void res.status(504).json({ error: 'the house did not answer in time' });
      for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-length' && k !== 'transfer-encoding') res.set(k, v);
      res.status(r.status).send(r.body);
    },
  };
}

/** The path segment a house is reached at through a relay: its key id, made URL-safe. */
export const relayId = (kid: string) => kid.replace(/[^a-zA-Z0-9]/g, '');
