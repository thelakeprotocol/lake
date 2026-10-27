import './approvals.css';
import { stringify } from 'yaml';
import QRCode from 'qrcode';
import { loadKey, signCredential, signEnvelope } from './owner-crypto';

// The control panel that comes with every house (open source). Served by the house at /owner/; every
// call is signed on this device with the owner's key, which never leaves it.

interface Request { id: string; offerId: string; visitor: { webId: string; domain: string }; purpose: string; fields: string[]; retention: string; priceUsd: number; study: string | null; question?: string; warnings?: string[]; note?: string; asked?: number; recommendation: string; grantDraft?: unknown }
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
  const [o, feed, { suggestions, assistants, notes, agenda }, door, free] = await Promise.all([
    call({ kind: 'panel.overview', tz_offset: new Date().getTimezoneOffset() }),
    call<{ at: string; kind: string; text: string }[]>({ kind: 'panel.activity' }),
    call<{ suggestions: Note[]; assistants: { label: string }[]; notes: { id: string; from: { name: string; domain: string; checked?: boolean; speaks_for?: { house: string; checked: boolean } }; text: string; at: string }[]; agenda?: AgendaItem[] }>({ kind: 'list' }),
    call<{ open: boolean; address: string; error?: string }>({ kind: 'panel.door' }).then((d) => (d.error ? null : d)).catch(() => null),
    call<{ set?: boolean }>({ kind: 'panel.free' }).catch(() => ({ set: false })),
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
    startCard(door, assistants.length > 0, !!free.set),
    suggestions.length ? h('div', { class: 'card' }, h('h3', {}, 'Your agent suggests'), suggestionList(suggestions)) : '',
    // What you agreed to, written in by your agent: yours to see and remove.
    agenda?.length ? agendaCard(agenda) : '',
    // Notes other agents left at your door: their words, nothing asked of your data. Your agent hears of them too.
    notes?.length ? h('div', { class: 'card' }, h('h3', {}, 'Notes at your door'), h('ul', { class: 'rows' }, ...notes.map((n) => h('li', {},
      h('div', {}, h('div', { class: 'r-title' }, `“${n.text}”`), h('div', { class: 'r-meta' }, `${n.from.name} (${n.from.domain}${n.from.checked ? ', domain proved' : ': not verified, anyone could send this'})${n.from.speaks_for ? (n.from.speaks_for.checked ? ` · the assistant of ${n.from.speaks_for.house.replace(/\/profile\/card#me$/, '')}: that house says so` : ' · says it speaks for a house, with nothing to show it') : ''} · ${time(n.at)} · their words`)),
      h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.note.dismiss', id: n.id }); void show(); } }, 'Dismiss'), ' ',
        h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.note.mute', id: n.id }); void show(); } }, 'Don\'t hear from them again')))))) : '',
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
      // The key is cut here, on this device, with your key: the house drafted the grant (a Solid Access Grant saying exactly
      // what you were shown), this device dates and signs it, and the house only checks it.
      const draft = structuredClone(q.grantDraft) as { credentialSubject: { providedConsent: { hasStatus: string } } };
      // The draft asks; signing it here is the owner giving consent.
      draft.credentialSubject.providedConsent.hasStatus = 'https://w3id.org/GConsent#ConsentStatusExplicitlyGiven';
      const grant = signCredential({ ...draft, issuer: webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 48 * 3_600_000).toISOString() }, key);
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

// ---- Keys: who you've said yes to ----
/** One consent record from your pod (ISO/IEC TS 27560 in DPV terms), as the house reads it for you. */
interface Consent {
  id: string; visitor: string; fields: { name: string; label: string }[]; purpose: string; purposeLabel: string; given: string; until: string; retention: string;
  how: { live?: true; rule?: number | null }; status: 'active' | 'withdrawn' | 'used' | 'ended'; withdrawnAt?: string;
}
const dayTime = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function keys(box: HTMLElement) {
  const [v, consents] = await Promise.all([call<{ keys: Key[] }>({ kind: 'list' }), call<Consent[]>({ kind: 'panel.consents' })]);
  // Taking a consent back is revoking its key: the house marks the record withdrawn, with the date.
  const takeBack = (id: string) => async (e: Event) => { (e.target as HTMLButtonElement).disabled = true; await call({ kind: 'revoke', revoke: id }).catch((x) => alert((x as Error).message)); void show(); };
  const row = (c: Consent) => h('li', {},
    h('div', {},
      h('div', { class: 'r-title' }, `${c.visitor}, for ${c.purposeLabel}`),
      h('div', { style: 'margin-top:6px' }, ...c.fields.map((f) => h('span', { class: 'chip' }, f.label))),
      h('div', { class: 'r-meta' }, [
        c.how.live ? 'you tapped Allow' : c.how.rule ? `your rule ${c.how.rule} said yes` : 'one of your rules said yes',
        c.retention === 'none' ? 'they keep nothing' : `they keep it for ${duration(c.retention)}`,
        { active: `until ${dayTime(c.until)} (${hoursLeft(c.until)} left)`, withdrawn: c.withdrawnAt ? `you took it back on ${dayTime(c.withdrawnAt)}` : 'you took it back', used: 'used once, can’t be used again', ended: `ended ${dayTime(c.until)}` }[c.status],
      ].join(' · '))),
    c.status === 'active'
      ? h('button', { class: 'btn danger small', type: 'button', onclick: takeBack(c.id) }, 'Take it back')
      : h('span', { class: `chip ${c.status === 'withdrawn' ? '' : 'neutral'}` }, { withdrawn: 'taken back', used: 'used', ended: 'ended' }[c.status]));
  // Keys with no consent record beside them (cut before records were kept): still yours to revoke.
  const recorded = new Set(consents.map((c) => c.id));
  const loose = v.keys.filter((k) => !recorded.has(k.id));
  const live = consents.filter((c) => c.status === 'active').length + loose.length;
  // A long history folds away on a phone; the newest stay in sight.
  const [recent, older] = [consents.slice(0, 20), consents.slice(20)];
  box.replaceChildren(
    h('p', { class: 'lede' }, 'Everyone you’ve said yes to, newest first: who, what, for what, and how. Take one back and they’re cut off on their next request; your pod keeps the record, with the day you took it back.'),
    consents.length ? h('ul', { class: 'rows' }, ...recent.map(row)) : h('p', { class: 'muted' }, 'You haven’t said yes to anyone yet.'),
    older.length ? h('details', { class: 'fold' }, h('summary', { class: 'muted' }, `${older.length} older`), h('ul', { class: 'rows' }, ...older.map(row))) : '',
    loose.length ? h('div', {}, h('h2', {}, 'Other keys'), h('ul', { class: 'rows' }, ...loose.map((k) => h('li', {},
      h('div', {}, h('div', { class: 'r-title' }, `${k.visitor} · ${k.purpose}`), h('div', { class: 'r-meta' }, `${k.fields.map(nice).join(', ')} · ${hoursLeft(k.until)} left · ${k.authorizedBy}`)),
      h('button', { class: 'btn danger small', type: 'button', onclick: takeBack(k.id) }, 'Revoke'))))) : '',
    live ? h('div', { class: 'savebar' }, h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Take back every key to your house?')) { await call({ kind: 'revoke', revoke: 'all' }); void show(); } } }, 'Take every key back')) : '',
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
  if (r.match.asks_identifying) when.push('asking for anything that identifies you');
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

/**
 * Your door (SPEC §9.0): open it to give your house's address out, in a signature or as a QR code, so people's AI can knock
 * or leave a note. The address is the identifier; a name only if you add one. Saved in your rules, like any setting.
 */
function doorCard(): HTMLElement {
  const box = h('div', { class: 'card', style: 'max-width:820px;margin-bottom:18px' }, h('p', { class: 'muted' }, 'Your door…'));
  void (async () => {
    const d = await call<{ open: boolean; about?: string; name?: string; address: string; error?: string }>({ kind: 'panel.door' }).catch(() => ({ error: 'no door' }) as never);
    if (d.error) return void box.remove();
    const about = h('input', { type: 'text', maxlength: '200', placeholder: 'One line, e.g. "Ask my agent about work, or about meeting up."', value: d.about ?? '', style: 'width:100%' }) as HTMLInputElement;
    const name = h('input', { type: 'text', maxlength: '60', placeholder: 'Optional: the address is enough', value: d.name ?? '', style: 'width:100%' }) as HTMLInputElement;
    const msg = h('span', { class: 'muted' });
    const save = async (open: boolean) => {
      const r = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.door.set', open, about: about.value, name: name.value });
      if (!r.ok) return void (msg.textContent = r.error ?? 'not saved');
      draft = null;
      void show();
    };
    const qr = d.open ? h('img', { alt: 'A QR code of your house address', width: '150', height: '150', src: await QRCode.toDataURL(d.address, { margin: 1, width: 300 }) }) : '';
    box.replaceChildren(
      h('h3', {}, d.open ? 'Your door is open' : 'Your door is closed'),
      h('p', { class: 'muted' }, d.open
        ? 'Give this address out, in your signature or as this QR code. Anyone\'s AI can knock there or leave a note, and your rules answer; opened in a browser, it shows people how.'
        : 'Open it to give your house\'s address out, in your signature or as a QR code, so people can reach you through their AI. Nobody finds you by name unless you add one, and your rules still answer everything.'),
      d.open ? h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:10px 0' }, h('div', { style: 'flex:1;min-width:220px' }, h('code', { style: 'overflow-wrap:anywhere' }, d.address), h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: () => void navigator.clipboard?.writeText(d.address) }, 'Copy'))), qr) : '',
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'One line on your door'), about),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'A name to show'), name),
      h('div', {}, h('button', { class: 'btn primary small', type: 'button', onclick: () => void save(true) }, d.open ? 'Save' : 'Open my door'), ' ', d.open ? h('button', { class: 'btn small', type: 'button', onclick: () => void save(false) }, 'Close it') : '', ' ', msg),
    );
  })();
  return box;
}

/**
 * When you're free to meet: windows like "mon-fri 09:00-12:00" in your own time zone. Your agent offers those times, around
 * what is already in your agenda, instead of asking you each time. Saved in your rules.
 */
function freeCard(): HTMLElement {
  const box = h('div', { class: 'card', style: 'max-width:820px;margin-bottom:18px' }, h('p', { class: 'muted' }, 'When you\'re free…'));
  void (async () => {
    const f = await call<{ set: boolean; tz?: string; meetings?: number; slots: unknown[] }>({ kind: 'panel.free' }).catch(() => null);
    if (!f) return void box.remove();
    const r = await call<{ rules: { availability?: { tz: string; free: string[]; meetings?: number } } }>({ kind: 'panel.rules' });
    const av = r.rules.availability;
    const free = h('textarea', { rows: '3', style: 'width:100%', placeholder: 'mon-fri 09:00-12:00\nsat 10:00-11:00' }) as HTMLTextAreaElement;
    free.value = (av?.free ?? []).join('\n');
    const tz = av?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const len = h('select', {}, ...[30, 45, 60, 90].map((m) => h('option', { value: String(m), ...((av?.meetings ?? 60) === m ? { selected: true } : {}) }, `${m} minutes`))) as HTMLSelectElement;
    const msg = h('span', { class: 'muted' });
    const save = async (clear = false) => {
      const lines = free.value.split('\n').map((x) => x.trim()).filter(Boolean);
      const res = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.availability.set', availability: clear || !lines.length ? null : { tz, free: lines, meetings: Number(len.value) } });
      if (!res.ok) return void (msg.textContent = res.error ?? 'not saved');
      draft = null;
      void show();
    };
    box.replaceChildren(
      h('h3', {}, 'When you\'re free to meet'),
      h('p', { class: 'muted' }, `Your agent offers these times (in ${tz}) to people who want to meet you, around what's already in your agenda, so it doesn't have to ask you each time. One window a line, like "mon-fri 09:00-12:00".${f.set ? ` Free now: ${f.slots.length} slot${f.slots.length === 1 ? '' : 's'} in the next two weeks.` : ''}`),
      free, h('div', { style: 'margin-top:8px' }, 'Each meeting: ', len, ' ', h('button', { class: 'btn primary small', type: 'button', onclick: () => void save() }, 'Save'), ' ', av ? h('button', { class: 'btn small', type: 'button', onclick: () => void save(true) }, 'Clear') : '', ' ', msg));
  })();
  return box;
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
    doorCard(),
    freeCard(),
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
  result: { eligible: boolean; outputs: Record<string, number>; notes?: string[] }; labels?: Record<string, { label: string; unit?: string }>; answer?: Record<string, unknown>;
};
const isCurrency = (unit?: string) => !!unit && /^[A-Z]{3}$/.test(unit);
// In the reader's own locale: an Australian browser shows $1,269, a British one A$1,269.
// Whole amounts stay whole (a loan's monthly payment); a grocery total keeps its cents.
const money0 = (n: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
const fmt = (v: number, unit?: string) => (isCurrency(unit) ? money0(v, unit) : unit === '%' ? `${v}%` : unit === 'yes/no' ? (v ? 'yes' : 'no') : String(v));
/** One choice of an intent term, as the owner reads it: a price range in its currency, a state's name. */
const choice = (t: Term | undefined, x: string | number) =>
  t?.kind === 'band' && isCurrency(t.unit) ? String(x).split('-').map((y) => money0(Number(y), t.unit)).join('–') : t?.names?.[String(x)] ?? String(x);

async function offers(box: HTMLElement) {
  const m = await call<{ intents: { pack: string; terms: Record<string, string | number>; members: number; group: string; agentsTold?: number; turnedAway?: { agent: string; code: string; why: string; at: string }[]; warning?: string }[]; offers: Offer[]; packs: { id: string; title: string; terms: Record<string, Term> }[] }>({ kind: 'panel.market' });
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
      // Accepting closes the request; what you took stays here, with whether your agent has paid for it.
      const taken = m.offers.filter((o) => o.pack === p.id && o.status !== 'open');
      if (taken.length) blocks.push(h('ul', { class: 'rows', style: 'max-width:820px' }, ...taken.map((o) => { const first = Object.keys(o.result.outputs)[0]!; const lab = o.labels?.[first] ?? { label: first }; return h('li', {},
        h('div', {}, h('div', { class: 'r-title' }, `${o.quoter.name}: ${fmt(o.result.outputs[first]!, lab.unit)}`), h('div', { class: 'r-meta' }, `${lab.label} · ${o.status === 'paid' ? 'paid by your agent' : 'accepted, not paid yet'}`)),
        h('span', { class: `chip ${o.status === 'paid' ? 'share' : ''}` }, o.status)); })));
      continue;
    }
    const mine = m.offers.filter((o) => o.pack === p.id);
    const eligible = mine.filter((o) => o.result.eligible);
    const stop = h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.intent.close', pack: p.id }); void show(); } }, 'Stop looking');
    blocks.push(h('div', { class: 'card ok', style: 'max-width:820px' },
      h('h3', {}, `Looking for ${p.title.toLowerCase()}`),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, `${Object.entries(intent.terms).map(([k, x]) => `${p.terms[k]?.label ?? k}: ${choice(p.terms[k], x)}`).join(' · ')}`),
      h('div', { class: 'r-meta' }, `${intent.members} household${intent.members === 1 ? '' : 's'} in your group · ${intent.agentsTold ?? 0} agent${intent.agentsTold === 1 ? '' : 's'} told · ${mine.length} priced it · ${eligible.length} offer${eligible.length === 1 ? '' : 's'} for you`),
      // Why the board is empty, when it is: the house's own record, or the agents it turned away and why.
      intent.warning ? h('p', { style: 'margin:10px 0 0;padding:8px 12px;border-left:3px solid var(--threat)' }, `${intent.warning.charAt(0).toUpperCase()}${intent.warning.slice(1)}.`) : '',
      intent.turnedAway?.length ? h('ul', { class: 'r-meta', style: 'margin:8px 0 0 18px' }, ...intent.turnedAway.map((t) => h('li', {}, `${t.agent}: ${t.why} (${t.code}, ${new Date(t.at).toLocaleTimeString()})`))) : '',
      h('div', { style: 'margin-top:12px' }, stop)));
    if (!mine.length && !intent.warning) blocks.push(h('p', { class: 'muted' }, 'Waiting for authorised agents to price it…'));
    for (const o of mine) {
      const out = o.result.outputs;
      const lab = (k: string) => o.labels?.[k] ?? { label: k };
      // The headline: a loan's rate and monthly payment, or else the program's first output under its own label.
      const first = Object.keys(out)[0]!;
      const headline = out.rate !== undefined
        ? [`${out.rate}%`, h('span', { class: 'muted', style: 'font-size:14px;margin-left:10px;font-family:var(--f-body)' }, `${fmt(out.monthly ?? 0, lab('monthly').unit)} a month`)]
        : [fmt(out[first]!, lab(first).unit), h('span', { class: 'muted', style: 'font-size:14px;margin-left:10px;font-family:var(--f-body)' }, lab(first).label)];
      const head = o.result.eligible ? h('div', { class: 'r-title', style: 'font-size:22px;font-family:var(--f-display)' }, ...headline) : h('div', { class: 'r-title muted' }, 'Not for you this time');
      const shown = out.rate !== undefined ? ['rate', 'monthly', 'group_off'] : [first, 'group_off'];
      const accept = h('button', { class: 'btn allow', type: 'button' }, o.status === 'paid' ? 'Paid' : o.status === 'accepted' ? 'Accepted' : 'Accept');
      if (o.status === 'accepted' || o.status === 'paid' || !o.result.eligible || eligible.some((x) => x.status === 'accepted')) accept.disabled = true;
      accept.onclick = async () => {
        if (!confirm(`Accept ${o.quoter.name}'s offer? Your signed record goes to them, and only them, so they can confirm it.`)) return;
        accept.disabled = true;
        const r = await acceptOffer(o.id);
        if (r.error) alert(r.error);
        void show();
      };
      blocks.push(h('article', { class: 'req', style: `border-color:${o.result.eligible ? 'var(--mint)' : 'var(--line)'};background:none` },
        h('div', { class: 'who', style: 'font-size:16px' }, o.quoter.name, (out.group_off ?? 0) > 0 ? h('span', { class: 'chip share', style: 'margin-left:8px' }, `group rate −${out.group_off}%`) : ''),
        head,
        // Every other output the program declares, by its own labels; the headline ones are above, and zeros say nothing.
        o.result.eligible ? h('dl', { class: 'facts' }, ...Object.keys(out).filter((k) => !shown.includes(k) && out[k]).map((k) => h('div', {}, h('dt', {}, lab(k).label), h('dd', {}, fmt(out[k]!, lab(k).unit)))),
          o.fee ? h('div', {}, h('dt', {}, 'Pays you'), h('dd', {}, `${money0(o.fee, o.currency)} if you accept`)) : '') : '',
        // The quoter's notes, worked out in your house: why it's not for you, or what would change.
        o.result.notes?.length ? h('ul', { class: 'r-meta', style: 'margin:8px 0 0 18px' }, ...o.result.notes.map((n) => h('li', {}, n))) : '',
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
  const v = await call<{ assistants: Assistant[]; suggestions: Note[] }>({ kind: 'list' });
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
          h('div', {}, h('div', { class: 'r-title' }, a.label.replace(/\s*\(.*\)$/, '')),
            h('div', { class: 'r-meta' }, `since ${time(a.addedAt)} · can look and suggest${a.allowance ? ` · may spend up to ${money$(a.allowance.amount, a.allowance.currency)} until ${new Date(a.allowance.until).toLocaleDateString()}` : ''}`),
            allowanceForm(a)),
          h('button', { class: 'btn danger small', type: 'button', onclick: async () => { await call({ kind: 'panel.assistant.revoke', kid: a.kid }); void show(); } }, 'Revoke')))))
      : h('p', { class: 'muted', style: 'margin-top:14px' }, 'No agent connected yet.'),
    h('h2', {}, 'What it suggests'),
    v.suggestions.length ? suggestionList(v.suggestions) : h('p', { class: 'muted' }, 'Nothing yet. Its suggestions show up here and on Home.'),
  );
}

