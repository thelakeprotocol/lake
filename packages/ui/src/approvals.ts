import './approvals.css';
import { stringify } from 'yaml';
import { loadKey, signCredential, signEnvelope } from './owner-crypto';

// The control panel that comes with every house (open source). Served by the house at /owner/; every
// call is signed on this device with the owner's key, which never leaves it.

interface Request { id: string; offerId: string; visitor: { webId: string; domain: string }; purpose: string; fields: string[]; retention: string; priceUsd: number; study: string | null; question?: string; warnings?: string[]; note?: string; asked?: number; recommendation: string }
interface Key { id: string; visitor: string; fields: string[]; purpose: string; until: string; authorizedBy: string }
type Decision = 'join' | 'ask' | 'decline';
interface Rule { match: Record<string, string | boolean | number>; allow_fields?: string[]; deny_fields?: string[]; min_price_usd?: number; retention?: string; grant_hours?: number; decision: Decision }
interface Rules { owner: string; device?: string; default: Decision; tags?: string[]; rules: Rule[]; negotiation?: { join_collectives?: boolean }; trust?: Record<string, string[]>; privacy?: { show_packs?: boolean } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const key = loadKey();
const api = new URL('./', location.href).href; // served at /owner/
let webId = '';
let houseName = '';
let leaseUntil: string | null = null;
let pendingSeen = new Set<string>();

// ---- tiny DOM helper ----
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---- talking to the house ----
async function pair(): Promise<boolean> {
  const token = new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined;
  const res = await fetch(`${api}pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: key.jwk, token }) });
  const body = await res.json();
  if (res.ok) {
    webId = body.webId;
    leaseUntil = body.until ?? null;
    history.replaceState(null, '', location.pathname);
    return true;
  }
  $('pair-msg').textContent = body.error ?? 'pairing failed';
  return false;
}

async function call<T = any>(payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${api}api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signEnvelope(payload, key, webId || 'owner')) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status));
  return res.json();
}

// ---- navigation ----
// Your agent and the agents that knock are different things: "My agent" is yours, "Visitors" are strangers.
const TABS = [
  ['home', 'Home'], ['requests', 'Requests'], ['offers', 'Offers'], ['myagent', 'My agent'], ['keys', 'Keys'], ['rules', 'Rules'],
  ['agents', 'Visitors'], ['money', 'Money'], ['data', 'Data'], ['move', 'Move house'],
] as const;
type Tab = (typeof TABS)[number][0];
let tab: Tab = TABS.find(([id]) => id === location.hash.slice(1))?.[0] ?? 'home';
let pending = 0;

const unused = new Set<Tab>(); // tabs this house has nothing for (no use case with offers, say)

function renderNav() {
  $('nav').replaceChildren(...TABS.filter(([id]) => !unused.has(id) || id === tab).map(([id, label]) =>
    h('button', { type: 'button', 'aria-current': id === tab ? 'page' : undefined, onclick: () => go(id) }, label, id === 'requests' && pending ? h('span', { class: 'badge' }, String(pending)) : null)));
}

function go(t: Tab) {
  tab = t;
  document.body.classList.add('fetching');
  if (location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`);
  renderNav();
  // On a phone the tabs scroll sideways; keep the one you picked in sight.
  $('nav').querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  void show();
}

// Each tab draws into its own box. A click shows that box at once (what you saw last time) and refreshes it
// behind; an answer for a tab you've left lands in its own box, never over the one you're looking at.
const boxes = new Map<Tab, HTMLElement>();
const boxFor = (t: Tab) => {
  let b = boxes.get(t);
  if (!b) boxes.set(t, (b = h('div', {}, h('p', { class: 'muted' }, 'Opening…'))));
  return b;
};
const view = () => boxFor(tab);
const drawing = new Map<Tab, boolean>(); // tab → asked again while drawing
const hoursLeft = (iso: string) => { const hr = (Date.parse(iso) - Date.now()) / 3_600_000; return hr < 1 ? `${Math.max(1, Math.round(hr * 60))} min` : `${Math.round(hr)} h`; };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nice = (f: string) => f.replace(/_/g, ' ');
/** "P99Y" → "99 years", "P30D" → "30 days". */
const duration = (iso: string) => {
  const units: [RegExp, string][] = [[/(\d+)Y/, 'year'], [/P[^T]*?(\d+)M/, 'month'], [/(\d+)W/, 'week'], [/(\d+)D/, 'day'], [/T.*?(\d+)H/, 'hour']];
  const parts = units.flatMap(([re, u]) => { const n = Number(re.exec(iso)?.[1] ?? 0); return n ? [`${n} ${u}${n === 1 ? '' : 's'}`] : []; });
  return parts.join(' ') || iso;
};
/** A WebID or agent id, said the way a person would: its domain. */
const who = (id: string) => { try { return new URL(id).hostname; } catch { return id.replace(/^agent:/, '') || 'someone'; } };

async function show() {
  const t = tab, box = boxFor(t);
  if ($('view').firstChild !== box) { $('view').replaceChildren(box); scrollTo(0, 0); }
  if (drawing.has(t)) return void drawing.set(t, true);
  drawing.set(t, false);
  try {
    do {
      drawing.set(t, false);
      await { home, requests, keys, rules, offers, myagent, agents, money, data, move }[t](box);
    } while (drawing.get(t));
    $('status').className = 'dot live';
  } catch (e) {
    $('status').className = 'dot down';
    box.replaceChildren(h('p', { class: 'muted' }, `Couldn't reach your house: ${(e as Error).message}`));
  } finally {
    drawing.delete(t);
    if (t === tab) document.body.classList.remove('fetching');
  }
}

// ---- Home ----
async function home(box: HTMLElement) {
  const [o, feed, { suggestions, assistants }] = await Promise.all([
    call({ kind: 'panel.overview', tz_offset: new Date().getTimezoneOffset() }),
    call<{ at: string; kind: string; text: string }[]>({ kind: 'panel.activity' }),
    call<{ suggestions: { id: string; from: string; text: string; at: string }[]; assistants: { label: string }[] }>({ kind: 'list' }),
  ]);
  houseName = o.name;
  $('title').textContent = `House ${o.name}`;
  const tile = (label: string, value: string | number, to: Tab, cls = '') =>
    h('div', { class: `tile link ${cls}`, role: 'button', tabindex: 0, onclick: () => go(to), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') go(to); } }, h('dt', {}, label), h('dd', {}, String(value)));
  const agentCard = h('div', { class: 'card' },
      h('h3', {}, 'Your AI agent'),
      h('p', { class: 'muted' }, assistants.length ? `${assistants.map((a) => a.label.replace(/\s*\(.*\)$/, '')).join(', ')} ${assistants.length === 1 ? 'is' : 'are'} looking after your house: it sees every knock and suggests; you decide.` : 'Let your own AI agent look after your house: it sees every knock and suggests what to do; only you decide.'),
      h('button', { class: 'btn small', type: 'button', onclick: () => go('myagent') }, assistants.length ? 'My agent →' : 'Give it a key →'));
  box.replaceChildren(
    suggestions.length ? h('div', { class: 'card' }, h('h3', {}, 'Your agent suggests'), suggestionList(suggestions)) : '',
    h('dl', { class: 'tiles' },
      tile('Waiting for you', o.pending, 'requests', o.pending ? 'amber' : ''),
      tile('Knocks today', o.knocksToday, 'agents'),
      tile('Live keys', o.keys, 'keys'),
      tile('Earned', `$${o.earned}`, 'money', 'mint'),
      tile('Attacks blocked today', o.blockedToday, 'agents', o.blockedToday ? 'threat' : ''),
    ),
    h('div', { class: `card ${o.record.ok ? 'ok' : 'bad'}` },
      h('h3', {}, o.record.ok ? 'Your record checks out' : 'Your record failed its check'),
      h('p', { class: 'muted' }, o.record.ok
        ? `Signed by a trusted issuer, unchanged since, converted by a certified converter. Your house holds ${o.claims} claims: ${o.holds.map(nice).join(', ') || 'none'}.`
        : `${o.record.why}. Your house won't join studies until this is fixed.`)),
    agentCard,
    leaseUntil ? leaseCard() : '',
    personCard(o.person),
    h('div', { class: 'card' },
      h('h3', {}, o.relayed ? 'Reached through the Lake' : 'Reached directly'),
      h('p', { class: 'muted' }, o.relayed ? 'Your house is behind a router; agents reach it through the nodes it follows.' : 'Agents reach your house at its own address.'),
      ...o.reachedAt.map((u: string) => h('div', {}, h('code', {}, u)))),
    h('h2', {}, 'At your door'),
    feed.length ? h('ul', { class: 'feed' }, ...feed.slice(0, 12).map((a) => h('li', {}, h('time', {}, time(a.at)), h('span', { class: a.kind === 'attack.blocked' ? 'k-threat' : a.kind === 'grant.issued' || a.kind === 'compute.done' ? 'k-mint' : a.kind === 'approval.requested' ? 'k-amber' : '' }, a.text))))
      : h('p', { class: 'muted' }, 'Quiet so far.'),
  );
}

/**
 * One person, one house: a stamp from a person checker says a real, single person owns this house, without
 * saying who. Things that count people (pledges, strikes) count each person once, whatever number of houses.
 */
function personCard(p: { stamped: boolean; by?: string; person?: string; checker?: boolean } | undefined) {
  if (!p) return '';
  const msg = h('p', { class: 'muted' });
  const get = h('button', { class: 'btn small', type: 'button' }, 'Get a person stamp');
  get.onclick = async () => {
    get.disabled = true;
    // Your consent, signed here on your device: the checker stamps the house only with it.
    const consent = signEnvelope({ kind: 'personhood.consent', house: webId }, key, webId || 'owner');
    const r = await call<{ error?: string }>({ kind: 'panel.person.request', consent }).catch((e) => ({ error: (e as Error).message }));
    if (r.error) { msg.textContent = r.error; get.disabled = false; } else void show();
  };
  const tally = h('input', { placeholder: 'tally address, e.g. https://…/s/tally', style: 'width:100%' }) as HTMLInputElement;
  const pid = h('input', { placeholder: 'pledge id', style: 'width:100%;margin-top:6px' }) as HTMLInputElement;
  const sign = h('button', { class: 'btn small', type: 'button', style: 'margin-top:8px' }, 'Sign this pledge');
  sign.onclick = async () => {
    const r = await call<{ kind?: string; count?: number; threshold?: number; error?: string; problems?: string[] }>({ kind: 'panel.pledge.sign', tally: tally.value.trim(), id: pid.value.trim() }).catch((e): { error: string; problems?: string[]; kind?: string; count?: number; threshold?: number } => ({ error: (e as Error).message }));
    msg.textContent = r.error ?? (r.problems ? r.problems.join('; ') : r.kind === 'tally.triggered' ? `Signed, and that was the last one needed: ${r.count} of ${r.threshold}. Everyone has been told.` : `Signed: ${r.count} of ${r.threshold}. Nobody knows who until it's full.`);
  };
  return h('div', { class: `card ${p.stamped ? 'ok' : ''}` },
    h('h3', {}, p.stamped ? 'One person, one house: stamped' : 'One person, one house'),
    h('p', { class: 'muted' }, p.stamped
      ? `${p.by ?? 'A person checker'} says a real, single person owns this house, without saying who (person …${p.person}). Pledges that count people count you once.`
      : p.checker ? 'Get a stamp that says a real, single person owns this house, without saying who. Pledges and strikes that count people only count stamped houses, once per person.' : 'No person checker is set for this house.'),
    !p.stamped && p.checker ? get : '',
    h('details', { style: 'margin-top:8px' }, h('summary', {}, 'Sign a pledge from your house'), tally, pid, sign),
    msg);
}

/** Sandbox houses are leased: shown on Home, with a way to hand the house back early. */
function leaseCard() {
  const until = new Date(leaseUntil!);
  const back = h('button', { class: 'btn danger small', type: 'button' }, 'Hand it back now');
  back.onclick = async () => {
    if (!confirm('Hand this house back? Every key is revoked and the next person gets it fresh.')) return;
    await call({ kind: 'release' });
    location.reload();
  };
  return h('div', { class: 'card' },
    h('h3', {}, `Yours until ${until.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`),
    h('p', { class: 'muted' }, 'A sandbox house is a lease. When it ends, every key is revoked, the rules reset and the next person can claim it. Want to keep a house? Run your own: it stays yours.'),
    back);
}

// ---- Requests ----
async function requests(box: HTMLElement) {
  const v = await call<{ requests: Request[] }>({ kind: 'list' });
  box.replaceChildren(
    h('p', { class: 'lede' }, 'Your rules answer the easy ones. These are the ones they left to you.'),
    v.requests.length ? h('div', {}, ...sameAsks(v.requests).map(requestCard)) : h('p', { class: 'muted' }, 'Nothing to decide. Your rules are handling it.'),
  );
}

/** An agent that knocks seven times with the same ask gets one card, answered once for all seven. */
function sameAsks(list: Request[]): Request[][] {
  const groups = new Map<string, Request[]>();
  for (const r of list) {
    const k = JSON.stringify([r.visitor.domain, r.purpose, r.fields, r.retention, r.priceUsd, r.study, r.question ?? '', r.warnings ?? [], r.recommendation]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()];
}

function requestCard(all: Request[]) {
  // The house folds repeats into one request (asked); older houses may still send several identical ones.
  const r = all[0]!, n = all.length, times = all.reduce((t, x) => t + (x.asked ?? 1), 0);
  // On a risky ask the safe answer is the easy one to hit.
  const risky = !!r.warnings?.length;
  const allow = h('button', { class: risky ? 'btn deny' : 'btn allow', type: 'button' }, n > 1 ? `Allow all ${n}` : 'Allow');
  const deny = h('button', { class: risky ? 'btn danger-fill' : 'btn deny', type: 'button' }, n > 1 ? `Deny all ${n}` : 'Deny');
  allow.onclick = async () => {
    allow.disabled = deny.disabled = true;
    for (const q of all) {
      // The key is cut here, on this device, with your key. The house only checks it.
      const grant = signCredential({
        '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeAccessGrant'], issuer: webId,
        validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        credentialSubject: { id: q.visitor.webId, offer: q.offerId, study: q.study, fields: q.fields, purpose: q.purpose, authorizedBy: 'owner, live', ...(q.study ? { uses: 1 } : {}) },
      }, key);
      await call({ kind: 'answer', request: q.id, answer: 'allow', grant }).catch((e) => alert(e.message));
    }
    void refreshBadge(); void show();
  };
  deny.onclick = async () => {
    allow.disabled = deny.disabled = true;
    for (const q of all) await call({ kind: 'answer', request: q.id, answer: 'deny' }).catch(() => {});
    void refreshBadge(); void show();
  };
  return h('article', { class: r.warnings?.length ? 'req risky' : 'req' },
    h('div', { class: 'who' }, r.visitor.domain, times > 1 ? h('span', { class: 'count' }, `asked ${times} times`) : null),
    r.question ? h('p', { class: 'q' }, `“${r.question}”`) : null,
    r.warnings?.length ? h('ul', { class: 'warn' }, ...r.warnings.map((w) => h('li', {}, `It ${w}`))) : null,
    r.note ? h('p', { class: 'note' }, h('b', {}, 'Their note, in their words (not checked): '), `“${r.note}”`) : null,
    h('dl', { class: 'facts' },
      ...([['Purpose', r.purpose], ['Fields', h('span', {}, ...r.fields.map((f) => h('span', { class: 'chip' }, nice(f))))], ['Keeps it', r.retention === 'none' ? 'no, deleted after the study' : `yes, for ${duration(r.retention)}`], ['Pays', `$${r.priceUsd}`], ['Key for', '48 hours, revocable']] as [string, Child][])
        .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
    h('p', { class: 'advice' }, h('b', {}, 'Your housekeeper says'), r.recommendation),
    h('div', { class: 'actions' }, allow, deny));
}

// ---- Keys ----
async function keys(box: HTMLElement) {
  const v = await call<{ keys: Key[] }>({ kind: 'list' });
  box.replaceChildren(
    h('p', { class: 'lede' }, 'Everyone who can use something in your house right now. Revoking cuts them off on their next request.'),
    v.keys.length ? h('ul', { class: 'rows' }, ...v.keys.map((k) => h('li', {},
      h('div', {}, h('div', { class: 'r-title' }, `${k.visitor} · ${k.purpose}`), h('div', { class: 'r-meta' }, `${k.fields.map(nice).join(', ')} · ${hoursLeft(k.until)} left · ${k.authorizedBy}`)),
      h('button', { class: 'btn danger small', type: 'button', onclick: async () => { await call({ kind: 'revoke', revoke: k.id }); void show(); } }, 'Revoke'))))
      : h('p', { class: 'muted' }, 'No one holds a key to your house.'),
    v.keys.length ? h('div', { class: 'savebar' }, h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Revoke every key to your house?')) { await call({ kind: 'revoke', revoke: 'all' }); void show(); } } }, 'Revoke every key')) : '',
  );
}

// ---- Rules ----
// The fields rules can name come from the packs this house takes part in (and the identifying ones they warn about).
let FIELDS: { name: string; label: string; pack: string }[] = [];
// The Lake's purposes come from the house; a rule about a broad one (marketing) covers those inside it (advertising).
let PURPOSES: { name: string; label: string; within?: string }[] = ['research', 'care', 'marketing', 'insurance'].map((name) => ({ name, label: name }));
let draft: Rules | null = null;

async function rules(box: HTMLElement) {
  if (!draft) {
    const r = await call<{ rules: Rules; fields?: { name: string; label: string; pack: string }[]; purposes?: typeof PURPOSES }>({ kind: 'panel.rules' });
    draft = structuredClone(r.rules);
    FIELDS = r.fields ?? [];
    if (r.purposes?.length) PURPOSES = r.purposes;
  }
  renderRules();
}

function summary(r: Rule): Child[] {
  const when: string[] = [];
  if (r.match.purpose) when.push(`${r.match.purpose} requests`);
  if (r.match.requester) when.push(`from ${r.match.requester}`);
  if (r.match.ethics_approved) when.push('ethics-approved');
  if (r.match.audit_certified) when.push('with certified study code');
  if (r.match.sponsor_verified) when.push('from a verified sponsor');
  if (r.match.reputation_at_least !== undefined) when.push(`reputation at least ${r.match.reputation_at_least}`);
  if (r.match.price_below !== undefined) when.push(`paying under $${r.match.price_below}`);
  const head = when.length ? when.join(', ') : 'Any request';
  const verb = { join: 'join', ask: 'ask me first', decline: 'decline' }[r.decision];
  const out: Child[] = [h('b', {}, head[0]!.toUpperCase() + head.slice(1)), ' → ', h('b', {}, verb)];
  if (r.decision === 'join') {
    const bits = [];
    if (r.allow_fields?.length) bits.push(`share ${r.allow_fields.map(nice).join(', ')}`);
    if (r.deny_fields?.length) bits.push(`never ${r.deny_fields.map(nice).join(', ')}`);
    if (r.min_price_usd) bits.push(`at least $${r.min_price_usd}`);
    if (r.retention === 'none') bits.push('nothing kept');
    if (r.grant_hours) bits.push(`keys for ${r.grant_hours} h`);
    if (bits.length) out.push(': ', bits.join('; '));
  }
  out.push('.');
  return out;
}

function seg(value: Decision, onPick: (d: Decision) => void) {
  return h('div', { class: 'seg', role: 'group' }, ...(['join', 'ask', 'decline'] as Decision[]).map((d) =>
    h('button', { type: 'button', class: d, 'aria-pressed': String(value === d), onclick: () => onPick(d) }, { join: 'Join', ask: 'Ask me', decline: 'Decline' }[d])));
}

function toggle(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  return h('label', { class: 'toggle' }, input, label);
}

function ruleCard(r: Rule, i: number, all: Rule[]) {
  const redraw = () => renderRules();
  const set = (k: string, v: string | boolean | number | undefined) => { if (v === undefined || v === '' || v === false) delete r.match[k]; else r.match[k] = v; redraw(); };
  const purpose = h('select', { onchange: (e: Event) => set('purpose', (e.target as HTMLSelectElement).value) },
    h('option', { value: '' }, 'any purpose'), ...PURPOSES.map((p) => h('option', { value: p.name, selected: r.match.purpose === p.name }, p.within ? `  ${p.label} (part of ${p.within})` : p.label)));
  const requester = h('input', { type: 'text', value: String(r.match.requester ?? ''), placeholder: 'any agent, or e.g. gp.example', onchange: (e: Event) => set('requester', (e.target as HTMLInputElement).value.trim()) });
  // Each field cycles: not mentioned → share → never.
  const fieldChip = (f: string) => {
    const state = r.allow_fields?.includes(f) ? 'share' : r.deny_fields?.includes(f) ? 'never' : 'neutral';
    return h('button', { type: 'button', class: `chip ${state}`, title: 'Tap to cycle: not mentioned → share → never', onclick: () => {
      r.allow_fields = (r.allow_fields ?? []).filter((x) => x !== f);
      r.deny_fields = (r.deny_fields ?? []).filter((x) => x !== f);
      if (state === 'neutral') r.allow_fields.push(f);
      else if (state === 'share') r.deny_fields.push(f);
      if (!r.allow_fields.length) delete r.allow_fields;
      if (!r.deny_fields.length) delete r.deny_fields;
      redraw();
    } }, state === 'share' ? '✓ ' : state === 'never' ? '✕ ' : '', nice(f));
  };
  const below = h('input', { type: 'number', min: '0.5', step: '0.5', value: r.match.price_below ?? '', placeholder: 'any price', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; set('price_below', v === '' ? undefined : Number(v)); } });
  const price = h('input', { type: 'number', min: '0', step: '0.5', value: r.min_price_usd ?? '', placeholder: 'any', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v === '') delete r.min_price_usd; else r.min_price_usd = Number(v); redraw(); } });
  const hours = h('input', { type: 'number', min: '1', max: '720', value: r.grant_hours ?? '', placeholder: '48', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v === '') delete r.grant_hours; else r.grant_hours = Number(v); redraw(); } });
  const move = (d: number) => { const j = i + d; if (j < 0 || j >= all.length) return; [all[i], all[j]] = [all[j]!, all[i]!]; redraw(); };
  return h('div', { class: 'rule' },
    h('div', { class: 'head' }, h('span', { class: 'count' }, `Rule ${i + 1}`),
      h('div', { class: 'tools' },
        h('button', { class: 'btn small', type: 'button', onclick: () => move(-1), disabled: i === 0, 'aria-label': 'Move up' }, '↑'),
        h('button', { class: 'btn small', type: 'button', onclick: () => move(1), disabled: i === all.length - 1, 'aria-label': 'Move down' }, '↓'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => { all.splice(i, 1); redraw(); } }, 'Remove'))),
    h('p', { class: 'sum' }, ...summary(r)),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', {}, 'When the purpose is'), purpose),
      h('div', { class: 'field' }, h('label', {}, 'From'), requester),
      h('div', { class: 'field' }, h('label', {}, 'Paying less than ($)'), below),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Only if'),
        toggle('an ethics body I trust approved it', !!r.match.ethics_approved, (v) => set('ethics_approved', v || undefined)),
        toggle('an auditor I trust certified the study', !!r.match.audit_certified, (v) => set('audit_certified', v || undefined)),
        toggle('the sponsor is verified', !!r.match.sponsor_verified, (v) => set('sponsor_verified', v || undefined))),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Then'), seg(r.decision, (d) => { r.decision = d; redraw(); })),
    ),
    r.decision === 'join' ? h('div', { class: 'grid2', style: 'margin-top:14px' },
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Fields (tap to cycle)'), h('div', {}, ...FIELDS.map((f) => fieldChip(f.name)))),
      h('div', { class: 'field' },
        h('label', {}, 'At least ($ per study)'), price,
        h('div', { style: 'height:10px' }),
        toggle('they keep nothing after the study', r.retention === 'none', (v) => { if (v) r.retention = 'none'; else delete r.retention; redraw(); }),
        h('div', { style: 'height:10px' }),
        h('label', {}, 'Key lasts (hours)'), hours),
    ) : null,
  );
}

