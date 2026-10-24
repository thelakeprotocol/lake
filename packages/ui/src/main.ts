import QRCode from 'qrcode';
import './style.css';

// The live Lake: the same picture as the simulation on the website, but every square, dot and thread
// is a real event from a Lake node's stream. The stream carries ids, kinds and counts only.

interface LakeEvent { id: string; kind: string; at: string; actor: string; subject?: string; data?: Record<string, string | number | boolean> }
interface Participant { id: string; role: string; label: string; tags: string[]; domain?: string; skills?: string[] }
interface Counters { houses: number; agents: number; conversations: number; valueSettled: number; attacksBlocked: number; recordsMoved: number }
type Wire =
  | { type: 'snapshot'; node: string; sandbox: boolean; approvalsUrl?: string; guilds?: { tag: string }[]; participants: Participant[]; counters: Counters; recent: { event: LakeEvent; text: string }[] }
  | { type: 'event'; event: LakeEvent; text: string; counters: Counters; participant?: Participant }
  | { type: 'reset' };

const COL = { ink: '#070B12', mint: '#3DDC97', orange: '#FF6A2B', violet: '#9D8FFF', threat: '#FF4D6A', muted: '#8B9BAE', fg: '#E6EDF2', amber: '#F5C451', sky: '#59C3FF', gold: '#FFE08A' };
const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface House { id: string; label: string; nx: number; ny: number; hx: number; hy: number; group?: string; born: number; resp: '' | 'join' | 'decline' | 'ask' | 'counter'; respT: number; alert: number; leaving: number; phase: number; computedT: number; tags: string[] }
interface Spec { id: string; label: string; nx: number; ny: number; domain?: string }
interface Agent { id: string; domain: string; label: string; x: number; y: number; trail: { x: number; y: number }[]; seen: number; goto?: { x: number; y: number; until: number } }
interface Visitor { id: string; x: number; y: number; vx: number; vy: number; bad: boolean; target: House | null; seen: number; q: number }
interface Thread { ax: number; ay: number; h: House; life: number; col: string }
interface Ripple { x: number; y: number; r: number; max: number; col: string; w: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }
/** An agent that quotes (a `*-quote` skill): docked on the right edge, sending its program into homes. */
interface Dock { id: string; domain: string; label: string; ny: number; pulse: number }
/** Houses sharing an intent's terms, gathered round one spot. The node says which group, never what anyone was offered. */
interface Group { key: string; label: string; cx: number; cy: number; order: string[] }
/** A quote program on its way into a house (t 0→1), then nothing coming back (t 1→2). */
interface Bolt { d: Dock; h: House; t: number }
interface Accepted { h: House; d: Dock; t: number; released: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), cv = $<HTMLCanvasElement>('lake'), ctx = cv.getContext('2d')!;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let W = 800, H = 500, clock = 0;

const houses = new Map<string, House>();
const specs = new Map<string, Spec>();
const visitors = new Map<string, Visitor>();
/** Dispatched agents (registered visitors), drawn orange. Keyed by id; also found by `agent:<domain>`. */
const agents = new Map<string, Agent>();
const agentByLabel = (s?: string) => [...agents.values()].find((a) => s === `agent:${a.domain}` || s === a.id);
let threads: Thread[] = [];
let ripples: Ripple[] = [];
let sparks: Spark[] = [];
/** The bargaining moment: the old price struck through, the bloc's price beside it. */
/** Guilds: houses sharing a tag, linked in violet. */
const guilds: { tag: string; born: number }[] = [];
let haggle: { was: number; price: number; t: number; at: Agent } | null = null;
/** Words that float up from a spot for a few seconds: an invention's name, a payment, a message kind. */
let floats: { x: number; y: number; text: string; col: string; t: number; big?: boolean }[] = [];
let invented = 0;
/** Where an agent rests: its own spot on a ring round the middle, so several agents don't stack up. */
const home = (ag: Agent) => {
  // Spread by arrival order round the ring (similar ids would land side by side), nudged by the id so it's stable.
  const i = [...agents.keys()].indexOf(ag.id), n = Math.max(agents.size, 4);
  const a = ((i < 0 ? hash(ag.id) * n : i) / n) * 6.283 + 0.4, r = Math.min(W, H) * 0.22;
  return { x: W / 2 + Math.cos(a) * r * 1.6, y: H / 2 + Math.sin(a) * r };
};
/** Any agent or specialist by its `agent:<domain>` label. */
const spot = (label?: string) => {
  const ag = agentByLabel(label);
  if (ag) return { x: ag.x, y: ag.y };
  const sp = [...specs.values()].find((x) => `agent:${x.domain}` === label);
  return sp ? { x: sp.nx * W, y: sp.ny * H } : null;
};
const docks = new Map<string, Dock>();
const dockByLabel = (s?: string) => [...docks.values()].find((d) => s === `agent:${d.domain}` || s === d.id);
const groups = new Map<string, Group>();
let bolts: Bolt[] = [];
let accepts: Accepted[] = [];
/** Each house and quoter once: a quote sent again (after a timeout, say) replaces the first. */
const quoted = new Set<string>();
/** The right edge belongs to docks; houses and specialists keep left of it. */
const DOCK_X = 0.955, HOUSE_MAX_X = 0.86;
const GROUP_SLOTS: [number, number][] = [[0.27, 0.46], [0.45, 0.46], [0.63, 0.46], [0.33, 0.77], [0.51, 0.77], [0.69, 0.77], [0.09, 0.52], [0.79, 0.5]];