interface Assistant { kid: string; label: string; addedAt: string; canHaveAllowance?: boolean; allowance?: { amount: number; currency: string; until: string } }

/**
 * A spending allowance for one assistant (SPEC §6.2): the house drafts it, this device signs it with your key, and the
 * house checks it matches. Your assistant spends under it with lake_pay; payments refuse anything over it, after its
 * date, or once you take it back.
 */
function allowanceForm(a: Assistant): Node {
  if (a.allowance) {
    return h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.allowance.revoke', kid: a.kid }); void show(); } }, 'Take the allowance back');
  }
  if (!a.canHaveAllowance) return h('div', { class: 'r-meta' }, 'To give it spending money, connect it again with a new code.');
  const amount = h('input', { type: 'number', min: '1', max: '500', step: '1', value: '10', style: 'width:5em' }) as HTMLInputElement;
  // The currency the shops you use quote in: nothing converts, so an allowance pays in its own currency only.
  const currency = h('select', {}, ...CURRENCIES.map((c) => h('option', { value: c }, c))) as HTMLSelectElement;
  const days = h('select', {}, ...[1, 3, 7, 30].map((d) => h('option', { value: String(d), ...(d === 7 ? { selected: true } : {}) }, `${d} day${d === 1 ? '' : 's'}`))) as HTMLSelectElement;
  const msg = h('span', { class: 'muted' });
  const sign = h('button', { class: 'btn small', type: 'button' }, 'Sign and give') as HTMLButtonElement;
  sign.onclick = async () => {
    sign.disabled = true;
    try {
      const d = await call<{ id: string; draft: Record<string, unknown>; error?: string }>({ kind: 'panel.allowance.draft', kid: a.kid, amount: Number(amount.value), currency: currency.value, days: Number(days.value) });
      if (d.error) throw new Error(d.error);
      const credential = signCredential({ ...d.draft, validFrom: new Date().toISOString() }, loadKey());
      const r = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.allowance.set', id: d.id, credential });
      if (!r.ok) throw new Error(r.error ?? 'refused');
      void show();
    } catch (e) {
      msg.textContent = (e as Error).message;
      sign.disabled = false;
    }
  };
  return h('div', { class: 'r-meta', style: 'margin-top:6px' }, 'Spending money: ', currency, ' ', amount, ' for ', days, ' ', sign, ' ', msg);
}