function chipsEditor(values: string[], placeholder: string, onChange: (v: string[]) => void) {
  const input = h('input', { type: 'text', placeholder }) as HTMLInputElement;
  input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) { onChange([...values, input.value.trim()]); } };
  return h('div', {}, ...values.map((v) => h('button', { type: 'button', class: 'chip', title: 'Remove', onclick: () => onChange(values.filter((x) => x !== v)) }, v, ' ✕')), input);
}

function renderRules(message?: { ok: boolean; text: string }) {
  const r = draft!;
  const trust = (r.trust ??= {});
  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save my rules');
  save.onclick = async () => {
    save.disabled = true;
    const clean = structuredClone(r);
    if (clean.trust && !Object.values(clean.trust).some((v) => v?.length)) delete clean.trust;
    const res = await call<{ ok: boolean; error?: string }>({ kind: 'panel.rules.set', text: stringify(clean) });
    renderRules(res.ok ? { ok: true, text: 'Saved in your pod. Your housekeeper uses these rules from now on.' } : { ok: false, text: res.error ?? 'not saved' });
  };
  boxFor('rules').replaceChildren(
    h('p', { class: 'lede' }, 'Your housekeeper follows these, top to bottom; the first rule that fits decides. They run as code, and nothing an agent writes can change them.'),
    ...r.rules.map((rule, i) => ruleCard(rule, i, r.rules)),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', onclick: () => { r.rules.push({ match: { purpose: 'research' }, decision: 'ask' }); renderRules(); } }, '+ Add a rule')),
    h('h2', {}, 'Everything else'),
    h('div', { class: 'card', style: 'max-width:820px' },
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'When no rule fits'), seg(r.default, (d) => { r.default = d; renderRules(); })),
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Bargaining'), toggle('bargain together with neighbours (a bloc gets better terms)', !!r.negotiation?.join_collectives, (v) => { r.negotiation = { ...(r.negotiation ?? {}), join_collectives: v }; renderRules(); })),
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Your house in public'), toggle('say what kinds of data my house holds (so agents with matching offers can find it)', r.privacy?.show_packs !== false, (v) => { if (v) delete r.privacy; else r.privacy = { show_packs: false }; renderRules(); })),
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'My interests (for guilds)'), chipsEditor(r.tags ?? [], 'add, then Enter', (v) => { r.tags = v; renderRules(); })),
      )),
    h('h2', {}, 'Whose word counts'),
    h('div', { class: 'card', style: 'max-width:820px' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'Approvals and signatures count only from these domains. Anyone else’s counts as none.'),
      h('div', { class: 'grid2' }, ...(['ethics', 'auditors', 'issuers', 'payments'] as const).map((k) =>
        h('div', { class: 'field' }, h('span', { class: 'lab' }, { ethics: 'Ethics bodies', auditors: 'Auditors', issuers: 'Record issuers', payments: 'Payments' }[k]),
          chipsEditor(trust[k] ?? [], 'domain, then Enter', (v) => { trust[k] = v; renderRules(); }))))),
    h('details', { style: 'margin-top:16px;max-width:820px' }, h('summary', { class: 'muted' }, 'See it as rules.yaml'), h('pre', {}, stringify(r))),
    h('div', { class: 'savebar' }, save,
      h('button', { class: 'btn', type: 'button', onclick: async () => { draft = null; await rules(boxFor('rules')); } }, 'Undo changes'),
      message ? h('span', { class: `msg ${message.ok ? 'ok' : 'bad'}` }, message.text) : null),
  );
}