function resize() {
  const r = stage.getBoundingClientRect();
  W = Math.max(200, r.width); H = Math.max(160, r.height);
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.ink; ctx.fillRect(0, 0, W, H);
}
resize();
new ResizeObserver(resize).observe(stage);

/** Deterministic spot per id, nudged away from neighbours, so a house is always in the same place. */
function place(id: string, avoid: { nx: number; ny: number }[]) {
  let s = hash(id);
  // Few houses get room to breathe (and readable labels); a crowded Lake packs tighter.
  const gap = avoid.length < 40 ? 90 : avoid.length < 200 ? 40 : 22;
  for (let i = 0; i < 60; i++) {
    const nx = 0.05 + (HOUSE_MAX_X - 0.05) * (s % 1), ny = 0.1 + 0.75 * ((s * 7.31) % 1);
    const underQr = !$('qr').hidden && nx * W > W - 190 && ny * H < 200; // keep clear of the QR card
    if (!underQr && avoid.every((o) => Math.hypot((o.nx - nx) * W, (o.ny - ny) * H) > gap)) return { nx, ny };
    s = hash(id + i);
  }
  return { nx: 0.05 + (HOUSE_MAX_X - 0.05) * (s % 1), ny: 0.1 + 0.75 * ((s * 7.31) % 1) };
}

function addParticipant(p: Participant, fresh: boolean) {
  if (p.role === 'house') {
    if (houses.has(p.id)) return;
    const pos = place(p.id, [...houses.values(), ...specs.values()]);
    houses.set(p.id, { id: p.id, label: p.label, ...pos, hx: pos.nx, hy: pos.ny, born: fresh ? clock : -10, resp: '', respT: 0, alert: 0, leaving: 0, phase: hash(p.id) * 6.28, computedT: -99, tags: p.tags ?? [] });
  } else if (p.role === 'visitor') {
    if (agents.has(p.id)) return;
    agents.set(p.id, { id: p.id, domain: p.domain ?? '', label: p.label, x: W / 2, y: H / 2, trail: [], seen: clock });
  } else if ((p.role === 'specialist' || p.role === 'agent') && p.skills?.some((k) => k.endsWith('-quote'))) {
    if (docks.has(p.id)) return;
    docks.set(p.id, { id: p.id, domain: p.domain ?? '', label: p.label, ny: 0, pulse: -9 });
    // Spread evenly down the right edge, in the order they arrived.
    const all = [...docks.values()];
    all.forEach((d, i) => { d.ny = all.length === 1 ? 0.5 : 0.1 + (0.72 * i) / (all.length - 1); });
  } else if (p.role === 'specialist' || p.role === 'agent') {
    if (specs.has(p.id)) return;
    // Round the edge of the Lake, left of the docks; a sandbox has ten specialists.
    const slots = [[0.16, 0.26], [0.78, 0.26], [0.84, 0.8], [0.17, 0.8], [0.47, 0.16], [0.31, 0.11], [0.63, 0.11], [0.05, 0.5], [0.47, 0.86], [0.05, 0.16]];
    const [nx, ny] = slots[specs.size % slots.length]!;
    specs.set(p.id, { id: p.id, label: p.label.replace(/\s*\(.*\)$/, ''), nx: nx!, ny: ny!, domain: p.domain });
  }
}

function visitor(id: string, bad = false): Visitor {
  let v = visitors.get(id);
  if (!v) {
    const edge = hash(id);
    const x = edge < 0.5 ? (edge < 0.25 ? 2 : W - 2) : rand(0, W), y = edge >= 0.5 ? (edge < 0.75 ? 2 : H - 2) : rand(0, H);
    v = { id, x, y, vx: rand(-20, 20), vy: rand(-20, 20), bad, target: null, seen: clock, q: 0 };
    visitors.set(id, v);
  }
  v.seen = clock;
  if (bad) v.bad = true;
  return v;
}

/** "region=qld;price_band=450000-599999;first_time_buyer=yes" → "QLD · 450k–600k · first time buyer": any pack's terms, read generically. */
function groupLabel(key: string) {
  const k = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  return key.split(';').map((kv) => {
    const [name = '', v = ''] = kv.split('=');
    const range = v.match(/^(\d+)-(\d+)$/);
    if (range) return `${k(Number(range[1]))}–${k(Number(range[2]) + 1)}`;
    if (v === 'yes') return name.replace(/_/g, ' ');
    if (v === 'no') return `not ${name.replace(/_/g, ' ')}`;
    if (v === 'any') return '';
    return v.length <= 3 ? v.toUpperCase() : v.replace(/[-_]/g, ' ');
  }).filter(Boolean).join(' · ');
}