/**
 * Accept an offer. More than your agent may spend: said before anything leaves (accepting releases your facts at once),
 * and the way on is one tap: raise its allowance to cover it (signed here, on this device) and accept, or pay it yourself
 * (run 48: the shop stopped at a refusal nobody could act on).
 */
async function acceptOffer(offer: string): Promise<{ error?: string; cancelled?: boolean }> {
  type R = { error?: string; code?: string; price?: { amount: number; currency: string }; allowance?: { kid: string; amount: number } };
  const accept = (even = false) => call<R>({ kind: 'panel.offer.accept', offer, ...(even ? { even_over_allowance: true } : {}) }).catch((e) => ({ error: (e as Error).message }) as R);
  const r = await accept();
  if (r.code !== 'over_allowance' || !r.price || !r.allowance) return r;
  const need = Math.min(Math.ceil(r.price.amount), 500);
  if (need >= r.price.amount && confirm(`${money$(r.price.amount, r.price.currency)} is more than your agent may spend (${money$(r.allowance.amount, r.price.currency)}).\n\nRaise its allowance to ${money$(need, r.price.currency)} for 7 days, signed on this device, and accept?`)) {
    const d = await call<{ id: string; draft: Record<string, unknown>; error?: string }>({ kind: 'panel.allowance.draft', kid: r.allowance.kid, amount: need, currency: r.price.currency, days: 7 });
    if (d.error) return d;
    const set = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.allowance.set', id: d.id, credential: signCredential({ ...d.draft, validFrom: new Date().toISOString() }, loadKey()) });
    if (!set.ok) return { error: set.error ?? 'the allowance was refused' };
    return accept();
  }
  return confirm('Accept anyway, and pay it yourself?') ? accept(true) : { cancelled: true };
}