// ---- Offers ----
type Term = { kind: string; label: string; options: (string | number)[]; unit?: string; names?: Record<string, string> };
type Offer = {
  id: string; pack: string; quoter: { name: string; domain: string }; title: string; status: string; groupSize: number; fee?: number; currency?: string;
  result: { eligible: boolean; outputs: Record<string, number> }; labels?: Record<string, { label: string; unit?: string }>; answer?: Record<string, unknown>;
};
const isCurrency = (unit?: string) => !!unit && /^[A-Z]{3}$/.test(unit);
// In the reader's own locale: an Australian browser shows $1,269, a British one A$1,269.
const money0 = (n: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
const fmt = (v: number, unit?: string) => (isCurrency(unit) ? money0(v, unit) : unit === '%' ? `${v}%` : unit === 'yes/no' ? (v ? 'yes' : 'no') : String(v));
/** One choice of an intent term, as the owner reads it: a price range in its currency, a state's name. */
const choice = (t: Term | undefined, x: string | number) =>
  t?.kind === 'band' && isCurrency(t.unit) ? String(x).split('-').map((y) => money0(Number(y), t.unit)).join('–') : t?.names?.[String(x)] ?? String(x);

async function offers(box: HTMLElement) {
  const m = await call<{ intents: { pack: string; terms: Record<string, string | number>; members: number; group: string }[]; offers: Offer[]; packs: { id: string; title: string; terms: Record<string, Term> }[] }>({ kind: 'panel.market' });
  if (!m.packs.length) return void box.replaceChildren(h('p', { class: 'muted' }, 'This house takes part in no use case that has offers yet.'));
  const blocks: Child[] = [h('p', { class: 'lede' }, 'Say what you’re looking for. Authorised agents price it inside your house, on your own data, and only you see the result. Nothing leaves until you accept.')];
  for (const p of m.packs) {
    const intent = m.intents.find((i) => i.pack === p.id);
    if (!intent) {
      // The form: the pack's coarse terms, each a choice, plus "work it out for me" where the pack can.
      const selects = Object.entries(p.terms).map(([k, t]) => {
        const sel = h('select', { name: k }, ...(t.kind === 'band' ? [h('option', { value: 'auto' }, 'What I can afford (worked out in my house)')] : []), ...t.options.map((o) => h('option', { value: String(o) }, choice(t, o))));
        return h('div', { class: 'field' }, h('label', {}, t.label), sel);
      });
      const go = h('button', { class: 'btn primary', type: 'button' }, `Ask for ${p.title.toLowerCase()}`);
      go.onclick = async () => {
        go.disabled = true;
        const terms = Object.fromEntries(selects.map((d) => { const s = d.querySelector('select')!; return [s.name, /^\d+$/.test(s.value) ? Number(s.value) : s.value]; }));
        const r = await call<{ error?: string }>({ kind: 'panel.intent.open', pack: p.id, terms }).catch((e) => ({ error: (e as Error).message }));
        if (r.error) { alert(r.error); go.disabled = false; } else void show();
      };
      blocks.push(h('div', { class: 'card', style: 'max-width:820px' }, h('h3', {}, p.title), h('div', { class: 'grid2', style: 'margin-top:12px' }, ...selects), h('div', { style: 'margin-top:14px' }, go)));
      continue;
    }
    const mine = m.offers.filter((o) => o.pack === p.id);
    const eligible = mine.filter((o) => o.result.eligible);
    const stop = h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.intent.close', pack: p.id }); void show(); } }, 'Stop looking');
    blocks.push(h('div', { class: 'card ok', style: 'max-width:820px' },
      h('h3', {}, `Looking for ${p.title.toLowerCase()}`),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, `${Object.entries(intent.terms).map(([k, x]) => `${p.terms[k]?.label ?? k}: ${choice(p.terms[k], x)}`).join(' · ')}`),
      h('div', { class: 'r-meta' }, `${intent.members} household${intent.members === 1 ? '' : 's'} in your group · ${mine.length} lender${mine.length === 1 ? '' : 's'} priced it · ${eligible.length} offer${eligible.length === 1 ? '' : 's'} for you`),
      h('div', { style: 'margin-top:12px' }, stop)));
    if (!mine.length) blocks.push(h('p', { class: 'muted' }, 'Waiting for authorised lenders to price it…'));
    for (const o of mine) {
      const out = o.result.outputs;
      const lab = (k: string) => o.labels?.[k] ?? { label: k };
      const head = o.result.eligible ? h('div', { class: 'r-title', style: 'font-size:22px;font-family:var(--f-display)' }, `${out.rate}%`, h('span', { class: 'muted', style: 'font-size:14px;margin-left:10px;font-family:var(--f-body)' }, `${fmt(out.monthly ?? 0, lab('monthly').unit)} a month`)) : h('div', { class: 'r-title muted' }, 'Not for you this time');
      const accept = h('button', { class: 'btn allow', type: 'button' }, o.status === 'accepted' ? 'Accepted' : 'Accept');
      if (o.status === 'accepted' || !o.result.eligible || eligible.some((x) => x.status === 'accepted')) accept.disabled = true;
      accept.onclick = async () => {
        if (!confirm(`Accept ${o.quoter.name}'s offer? Your signed record goes to them, and only them, so they can confirm it.`)) return;
        accept.disabled = true;
        const r = await call<Offer & { error?: string }>({ kind: 'panel.offer.accept', offer: o.id }).catch((e) => ({ error: (e as Error).message }) as never);
        if (r.error) alert(r.error);
        void show();
      };
      blocks.push(h('article', { class: 'req', style: `border-color:${o.result.eligible ? 'var(--mint)' : 'var(--line)'};background:none` },
        h('div', { class: 'who', style: 'font-size:16px' }, o.quoter.name, (out.group_off ?? 0) > 0 ? h('span', { class: 'chip share', style: 'margin-left:8px' }, `group rate −${out.group_off}%`) : ''),
        head,
        // Every other output the program declares, by its own labels; the headline ones are above, and zeros say nothing.
        o.result.eligible ? h('dl', { class: 'facts' }, ...Object.keys(out).filter((k) => !['rate', 'monthly', 'group_off'].includes(k) && out[k]).map((k) => h('div', {}, h('dt', {}, lab(k).label), h('dd', {}, fmt(out[k]!, lab(k).unit)))),
          o.fee ? h('div', {}, h('dt', {}, 'Pays you'), h('dd', {}, `${money0(o.fee, o.currency)} if you accept`)) : '') : '',
        o.answer ? h('p', { class: 'advice' }, h('b', {}, o.quoter.name), String(o.answer.kind === 'agreed' ? `Yes: ${o.answer.what ?? 'agreed'}. ${o.answer.feePaid ? `${money0(Number(o.answer.feePaid), o.currency)} paid to you.` : ''} Next: ${o.answer.next ?? ''}` : o.answer.why ?? o.answer.kind)) : '',
        o.result.eligible ? h('div', { class: 'actions', style: 'grid-template-columns:1fr' }, accept) : ''));
    }
  }
  box.replaceChildren(...blocks.filter((b): b is Node | string => !!b));
}

