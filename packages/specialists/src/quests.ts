import { readFile, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { cardUrlFor, verifyLakeCard, type AgentCard, type LakeEvent, type LakeProfile } from '@thelakeprotocol/core';
import { fromNode } from './net.js';
import { specialist, type SpecialistOptions, type Specialist } from './review.js';

interface Quest { id: string; title: string; how: string }

const HOUSE: Quest[] = [
  { id: 'open-the-door', title: 'Open the door', how: 'Run a house and join the sandbox: docker run … lake-house --relay. No ports to open.' },
  { id: 'say-no', title: 'Say no', how: 'Let your rules decline someone. The swarm\'s marketing agents knock all the time.' },
  { id: 'say-yes', title: 'Say yes', how: 'Let a rule you wrote join a request on its own. A GP asking for medications is the classic.' },
  { id: 'strength-in-numbers', title: 'Strength in numbers', how: 'Counter as part of a bloc. Turn on bargaining (join_collectives) and wait for the sponsor\'s next study.' },
  { id: 'owner-in-the-loop', title: 'Owner in the loop', how: 'Answer a request yourself in the control panel: a rule that says "ask me" sends one there.' },
  { id: 'answer-a-study', title: 'Answer a study', how: 'Join a certified study. It runs inside your house; your true answer leaves only as two unreadable pieces, and the researcher sees only totals.' },
  { id: 'hold-the-door', title: 'Hold the door', how: 'Block an attack. Ask the sparring partner for a bout, or tag your house "sparring".' },
  { id: 'take-it-back', title: 'Take it back', how: 'Revoke a key in the control panel.' },
  { id: 'find-your-people', title: 'Find your people', how: 'Share an interest tag with other houses until a guild forms.' },
];

const AGENT: Quest[] = [
  { id: 'first-knock', title: 'First knock', how: 'Send a signed offer to any house. The guide\'s tour has one ready to send.' },
  { id: 'got-a-no', title: 'Take no for an answer', how: 'Get declined. Ask for marketing; nobody here wants it.' },
  { id: 'got-a-yes', title: 'Get a yes', how: 'Make an offer some house\'s rules accept.' },
  { id: 'haggled', title: 'Haggled', how: 'Get a counter-offer. Lowball a research study and the bloc pushes back.' },
  { id: 'ethics-approved', title: 'Above board', how: 'Get a study protocol approved by the ethics agent.' },
  { id: 'certified', title: 'Certified', how: 'Get a study certified by the auditor.' },
  { id: 'answered', title: 'Ask the Lake', how: 'Finish a study and report its answer: lake dispatch, or the MCP tool lake_dispatch_study.' },
  { id: 'paid-up', title: 'Paid up', how: 'Pay the houses in a study under a human\'s AP2 mandate.' },
  { id: 'inspected', title: 'Passed inspection', how: 'Ask the inspector to check your agent (or your house).' },
  { id: 'sparred', title: 'Sparring partner', how: 'Ask the sparring partner for a bout with any house.' },
  // Things agents do with each other, not just with houses.
  { id: 'made-contact', title: 'Made contact', how: 'Send a signed message to another visiting agent (lake_search finds them; lake_ask sends).' },
  { id: 'paid-an-agent', title: 'Settled up', how: 'Pay another agent for a deal you made: lake_pay, in dollars or any unit you both agreed on.' },
  { id: 'inventor', title: 'Inventor', how: 'Publish a blueprint of your own: a game, a market, a pact. lake_publish_blueprint.' },
];

type Reply =
  | { kind: 'progress'; who: string; track: 'house' | 'agent'; done: number; of: number; quests: (Quest & { done: boolean })[]; badge?: string; next?: string }
  | { kind: 'leaderboard'; top: { who: string; label: string; done: number; of: number }[] }
  | { kind: 'quests'; house: Quest[]; agent: Quest[]; ask: string };

/**
 * Quests: small things to try in the sandbox, checked against what actually happened on the Lake (the
 * node's public event stream: ids, kinds and counts only). Finish a track and get a signed badge.
 */
export async function createQuests(o: SpecialistOptions & { nodeUrl: string; dataDir: string }): Promise<Specialist> {
  const file = `${o.dataDir}/quests.json`;
  const done = new Map<string, Set<string>>(Object.entries(JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, string[]>).map(([k, v]) => [k, new Set(v)]));
  const labels = new Map<string, string>();
  const domains = new Map<string, string>(); // registered agent id → its domain
  const visitors = new Set<string>(); // agent:<domain> of visiting agents (not specialists)
  let dirty = false;
  const mark = (who: string | undefined, quest: string) => {
    if (!who || !quest) return;
    const set = done.get(who) ?? new Set<string>();
    if (!set.has(quest)) { set.add(quest); done.set(who, set); dirty = true; }
  };
  setInterval(() => { if (dirty) { dirty = false; void writeFile(file, JSON.stringify(Object.fromEntries([...done].map(([k, v]) => [k, [...v]])))); } }, 15_000).unref();

  const seen = new Set<string>();
  const on = (e: LakeEvent) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    if (seen.size > 5000) seen.clear();
    const d = e.data ?? {};
    const house = e.actor.startsWith('house:') ? e.actor : undefined;
    const visitor = e.subject?.startsWith('agent:') ? e.subject : undefined;
    switch (e.kind) {
      case 'house.joined': mark(house, 'open-the-door'); break;
      case 'attack.blocked': mark(house, 'hold-the-door'); break;
      case 'approval.answered': mark(house, 'owner-in-the-loop'); break;
      case 'compute.done': mark(house, 'answer-a-study'); break;
      case 'grant.revoked': mark(house, 'take-it-back'); break;
      case 'knock': {
        // A house's report doesn't say who knocked; the agent's own report says it knocked, and what it was told.
        const from = domains.has(e.actor) ? `agent:${domains.get(e.actor)}` : visitor;
        mark(from, 'first-knock');
        if (domains.has(e.actor)) mark(from, { decline: 'got-a-no', join: 'got-a-yes', counter: 'haggled' }[String(d.decision ?? '')] ?? '');
        break;
      }
      // A bloc countering an agent's study is haggling, whoever reports it.
      case 'counter': mark(domains.has(e.actor) ? `agent:${domains.get(e.actor)}` : undefined, 'haggled'); break;
      case 'study.result': mark(domains.has(e.actor) ? `agent:${domains.get(e.actor)}` : undefined, 'answered'); break;
      case 'blueprint.published': mark(domains.has(e.actor) ? `agent:${domains.get(e.actor)}` : undefined, 'inventor'); break;
      case 'agent.message': {
        const from = domains.has(e.actor) ? `agent:${domains.get(e.actor)}` : undefined;
        if (d.kind === 'payment') mark(from, 'paid-an-agent');
        else if (visitor && visitors.has(visitor)) mark(from, 'made-contact');
        break;
      }
      case 'decision': {
        const x = String(d.decision ?? '');
        if (house) {
          mark(house, { decline: 'say-no', join: 'say-yes', counter: 'strength-in-numbers' }[x] ?? '');
          mark(visitor, { decline: 'got-a-no', join: 'got-a-yes', counter: 'haggled' }[x] ?? '');
        } else {
          // Reported by a specialist about whoever asked it.
          mark(visitor, { approved: 'ethics-approved', certified: 'certified', settled: 'paid-up', report: 'inspected', sparred: 'sparred' }[x] ?? '');
        }
        break;
      }
    }
  };
  const learn = (p: { id: string; label: string; domain: string; role: string }) => {
    labels.set(p.id, p.label);
    if (p.role !== 'house') { domains.set(p.id, p.domain); labels.set(`agent:${p.domain}`, p.label); }
    if (p.role === 'visitor') visitors.add(`agent:${p.domain}`);
  };

  // Follow the node's public stream, reconnecting if it drops.
  const follow = () => {
    const ws = new WebSocket(`${o.nodeUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/events`);
    ws.on('message', (raw) => {
      try {
        const w = JSON.parse(String(raw));
        if (w.type === 'snapshot') { w.participants.forEach(learn); w.recent.forEach((l: { event: LakeEvent }) => on(l.event)); }
        if (w.type === 'event') { if (w.participant) learn(w.participant); on(w.event); }
      } catch {
        // not for us
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => setTimeout(follow, 5000).unref());
  };
  follow();

  const badges = new Map<string, string>();
  const s: Specialist = await specialist<Reply>(o, 'Quests', 'Things to try in the sandbox, checked against what actually happened on the Lake. Finish a track, get a signed badge. Send { kind: "quests" }, { kind: "progress", who } or { kind: "leaderboard" }.', 'quests', async (p, _from, caller) => {
    if (p.kind === 'quests') return { kind: 'quests', house: HOUSE, agent: AGENT, ask: 'send { kind: "progress", who: "<your house URL, an agent\'s domain, or a map id>" }; leave out who for yourself' };
    if (p.kind === 'leaderboard') {
      const top = [...done].map(([who, set]) => ({ who, label: labels.get(who) ?? who, done: set.size, of: who.startsWith('house:') ? HOUSE.length : AGENT.length }))
        .sort((a, b) => b.done / b.of - a.done / a.of || b.done - a.done).slice(0, 10);
      return { kind: 'leaderboard', top };
    }
    if (p.kind !== 'progress') return { kind: 'refused', problems: ['send { kind: "quests" }, { kind: "progress", who } or { kind: "leaderboard" }'] };
    let who: string;
    try {
      who = await resolve(typeof p.who === 'string' ? p.who : undefined, caller);
    } catch (e) {
      return { kind: 'refused', problems: [(e as Error).message] };
    }
    const track = who.startsWith('house:') ? 'house' : 'agent';
    const list = track === 'house' ? HOUSE : AGENT;
    const mine = done.get(who) ?? new Set<string>();
    if (track === 'house' && !mine.has('find-your-people')) {
      // Guilds are a live fact, not an event: ask the node which tags have one and whether this house shares one.
      const [state, cards] = await Promise.all([fromNode<{ guilds: { tag: string }[] }>(o.nodeUrl, '/state'), fromNode<{ id: string; card: AgentCard }[]>(o.nodeUrl, '/cards?role=house')]);
      const tags = (cards?.find((c) => c.id === who)?.card.capabilities?.extensions?.[0]?.params as { tags?: string[] } | undefined)?.tags ?? [];
      if (state?.guilds.some((g) => tags.includes(g.tag))) mark(who, 'find-your-people');
      if (cards?.some((c) => c.id === who)) mark(who, 'open-the-door');
    }
    const quests = list.map((q) => ({ ...q, done: mine.has(q.id) }));
    const n = quests.filter((q) => q.done).length;
    let badge = badges.get(who);
    if (!badge && n === list.length) {
      badge = await s.vc('LakeBadge', { id: who, badge: track === 'house' ? 'Sandbox housekeeper' : 'Sandbox explorer', quests: list.map((q) => q.id) }, 3650);
      badges.set(who, badge);
    }
    return { kind: 'progress', who, track, done: n, of: list.length, quests, badge, next: quests.find((q) => !q.done)?.how };
  });
  return s;

  /** A map id, a house or agent URL (its card is fetched and verified), a domain, or (nothing) the caller. */
  async function resolve(who: string | undefined, caller: LakeProfile): Promise<string> {
    const idOf = (pr: LakeProfile) => (pr.role === 'house' ? `house:${pr.publicJwk.kid!.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}` : `agent:${pr.ownerDomain}`);
    if (!who) return idOf(caller);
    if (/^(house|agent):/.test(who)) return who;
    if (/^https?:\/\//.test(who)) {
      const base = who.replace(/\/$/, '');
      const url = base.endsWith('/a2a') ? cardUrlFor(base) : `${base}/.well-known/agent-card.json`;
      const listed = await fromNode<{ card: AgentCard }[]>(o.nodeUrl, '/cards');
      // Only cards the node already verified and lists: the quests agent doesn't fetch arbitrary URLs.
      const card = listed?.find((l) => l.card.supportedInterfaces[0]?.url.replace(/\/$/, '') === base || cardUrlFor(l.card.supportedInterfaces[0]?.url ?? '') === url)?.card;
      if (!card) throw new Error(`the sandbox node doesn't list ${who}; join first, or give a map id like house:abcd1234`);
      return idOf(await verifyLakeCard(card));
    }
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(who)) return `agent:${who.toLowerCase()}`;
    throw new Error('who: a house URL, an agent\'s domain, or a map id like house:abcd1234');
  }
}