const CURRENCIES = ['USD', 'AUD', 'EUR', 'GBP', 'CAD', 'NZD'];
const money$ = (amount: number, currency = 'USD') => (currency === 'USD' ? `$${amount}` : `${currency} ${amount}`);

type Note = { id: string; from: string; text: string; at: string; offer?: string; pledge?: { tally: string; id: string }; advice?: 'do' | 'dont' | 'your_call'; ask?: { choices: string[]; recommend?: number; answered?: string }; reply?: string; rules?: string; door?: { about: string }; note?: string; mute?: boolean };
const ADVICE_SAYS = { do: 'Your assistant advises: yes', dont: 'Your assistant advises: no', your_call: 'Your assistant says: your call' } as const;
function replyBox(x: Note): Node {
  if (x.reply) return h('div', { class: 'r-meta' }, `you wrote: “${x.reply}”`);
  const input = h('input', { type: 'text', maxlength: '500', placeholder: 'Reply in your own words', style: 'min-width:12em' }) as HTMLInputElement;
  const send = h('button', { class: 'btn small', type: 'button' }, 'Send') as HTMLButtonElement;
  send.onclick = async () => {
    if (!input.value.trim()) return;
    send.disabled = true;
    await call({ kind: 'panel.assistant.answer', id: x.id, text: input.value });
    void show();
  };
  return h('span', {}, input, ' ', send, ' ');
}

