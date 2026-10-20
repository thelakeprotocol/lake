// The Lake, simulated. A canvas world of houses (mint squares), loose agents (grey dots),
// specialists (violet), attackers (red) and your dispatched agent (orange).
// Ported from the original "The Lake" simulation; the real map runs the same visuals off live events.

const COL = { ink: '#070B12', mint: '#3DDC97', orange: '#FF6A2B', violet: '#9D8FFF', threat: '#FF4D6A', muted: '#8B9BAE', fg: '#E6EDF2', amber: '#F5C451' };
const KINDS = ['energy buyers', 'renters', 'carers', 'cyclists', 'research volunteers'];
// Where specialists and the mission centre sit. "right" keeps them clear of a headline on the left.
const LAYOUTS = {
  centre: { specs: [{ n: 'Ethics', nx: 0.18, ny: 0.3 }, { n: 'Auditor', nx: 0.82, ny: 0.3 }, { n: 'Payments', nx: 0.8, ny: 0.74 }], center: { nx: 0.5, ny: 0.52 } },
  right: { specs: [{ n: 'Ethics', nx: 0.6, ny: 0.24 }, { n: 'Auditor', nx: 0.9, ny: 0.3 }, { n: 'Payments', nx: 0.88, ny: 0.7 }], center: { nx: 0.73, ny: 0.5 } },
};

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const rand = (a, b) => a + Math.random() * (b - a);
const ri = (n) => Math.floor(Math.random() * n);
const hex4 = () => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, '0');
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const ease = (u) => { u = Math.max(0, Math.min(1, u)); return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; };
const lerpP = (a, b, u) => { const e = ease(u); return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }; };

/**
 * @param {HTMLCanvasElement} cv
 * @param {{ onEvent?: (text: string, kind: string) => void, onStats?: (s: object) => void, onStep?: (step: string|null) => void, onMissionEnd?: () => void, density?: number, layout?: (width: number) => 'centre' | 'right' }} hooks
 */