// ---- Agents ----
async function agents(box: HTMLElement) {
  const list = await call<{ agent: string; knocks: number; last: string; lastDecision?: string; blocked: number; reputation: number | null }[]>({ kind: 'panel.agents' });
  // Keys that never proved who they are and only got blocked are noise next to real visitors: fold them away.
  const junk = list.filter((a) => a.agent.startsWith('key:') && a.blocked && !a.knocks);
  const row = (a: (typeof list)[number]) => h('li', {},
      h('div', {}, h('div', { class: 'r-title' }, a.agent.replace(/^agent:/, '').replace(/^key:/, 'unverified key ')),
        h('div', { class: 'r-meta' }, `${a.knocks} knock${a.knocks === 1 ? '' : 's'} · last ${time(a.last)}${a.lastDecision ? ` · you said ${a.lastDecision}` : ''}${a.blocked ? ` · ${a.blocked} blocked` : ''}`)),
      h('div', { class: 'r-meta' }, a.reputation === null ? (a.blocked ? 'blocked' : '') : h('span', {}, `reputation ${a.reputation}`, h('span', { class: 'rep' }, h('i', { style: `width:${Math.round(a.reputation * 100)}%` })))));
  const real = list.filter((a) => !junk.includes(a));
  box.replaceChildren(
    h('p', { class: 'lede' }, 'Every agent that has come to your door lately, what your house told it, and how it behaves across the Lake.'),
    real.length ? h('ul', { class: 'rows' }, ...real.map(row)) : h('p', { class: 'muted' }, 'No visitors yet.'),
    junk.length ? h('details', { class: 'fold' }, h('summary', { class: 'muted' }, `${junk.length} unproven key${junk.length === 1 ? '' : 's'} tried something and ${junk.length === 1 ? 'was' : 'were'} blocked`), h('ul', { class: 'rows' }, ...junk.map(row))) : '',
  );
}

