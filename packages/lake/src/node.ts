import { createServer, type Server } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildCard, describe, EVENT_KINDS, makeEvent, ReplayGuard, signCard, verifyMessage,
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
}

export interface Counters {
  houses: number;
  agents: number;
  conversations: number;
  valueSettled: number;
  attacksBlocked: number;
  recordsMoved: number;
}

type Wire =
  | { type: 'snapshot'; node: string; sandbox: boolean; approvalsUrl?: string; participants: Participant[]; counters: Counters; recent: Line[] }
  | { type: 'event'; event: LakeEvent; text: string; counters: Counters; participant?: Participant };
interface Participant { id: string; role: string; label: string; tags: string[]; domain: string }
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

  const participant = (e: Entry): Participant => ({ id: e.id, role: e.profile.role, label: e.label, tags: e.profile.tags, domain: e.profile.ownerDomain });
  const recount = () => {
    const all = registry.all();
    counters.houses = all.filter((e) => e.profile.role === 'house').length;
    counters.agents = all.filter((e) => e.profile.role !== 'house' && e.profile.role !== 'node').length + seenVisitors.size;
  };
  const send = (ws: WebSocket, w: Wire) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(w));

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
      case 'attack.blocked': counters.attacksBlocked++; break;
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
    const p = participant(r.entry);
    publish(r.entry.profile.role === 'house' ? makeEvent('house.joined', r.entry.id, undefined, { label: r.entry.label }) : makeEvent('agent.registered', r.entry.id, undefined, { role: r.entry.profile.role, label: r.entry.label }), p);
    res.json({ id: r.entry.id, domainVia: r.entry.domainVia });
  });

  app.get('/cards', (req, res) => {
    const q = { skill: str(req.query.skill), tag: str(req.query.tag), role: str(req.query.role) };
    res.json(registry.search(q).map((e) => ({ id: e.id, card: e.card })));
  });

  app.get('/state', (_req, res) => void res.json({ counters, participants: registry.all().map(participant) }));

  // Participants report what happened at their door. Signed by their registered key; the node
  // stamps the actor itself, so nobody can speak for someone else.
  app.post('/events', async (req, res) => {
    const env = req.body as Signed<{ kind: 'events'; events: LakeEvent[] }>;
    const entry = env?.payload?.iss ? registry.byWebId(env.payload.iss) : undefined;
    if (!entry) return void res.status(403).json({ code: 'not-registered', why: 'register your card first' });
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

  if (o.uiDir) app.use(express.static(o.uiDir));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/events' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    send(ws, { type: 'snapshot', node: o.domain, sandbox: o.sandbox, approvalsUrl: o.approvalsUrl, participants: registry.all().map(participant), counters, recent: recent.slice(-20) });
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