export function createLake(cv, hooks = {}) {
  const ctx = cv.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const SPD = reduced ? 0.45 : 1;
  const density = hooks.density ?? 1;
  let W = 800, H = 500, raf = 0, ro = null;
  let SPECS = LAYOUTS.centre.specs, CENTER = LAYOUTS.centre.center;

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    W = Math.max(200, r.width); H = Math.max(160, r.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COL.ink; ctx.fillRect(0, 0, W, H);
    const l = LAYOUTS[hooks.layout?.(W) ?? 'centre'];
    SPECS = l.specs; CENTER = l.center;
  }
  resize();
  ro = new ResizeObserver(resize); ro.observe(cv.parentElement);

  const px = (o) => ({ x: o.nx * W, y: o.ny * H });
  let houses = [], agents = [], threads = [], ripples = [], guilds = [], sparks = [];
  const stats = { conv: 0, value: 0, blocked: 0 };
  let clock = 0, paused = false, mission = null, me = null;

  function addHouse(born) {
    for (let tries = 0; tries < 60; tries++) {
      const nx = rand(0.04, 0.96), ny = rand(0.08, 0.9), x = nx * W, y = ny * H;
      let ok = SPECS.every((s) => { const p = px(s); return dist(x, y, p.x, p.y) >= 56; });
      const c = px(CENTER); if (dist(x, y, c.x, c.y) < 60) ok = false;
      if (ok) ok = houses.every((h) => dist(x, y, h.nx * W, h.ny * H) >= 20);
      if (!ok) continue;
      const h = { nx, ny, kind: ri(KINDS.length), alert: 0, dark: 0, born, resp: 0, respT: 0, id: hex4(), phase: rand(0, 6.28) };
      houses.push(h); return h;
    }
    return null;
  }
  function addAgent(bad, edge) {
    let x = rand(0, W), y = rand(0, H);
    if (edge) { if (Math.random() < 0.5) x = Math.random() < 0.5 ? 2 : W - 2; else y = Math.random() < 0.5 ? 2 : H - 2; }
    const a = { x, y, vx: rand(-20, 20), vy: rand(-20, 20), bad, rep: 1, q: 0, target: null, cool: rand(0, 3), id: hex4(), struck: false };
    agents.push(a); return a;
  }

  const area = W * H;
  const nHouses = Math.round(Math.max(55, Math.min(170, area / 5200)) * density);
  const nAgents = Math.round(Math.max(110, Math.min(300, area / 2400)) * density);
  for (let i = 0; i < nHouses; i++) addHouse(-10);
  for (let k = 0; k < nAgents; k++) addAgent(k < 5, false);

  const event = (text, kind = '') => hooks.onEvent?.(text, kind);
  const step = (s) => hooks.onStep?.(s);

  function warnNeighbours(h, radius) {
    const hx = h.nx * W, hy = h.ny * H; let n = 0;
    for (const o of houses) {
      if (o === h || o.dark > 0) continue;
      if (dist(hx, hy, o.nx * W, o.ny * H) < radius) { o.alert = Math.max(o.alert, 0.7); n++; }
    }
    return n;
  }

  function knock(a, h) {
    const hx = h.nx * W, hy = h.ny * H;
    if (a.bad) {
      stats.blocked++;
      threads.push({ ax: a.x, ay: a.y, h, life: 1, col: COL.threat });
      h.alert = 1;
      ripples.push({ x: hx, y: hy, r: 4, max: 150, col: COL.threat, w: 2 });
      const n = warnNeighbours(h, 150);
      a.rep -= 0.24;
      if (!a.struck) { a.struck = true; event(`Attacker ${a.id} knocked on pod-${h.id} with no key. Blocked. ${n} neighbours warned.`, 'threat'); }
      if (a.rep < 0.3 && !a.q) { a.q = 0.001; event(`Immune response: attacker ${a.id} quarantined. No human intervened.`, 'threat'); }
    } else {
      stats.conv++;
      stats.value += rand(0.2, 3.5);
      threads.push({ ax: a.x, ay: a.y, h, life: 1, col: COL.mint });
    }
  }

  function formGuild() {
    const kind = ri(KINDS.length), members = houses.filter((h) => h.kind === kind && h.dark <= 0);
    if (members.length < 4) return;
    const edges = [], used = new Set();
    for (const h of members) {
      const hx = h.nx * W, hy = h.ny * H;
      members.filter((o) => o !== h)
        .map((o) => ({ o, d: dist(hx, hy, o.nx * W, o.ny * H) }))
        .filter((e) => e.d < Math.max(160, Math.min(W, H) * 0.35))
        .sort((p, q) => p.d - q.d).slice(0, 2)
        .forEach((e) => { const key = [h.id, e.o.id].sort().join(); if (!used.has(key)) { used.add(key); edges.push([h, e.o]); } });
    }
    if (edges.length < 3) return;
    const count = new Set(); edges.forEach((e) => { count.add(e[0]); count.add(e[1]); });
    guilds.push({ edges, born: clock, kind });
    if (guilds.length > 3) guilds.shift();
    event(`Guild formed: ${count.size} housekeepers for ${KINDS[kind]} now bargain as one.`, 'violet');
  }

  function dispatch() {
    if (mission) return false;
    const c = px(CENTER);
    me = { x: c.x, y: c.y, trail: [] };
    mission = { t: 0, fired: {}, joined: 0, declined: 0, asked: 0, front: 0 };
    houses.forEach((h) => { h.resp = 0; });
    step('mandate');
    event('You dispatched an agent: “Do over-60s on drug X get readmitted less?” Budget signed: $5,000.', 'orange');
    return true;
  }
  const once = (key, fn) => { if (!mission.fired[key]) { mission.fired[key] = true; fn(); } };

  function updateMission(dt) {
    const m = mission; m.t += dt * SPD;
    const t = m.t, c = px(CENTER), eth = px(SPECS[0]), aud = px(SPECS[1]), pay = px(SPECS[2]);
    let p;
    if (t < 2) { once('go-eth', () => step('ethics')); p = lerpP(c, eth, t / 2); }
    else if (t < 4) { once('eth', () => { step('audit'); event('Ethics agent approved the study. A signed credential lands in your agent’s wallet.', 'violet'); }); p = lerpP(eth, aud, (t - 2) / 2); }
    else if (t < 6) { once('aud', () => event('Auditor certified the code: aggregates only, stores nothing, deletes on exit.', 'violet')); p = lerpP(aud, c, (t - 4) / 2); }
    else if (t < 13.5) {
      p = c;
      once('knock', () => { step('knock'); event('Knocking on every house over A2A. Offer: $2 per participant.', 'orange'); });
      if (t < 9.5) {
        const maxR = Math.hypot(W, H) * 0.62;
        m.front = Math.min((t - 6) / 3.2, 1) * maxR;
        for (const h of houses) {
          if (h.resp || h.dark > 0) continue;
          if (dist(c.x, c.y, h.nx * W, h.ny * H) <= m.front) {
            const r = Math.random(); h.resp = r < 0.68 ? 1 : r < 0.86 ? 2 : 3; h.respT = clock;
            if (h.resp === 1) m.joined++; else if (h.resp === 2) m.declined++; else m.asked++;
            if (Math.random() < 0.5) threads.push({ ax: c.x, ay: c.y, h, life: 0.9, col: COL.orange });
          }
        }
      }
      if (t >= 8) once('decide', () => step('decide'));
      if (t >= 9.6) once('tally', () => event(`${m.joined} joined · ${m.declined} declined · ${m.asked} asked their owners first.`, 'mint'));
      if (t >= 10.6) once('union', () => { step('bargain'); event('Housekeepers spotted the identical offer and countered together: $5, not $2. Accepted.', 'mint'); });
      if (t >= 12.4) once('allow', () => {
        step('grant');
        houses.forEach((h) => { if (h.resp === 3) { h.resp = 1; m.joined++; } });
        m.asked = 0;
        event('Owners tapped Allow. Keys issued for 48 hours, revocable any time.', 'mint');
      });
    }
    else if (t < 14.5) { once('compute', () => step('compute')); p = lerpP(c, pay, t - 13.5); }
    else if (t < 16) {
      p = pay;
      once('pay', () => {
        step('pay');
        stats.value += m.joined * 5;
        houses.forEach((h) => { if (h.resp === 1 && Math.random() < 0.6) threads.push({ ax: pay.x, ay: pay.y, h, life: 1, col: COL.violet }); });
        event(`Payments settled $${(m.joined * 5).toLocaleString()} across ${m.joined} participants. Every receipt is in its owner’s pod.`, 'violet');
      });
    }
    else if (t < 17.5) p = lerpP(pay, c, (t - 16) / 1.5);
    else {
      step('answer');
      event(`Answer delivered in ${Math.round(t)} seconds. Records moved: 0.`, 'mint');
      mission = null; me = null;
      hooks.onMissionEnd?.();
      return;
    }
    me.x = p.x; me.y = p.y;
    me.trail.push({ x: p.x, y: p.y }); if (me.trail.length > 28) me.trail.shift();
  }

  let guildTimer = 2.5, attackTimer = 6;
  function update(dt) {
    clock += dt;
    const s = dt * SPD;
    for (let i = agents.length - 1; i >= 0; i--) {
      const a = agents[i];
      if (a.q) {
        a.q += s; a.vx *= 0.96; a.vy *= 0.96; a.x += a.vx * s; a.y += a.vy * s;
        if (a.q > 16) agents.splice(i, 1);
        continue;
      }
      a.cool -= s;
      if (!a.target || a.target.dark > 0) { a.target = null; if (Math.random() < 0.02) a.target = houses[ri(houses.length)]; }
      if (a.target) {
        const tx = a.target.nx * W, ty = a.target.ny * H, dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy) || 1;
        const acc = a.bad ? 46 : 30;
        a.vx += (dx / d) * acc * s; a.vy += (dy / d) * acc * s;
        if (d < 10 && a.cool <= 0) { if (a.target.dark <= 0) knock(a, a.target); a.target = null; a.cool = rand(1.5, 5); }
      }
      a.vx += rand(-40, 40) * s; a.vy += rand(-40, 40) * s;
      const max = a.bad ? 62 : 44, sp = Math.hypot(a.vx, a.vy);
      if (sp > max) { a.vx *= max / sp; a.vy *= max / sp; }
      a.vx *= 0.995; a.vy *= 0.995; a.x += a.vx * s; a.y += a.vy * s;
      if (a.x < 0) { a.x = 0; a.vx = Math.abs(a.vx); } if (a.x > W) { a.x = W; a.vx = -Math.abs(a.vx); }
      if (a.y < 0) { a.y = 0; a.vy = Math.abs(a.vy); } if (a.y > H) { a.y = H; a.vy = -Math.abs(a.vy); }
    }
    houses.forEach((h) => { h.alert = Math.max(0, h.alert - s * 0.22); if (h.dark > 0) h.dark -= s; if (h.resp && !mission && clock - h.respT > 9) h.resp = 0; });
    threads = threads.filter((t) => { t.life -= s * 1.1; return t.life > 0; });
    ripples = ripples.filter((r) => { r.r += s * 200; return r.r < r.max; });
    sparks = sparks.filter((p) => { p.life -= s * 1.4; p.x += p.vx * s; p.y += p.vy * s; return p.life > 0; });
    guildTimer -= s;
    if (guildTimer <= 0) { formGuild(); guildTimer = rand(13, 20); }
    attackTimer -= s;
    const active = agents.filter((a) => a.bad && !a.q).length;
    if (attackTimer <= 0) { if (active < 4) addAgent(true, true); attackTimer = rand(7, 12); }
    if (mission) updateMission(dt);
  }

  function draw(now) {
    ctx.fillStyle = reduced ? COL.ink : rgba(COL.ink, 0.32);
    ctx.fillRect(0, 0, W, H);

    guilds.forEach((g, gi) => {
      const age = clock - g.born, fade = Math.min(1, age / 2) * Math.max(0, 1 - Math.max(0, age - 40) / 10);
      const pulse = 0.55 + 0.45 * Math.sin(now / 700 + gi);
      ctx.strokeStyle = rgba(COL.violet, 0.28 * fade * pulse); ctx.lineWidth = 1;
      ctx.beginPath();
      g.edges.forEach((e) => { if (e[0].dark > 0 || e[1].dark > 0) return; ctx.moveTo(e[0].nx * W, e[0].ny * H); ctx.lineTo(e[1].nx * W, e[1].ny * H); });
      ctx.stroke();
    });
    threads.forEach((t) => {
      ctx.strokeStyle = rgba(t.col, 0.55 * t.life); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(t.ax, t.ay); ctx.lineTo(t.h.nx * W, t.h.ny * H); ctx.stroke();
    });
    ripples.forEach((r) => {
      ctx.strokeStyle = rgba(r.col, 0.5 * (1 - r.r / r.max)); ctx.lineWidth = r.w;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.283); ctx.stroke();
    });
    if (mission && mission.t >= 6 && mission.t < 9.6) {
      const c = px(CENTER);
      ctx.strokeStyle = rgba(COL.orange, 0.5); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1, mission.front), 0, 6.283); ctx.stroke();
    }
    houses.forEach((h) => {
      const x = h.nx * W, y = h.ny * H;
      const grow = h.born > 0 ? Math.min(1, (clock - h.born) / 0.8) : 1;
      if (h.born > 0 && clock - h.born < 1.6) { ctx.strokeStyle = rgba(COL.mint, 1 - (clock - h.born) / 1.6); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6 + (clock - h.born) * 26, 0, 6.283); ctx.stroke(); }
      const s = (4.2 + Math.sin(now / 900 + h.phase) * 0.6) * grow;
      if (h.dark > 0) { ctx.strokeStyle = rgba(COL.muted, 0.6); ctx.lineWidth = 1; ctx.strokeRect(x - s, y - s, s * 2, s * 2); return; }
      let fill = rgba(COL.mint, 0.75), glow = rgba(COL.mint, 0.12);
      if (h.resp === 1) { fill = COL.mint; glow = rgba(COL.mint, 0.3); }
      else if (h.resp === 2) { fill = rgba(COL.muted, 0.7); glow = 'rgba(0,0,0,0)'; }
      else if (h.resp === 3) { fill = COL.amber; glow = rgba(COL.amber, 0.3); }
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, s * 2.6, 0, 6.283); ctx.fill();
      ctx.fillStyle = fill; ctx.fillRect(x - s, y - s, s * 2, s * 2);
      if (h.alert > 0.05) { ctx.strokeStyle = rgba(COL.threat, h.alert * 0.9); ctx.lineWidth = 1.5; ctx.strokeRect(x - s - 3, y - s - 3, s * 2 + 6, s * 2 + 6); }
    });
    SPECS.forEach((sp) => {
      const p = px(sp), r = 9 + Math.sin(now / 600);
      ctx.fillStyle = rgba(COL.violet, 0.16); ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, 6.283); ctx.fill();
      ctx.fillStyle = COL.violet; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.fill();
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = COL.violet;
      ctx.fillText(sp.n.toUpperCase(), p.x, p.y + r + 16);
    });
    agents.forEach((a) => {
      if (a.bad) {
        if (a.q) {
          const fade = Math.max(0, 1 - a.q / 16);
          ctx.strokeStyle = rgba(COL.threat, 0.7 * fade); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(a.x, a.y, 9, 0, 6.283); ctx.stroke();
          ctx.fillStyle = rgba(COL.threat, 0.5 * fade); ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, 6.283); ctx.fill();
        } else { ctx.fillStyle = COL.threat; ctx.beginPath(); ctx.arc(a.x, a.y, 3.4, 0, 6.283); ctx.fill(); }
      } else { ctx.fillStyle = rgba(COL.muted, 0.8); ctx.beginPath(); ctx.arc(a.x, a.y, 1.8, 0, 6.283); ctx.fill(); }
    });
    sparks.forEach((p) => { ctx.fillStyle = rgba(COL.muted, p.life); ctx.fillRect(p.x, p.y, 2, 2); });
    if (me) {
      ctx.strokeStyle = rgba(COL.orange, 0.35); ctx.lineWidth = 2; ctx.beginPath();
      me.trail.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      const rr = 12 + Math.sin(now / 180) * 2.5;
      ctx.strokeStyle = COL.orange; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(me.x, me.y, rr, 0, 6.283); ctx.stroke();
      ctx.fillStyle = COL.orange; ctx.beginPath(); ctx.arc(me.x, me.y, 6, 0, 6.283); ctx.fill();
      if (mission && mission.t >= 10.4 && mission.t < 13.4) {
        const c2 = px(CENTER), size = Math.max(28, Math.min(64, W / 12));
        ctx.font = `700 ${size}px Oswald, "Arial Narrow", sans-serif`; ctx.textAlign = 'center';
        ctx.fillStyle = rgba(COL.muted, 0.9); ctx.fillText('$2', c2.x - size * 1.1, c2.y - 34);
        ctx.strokeStyle = COL.threat; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(c2.x - size * 1.6, c2.y - 34 - size * 0.35); ctx.lineTo(c2.x - size * 0.6, c2.y - 34 - size * 0.35); ctx.stroke();
        if (mission.t >= 11) { ctx.fillStyle = COL.mint; ctx.fillText('$5', c2.x + size * 1.1, c2.y - 34); }
      }
    }
  }

  function pushStats() {
    hooks.onStats?.({
      houses: houses.length,
      agents: agents.filter((a) => !a.q).length,
      conv: stats.conv,
      value: Math.round(stats.value),
      blocked: stats.blocked,
      moved: 0,
    });
  }

  // Warm up so the lake is already alive on first paint.
  for (let w = 0; w < 240; w++) update(1 / 30);
  clock = 0;
  formGuild();
  guildTimer = rand(9, 14);
  pushStats();
  event(`Lake online: ${houses.length} homes, ${agents.length} agents. No central database anywhere.`, 'mint');

  let last = performance.now(), statT = 0, visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
  io.observe(cv);
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!paused && visible) { update(dt); statT += dt; if (statT > 0.25) { statT = 0; pushStats(); } draw(now); }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    dispatch,
    spawnHouse() {
      const h = addHouse(clock);
      if (h) event(`docker run lake-house --name pod-${h.id} → a new home joined the Lake.`, 'mint');
      return !!h;
    },
    releaseAttacker() {
      const a = addAgent(true, true);
      a.target = houses[ri(houses.length)];
      event(`An attacker (${a.id}) slipped into the Lake. Watch the housekeepers respond.`, 'threat');
    },
    revoke() {
      const live = houses.filter((h) => h.dark <= 0);
      if (!live.length) return;
      const h = live[ri(live.length)], hx = h.nx * W, hy = h.ny * H;
      let cut = 0;
      threads = threads.filter((t) => { if (t.h === h) { cut++; return false; } return true; });
      agents.forEach((a) => { if (a.target === h) { a.target = null; cut++; } });
      for (let i = 0; i < 18; i++) sparks.push({ x: hx, y: hy, vx: rand(-90, 90), vy: rand(-90, 90), life: 1 });
      ripples.push({ x: hx, y: hy, r: 4, max: 90, col: COL.fg, w: 1.5 });
      h.dark = 8; h.resp = 0;
      event(`The owner of pod-${h.id} revoked every key. ${cut} connection${cut === 1 ? '' : 's'} cut instantly.`, '');
    },
    setPaused(p) { paused = p; },
    get busy() { return !!mission; },
    destroy() { cancelAnimationFrame(raf); ro?.disconnect(); io.disconnect(); },
  };
}