/** A house joins a group: it drifts to the group's spot, packed in a sunflower spiral round the centre. */
function joinGroup(h: House, key: string) {
  if (h.group === key) return;
  leaveGroup(h);
  let g = groups.get(key);
  if (!g) {
    // Fixed spots, clear of the specialists and the docks, taken in the order groups appear; more groups than spots overlap.
    const slot = GROUP_SLOTS.find(([cx, cy]) => ![...groups.values()].some((o) => o.cx === cx && o.cy === cy)) ?? GROUP_SLOTS[groups.size % GROUP_SLOTS.length]!;
    g = { key, label: groupLabel(key), cx: slot[0], cy: slot[1], order: [] };
    groups.set(key, g);
  }
  g.order.push(h.id);
  h.group = key;
}
function leaveGroup(h: House) {
  const g = h.group ? groups.get(h.group) : undefined;
  if (g) { g.order = g.order.filter((id) => id !== h.id); if (!g.order.length) groups.delete(g.key); }
  h.group = undefined;
}
/** Where a house should be: its own spot, or its place in its group's spiral. */
function target(h: House) {
  const g = h.group ? groups.get(h.group) : undefined;
  if (!g) return { x: h.hx, y: h.hy };
  const i = g.order.indexOf(h.id), r = 15 * Math.sqrt(i + 0.5), a = i * 2.39996;
  return { x: g.cx + (r * Math.cos(a)) / W, y: g.cy + (r * Math.sin(a)) / H };
}

function onEvent(e: LakeEvent, p?: Participant) {
  const h = houses.get(e.actor);
  const at = (x: House) => ({ x: x.nx * W, y: x.ny * H });
  switch (e.kind) {
    case 'house.joined':
    case 'agent.registered':
      if (p) addParticipant(p, true);
      break;
    case 'house.left':
      if (h) h.leaving = clock;
      break;
    case 'knock': {
      const ag = agents.get(e.actor);
      if (ag && e.data?.count === undefined) {
        // One knock, reported by the agent itself without the house: a pulse at the agent.
        ag.seen = clock;
        ripples.push({ x: ag.x, y: ag.y, r: 4, max: 40, col: COL.orange, w: 1.5 });
        break;
      }
      if (ag) {
        // A broadcast: one offer to every house that advertises the skill.
        ag.seen = clock;
        ripples.push({ x: ag.x, y: ag.y, r: 4, max: Math.hypot(W, H) * 0.7, col: COL.orange, w: 2 });
        for (const x of houses.values()) if (Math.random() < 0.6) threads.push({ ax: ag.x, ay: ag.y, h: x, life: 0.9, col: COL.orange });
        break;
      }
      if (h && agentByLabel(e.subject)) break; // the broadcast already drew it
      if (h && e.subject) {
        const v = visitor(e.subject);
        v.target = h;
        threads.push({ ax: v.x, ay: v.y, h, life: 1, col: COL.muted });
      } else if (h) {
        // Nodes don't say who knocked (SPEC §8): the house lights up, nobody is drawn at its door.
        const { x, y } = at(h);
        ripples.push({ x, y, r: 3, max: 26, col: COL.muted, w: 1.5 });
      }
      break;
    }
    case 'agent.quarantined': {
      const v = e.subject ? visitors.get(e.subject) : undefined;
      if (v) { v.q = clock; v.bad = true; ripples.push({ x: v.x, y: v.y, r: 4, max: 60, col: COL.threat, w: 2 }); }
      break;
    }
    case 'guild.formed': {
      const tag = String(e.data?.tag ?? '');
      const g = guilds.find((x) => x.tag === tag);
      if (g) g.born = clock; else guilds.push({ tag, born: clock });
      break;
    }
    case 'grant.revoked':
      if (h) {
        // Keys pulled: every line into this house snaps.
        const { x, y } = at(h);
        threads = threads.filter((t) => t.h !== h);
        for (let i = 0; i < 22; i++) sparks.push({ x, y, vx: rand(-110, 110), vy: rand(-110, 110), life: 1 });
        ripples.push({ x, y, r: 4, max: 110, col: COL.fg, w: 2 });
        h.resp = '';
      }
      break;
    case 'approval.answered':
      if (h) { const { x, y } = at(h); ripples.push({ x, y, r: 4, max: 80, col: e.data?.answer === 'Allow' ? COL.mint : COL.muted, w: 2 }); h.resp = e.data?.answer === 'Allow' ? 'join' : 'decline'; h.respT = clock; }
      break;
    case 'grant.issued':
      if (h) { const { x, y } = at(h); ripples.push({ x, y, r: 4, max: 40, col: COL.mint, w: 1.5 }); }
      break;
    case 'counter': {
      const ag = agents.get(e.actor);
      if (ag) haggle = { was: Number(e.data?.was), price: Number(e.data?.price), t: clock, at: ag };
      break;
    }
    case 'payment.settled': {
      const from = specs.get(e.actor);
      if (from) for (const x of houses.values()) if (clock - x.computedT < 60) threads.push({ ax: from.nx * W, ay: from.ny * H, h: x, life: 1.2, col: COL.violet });
      break;
    }
    case 'compute.done': {
      if (h) h.computedT = clock;
      const ag = agentByLabel(e.subject);
      if (h && ag) threads.push({ ax: ag.x, ay: ag.y, h, life: 1, col: COL.mint });
      break;
    }
    case 'agent.message': {
      // Agents talking to each other: a line from one to the other, the kind of message (never its content), and money in gold.
      const from = agents.get(e.actor), to = spot(e.subject);
      if (!from) break;
      // A deal reported without its counterparty: a glow at the dealer, never a line to whom.
      if (!e.subject) {
        from.seen = clock;
        const pay = e.data?.kind === 'payment';
        ripples.push({ x: from.x, y: from.y, r: 4, max: 34, col: pay ? COL.gold : COL.sky, w: 2 });
        floats.push({ x: from.x, y: from.y - 18, text: pay ? (!e.data?.unit || e.data.unit === 'USD' ? `$${e.data?.amount}` : `${e.data?.amount} ${e.data?.unit}`) : '', col: pay ? COL.gold : COL.sky, t: clock, big: pay });
        break;
      }
      if (!to) break;
      from.seen = clock;
      const pay = e.data?.kind === 'payment';
      const tx = { x: to.x, y: to.y, nx: to.x / W, ny: to.y / H } as unknown as House;
      threads.push({ ax: from.x, ay: from.y, h: tx, life: pay ? 1.6 : 1, col: pay ? COL.gold : COL.sky });
      const what = pay ? (!e.data?.unit || e.data.unit === 'USD' ? `$${e.data?.amount}` : `${e.data?.amount} ${e.data?.unit}`) : String(e.data?.kind ?? '');
      floats.push({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 6, text: what, col: pay ? COL.gold : COL.sky, t: clock, big: pay });
      break;
    }
    case 'blueprint.published': {
      invented++;
      const by = agents.get(e.actor) ?? specs.get(e.actor);
      const x = by ? ('x' in by ? by.x : by.nx * W) : W / 2, y = by ? ('y' in by ? by.y : by.ny * H) : H / 2;
      for (let i = 0; i < 26; i++) sparks.push({ x, y, vx: rand(-90, 90), vy: rand(-90, 90), life: 1.2 });
      ripples.push({ x, y, r: 4, max: 140, col: COL.mint, w: 3 });
      floats.push({ x, y: y - 28, text: `invented: ${e.data?.name}`, col: COL.mint, t: clock, big: true });
      break;
    }
    case 'study.result': {
      const ag = agents.get(e.actor);
      if (ag) { ag.seen = clock; ripples.push({ x: ag.x, y: ag.y, r: 4, max: 120, col: COL.mint, w: 3 }); }
      break;
    }
    case 'decision':
      if (!h && specs.has(e.actor)) {
        // A specialist approved, certified or settled for this agent: the agent goes to it, as in the simulation.
        const sp = specs.get(e.actor)!, ag = agentByLabel(e.subject);
        if (ag) { ag.goto = { x: sp.nx * W, y: sp.ny * H, until: clock + 1.6 }; ag.seen = clock; }
        break;
      }
      if (h) {
        h.resp = String(e.data?.decision ?? '') as House['resp'];
        h.respT = clock;
        const v = e.subject ? visitors.get(e.subject) ?? agentByLabel(e.subject) : undefined;
        const col = h.resp === 'join' ? COL.mint : h.resp === 'ask' ? COL.amber : h.resp === 'counter' ? COL.violet : COL.muted;
        if (v) threads.push({ ax: v.x, ay: v.y, h, life: 1, col });
      }
      break;
    case 'approval.requested':
      if (h) { const { x, y } = at(h); ripples.push({ x, y, r: 4, max: 70, col: COL.amber, w: 1.5 }); }
      break;
    case 'intent.opened':
      // In a sandbox the node names the house; in production only 'lake' asks, and nobody moves.
      if (h && e.data?.group) {
        joinGroup(h, String(e.data.group));
        const { x, y } = at(h);
        ripples.push({ x, y, r: 4, max: 45, col: COL.sky, w: 1.5 });
      }
      break;
    case 'quote.made': {
      quoted.add(`${e.actor}|${e.subject}`);
      const d = dockByLabel(e.subject);
      if (h && d) { bolts.push({ d, h, t: 0 }); d.pulse = clock; }
      break;
    }
    case 'offer.accepted': {
      const d = dockByLabel(e.subject);
      if (h && d) {
        accepts.push({ h, d, t: clock, released: Number(e.data?.released ?? 0) });
        const { x, y } = at(h);
        ripples.push({ x, y, r: 4, max: 120, col: COL.gold, w: 2.5 });
      }
      break;
    }
    case 'attack.blocked': {
      const v = e.subject ? visitor(e.subject, true) : null;
      if (h) {
        h.alert = 1;
        const { x, y } = at(h);
        ripples.push({ x, y, r: 4, max: 150, col: COL.threat, w: 2 });
        if (v) { v.target = h; threads.push({ ax: v.x, ay: v.y, h, life: 1, col: COL.threat }); }
        // The house's alarm reaches its neighbours.
        for (const o of houses.values()) if (o !== h && Math.hypot((o.nx - h.nx) * W, (o.ny - h.ny) * H) < 150) o.alert = Math.max(o.alert, 0.7);
      } else {
        ripples.push({ x: W / 2, y: H / 2, r: 4, max: Math.min(W, H) / 2, col: COL.threat, w: 1.5 });
      }
      break;
    }
  }
}