// ---- My agent ----
/** The code you hand your agent, kept here so a refresh doesn't wipe it while you copy it. */
let invite: { msg: string; until: number } | null = null;

/** Your own AI agent, inside your house: a key that may look and suggest, never decide. */
async function myagent(box: HTMLElement) {
  const v = await call<{ assistants: { kid: string; label: string; addedAt: string }[]; suggestions: { id: string; from: string; text: string; at: string }[] }>({ kind: 'list' });
  const houseUrl = location.origin + location.pathname.replace(/\/owner\/.*$/, '');
  if (invite && invite.until < Date.now()) invite = null;
  const give = h('button', { class: 'btn primary', type: 'button' }, v.assistants.length ? 'Give another agent a key' : 'Give my AI agent a key');
  give.onclick = async () => {
    give.disabled = true;
    const r = await call<{ code: string; until: string }>({ kind: 'panel.assistant.invite', label: 'my assistant' });
    invite = { msg: `Connect to my house as my assistant: use lake_house_connect with house_url ${houseUrl} and code ${r.code}. Then look around inside and tell me what you see.`, until: Date.parse(r.until) };
    void show();
  };
  const code = invite ? (() => {
    const text = h('textarea', { readonly: true, rows: 5, class: 'copybox' }) as HTMLTextAreaElement;
    text.value = invite.msg;
    text.onfocus = () => text.select();
    const copy = h('button', { class: 'btn small', type: 'button' }, 'Copy');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(invite!.msg); copy.textContent = 'Copied ✓'; } catch { text.focus(); text.select(); copy.textContent = 'Selected: copy it'; }
    };
    const mins = Math.max(1, Math.round((invite.until - Date.now()) / 60_000));
    return h('div', { class: 'card' }, h('h3', {}, 'Paste this to your AI agent'),
      h('p', { class: 'muted' }, `It needs the Lake connector. The code works once, for the next ${mins} minute${mins === 1 ? '' : 's'}.`), text, copy);
  })() : '';
  box.replaceChildren(
    h('p', { class: 'lede' }, 'Give your own AI agent a key to your house. It can look at everything (requests, offers, visitors, your data) and suggest what to do. It can never decide: only your key can Allow, change your rules, accept an offer or revoke a key.'),
    code || give,
    v.assistants.length
      ? h('div', {}, h('h2', {}, 'Connected'), h('ul', { class: 'rows' }, ...v.assistants.map((a) => h('li', {},
          h('div', {}, h('div', { class: 'r-title' }, a.label.replace(/\s*\(.*\)$/, '')), h('div', { class: 'r-meta' }, `since ${time(a.addedAt)} · can look and suggest`)),
          h('button', { class: 'btn danger small', type: 'button', onclick: async () => { await call({ kind: 'panel.assistant.revoke', kid: a.kid }); void show(); } }, 'Revoke')))))
      : h('p', { class: 'muted', style: 'margin-top:14px' }, 'No agent connected yet.'),
    h('h2', {}, 'What it suggests'),
    v.suggestions.length ? suggestionList(v.suggestions) : h('p', { class: 'muted' }, 'Nothing yet. Its suggestions show up here and on Home.'),
  );
}

