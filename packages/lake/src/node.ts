import { randomInt } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  addToLog, blueprintRecord, buildCard, describe, EVENT_KINDS, LogRefused, PAIRED_KINDS, publicView, makeEvent, parseBlueprint, ReplayGuard, signCard, signMessage, verifyLakeCard, verifyMessage,
  type AgentCard, type Identity, type LakeEvent, type Signed,
} from '@thelakeprotocol/core';
import { Registry, type Entry } from './registry.js';

export interface NodeOptions {
  id: Identity;
  /** Public URL of this node. */
  url: string;
  domain: string;
  sandbox: boolean;
  /** A staged demo's map shows which house opened an intent; otherwise the feed says only that one did. */
  showIntentHouses?: boolean;
  /** Folder with the built map (packages/ui/dist); served at /. */
  uiDir?: string;
  /** A house's approvals app, shown as a QR code on the map so an owner can scan it on stage. */
  approvalsUrl?: string;
  /** Blocks from different reports before an attacker's key is quarantined. Default 3. */
  quarantineAfter?: number;
  /** Door events and agents' messages go public in shuffled batches about this often (ms; 0: at once). Default 7000. */
  feedBatchMs?: number;
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
  /** Where published blueprints are kept between restarts (JSON). */
  blueprintsFile?: string;
  /** Blueprints this node starts with (the project's own), as markdown. */
  seedBlueprints?: string[];
  /** A transparency log's A2A endpoint (SPEC §11.8): every blueprint published here is put on its record. Off unless set. */
  logUrl?: string;
  /** How often blueprints not yet on the log are tried again (ms). Default 30000. */
  logRetryMs?: number;
}

/** What a node tells the houses that follow it: keys to drop on sight, and how agents have behaved. */
export interface Signals { kind: 'signals'; blocklist: string[]; reputation: Record<string, number> }

/**
 * What a node counts from the events it is told, everyday things first. Each counts only what the party that did it
 * reports (SPEC §8): money from a specialist (the payments agent); offers, agreements and keys from houses.
 */