type AgendaItem = { id: string; what: string; when: string; where?: string; with?: string; note?: string; start?: string; by: string; agreed?: { by: string; said: string; speaks_for?: { house: string; checked: boolean } } };
// What you agreed to, written in by your agent, with who agreed on the other side (or that nobody has yet): yours to see,
// add to your own calendar, and remove.
/** Your agenda's private calendar address, shown on a tap, with Copy and New address. */
function feedLine(): Node {
  const feed = h('span', {});
  const showFeed = async (reset = false) => {
    const f = await call<{ url?: string; path: string }>({ kind: 'panel.agenda.feed', ...(reset ? { reset: true } : {}) });
    const url = f.url ?? new URL(f.path.replace(/^\/owner\//, ''), location.href).href;
    try { localStorage.setItem('lake.start.calendar', '1'); } catch { /* a private window */ }
    feed.replaceChildren(h('code', { style: 'overflow-wrap:anywhere' }, url), ' ', h('button', { class: 'btn small', type: 'button', onclick: () => void navigator.clipboard.writeText(url) }, 'Copy'), ' ',
      h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Make a new address? The old one stops working.')) void showFeed(true); } }, 'New address'));
  };
  return h('span', {}, h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => { (e.target as HTMLElement).remove(); void showFeed(); } }, 'Show the address'), feed);
}

const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };

