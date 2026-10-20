import QRCode from 'qrcode';
import './style.css';

// The live Lake: the same picture as the simulation on the website, but every square, dot and thread
// is a real event from a Lake node's stream. The stream carries ids, kinds and counts only.

interface LakeEvent { id: string; kind: string; at: string; actor: string; subject?: string; data?: Record<string, string | number | boolean> }
interface Participant { id: string; role: string; label: string; tags: string[]; domain?: string }
interface Counters { houses: number; agents: number; conversations: number; valueSettled: number; attacksBlocked: number; recordsMoved: number }
type Wire =
  | { type: 'snapshot'; node: string; sandbox: boolean; approvalsUrl?: string; guilds?: { tag: string }[]; participants: Participant[]; counters: Counters; recent: { event: LakeEvent; text: string }[] }
  | { type: 'event'; event: LakeEvent; text: string; counters: Counters; participant?: Participant }
  | { type: 'reset' };

const COL = { ink: '#070B12', mint: '#3DDC97', orange: '#FF6A2B', violet: '#9D8FFF', threat: '#FF4D6A', muted: '#8B9BAE', fg: '#E6EDF2', amber: '#F5C451' };
const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface House { id: string; label: string; nx: number; ny: number; born: number; resp: '' | 'join' | 'decline' | 'ask' | 'counter'; respT: number; alert: number; leaving: number; phase: number; computedT: number; tags: string[] }
interface Spec { id: string; label: string; nx: number; ny: number }
interface Agent { id: string; domain: string; label: string; x: number; y: number; trail: { x: number; y: number }[]; seen: number; goto?: { x: number; y: number; until: number } }
interface Visitor { id: string; x: number; y: number; vx: number; vy: number; bad: boolean; target: House | null; seen: number; q: number }
interface Thread { ax: number; ay: number; h: House; life: number; col: string }
interface Ripple { x: number; y: number; r: number; max: number; col: string; w: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }

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
    const nx = 0.05 + 0.9 * (s % 1), ny = 0.1 + 0.75 * ((s * 7.31) % 1);
    const underQr = !$('qr').hidden && nx * W > W - 190 && ny * H < 200; // keep clear of the QR card
    if (!underQr && avoid.every((o) => Math.hypot((o.nx - nx) * W, (o.ny - ny) * H) > gap)) return { nx, ny };
    s = hash(id + i);
  }
  return { nx: 0.05 + 0.9 * (s % 1), ny: 0.1 + 0.75 * ((s * 7.31) % 1) };
}

function addParticipant(p: Participant, fresh: boolean) {
  if (p.role === 'house') {
    if (houses.has(p.id)) return;
    const pos = place(p.id, [...houses.values(), ...specs.values()]);
    houses.set(p.id, { id: p.id, label: p.label, ...pos, born: fresh ? clock : -10, resp: '', respT: 0, alert: 0, leaving: 0, phase: hash(p.id) * 6.28, computedT: -99, tags: p.tags ?? [] });
  } else if (p.role === 'visitor') {
    if (agents.has(p.id)) return;
    agents.set(p.id, { id: p.id, domain: p.domain ?? '', label: p.label, x: W / 2, y: H / 2, trail: [], seen: clock });
  } else if (p.role === 'specialist' || p.role === 'agent') {
    if (specs.has(p.id)) return;
    const slots = [[0.18, 0.28], [0.82, 0.28], [0.8, 0.74], [0.2, 0.74], [0.5, 0.18]];
    const [nx, ny] = slots[specs.size % slots.length]!;
    specs.set(p.id, { id: p.id, label: p.label.replace(/\s*\(.*\)$/, ''), nx: nx!, ny: ny! });
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
    if (clock - ag.seen > 60) { agents.delete(id); continue; }
    const to = ag.goto && clock < ag.goto.until ? ag.goto : { x: W / 2, y: H / 2 };
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
    h.alert = Math.max(0, h.alert - dt * 0.22);
    if (h.resp && clock - h.respT > 12) h.resp = '';
    if (h.leaving && clock - h.leaving > 2) houses.delete(id);
  }
  threads = threads.filter((t) => (t.life -= dt * 0.6) > 0);
  ripples = ripples.filter((r) => (r.r += dt * 160) < r.max);
  sparks = sparks.filter((p) => { p.life -= dt * 1.3; p.x += p.vx * dt; p.y += p.vy * dt; return p.life > 0; });
}

function draw(now: number) {
  ctx.fillStyle = reduced ? COL.ink : rgba(COL.ink, 0.32);
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
    if (h.alert > 0.05) { ctx.strokeStyle = rgba(COL.threat, h.alert * 0.9); ctx.lineWidth = 1.5; ctx.strokeRect(x - s - 3, y - s - 3, s * 2 + 6, s * 2 + 6); }
    if (houses.size <= 40) { ctx.fillStyle = rgba(COL.fg, 0.55); ctx.fillText(h.label.replace(/^House /, ''), x, y + s + 14); }
    ctx.globalAlpha = 1;
  }
  ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
  for (const sp of specs.values()) {
    const x = sp.nx * W, y = sp.ny * H, r = 9 + Math.sin(now / 600);
    ctx.fillStyle = rgba(COL.violet, 0.16); ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, 6.283); ctx.fill();
    ctx.fillStyle = COL.violet; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.fillText(sp.label.toUpperCase(), x, y + r + 16);
  }
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
  for (const ag of agents.values()) {
    ctx.strokeStyle = rgba(COL.orange, 0.35); ctx.lineWidth = 2; ctx.beginPath();
    ag.trail.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    const rr = 12 + Math.sin(now / 180) * 2.5;
    ctx.strokeStyle = COL.orange; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ag.x, ag.y, rr, 0, 6.283); ctx.stroke();
    ctx.fillStyle = COL.orange; ctx.beginPath(); ctx.arc(ag.x, ag.y, 6, 0, 6.283); ctx.fill();
    // A moving label smears across the fading canvas; show it only when the agent is still.
    const to = ag.goto && clock < ag.goto.until ? ag.goto : { x: W / 2, y: H / 2 };
    if (Math.hypot(to.x - ag.x, to.y - ag.y) < 8) {
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillText(ag.label.toUpperCase(), ag.x, ag.y + rr + 16);
    }
  }
}

// ---- Log and counters ----
const logEl = $('log');
const lines: { t: string; text: string; kind: string }[] = [];
const KIND_CLASS: Record<string, string> = { 'counter': 'mint', 'agreement.signed': '', 'grant.revoked': 'threat', 'approval.answered': 'mint', 'knock': '', 'offer': 'orange', 'compute.done': 'mint', 'grant.issued': 'mint', 'attack.blocked': 'threat', 'agent.quarantined': 'threat', 'record.moved': 'threat', 'house.joined': 'mint', 'agent.registered': 'violet', 'approval.requested': 'amber', 'guild.formed': 'violet', 'payment.settled': 'violet', 'study.result': 'mint' };
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
connect();

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  update(dt); draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