function update(dt: number) {
  clock += dt;
  for (const [id, ag] of agents) {
    // Agents can think quietly for a while; they leave the map only after a long silence.
    if (clock - ag.seen > 900) { agents.delete(id); continue; }
    const to = ag.goto && clock < ag.goto.until ? ag.goto : home(ag);
    ag.x += (to.x - ag.x) * Math.min(1, dt * 2.5);
    ag.y += (to.y - ag.y) * Math.min(1, dt * 2.5);
    ag.trail.push({ x: ag.x, y: ag.y });
    if (ag.trail.length > 28) ag.trail.shift();
  }
  for (const [id, v] of visitors) {
    if (clock - v.seen > 40 || (v.q && clock - v.q > 16)) { visitors.delete(id); continue; }
    if (v.q) { v.vx *= 0.96; v.vy *= 0.96; v.x += v.vx * dt; v.y += v.vy * dt; continue; }
    if (v.target && !houses.has(v.target.id)) v.target = null;
    if (v.target) {
      const tx = v.target.nx * W, ty = v.target.ny * H, dx = tx - v.x, dy = ty - v.y, d = Math.hypot(dx, dy) || 1;
      if (d > 30) { v.vx += (dx / d) * 40 * dt; v.vy += (dy / d) * 40 * dt; } else v.target = null;
    }
    v.vx += rand(-30, 30) * dt; v.vy += rand(-30, 30) * dt;
    const sp = Math.hypot(v.vx, v.vy), max = v.bad ? 60 : 44;
    if (sp > max) { v.vx *= max / sp; v.vy *= max / sp; }
    v.x = Math.min(W, Math.max(0, v.x + v.vx * dt)); v.y = Math.min(H, Math.max(0, v.y + v.vy * dt));
  }
  for (const [id, h] of houses) {
    const to = target(h);
    h.nx += (to.x - h.nx) * Math.min(1, dt * 1.4);
    h.ny += (to.y - h.ny) * Math.min(1, dt * 1.4);
    h.alert = Math.max(0, h.alert - dt * 0.22);
    if (h.resp && clock - h.respT > 12) h.resp = '';
    if (h.leaving && clock - h.leaving > 2) { leaveGroup(h); houses.delete(id); }
  }
  bolts = bolts.filter((b) => houses.has(b.h.id) && (b.t += dt * 1.1) < 2);
  accepts = accepts.filter((a) => houses.has(a.h.id));
  threads = threads.filter((t) => (t.life -= dt * 0.6) > 0);
  ripples = ripples.filter((r) => (r.r += dt * 160) < r.max);
  sparks = sparks.filter((p) => { p.life -= dt * 1.3; p.x += p.vx * dt; p.y += p.vy * dt; return p.life > 0; });
  floats = floats.filter((f) => clock - f.t < (f.big ? 6 : 2.2));
}