/**
 * The first five minutes, on Home until done: open your door, connect your own AI, put your agenda in your calendar, and
 * try it. Each step says what it is in one line; nothing to learn first.
 */
function startCard(door: { open: boolean; address: string } | null, hasAssistant: boolean, freeSet: boolean): Node | string {
  if (stored('lake.start.done') || !door) return '';
  const calendar = !!stored('lake.start.calendar');
  if (door.open && hasAssistant && calendar && freeSet) return '';
  const step = (done: boolean, title: string, body: Node | string) => h('li', {}, h('div', {}, h('div', { class: 'r-title' }, `${done ? '✓ ' : ''}${title}`), h('div', { class: 'r-meta' }, body)));
  return h('div', { class: 'card' }, h('h3', {}, 'Start here'),
    h('ol', { class: 'rows' },
      step(door.open, 'Open your door', door.open ? h('span', {}, 'Your address, for your email signature or a QR code: ', h('code', { style: 'overflow-wrap:anywhere' }, door.address), ' ', h('button', { class: 'btn small', type: 'button', onclick: () => void navigator.clipboard.writeText(door.address) }, 'Copy')) : doorCard()),
      step(hasAssistant, 'Let your own AI look after it', hasAssistant ? 'Connected: it sees what comes to your door and suggests; you tap.' : h('span', {}, 'It answers people for you, by what you\'ve agreed, and asks you the rest. ', h('button', { class: 'btn small', type: 'button', onclick: () => go('myagent') }, 'Give it a key →'))),
      step(freeSet, 'Say when you\'re free to meet', freeSet ? 'Set: your agent offers those times, around your agenda.' : freeCard()),
      step(calendar, 'Put your agenda in your calendar', h('span', {}, 'What you agree to through your AI shows up in your own calendar app (subscribe to this address; keep it to yourself). ', feedLine())),
      step(false, 'Try it', door.open ? h('span', {}, 'Ask any AI with the Lake connector: ', h('em', {}, `“Leave a note at ${door.address} saying hello.”`), ' It shows up here, and your AI hears of it.') : 'Once your door is open.')),
    h('button', { class: 'btn small', type: 'button', onclick: () => { try { localStorage.setItem('lake.start.done', '1'); } catch { /* fine */ } void show(); } }, 'Hide this'));
}