function suggestionList(list: { id: string; from: string; text: string; at: string }[]): Node {
  return h('ul', { class: 'rows' }, ...list.map((x) => h('li', {},
    h('div', {}, h('div', { class: 'r-title' }, x.text), h('div', { class: 'r-meta' }, `${x.from} · ${time(x.at)}`)),
    h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.assistant.dismiss', id: x.id }); void show(); } }, 'Dismiss'))));
}

// ---- Money ----
async function money(box: HTMLElement) {
  const m = await call<{ total: number; receipts: { amount: number; currency: string; agreement: string; from: string; payer?: string; at: string; settlement: string }[] }>({ kind: 'panel.money' });
  box.replaceChildren(
    h('dl', { class: 'tiles' }, h('div', { class: 'tile mint' }, h('dt', {}, 'Earned'), h('dd', {}, `$${m.total}`)), h('div', { class: 'tile' }, h('dt', {}, 'Receipts'), h('dd', {}, String(m.receipts.length)))),
    h('p', { class: 'lede' }, 'Every payment comes with a receipt signed by a payments agent you trust, filed in your pod. In the sandbox, settlement is simulated.'),
    m.receipts.length ? h('ul', { class: 'rows', style: 'margin-top:14px' }, ...m.receipts.map((r) => h('li', {},
      h('div', { title: r.agreement }, h('div', { class: 'r-title' }, r.payer ? `$${r.amount} from ${who(r.payer)}` : `$${r.amount}`), h('div', { class: 'r-meta' }, `${new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · signed by ${who(r.from)} · ${r.settlement}`)),
      h('span', { class: 'chip share' }, 'signed'))))
      : h('p', { class: 'muted' }, 'No payments yet.'),
  );
}

// ---- Data ----
async function data(box: HTMLElement) {
  type Source = { pack: string; title: string; folder: string; issuer: string | null; converter: string; certifiedBy: string | null; ok: boolean; why?: string };
  const d = await call<{ claims: { field: string; label?: string; value: string; code?: string; observedAt?: string }[]; record: { ok: boolean; why?: string }; sources: Source[]; folders: Record<string, number> }>({ kind: 'panel.data' });
  const by = new Map<string, typeof d.claims>();
  for (const c of d.claims) by.set(c.label ?? nice(c.field), [...(by.get(c.label ?? nice(c.field)) ?? []), c]);
  box.replaceChildren(
    h('p', { class: 'lede' }, 'What your house holds. It never leaves: programs run here, and only what you agreed to comes out.'),
    h('h2', {}, 'Where it came from'),
    ...d.sources.map((s) => h('div', { class: `card ${s.ok ? 'ok' : 'bad'}`, style: 'max-width:820px' },
      h('h3', {}, s.title),
      h('dl', { class: 'facts' },
        ...([['Signed by', s.issuer ?? 'unknown'], ['Converted by', s.converter], ['Certified by', s.certifiedBy ?? 'not certified'], ['Kept in', `/${s.folder}`], ['Check', s.ok ? 'every signature verifies, and the claims pass their shapes' : s.why ?? 'failed']] as [string, string][])
          .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))))),
    h('h2', {}, 'Claims'),
    ...[...by].map(([label, cs]) => h('div', { class: 'card', style: 'max-width:820px' }, h('h3', {}, label),
      h('div', { style: 'margin-top:8px' }, ...cs.map((c) => h('span', { class: 'chip' }, c.value, c.observedAt ? ` · ${new Date(c.observedAt).toLocaleDateString()}` : ''))))),
    h('h2', {}, 'Folders in your pod'),
    h('ul', { class: 'rows' }, ...Object.entries(d.folders).map(([f, n]) => h('li', {}, h('div', { class: 'r-title' }, `/${f}`), h('span', { class: 'count' }, `${n} item${n === 1 ? '' : 's'}`)))),
  );
}

// ---- Move house ----
async function move(box: HTMLElement) {
  const btn = h('button', { class: 'btn primary', type: 'button' }, 'Download everything');
  const note = h('p', { class: 'muted' });
  btn.onclick = async () => {
    btn.disabled = true;
    note.textContent = 'Collecting every file in your pod…';
    const x = await call<{ files: Record<string, string>; webId: string }>({ kind: 'panel.export' });
    const blob = new Blob([JSON.stringify(x, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `my-house-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    note.textContent = `${Object.keys(x.files).length} files downloaded, including your agreements, receipts, audit log and wallet. Keep it safe: your wallet is in there.`;
    btn.disabled = false;
  };
  box.replaceChildren(
    h('p', { class: 'lede' }, 'Your house is yours. Take everything with you, to another host or to your own machine, whenever you like. No one can stop you.'),
    h('div', { class: 'savebar', style: 'position:static' }, btn), note,
  );
}

// ---- start ----
async function refreshBadge() {
  try {
    const v = await call<{ requests: Request[] }>({ kind: 'list' });
    if (v.requests.some((r) => !pendingSeen.has(r.id))) navigator.vibrate?.([120, 60, 120]);
    pendingSeen = new Set(v.requests.map((r) => r.id));
    if (pending !== v.requests.length) { pending = v.requests.length; renderNav(); }
    $('status').className = 'dot live';
  } catch {
    $('status').className = 'dot down';
  }
}

addEventListener('hashchange', () => { const t = TABS.find(([id]) => id === location.hash.slice(1))?.[0]; if (t && t !== tab && webId) go(t); });
$('pair-btn').onclick = async () => { if (await pair()) start(); };

function start() {
  $('pair').hidden = true;
  $('view').hidden = false;
  $('who').textContent = webId;
  void call({ kind: 'panel.overview' }).then((o) => { houseName = o.name; $('title').textContent = `House ${o.name}`; }).catch(() => {});
  renderNav();
  void show();
  void refreshBadge();
  void call<{ packs: unknown[] }>({ kind: 'panel.market' }).then((m) => { if (!m.packs?.length) { unused.add('offers'); renderNav(); } }).catch(() => {});
  setInterval(refreshBadge, 1500);
  // Live tabs refresh themselves; the rules editor never overwrites what you're typing.
  // Never while you're typing, choosing or selecting something: a refresh would wipe it.
  const busy = () => !!document.querySelector('select:focus, input:focus, textarea:focus') || !!window.getSelection()?.toString();
  setInterval(() => { if (['home', 'requests', 'keys', 'offers', 'myagent', 'agents'].includes(tab) && !document.hidden && !busy()) void show(); }, 3000);
}

// Already paired? A signed "list" answers. Otherwise offer to pair (automatically when the link carries a token).
call({ kind: 'list' }).then((v) => { webId = v.webId; leaseUntil = v.until ?? null; start(); }).catch(async () => {
  $('pair').hidden = false;
  if (location.hash.includes('pair=') && (await pair())) start();
});