function draw(now: number) {
  ctx.fillStyle = reduced ? COL.ink : rgba(COL.ink, 0.42);
  ctx.fillRect(0, 0, W, H);
  guilds.forEach((g, gi) => {
    const members = [...houses.values()].filter((h) => h.tags.includes(g.tag));
    const pulse = 0.55 + 0.45 * Math.sin(now / 700 + gi);
    ctx.strokeStyle = rgba(COL.violet, 0.3 * pulse * Math.min(1, (clock - g.born) / 2)); ctx.lineWidth = 1;
    ctx.beginPath();
    for (const h of members) {
      const near = members.filter((o) => o !== h).sort((a, b) => Math.hypot(a.nx - h.nx, a.ny - h.ny) - Math.hypot(b.nx - h.nx, b.ny - h.ny)).slice(0, 2);
      for (const o of near) { ctx.moveTo(h.nx * W, h.ny * H); ctx.lineTo(o.nx * W, o.ny * H); }
    }
    ctx.stroke();
  });
  // Groups: a soft disc round the members, and what they share, in words.
  for (const g of groups.values()) {
    if (g.order.length < 2) continue;
    const x = g.cx * W, y = g.cy * H, r = 15 * Math.sqrt(g.order.length) + 18;
    ctx.fillStyle = rgba(COL.sky, 0.05); ctx.strokeStyle = rgba(COL.sky, 0.28); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = rgba(COL.sky, 0.95);
    ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
    const ly = g.cy > 0.6 ? y + r + 16 : y - r - 18;
    ctx.fillText(g.label.toUpperCase(), x, ly);
    ctx.fillStyle = rgba(COL.fg, 0.7);
    ctx.fillText(`${g.order.length} households`, x, ly + 13);
  }
  // Several owners may say yes at once; words on one line are enough.
  const labelled = accepts.find((a) => clock - a.t < 7);
  for (const a of accepts) {
    // One line, to one agent, only after its owner said yes.
    const hx = a.h.nx * W, hy = a.h.ny * H, dx = DOCK_X * W - 14, dy = a.d.ny * H, age = clock - a.t;
    const k = Math.min(1, age / 1.2);
    ctx.strokeStyle = rgba(COL.gold, 0.85); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + (dx - hx) * k, hy + (dy - hy) * k); ctx.stroke();
    if (a === labelled && a.released) {
      ctx.globalAlpha = Math.min(1, (7 - age) / 1.5);
      ctx.font = '500 12px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = COL.gold;
      ctx.fillText(`${a.released} files shared, after its owner said yes`, (hx + dx) / 2, (hy + dy) / 2 - 10);
      ctx.globalAlpha = 1;
    }
  }
  for (const b of bolts) {
    // In: the program, bright. Back: nothing, a faint dot.
    const sx = DOCK_X * W - 14, sy = b.d.ny * H, hx = b.h.nx * W, hy = b.h.ny * H;
    const k = b.t < 1 ? b.t : 2 - b.t, x = sx + (hx - sx) * k, y = sy + (hy - sy) * k;
    if (b.t < 1) {
      ctx.strokeStyle = rgba(COL.sky, 0.35); ctx.lineWidth = 1;
      const tk = Math.max(0, k - 0.12);
      ctx.beginPath(); ctx.moveTo(sx + (hx - sx) * tk, sy + (hy - sy) * tk); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = COL.sky; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.283); ctx.fill();
    } else {
      ctx.strokeStyle = rgba(COL.muted, 0.45 * (2 - b.t)); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 6.283); ctx.stroke();
    }
  }
  for (const t of threads) {
    ctx.strokeStyle = rgba(t.col, 0.6 * t.life); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(t.ax, t.ay); ctx.lineTo(t.h.nx * W, t.h.ny * H); ctx.stroke();
  }
  for (const r of ripples) {
    ctx.strokeStyle = rgba(r.col, 0.5 * (1 - r.r / r.max)); ctx.lineWidth = r.w;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.283); ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.font = '400 10px "IBM Plex Mono", ui-monospace, monospace';
  for (const h of houses.values()) {
    const x = h.nx * W, y = h.ny * H, age = clock - h.born;
    if (h.born > 0 && age < 1.6) { ctx.strokeStyle = rgba(COL.mint, 1 - age / 1.6); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6 + age * 30, 0, 6.283); ctx.stroke(); }
    const grow = h.born > 0 ? Math.min(1, age / 0.8) : 1;
    const fade = h.leaving ? Math.max(0, 1 - (clock - h.leaving) / 2) : 1;
    const s = (5 + Math.sin(now / 900 + h.phase) * 0.6) * grow;
    const fill = h.resp === 'join' ? COL.mint : h.resp === 'ask' ? COL.amber : h.resp === 'counter' ? COL.violet : h.resp === 'decline' ? rgba(COL.muted, 0.8) : rgba(COL.mint, 0.75);
    ctx.globalAlpha = fade;
    ctx.fillStyle = h.resp === 'decline' ? 'rgba(0,0,0,0)' : rgba(h.resp === 'ask' ? COL.amber : COL.mint, h.resp ? 0.3 : 0.12);
    ctx.beginPath(); ctx.arc(x, y, s * 2.6, 0, 6.283); ctx.fill();
    ctx.fillStyle = fill; ctx.fillRect(x - s, y - s, s * 2, s * 2);
    if (h.group) { ctx.strokeStyle = rgba(COL.sky, 0.8); ctx.lineWidth = 1.2; ctx.strokeRect(x - s - 2.5, y - s - 2.5, s * 2 + 5, s * 2 + 5); }
    if (h.alert > 0.05) { ctx.strokeStyle = rgba(COL.threat, h.alert * 0.9); ctx.lineWidth = 1.5; ctx.strokeRect(x - s - 3, y - s - 3, s * 2 + 6, s * 2 + 6); }
    if (houses.size <= 40 && !h.group) { ctx.fillStyle = rgba(COL.fg, 0.55); ctx.fillText(h.label.replace(/^House /, ''), x, y + s + 14); }
    ctx.globalAlpha = 1;
  }
  ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
  for (const sp of specs.values()) {
    const x = sp.nx * W, y = sp.ny * H, r = 9 + Math.sin(now / 600);
    ctx.fillStyle = rgba(COL.violet, 0.16); ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, 6.283); ctx.fill();
    ctx.fillStyle = COL.violet; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.fillText(sp.label.toUpperCase(), x, y + r + 16);
  }
  for (const d of docks.values()) {
    const x = DOCK_X * W, y = d.ny * H, glow = Math.max(0, 1 - (clock - d.pulse) / 0.8);
    ctx.fillStyle = rgba(COL.sky, 0.12 + 0.3 * glow); ctx.strokeStyle = COL.sky; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(x - 14, y - 9, 28, 18, 4); ctx.fill(); ctx.stroke();
    ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.fillStyle = rgba(COL.fg, 0.75);
    ctx.fillText(d.label.toUpperCase(), x - 22, y + 3.5);
  }
  if (quoted.size) {
    ctx.textAlign = 'left'; ctx.fillStyle = COL.sky;
    ctx.font = `700 ${Math.max(22, Math.min(40, W / 34))}px Oswald, "Arial Narrow", sans-serif`;
    ctx.fillText(quoted.size.toLocaleString('en-US'), 18, 44);
    ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = rgba(COL.fg, 0.75);
    ctx.fillText('OFFERS WORKED OUT INSIDE HOMES', 18, 62);
    if (accepts.length) { ctx.fillStyle = COL.gold; ctx.fillText(`${accepts.length} ACCEPTED`, 18, 78); }
  }
  ctx.textAlign = 'center';
  for (const v of visitors.values()) {
    if (v.q) {
      const fade = Math.max(0, 1 - (clock - v.q) / 16);
      ctx.strokeStyle = rgba(COL.threat, 0.7 * fade); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(v.x, v.y, 9, 0, 6.283); ctx.stroke();
      ctx.fillStyle = rgba(COL.threat, 0.5 * fade); ctx.beginPath(); ctx.arc(v.x, v.y, 2.5, 0, 6.283); ctx.fill();
      continue;
    }
    ctx.fillStyle = v.bad ? COL.threat : rgba(COL.muted, 0.85);
    ctx.beginPath(); ctx.arc(v.x, v.y, v.bad ? 3.4 : 2.2, 0, 6.283); ctx.fill();
  }
  if (haggle && clock - haggle.t < 4) {
    const size = Math.max(28, Math.min(64, W / 12)), x = haggle.at.x, y = haggle.at.y - 44;
    ctx.globalAlpha = Math.min(1, (4 - (clock - haggle.t)) * 2);
    ctx.font = `700 ${size}px Oswald, "Arial Narrow", sans-serif`; ctx.textAlign = 'center';
    ctx.fillStyle = rgba(COL.muted, 0.9); ctx.fillText(`$${haggle.was}`, x - size * 1.1, y);
    ctx.strokeStyle = COL.threat; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x - size * 1.6, y - size * 0.35); ctx.lineTo(x - size * 0.6, y - size * 0.35); ctx.stroke();
    if (clock - haggle.t > 0.6) { ctx.fillStyle = COL.mint; ctx.fillText(`$${haggle.price}`, x + size * 1.1, y); }
    ctx.globalAlpha = 1;
  }
  for (const p of sparks) { ctx.fillStyle = rgba(COL.fg, p.life); ctx.fillRect(p.x, p.y, 2, 2); }
  for (const f of floats) {
    const age = clock - f.t, life = f.big ? 6 : 2.2;
    ctx.globalAlpha = Math.min(1, (life - age) / 0.8, age * 4);
    ctx.textAlign = 'center'; ctx.fillStyle = f.col;
    ctx.font = f.big ? `700 ${Math.max(16, Math.min(26, W / 55))}px Oswald, "Arial Narrow", sans-serif` : '500 11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillText(f.big ? f.text.toUpperCase() : f.text, f.x, f.y - age * 8);
    ctx.globalAlpha = 1;
  }
  if (invented) {
    const y0 = quoted.size ? 100 : 44;
    ctx.textAlign = 'left'; ctx.fillStyle = COL.mint;
    ctx.font = `700 ${Math.max(22, Math.min(40, W / 34))}px Oswald, "Arial Narrow", sans-serif`;
    ctx.fillText(String(invented), 18, y0);
    ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = rgba(COL.fg, 0.75);
    ctx.fillText(`INVENTION${invented === 1 ? '' : 'S'} PUBLISHED HERE`, 18, y0 + 18);
  }
  for (const ag of agents.values()) {
    ctx.strokeStyle = rgba(COL.orange, 0.35); ctx.lineWidth = 2; ctx.beginPath();
    ag.trail.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    const rr = 12 + Math.sin(now / 180) * 2.5;
    ctx.strokeStyle = COL.orange; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ag.x, ag.y, rr, 0, 6.283); ctx.stroke();
    ctx.fillStyle = COL.orange; ctx.beginPath(); ctx.arc(ag.x, ag.y, 6, 0, 6.283); ctx.fill();
    // A moving label smears across the fading canvas; show it only when the agent is still.
    const to = ag.goto && clock < ag.goto.until ? ag.goto : home(ag);
    if (Math.hypot(to.x - ag.x, to.y - ag.y) < 8) {
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillText(ag.label.replace(/\s*\(.*\)$/, '').toUpperCase(), ag.x, ag.y + rr + 16);
    }
  }
}