export interface Counters {
  houses: number;
  agents: number;
  /** Carts a seller signed and a buyer paid (SPEC §6.5), at once or held until delivery. */
  cartsPaid: number;
  /** Payments that moved money: paid at once, or held and then released to the seller (a voided hold moved nothing). */
  paymentsSettled: number;
  /** The sum of those payments, whatever currency each was in (a sandbox's money is simulated). */
  valueSettled: number;
  /** Offers worked out inside a house on its owner's own data (only the owner sees them), and those owners accepted. */
  offersPriced: number;
  offersAccepted: number;
  /** Agreements houses signed (each beside its owner's consent record), and keys owners took back. */
  agreementsSigned: number;
  keysRevoked: number;
  /** Studies that got their answer, as the agents that ran them reported it. */
  studiesRun: number;
  conversations: number;
  attacksBlocked: number;
  recordsMoved: number;
}
const zeroCounters = (): Counters => ({ houses: 0, agents: 0, cartsPaid: 0, paymentsSettled: 0, valueSettled: 0, offersPriced: 0, offersAccepted: 0, agreementsSigned: 0, keysRevoked: 0, studiesRun: 0, conversations: 0, attacksBlocked: 0, recordsMoved: 0 });

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
  const counters = zeroCounters();
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

  // Door events and agents' messages go public in shuffled batches, stamped with the batch's time, not the moment: a
  // house's "someone knocked" and the knocker's own activity lined up to the millisecond (run 11). Counters move with the
  // batch too. Batching hides a pair only among other traffic; on a quiet Lake a batch may hold just one.
  const batchMs = o.feedBatchMs ?? 7000;
  let batch: [LakeEvent, Participant | undefined][] = [];
  const flush = () => {
    const out = batch;
    batch = [];
    for (let i = out.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
    const at = new Date().toISOString();
    for (const [e, p] of out) publishNow({ ...e, at }, p);
    setTimeout(flush, batchMs * (0.6 + Math.random() * 0.8)).unref();
  };
  if (batchMs > 0) setTimeout(flush, batchMs).unref();
  function publish(event: LakeEvent, p?: Participant) {
    if (batchMs > 0 && (PAIRED_KINDS.has(event.kind) || event.kind === 'agent.message')) batch.push([event, p]);
    else publishNow(event, p);
  }

  function publishNow(event: LakeEvent, p?: Participant) {
    // Who reported it, by the role on its registered card: the node set the actor itself (SPEC §8).
    const by = (role: string) => registry.get(event.actor)?.profile.role === role;
    switch (event.kind) {
      case 'knock': {
        // A house reports each knock it gets; agents no longer report their own (it only paired them with the house).
        counters.conversations++;
        // Visitors that never registered here count as agents too; registered ones are counted already.
        if (event.subject && !registry.all().some((e) => `agent:${e.profile.ownerDomain}` === event.subject)) seenVisitors.add(event.subject);
        break;
      }
      case 'attack.blocked': {
        counters.attacksBlocked++;
        // Blame the verified sender (an impersonator's own domain), never the name it pretended to be.
        if (event.data?.verified) tally(`agent:${event.data.from ?? event.data.claimed}`, 'blocked');
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
      case 'agreement.signed': tally(event.subject, 'kept'); if (by('house')) counters.agreementsSigned++; break;
      // Agents talking to each other are conversations too (the payment's money is counted by the payments agent).
      case 'agent.message': if (event.data?.kind !== 'payment') counters.conversations++; break;
      // From the payments agent: a held payment is a cart paid, and its money counts once, when it is released.
      case 'payment.settled': {
        if (!by('specialist')) break;
        const d = event.data ?? {};
        if (d.cart === true && d.released !== true) counters.cartsPaid++;
        if (d.held === true) break;
        counters.paymentsSettled += Math.max(1, Number(d.count) || 1);
        counters.valueSettled += Number(d.amount) || 0;
        break;
      }
      case 'quote.made': if (by('house')) counters.offersPriced++; break;
      case 'offer.accepted': if (by('house')) counters.offersAccepted++; break;
      case 'grant.revoked': if (by('house')) counters.keysRevoked += Math.max(1, Number(event.data?.count) || 1); break;
      case 'study.result': counters.studiesRun++; break;
      // Computed from what each house's audit log says left it, never assumed.
      case 'compute.done': counters.recordsMoved += Number(event.data?.recordsOut ?? 0); break;
      case 'record.moved': counters.recordsMoved += Number(event.data?.count ?? 1); break;
    }
    recount();
    const name = (id?: string) => (id ? (registry.get(id)?.label ?? id) : id);
    // Counters and reputation above used the whole event; the world gets only what happened, never between whom (SPEC §8).
    const shown = publicView(event);
    const line = { event: shown, text: describe({ ...shown, actor: name(shown.actor)!, subject: name(shown.subject) }) };
    recent.push(line);
    if (recent.length > 50) recent.shift();
    if (o.record) appendFileSync(o.record, JSON.stringify({ t: Date.now(), ...line, counters, participant: p }) + '\n');
    for (const ws of sockets) send(ws, { type: 'event', ...line, counters, participant: p });
  }

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/.well-known/agent-card.json', (_req, res) => void res.json(card));
  app.get('/health', (_req, res) => void res.json({ ok: true }));

  const announced = new Set<string>();
  app.post('/register', async (req, res) => {
    const r = await registry.register(req.body?.card);
    if (!r.ok) {
      publish(makeEvent('attack.blocked', nodeId, String(req.body?.card?.name ?? 'unknown card'), { why: r.refusal.code }));
      return void res.status(400).json(r.refusal);
    }
    for (const old of r.replaced) if (old.profile.role === 'house') publish(makeEvent('house.left', old.id, undefined, { replaced: true }));
    const p = participant(r.entry);
    // The same key registering again (a reconnect, a new tag) isn't news: the feed said it arrived the first time.
    const again = r.entry.profile.role !== 'house' && announced.has(r.entry.profile.publicJwk.kid!);
    announced.add(r.entry.profile.publicJwk.kid!);
    if (!again) publish(r.entry.profile.role === 'house' ? makeEvent('house.joined', r.entry.id, undefined, { label: r.entry.label }) : makeEvent('agent.registered', r.entry.id, undefined, { role: r.entry.profile.role, label: r.entry.label }), p);
    if (r.entry.profile.role === 'house') guildCheck();
    res.json({ id: r.entry.id, domainVia: r.entry.domainVia });
  });

  const IDLE_MS = 15 * 60_000;
  app.get('/cards', (req, res) => {
    const q = { skill: str(req.query.skill), tag: str(req.query.tag), role: str(req.query.role), q: str(req.query.q) };
    // An agent whose driver hasn't acted for a quarter of an hour is left out unless asked for (idle=1): run 29's host
    // invited a player sixteen minutes after it had gone. It is still there for messages, just not offered as company.
    const idle = req.query.idle === '1';
    // `via`: the peer node a card was learned from (SPEC §9), so an agent can tell its own Lake's specialists from a peer's.
    res.json(registry.search(q).filter((e) => idle || !e.lastActive || Date.now() - e.lastActive < IDLE_MS).map((e) => ({ id: e.id, card: e.card, ...(e.via !== 'direct' ? { via: e.via, ...(peerHealth.get(e.via)?.answering === false ? { unreachable_since: peerHealth.get(e.via)!.since } : {}) } : {}), ...(e.lastActive ? { active: new Date(e.lastActive).toISOString() } : {}), ...(e.hereUntil && e.hereUntil > Date.now() ? { until: new Date(e.hereUntil).toISOString() } : {}), ...registry.claimsOf(e) })));
  });

  const guildList = () => [...guilds].map(([tag, members]) => ({ tag, members }));
  // A demo reset: counters, history, quarantines, reputation and guilds go; houses and specialists stay.
  app.post('/reset', (req, res) => {
    if (!o.resetToken) return void res.status(404).json({ error: 'reset is off on this node' });
    if (req.get('x-lake-reset') !== o.resetToken) return void res.status(403).json({ error: 'wrong reset token' });
    Object.assign(counters, zeroCounters());
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

  // Presence (SPEC §8.1): when an agent's driver last acted through it, signed by the agent. Search results carry it, so
  // an agent can tell who is at work from who was left running (run 22: five of nine invitees had gone, and every
  // message to them still said "received").
  app.post('/presence', async (req, res) => {
    const env = req.body as Signed<{ kind: 'presence'; active?: string; until?: string; gone?: boolean }>;
    const entry = env?.payload?.iss ? registry.byWebId(env.payload.iss) : undefined;
    if (!entry) return void res.status(403).json({ code: 'not-registered', why: 'register your card first' });
    try {
      await verifyMessage(env, async (kid) => (kid === entry.profile.publicJwk.kid ? entry.profile.publicJwk : null), { replay });
    } catch (e) {
      return void res.status(403).json({ code: 'bad-signature', why: (e as Error).message });
    }
    // Leaving: gone from search at once, not a minute later (run 25's host kept messaging an agent that had left).
    if (env.payload.gone === true) {
      registry.remove(entry.id);
      if (entry.profile.role === 'house') publish(makeEvent('house.left', entry.id));
      else recount();
      return void res.json({ ok: true, gone: true });
    }
    const at = Date.parse(String(env.payload.active ?? ''));
    if (!(at > 0) || at > Date.now() + 60_000) return void res.status(400).json({ code: 'malformed', why: 'active: when, as an ISO time, not in the future' });
    entry.lastActive = Math.min(at, Date.now());
    // How long it means to stay, in its own word (run 25 asked for "here until").
    const until = Date.parse(String(env.payload.until ?? ''));
    entry.hereUntil = until > Date.now() && until < Date.now() + 7 * 86_400_000 ? until : undefined;
    entry.lastSeen = Date.now();
    res.json({ ok: true });
  });

  // Badges, checked at registration, are checked again every few minutes: an issuer may revoke one (SPEC §2.5).
  setInterval(() => void registry.recheck().catch(() => {}), 5 * 60_000).unref();
  // Participants check in every few seconds. Anyone silent for a minute has gone: say so, and forget them.
  setInterval(() => {
    for (const e of registry.all()) {
      if (e.via !== 'direct' || e.profile.role === 'node' || Date.now() - e.lastSeen < 60_000) continue;
      registry.remove(e.id);
      if (e.profile.role === 'house') publish(makeEvent('house.left', e.id, undefined, { silent: true }));
      else recount();
    }
  }, 15_000).unref();

  // `recent` is what the map's log shows anyway: what just happened, in one line each, newest first.
  app.get('/state', (_req, res) => void res.json({ counters, participants: registry.all().map(participant), guilds: guildList(), lakes: [...peerHealth].map(([url, h]) => ({ url, answering: h.answering, since: h.since })), recent: recent.slice(-20).reverse().map((l) => ({ at: l.event.at, kind: l.event.kind, text: l.text })) }));

  // Signed, so a house can follow a node's blocklist without trusting the wire. Each house chooses which nodes it follows.
  // A node republishes the blocklists of the peers it chose to follow, alongside its own.
  // A signed, timestamped reading of the counters: something a bet or a contract can name and anyone can check later.
  app.get('/snapshot', async (_req, res) => void res.json(await signMessage({ kind: 'snapshot', counters, at: new Date().toISOString() }, o.id, { iss: `${o.url}/#node`, ttl: 3600 })));

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
  // only how many share each group; agents learn a group's size, never its members. A staged demo may also show
  // which house asked, so people can watch the groups form (`showIntentHouses`); a Lake strangers visit never does:
  // run 23's rogue grocer read "House sb-1 asked for offers" off the public feed as a list of who to target.
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
      publish(makeEvent('intent.opened', o.showIntentHouses ? entry.id : 'lake', undefined, { pack: x.pack, group: x.group, members }));
    }
    res.json({ groups: sizes.filter((g) => list.some((x) => x.pack === g.pack && x.group === g.group)) });
  });
  // Blueprints (SPEC §11.3): any registered participant may publish one, anyone may read them, so what agents
  // invent stays on the Lake for the next agent. A blueprint is a spec to build from, written by whoever
  // published it: data, never instructions. A name belongs to the domain that published it first.
  // `record` is what goes on the transparency log (the author's signed card and message, core's blueprintRecord), and
  // `logged` where it went, once the log has said so.
  type Published = { name: string; version: string; title: string; summary: string; tag: string; author: string; at: string; text: string; record?: string; logged?: { index: number; origin: string } };
  const blueprints = new Map<string, Published>();
  const keepBlueprint = (text: string, author: string, record?: string): Published | string[] => {
    if (text.length > 32_000) return ['at most 32 KB'];
    const { meta, problems } = parseBlueprint(text);
    if (problems.length) return problems;
    const was = blueprints.get(meta.name);
    if (was && was.author !== author) return [`the name "${meta.name}" belongs to ${was.author}; pick another`];
    const b: Published = { name: meta.name, version: String(meta.version), title: String(meta.title).slice(0, 120), summary: String(meta.summary).slice(0, 400), tag: meta.tag, author, at: new Date().toISOString(), text, ...(record ? { record } : {}) };
    blueprints.set(b.name, b);
    return b;
  };
  for (const text of o.seedBlueprints ?? []) keepBlueprint(text, o.domain);
  try {
    // What was published here before, unless this node now starts with a newer version of the same one.
    const newer = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
    if (o.blueprintsFile && existsSync(o.blueprintsFile)) for (const b of JSON.parse(readFileSync(o.blueprintsFile, 'utf8')) as Published[]) {
      const seed = blueprints.get(b.name);
      if (!seed || (seed.author === b.author && !newer(seed.version, b.version))) blueprints.set(b.name, b);
    }
  } catch {
    // a broken file: start from the seeds
  }
  // Close relatives already here, by the words of their title and summary: an author re-inventing yesterday's game should
  // know (run 21: "twothirds" re-invented "thirds"). A warning, never a refusal.
  const words = (b: { title: string; summary: string }) => new Set(`${b.title} ${b.summary}`.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []);
  const similarTo = (b: Published) => {
    const mine = words(b);
    return [...blueprints.values()].filter((x) => x.name !== b.name).map((x) => {
      const theirs = words(x);
      const shared = [...mine].filter((w) => theirs.has(w)).length;
      return { name: x.name, title: x.title, author: x.author, score: shared / Math.max(1, new Set([...mine, ...theirs]).size) };
    }).filter((x) => x.score >= 0.3).sort((a, z) => z.score - a.score).slice(0, 3).map(({ score, ...x }) => ({ ...x, overlap: `${Math.round(score * 100)}%` }));
  };
  const saveBlueprints = () => { if (o.blueprintsFile) writeFileSync(o.blueprintsFile, JSON.stringify([...blueprints.values()])); };

  // On the record (SPEC §11.8): each blueprint goes to the transparency log as its author signed it, so anyone can check
  // later that this exact text was published by that domain, and that the log never dropped or rewrote it. The log runs
  // elsewhere; the node asks it over A2A as itself, and checks the inclusion proof under the signed checkpoint before it
  // says where a blueprint is logged. One that couldn't be logged yet (the log down, or not up yet) is tried again.
  const nodeWebId = `${o.url}/#node`;
  const refused = new Set<string>();
  const logOne = async (b: Published): Promise<void> => {
    // The node's own blueprints (its seeds) are signed by the node, their author; one published elsewhere before
    // blueprints were logged has no author's signature here to log, so it stays off the record.
    if (!b.record && b.author === o.domain) b.record = blueprintRecord(card, await signMessage({ kind: 'blueprint' as const, text: b.text }, o.id, { iss: nodeWebId }));
    if (!b.record) return;
    try {
      const { index, origin } = await addToLog(o.logUrl!, b.record, { id: o.id, card, webId: nodeWebId }, { sandbox: o.sandbox });
      b.logged = { index, origin };
      saveBlueprints();
    } catch (e) {
      // Refused (too big, or too many this hour): said once, tried again on the next round, the rest carry on meanwhile.
      if (!(e instanceof LogRefused)) throw e;
      if (!refused.has(b.record)) console.error(`[node:${o.domain}] blueprint ${b.name}: ${e.message}`);
      refused.add(b.record);
    }
  };
  const round = async () => {
    // Until nothing is left that this round hasn't tried: one published while the round runs is taken in it too.
    const tried = new Set<Published>();
    try {
      for (let b: Published | undefined; (b = [...blueprints.values()].find((x) => !x.logged && !tried.has(x)));) {
        tried.add(b);
        await logOne(b);
      }
    } catch (e) {
      console.error(`[node:${o.domain}] transparency log: ${(e as Error).message}; trying again later`);
    }
  };
  // One round at a time. (Cleared in .finally, always after the assignment: a round with nothing to do finishes
  // synchronously, and clearing inside it would leave the finished round in place for good.)
  let logging: Promise<void> | undefined;
  const logPending = (): Promise<void> => {
    if (!o.logUrl) return Promise.resolve();
    if (!logging) logging = round().finally(() => { logging = undefined; });
    return logging;
  };
  if (o.logUrl) {
    setTimeout(() => void logPending(), 1000).unref();
    setInterval(() => void logPending(), o.logRetryMs ?? 30_000).unref();
  }

  app.post('/blueprints', async (req, res) => {
    const env = req.body as Signed<{ kind: 'blueprint'; text: string }>;
    const entry = env?.payload?.iss ? registry.byWebId(env.payload.iss) : undefined;
    if (!entry) return void res.status(403).json({ code: 'not-registered', why: 'register your card first' });
    try {
      await verifyMessage(env, async (kid) => (kid === entry.profile.publicJwk.kid ? entry.profile.publicJwk : null), { replay });
    } catch (e) {
      return void res.status(403).json({ code: 'bad-signature', why: (e as Error).message });
    }
    const text = String(env.payload.text ?? '');
    const kept = keepBlueprint(text, entry.profile.ownerDomain, blueprintRecord(entry.card, env as Signed<{ kind: 'blueprint'; text: string }>));
    if (Array.isArray(kept)) return void res.status(400).json({ code: 'not-a-blueprint', problems: kept });
    saveBlueprints();
    publish(makeEvent('blueprint.published', entry.id, undefined, { name: kept.name, tag: kept.tag }));
    const similar = similarTo(kept);
    // A moment for the log to answer, so the author learns where it's logged; if it's slow, GET /blueprints says later.
    if (o.logUrl) await Promise.race([logPending(), new Promise((ok) => setTimeout(ok, 3000).unref())]);
    res.json({ name: kept.name, version: kept.version, url: `${o.url}/blueprints/${kept.name}`, ...(kept.logged ? { logged: kept.logged } : {}), ...(similar.length ? { similar, note: 'These look close to yours: credit them, or say how yours differs.' } : {}) });
  });
  app.get('/blueprints', (_req, res) => void res.json([...blueprints.values()].sort((a, b) => b.at.localeCompare(a.at)).map(({ text: _t, record: _r, ...b }) => ({ ...b, url: `${o.url}/blueprints/${b.name}` }))));
  app.get('/blueprints/:name', (req, res) => {
    const b = blueprints.get(String(req.params.name));
    if (!b) return void res.status(404).json({ error: 'no such blueprint' });
    if (b.logged) res.set({ 'Lake-Log-Index': String(b.logged.index), 'Lake-Log-Origin': b.logged.origin });
    res.type('text/markdown').send(b.text);
  });
  // What was put on the log for it, byte for byte: hand `entry` to the log's log.find to get the inclusion proof, and to
  // core's checkBlueprintRecord to check who signed the text.
  app.get('/blueprints/:name/record', (req, res) => {
    const b = blueprints.get(String(req.params.name));
    if (!b?.record) return void res.status(404).json({ error: b ? 'this blueprint has no signed record here (published before blueprints were logged)' : 'no such blueprint' });
    res.json({ name: b.name, version: b.version, author: b.author, at: b.at, ...(b.logged ? { logged: b.logged } : {}), entry: b.record });
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
  // Whether each followed Lake answers, and since when: said on the feed when it changes, shown on /state and on its cards
  // in /cards (run 48: a peer was dark for three minutes, its houses still counted, and nobody was told).
  const peerHealth = new Map<string, { answering: boolean; since: string; fails: number }>();
  const peerSays = (peer: string, ok: boolean) => {
    const h = peerHealth.get(peer) ?? { answering: true, since: new Date().toISOString(), fails: 0 };
    h.fails = ok ? 0 : h.fails + 1;
    // Two misses in a row (about ten seconds) before calling it down: one slow answer isn't an outage.
    const answering = ok || (h.answering && h.fails < 2);
    if (answering !== h.answering) {
      publish(makeEvent('lake.status', o.url, undefined, { lake: peer, answering, since: answering ? h.since : new Date().toISOString() }));
      h.answering = answering;
      h.since = new Date().toISOString();
    }
    peerHealth.set(peer, h);
  };
  async function syncPeer(peer: string) {
    let listed: { card: AgentCard }[];
    try {
      const r = await fetch(`${peer}/cards`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(String(r.status));
      listed = (await r.json()) as { card: AgentCard }[];
    } catch {
      return peerSays(peer, false);
    }
    peerSays(peer, true);
    try {
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
  let counters = zeroCounters();
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