function agendaCard(agenda: AgendaItem[]): Node {
  return h('div', { class: 'card' }, h('h3', {}, 'Coming up'), h('ul', { class: 'rows' }, ...agenda.map((a) => h('li', {},
    h('div', {}, h('div', { class: 'r-title' }, a.what),
      h('div', { class: 'r-meta' }, `${a.when}${a.where ? ` · ${a.where}` : ''}${a.with ? ` · with ${a.with}` : ''} · noted by ${a.by}`),
      h('div', { class: 'r-meta' }, a.agreed ? `Agreed by ${a.agreed.by}${a.agreed.speaks_for?.checked ? `, which speaks for ${a.agreed.speaks_for.house}` : ' (an agent; it showed no house it speaks for)'}: “${a.agreed.said}”` : 'Proposed: nothing from their side says they agreed yet'),
      a.note ? h('div', { class: 'r-meta' }, `${a.by}: “${a.note}”`) : ''),
    h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.agenda.remove', id: a.id }); void show(); } }, 'Remove'))))),
    h('p', { class: 'r-meta' }, 'In your own calendar app: subscribe to this address (keep it to yourself: whoever has it can read your agenda). ', feedLine()));
}

function suggestionList(list: Note[]): Node {
  return h('ul', { class: 'rows' }, ...list.map((x) => h('li', {},
    h('div', {}, h('div', { class: 'r-title' }, x.text), h('div', { class: 'r-meta' }, `${x.from} · ${time(x.at)}${x.advice ? ` · ${ADVICE_SAYS[x.advice]}` : ''}${x.ask?.answered ? ` · you answered: ${x.ask.answered}` : ''}`)),
    h('div', {},
      // A note about an offer carries its Accept: still your tap, on your key, like on the Offers tab.
      x.offer ? h('button', { class: 'btn small', type: 'button', onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        const r = await acceptOffer(x.offer!);
        if (!r.error && !r.cancelled) await call({ kind: 'panel.assistant.dismiss', id: x.id }); else if (r.error) alert(r.error);
        void show();
      } }, 'Accept the offer') : '',
      // Your agent proposes not hearing from a note's sender again: your tap mutes it, by its key.
      x.note && x.mute ? h('button', { class: 'btn small', type: 'button', onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        await call({ kind: 'panel.note.mute', id: x.note });
        await call({ kind: 'panel.assistant.dismiss', id: x.id });
        void show();
      } }, 'Mute this sender') : '',
      // New rules your agent proposes: applied by your tap, with your key, like editing them yourself.
      x.rules ? h('button', { class: 'btn small', type: 'button', onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        const r = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.rules.set', text: x.rules });
        if (r.ok) { draft = null; await call({ kind: 'panel.assistant.dismiss', id: x.id }); } else alert(r.error);
        void show();
      } }, 'Apply these rules') : '',
      // A new line for your door: applied by your tap; the door stays open, its name as it was.
      x.door ? h('button', { class: 'btn small', type: 'button', onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        const cur = await call<{ name?: string }>({ kind: 'panel.door' });
        const r = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.door.set', open: true, about: x.door!.about, ...(cur.name ? { name: cur.name } : {}) });
        if (r.ok) await call({ kind: 'panel.assistant.dismiss', id: x.id }); else alert(r.error);
        void show();
      } }, `Put “${x.door.about}” on your door`) : '',
      // Your own words back to your agent (a café, a title, "not this week"): sent as yours.
      replyBox(x),
      // A question: each choice is a button; the answer goes to your assistant.
      ...(x.ask && !x.ask.answered ? x.ask.choices.map((c, i) => h('button', { class: `btn small${x.ask!.recommend === i ? ' primary' : ''}`, type: 'button', onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        await call({ kind: 'panel.assistant.answer', id: x.id, choice: c });
        void show();
      } }, c)) : []),
      // Likewise a pledge: signing it is your tap, with your house's key (and your person stamp, for a people-only one).
      x.pledge ? h('button', { class: 'btn small', type: 'button', onclick: async (e: Event) => {
        (e.target as HTMLButtonElement).disabled = true;
        const r = await call<{ error?: string }>({ kind: 'panel.pledge.sign', tally: x.pledge!.tally, id: x.pledge!.id });
        if (!r.error) await call({ kind: 'panel.assistant.dismiss', id: x.id });
        else alert(r.error);
        void show();
      } }, 'Sign the pledge') : '',
      ' ',
      h('button', { class: 'btn small', type: 'button', onclick: async () => { await call({ kind: 'panel.assistant.dismiss', id: x.id }); void show(); } }, 'Dismiss')))));
}