// ---- Log and counters ----
const logEl = $('log');
const lines: { t: string; text: string; kind: string }[] = [];
const KIND_CLASS: Record<string, string> = { 'counter': 'mint', 'agreement.signed': '', 'grant.revoked': 'threat', 'approval.answered': 'mint', 'knock': '', 'offer': 'orange', 'compute.done': 'mint', 'grant.issued': 'mint', 'attack.blocked': 'threat', 'agent.quarantined': 'threat', 'record.moved': 'threat', 'house.joined': 'mint', 'agent.registered': 'violet', 'approval.requested': 'amber', 'guild.formed': 'violet', 'payment.settled': 'violet', 'study.result': 'mint', 'intent.opened': 'sky', 'offer.accepted': 'gold' };
function log(e: LakeEvent, text: string) {
  lines.unshift({ t: new Date(e.at).toLocaleTimeString([], { hour12: false }), text, kind: KIND_CLASS[e.kind] ?? (e.kind === 'decision' && e.data?.decision === 'join' ? 'mint' : '') });
  lines.length = Math.min(lines.length, 5);
  logEl.replaceChildren(...lines.map((l) => {
    const li = document.createElement('li');
    const time = document.createElement('time'); time.textContent = l.t;
    const span = document.createElement('span'); span.textContent = l.text; if (l.kind) span.className = `k-${l.kind}`;
    li.append(time, span);
    return li;
  }));
}
function counters(c: Counters) {
  const f = (n: number) => n.toLocaleString('en-US');
  $('c-houses').textContent = f(c.houses);
  $('c-agents').textContent = f(c.agents);
  $('c-conv').textContent = f(c.conversations);
  $('c-value').textContent = f(Math.round(c.valueSettled));
  $('c-blocked').textContent = f(c.attacksBlocked);
  $('c-moved').textContent = f(c.recordsMoved);
  $('c-moved').parentElement!.classList.toggle('alarm', c.recordsMoved > 0);
  $('empty').hidden = c.houses > 0;
}

// ---- The stream ----
function connect(delay = 500) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/events`);
  const status = $('status'), where = $('where');
  ws.onopen = () => { status.className = 'dot live'; delay = 500; };
  ws.onmessage = (m) => {
    const w = JSON.parse(m.data) as Wire;
    if (w.type === 'snapshot') {
      where.textContent = `live · node ${w.node}${w.sandbox ? ' · sandbox' : ''}`;
      if (w.approvalsUrl) { $('qr').hidden = false; void QRCode.toCanvas($<HTMLCanvasElement>('qr-canvas'), w.approvalsUrl, { width: 232, margin: 0 }); }
      for (const p of w.participants) addParticipant(p, false);
      for (const g of w.guilds ?? []) if (!guilds.some((x) => x.tag === g.tag)) guilds.push({ tag: g.tag, born: -10 });
      for (const r of w.recent) log(r.event, r.text);
      counters(w.counters);
    } else if (w.type === 'reset') {
      location.reload();
    } else {
      onEvent(w.event, w.participant);
      log(w.event, w.text);
      counters(w.counters);
    }
  };
  ws.onclose = () => {
    status.className = 'dot down';
    where.textContent = 'node unreachable · retrying';
    setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
  };
}
const params = new URLSearchParams(location.search);
if (params.has('capture')) void capture(params.get('replay') ?? './replay.jsonl', Number(params.get('from') ?? 0), Number(params.get('speed') ?? 1), params.get('captions'));
else {
  connect();
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt); draw(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * Capture mode (?capture&replay=run.jsonl&from=ms): a recorded run (node --record), played on a virtual
 * clock that only moves when told to, so a video can be rendered frame by frame at a steady rate however
 * busy the machine is. Same events, same timing as they happened, or `speed` times faster. `captions` is a
 * JSON list of { t (the run's own clock, ms), text, sub } lines, { t, image } insets and { t, scoreboard }
 * panels, shown over the map from their time until the next of the same kind (or `until`). A caption's
 * `speed` holds from its time on, so slow stretches of a run can pass quickly and the key moments don't.
 */
type Caption = { t: number; until?: number; speed?: number; text?: string; sub?: string; image?: string; scoreboard?: { title: string; rows: [value: string, label: string, today?: string][] } };
async function capture(src: string, fromMs: number, speed: number, captionsSrc: string | null) {
  const caps = captionsSrc ? ((await (await fetch(captionsSrc)).json()) as Caption[]) : [];
  const layer = document.createElement('div');
  layer.className = 'captions';
  // On film, captions say what happens; the event log would only compete with them.
  if (caps.length) stage.classList.add('filming');
  stage.append(layer);
  const shown = new Map<string, Caption | undefined>();
  const showCaptions = (t: number) => {
    const current = (kind: 'text' | 'image' | 'scoreboard') => caps.filter((c) => c[kind] && c.t <= t && (c.until === undefined || t < c.until)).at(-1);
    const next = { text: current('text'), image: current('image'), scoreboard: current('scoreboard') };
    if (Object.entries(next).every(([k, c]) => shown.get(k) === c)) return;
    Object.entries(next).forEach(([k, c]) => shown.set(k, c));
    const parts: HTMLElement[] = [];
    if (next.text) {
      const el = document.createElement('div'); el.className = 'cap-text';
      const big = document.createElement('p'); big.textContent = next.text.text!; el.append(big);
      if (next.text.sub) { const sub = document.createElement('p'); sub.className = 'sub'; sub.textContent = next.text.sub; el.append(sub); }
      parts.push(el);
    }
    if (next.image) { const img = document.createElement('img'); img.className = 'cap-image'; img.src = next.image.image!; parts.push(img); }
    if (next.scoreboard) {
      const el = document.createElement('div'); el.className = 'cap-board';
      const h = document.createElement('h2'); h.textContent = next.scoreboard.scoreboard!.title; el.append(h);
      const dl = document.createElement('dl');
      for (const [value, label, today] of next.scoreboard.scoreboard!.rows) {
        const cell = document.createElement('div');
        const dd = document.createElement('dd'); dd.textContent = value;
        const dt = document.createElement('dt'); dt.textContent = label;
        cell.append(dd, dt);
        // What the same thing takes today, for contrast.
        if (today) { const was = document.createElement('p'); was.className = 'today'; was.textContent = today; cell.append(was); }
        dl.append(cell);
      }
      el.append(dl); parts.push(el);
    }
    layer.replaceChildren(...parts);
  };
  type Line = { t: number; event: LakeEvent; text: string; counters: Counters; participant?: Participant };
  const lines = (await (await fetch(src)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
  const start = (lines[0]?.t ?? 0) + fromMs;
  $('status').className = 'dot live';
  $('where').textContent = 'live · node lake.local · sandbox';
  let i = 0;
  // Everything before the window: the Lake as it stood, without animation.
  for (; i < lines.length && lines[i]!.t < start; i++) {
    const l = lines[i]!;
    if (l.participant) addParticipant(l.participant, false);
    if (l.event.kind === 'house.left') houses.delete(l.event.actor);
    if (l.event.kind === 'guild.formed' && !guilds.some((g) => g.tag === l.event.data?.tag)) guilds.push({ tag: String(l.event.data?.tag), born: -10 });
    if (l.event.kind === 'intent.opened' || l.event.kind === 'quote.made') onEvent(l.event);
    counters(l.counters);
  }
  let vt = start;
  const w = window as unknown as { __lakeStep: (ms: number) => boolean };
  w.__lakeStep = (ms: number) => {
    vt += ms * (caps.filter((c) => c.speed && c.t <= vt).at(-1)?.speed ?? speed);
    showCaptions(vt);
    for (; i < lines.length && lines[i]!.t <= vt; i++) {
      const l = lines[i]!;
      onEvent(l.event, l.participant);
      log(l.event, l.text);
      counters(l.counters);
    }
    update(ms / 1000);
    draw(vt);
    return i < lines.length;
  };
  // Settle the first frame so the canvas isn't blank.
  for (let k = 0; k < 30; k++) { update(1 / 30); draw(vt); }
  document.body.dataset.ready = '1';
}