// ---- Money ----
async function money(box: HTMLElement) {
  const m = await call<{ total: number; receipts: { amount: number; currency: string; agreement: string; from: string; payer?: string; at: string; settlement: string }[]; spent?: { amount: number; currency: string; agreement: string; to: string; at: string }[] }>({ kind: 'panel.money' });
  box.replaceChildren(
    h('dl', { class: 'tiles' }, h('div', { class: 'tile mint' }, h('dt', {}, 'Earned'), h('dd', {}, `$${m.total}`)), h('div', { class: 'tile' }, h('dt', {}, 'Receipts'), h('dd', {}, String(m.receipts.length)))),
    h('p', { class: 'lede' }, 'Every payment comes with a receipt signed by a payments agent you trust, filed in your pod. In the sandbox, settlement is simulated.'),
    m.receipts.length ? h('ul', { class: 'rows', style: 'margin-top:14px' }, ...m.receipts.map((r) => h('li', {},
      h('div', { title: r.agreement }, h('div', { class: 'r-title' }, r.payer ? `${money$(r.amount, r.currency)} from ${who(r.payer)}` : money$(r.amount, r.currency)), h('div', { class: 'r-meta' }, `${new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · signed by ${who(r.from)} · ${r.settlement}`)),
      h('span', { class: 'chip share' }, 'signed'))))
      : h('p', { class: 'muted' }, 'No payments yet.'),
    // What your own agent paid for you, under the allowance you signed: its receipts, handed back to your house.
    m.spent?.length ? h('div', {}, h('h2', {}, 'Spent by your agent'), h('ul', { class: 'rows' }, ...m.spent.map((r) => h('li', {},
      h('div', { title: r.agreement }, h('div', { class: 'r-title' }, `${money$(r.amount, r.currency)} to ${who(r.to)}`), h('div', { class: 'r-meta' }, `${new Date(r.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · under your allowance · ${r.agreement.replace(/^urn:(lake:order|ap2:cart):/, 'order ').slice(0, 40)}`)),
      h('span', { class: 'chip share' }, 'signed'))))) : '',
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
