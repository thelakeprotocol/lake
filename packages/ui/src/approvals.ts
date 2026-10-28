import './approvals.css';
import { stringify } from 'yaml';
import QRCode from 'qrcode';
import { h as ph, render, createContext, type ComponentChildren, type VNode } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { loadKey, signCredential, signEnvelope } from './owner-crypto';

// The control panel that comes with every house (open source). Served by the house at /owner/; every call is signed on
// this device with the owner's key, which never leaves it. Drawn with Preact: each screen is a function of what the house
// said, redrawn when the house says something changed (a stream, SSE) or after anything you do here.

interface Request { id: string; offerId: string; visitor: { webId: string; domain: string }; purpose: string; fields: string[]; retention: string; priceUsd: number; study: string | null; question?: string; warnings?: string[]; note?: string; asked?: number; recommendation: string; grantDraft?: unknown }
interface Key { id: string; visitor: string; fields: string[]; purpose: string; until: string; authorizedBy: string }
type Decision = 'join' | 'ask' | 'decline';
interface Rule { match: Record<string, string | boolean | number>; allow_fields?: string[]; deny_fields?: string[]; min_price_usd?: number; retention?: string; grant_hours?: number; decision: Decision }
interface Rules { owner: string; device?: string; default: Decision; tags?: string[]; rules: Rule[]; negotiation?: { join_collectives?: boolean }; trust?: Record<string, string[]>; privacy?: { show_packs?: boolean }; availability?: { tz: string; free: string[]; meetings?: number } }

// Hyperscript, loosely typed: the same h(tag, props, ...children) the panel always used, now making Preact nodes.
type Child = ComponentChildren;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (tag: any, props?: Record<string, unknown> | null, ...children: Child[]): VNode => ph(tag, (props ?? null) as never, ...(children as never[]));

const key = loadKey();
const api = new URL('./', location.href).href; // served at /owner/
let webId = '';
let leaseUntil: string | null = null;

// ---- talking to the house ----
/** Whether the house is answering, as the last call found: the status dot. */
let reachable = true;
const reachWatchers = new Set<(ok: boolean) => void>();
const reached = (ok: boolean) => { if (ok !== reachable) { reachable = ok; for (const w of reachWatchers) w(ok); } };
async function call<T = any>(payload: Record<string, unknown>): Promise<T> {
  let res: Response;
  try { res = await fetch(`${api}api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signEnvelope(payload, key, webId || 'owner')) }); } catch (e) { reached(false); throw e; }
  reached(true);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status));
  return res.json();
}

/**
 * What each screen last showed, kept on this device: shown at once next time while it's fetched again
 * (stale-while-revalidate), so opening the panel isn't a blank page while the house answers.
 */
const CACHE = `lake-panel:${location.pathname}:`;
const cached = <T>(k: string): T | undefined => { try { const v = localStorage.getItem(CACHE + k); return v ? (JSON.parse(v) as T) : undefined; } catch { return undefined; } };
const remember = (k: string, v: unknown) => { try { localStorage.setItem(CACHE + k, JSON.stringify(v)); } catch { /* full or private: just not kept */ } };

/**
 * What the house holds changes (a note arrives, you tap Allow): every screen refetches. `version` goes up when the house
 * says so over its stream, and after anything you do here (bump).
 */
const Version = createContext({ version: 0, bump: () => {} });
const useBump = () => useContext(Version).bump;

/** Draw this component again (after an edit that lives only on this screen). */
const useRedraw = () => { const [, set] = useState(0); return () => set((n) => n + 1); };

/** One signed call, fetched again whenever something changed. Keeps what it had while it fetches, so nothing flickers. */
function useHouse<T>(payload: Record<string, unknown>): { data?: T; error?: string } {
  const { version } = useContext(Version);
  const k = JSON.stringify(payload);
  const [state, set] = useState<{ data?: T; error?: string }>(() => ({ data: cached<T>(k) }));
  useEffect(() => {
    let live = true;
    call<T>(payload).then((data) => { remember(k, data); if (live) set({ data }); }, (e: Error) => live && set((s) => ({ ...s, error: e.message })));
    return () => { live = false; };
  }, [k, version]);
  return state;
}

// ---- small pieces ----
const hoursLeft = (iso: string) => { const hr = (Date.parse(iso) - Date.now()) / 3_600_000; return hr < 1 ? `${Math.max(1, Math.round(hr * 60))} min` : `${Math.round(hr)} h`; };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nice = (f: string) => f.replace(/_/g, ' ');
const dayTime = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** "P99Y" → "99 years", "P30D" → "30 days". */
const duration = (iso: string) => {
  const units: [RegExp, string][] = [[/(\d+)Y/, 'year'], [/P[^T]*?(\d+)M/, 'month'], [/(\d+)W/, 'week'], [/(\d+)D/, 'day'], [/T.*?(\d+)H/, 'hour']];
  const parts = units.flatMap(([re, u]) => { const n = Number(re.exec(iso)?.[1] ?? 0); return n ? [`${n} ${u}${n === 1 ? '' : 's'}`] : []; });
  return parts.join(' ') || iso;
};
/** A WebID or agent id, said the way a person would: its domain. */
const who = (id: string) => { try { return new URL(id).hostname; } catch { return id.replace(/^agent:/, '') || 'someone'; } };
const shortName = (label: string) => label.replace(/\s*\(.*\)$/, '');
const CURRENCIES = ['USD', 'AUD', 'EUR', 'GBP', 'CAD', 'NZD'];
const money$ = (amount: number, currency = 'USD') => (currency === 'USD' ? `$${amount}` : `${currency} ${amount}`);
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* a private window */ } };

/** A button that runs something on the house: disabled while it runs, then everything refetches. */
function Act({ label, cls = '', run, title }: { label: Child; cls?: string; run: () => Promise<unknown>; title?: string }) {
  const bump = useBump();
  const [busy, setBusy] = useState(false);
  return h('button', { class: `btn small ${cls}`, type: 'button', disabled: busy, title, onClick: async () => {
    setBusy(true);
    try { await run(); } catch (e) { alert((e as Error).message); } finally { setBusy(false); bump(); }
  } }, label);
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [said, setSaid] = useState(label);
  return h('button', { class: 'btn small', type: 'button', onClick: async () => {
    try { await navigator.clipboard.writeText(text); setSaid('Copied ✓'); setTimeout(() => setSaid(label), 1500); } catch { setSaid('Copy failed'); }
  } }, said);
}

/** A long list, ten at a time, with Show more (and how many are left). */
function Paged<T>({ items, render, size = 10, tag = 'ul', cls = 'items' }: { items: T[]; render: (x: T) => VNode; size?: number; tag?: string; cls?: string }) {
  const [shown, setShown] = useState(size);
  const left = items.length - shown;
  return h('div', {}, h(tag, { class: cls }, ...items.slice(0, shown).map(render)),
    left > 0 ? h('button', { class: 'btn small more-items', type: 'button', onClick: () => setShown(shown + size) }, `Show ${Math.min(size, left)} more`, h('span', { class: 'muted' }, ` of ${left}`)) : null);
}

function Failed({ error }: { error?: string }) {
  return error ? h('p', { class: 'muted' }, `Couldn't reach your house: ${error}`) : h('p', { class: 'muted' }, 'Opening…');
}

// ---- navigation ----
// Your agent and the agents that knock are different things: "My agent" is yours, "Visitors" are strangers.
const TABS = [
  ['home', 'Home'], ['requests', 'Requests'], ['offers', 'Offers'], ['myagent', 'My agent'], ['keys', 'Keys'], ['rules', 'Rules'],
  ['agents', 'Visitors'], ['money', 'Money'], ['data', 'Data'], ['move', 'Move house'],
] as const;
type Tab = (typeof TABS)[number][0];
/** Four tabs for every day; the rest one tap away under More. */
const MAIN: Tab[] = ['home', 'requests', 'myagent', 'rules'];
const tabFromHash = (): Tab => TABS.find(([id]) => id === location.hash.slice(1))?.[0] ?? 'home';

function Nav({ tab, go, pending, noOffers }: { tab: Tab; go: (t: Tab) => void; pending: number; noOffers: boolean }) {
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  // A tap anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!e.composedPath().includes(nav.current!)) setOpen(false); };
    addEventListener('click', close);
    return () => removeEventListener('click', close);
  }, [open]);
  const shown = TABS.filter(([id]) => !(id === 'offers' && noOffers) || id === tab);
  const button = ([id, label]: readonly [Tab, string]) => h('button', { key: id, type: 'button', class: MAIN.includes(id) ? 'main' : 'extra', 'aria-current': id === tab ? 'page' : undefined, onClick: () => { setOpen(false); go(id); } },
    label, id === 'requests' && pending ? h('span', { class: 'badge' }, String(pending)) : null);
  return h('nav', { id: 'nav', ref: nav, class: open ? 'more-open' : '', 'aria-label': 'Control panel' },
    ...shown.filter(([id]) => MAIN.includes(id)).map(button),
    h('button', { type: 'button', class: `more-btn${MAIN.includes(tab) ? '' : ' here'}`, 'aria-expanded': String(open), onClick: () => setOpen(!open) }, 'More'),
    h('div', { class: 'more-menu' }, h('span', { class: 'more-label' }, 'More'), ...shown.filter(([id]) => !MAIN.includes(id)).map(button),
      h('button', { type: 'button', class: 'extra signout', onClick: signOut }, 'Sign out on this device')));
}

/**
 * Your key lives only on this device: signing out forgets it here. Coming back takes a new pairing link (a sandbox house
 * you claimed is simply free again once its lease ends), so it asks first.
 */
function signOut() {
  if (!confirm('Sign out on this device?\n\nYour house\'s key is only on this device. Once it\'s gone, you need a new pairing link to get back in (on the sandbox, from whoever runs it).')) return;
  // The key, and what the screens last showed (else the panel would open as if still paired).
  try { for (const k of Object.keys(localStorage)) if (k === `lake-owner-key:${location.host}` || k.startsWith(CACHE)) localStorage.removeItem(k); } catch { /* nothing kept */ }
  location.reload();
}

// ---- Home ----
type DoorState = { open: boolean; about?: string; name?: string; address: string; error?: string };
type FreeState = { set: boolean; tz?: string; meetings?: number; slots: unknown[] };
type Note = { id: string; from: string; text: string; at: string; offer?: string; pledge?: { tally: string; id: string }; advice?: 'do' | 'dont' | 'your_call'; ask?: { choices: string[]; recommend?: number; answered?: string }; reply?: string; rules?: string; door?: { about: string }; note?: string; mute?: boolean };
type AgendaItem = { id: string; what: string; when: string; where?: string; with?: string; note?: string; start?: string; by: string; agreed?: { by: string; said: string; speaks_for?: { house: string; checked: boolean } } };
type DoorNote = { id: string; from: { web?: boolean; name: string; domain: string; checked?: boolean; speaks_for?: { house: string; checked: boolean } }; text: string; at: string; answered?: { text: string; by: string } };
interface Assistant { kid: string; label: string; addedAt: string; canHaveAllowance?: boolean; allowance?: { amount: number; currency: string; until: string } }
interface ListView { webId: string; until?: string; requests: Request[]; keys: Key[]; suggestions: Note[]; assistants: Assistant[]; notes: DoorNote[]; agenda?: AgendaItem[] }

function Home({ go }: { go: (t: Tab) => void }) {
  const o = useHouse<any>({ kind: 'panel.overview', tz_offset: new Date().getTimezoneOffset() });
  const feed = useHouse<{ at: string; kind: string; text: string }[]>({ kind: 'panel.activity' });
  const list = useHouse<ListView>({ kind: 'list' });
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const free = useHouse<FreeState>({ kind: 'panel.free' });
  if (!list.data) return h(Failed, { error: list.error });
  const { suggestions, assistants, notes, agenda } = list.data;
  // Each part shows as soon as its own answer is in: the overview (the slowest) only fills the numbers and the details.
  const waiting = list.data.requests.length;
  const needs = [
    ...suggestions.map((x) => ({ k: `s-${x.id}`, v: () => h(SuggestionItem, { key: `s-${x.id}`, x }) })),
    ...(notes ?? []).map((n) => ({ k: `n-${n.id}`, v: () => h(NoteItem, { key: `n-${n.id}`, n }) })),
  ];
  const stat = (label: string, value: string | number, to: Tab, cls = '') =>
    h('button', { class: `stat ${cls}`, type: 'button', onClick: () => go(to) }, h('b', {}, String(value)), h('span', {}, label));
  return h('div', {},
    h(StartCard, { door: door.data && !door.data.error ? door.data : null, hasAssistant: assistants.length > 0, free: free.data ?? { set: false, slots: [] }, go }),
    // What needs you, first and only: your agent's suggestions, notes at your door, requests your rules left to you.
    h('section', { class: 'block' }, h('h2', {}, 'Needs you'),
      waiting || needs.length
        ? h('div', {},
            waiting ? h('ul', { class: 'items', style: 'margin-bottom:10px' }, h('li', { key: 'waiting', class: 'item amber' }, h('p', { class: 'item-text' }, `${waiting} request${waiting === 1 ? '' : 's'} your rules left to you`),
              h('div', { class: 'item-actions' }, h('button', { class: 'btn primary small', type: 'button', onClick: () => go('requests') }, 'Look at them')))) : null,
            needs.length ? h(Paged, { items: needs, render: (x: (typeof needs)[number]) => x.v() }) : null)
        : h('p', { class: 'empty' }, 'Nothing needs you. Your rules and your agent are handling it.')),
    agenda?.length ? h('section', { class: 'block' }, h('h2', {}, 'Coming up'), h(AgendaList, { agenda })) : null,
    door.data?.open ? h(ShareDoor, { address: door.data.address }) : null,
    o.data ? h('div', { class: 'stats' },
      stat(o.data.knocksToday === 1 ? 'knock today' : 'knocks today', o.data.knocksToday, 'agents'),
      stat(o.data.keys === 1 ? 'live key' : 'live keys', o.data.keys, 'keys'),
      stat('earned', `$${o.data.earned}`, 'money'),
      o.data.blockedToday ? stat('attacks blocked', o.data.blockedToday, 'agents', 'threat') : null) : h('div', { class: 'stats' }, h('span', { class: 'stat skeleton' }, '…')),
    // Everything else, one tap away.
    !o.data ? null : h('details', { class: 'fold' }, h('summary', {}, 'About your house'),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', {}, 'Your record'), h('dd', {}, o.data.record.ok ? `Checks out: signed by a trusted issuer, unchanged. ${o.data.claims} claims (${o.data.holds.map(nice).join(', ') || 'none'}).` : `Failed its check: ${o.data.record.why}.`)),
        h('div', {}, h('dt', {}, 'Your agent'), h('dd', {}, assistants.length ? `${assistants.map((a) => shortName(a.label)).join(', ')}: looks and suggests; you decide.` : 'None yet.')),
        h('div', {}, h('dt', {}, 'Reached'), h('dd', {}, o.data.relayed ? 'Through the Lake (your house is behind a router)' : 'Directly, at its own address')),
        h('div', {}, h('dt', {}, 'Identity'), h('dd', {}, h('code', {}, webId)))),
      h(PersonCard, { p: o.data.person }),
      leaseUntil ? h(LeaseCard, {}) : null,
      h('h3', {}, 'Recent at your door'),
      feed.data?.length ? h(Paged, { items: feed.data, size: 12, tag: 'ul', cls: 'feed', render: (a: { at: string; kind: string; text: string }) => h('li', { key: `${a.at}-${a.text}` }, h('time', {}, time(a.at)), h('span', { class: a.kind === 'attack.blocked' ? 'k-threat' : a.kind === 'grant.issued' || a.kind === 'compute.done' ? 'k-mint' : a.kind === 'approval.requested' ? 'k-amber' : '' }, a.text)) })
        : h('p', { class: 'muted' }, 'Quiet so far.')),
  );
}

/**
 * Getting set up, on Home until done: open your door, connect your own AI, say when you're free, put your agenda in your
 * calendar. One line and one button each; the details live where the button takes you.
 */
function StartCard({ door, hasAssistant, free, go }: { door: DoorState | null; hasAssistant: boolean; free: FreeState; go: (t: Tab) => void }) {
  const [hidden, setHidden] = useState(!!stored('lake.start.done'));
  const [calendar, setCalendar] = useState(!!stored('lake.start.calendar'));
  if (hidden || !door) return null;
  const steps: [boolean, string, Child][] = [
    [door.open, 'Open your door', h(Act, { label: 'Open it', cls: 'primary', run: () => call({ kind: 'panel.door.set', open: true }) })],
    [hasAssistant, 'Let your own AI look after it', h('button', { class: 'btn small', type: 'button', onClick: () => go('myagent') }, 'Give it a key')],
    [free.set, 'Say when you\'re free to meet', h('button', { class: 'btn small', type: 'button', onClick: () => { go('rules'); setTimeout(() => document.getElementById('free')?.scrollIntoView({ behavior: 'smooth' }), 400); } }, 'Set your hours')],
    [calendar, 'Put your agenda in your calendar', h(FeedLine, { onShown: () => { store('lake.start.calendar', '1'); setCalendar(true); } })],
  ];
  const done = steps.filter(([d]) => d).length;
  if (done === steps.length) return null;
  return h('section', { class: 'block start' },
    h('div', { class: 'start-head' }, h('h2', {}, 'Get set up'), h('span', { class: 'progress' }, `${done} of ${steps.length}`,
      h('button', { class: 'link', type: 'button', onClick: () => { store('lake.start.done', '1'); setHidden(true); } }, 'Hide'))),
    h('ol', { class: 'steps' }, ...steps.map(([ok, title, action], i) => h('li', { key: i, class: ok ? 'done' : '' },
      h('span', { class: 'tick', 'aria-hidden': 'true' }, ok ? '✓' : String(i + 1)), h('span', { class: 'step-title' }, title), ok ? null : h('span', { class: 'step-action' }, action)))),
    door.open ? h('p', { class: 'hint' }, 'Try it: tell any AI, ', h('em', {}, `“Knock on the door at ${door.address} and say hello.”`)) : null);
}

/** Your agenda's private calendar address, shown on a tap, with Copy and New address. */
function FeedLine({ onShown }: { onShown?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const show = async (reset = false) => {
    const f = await call<{ url?: string; path: string }>({ kind: 'panel.agenda.feed', ...(reset ? { reset: true } : {}) });
    setUrl(f.url ?? new URL(f.path.replace(/^\/owner\//, ''), location.href).href);
    if (!reset) onShown?.();
  };
  if (!url) return h('button', { class: 'btn small', type: 'button', onClick: () => void show() }, 'Show the address');
  return h('span', { class: 'row' }, h('code', {}, url), h(CopyButton, { text: url }),
    h('button', { class: 'btn small quiet', type: 'button', onClick: () => { if (confirm('Make a new address? The old one stops working.')) void show(true); } }, 'New address'));
}

/** What you agreed to, written in by your agent, with who agreed on the other side (or that nobody has yet). */
function AgendaList({ agenda }: { agenda: AgendaItem[] }) {
  return h('div', {},
    h(Paged, { items: agenda, render: (a: AgendaItem) => h('li', { key: a.id, class: 'item' },
      h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, a.what), h('span', { class: `chip ${a.agreed ? 'ok' : 'wait'}` }, a.agreed ? 'Agreed' : 'Proposed')),
      h('p', { class: 'item-meta' }, [a.when, a.where, a.with ? `with ${a.with}` : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'item-foot' },
        h('details', { class: 'more' }, h('summary', {}, 'Details'),
          h('p', { class: 'item-meta' }, a.agreed ? `${a.agreed.by}${a.agreed.speaks_for?.checked ? `, which speaks for ${a.agreed.speaks_for.house}` : ' (an agent; it showed no house it speaks for)'} said: “${a.agreed.said}”` : 'Nothing from their side says they agreed yet: it holds the time.'),
          a.note ? h('p', { class: 'item-meta' }, `${a.by}: “${a.note}”`) : null),
        h(Act, { label: 'Remove', cls: 'quiet', run: () => call({ kind: 'panel.agenda.remove', id: a.id }) }))) }),
    h('details', { class: 'fold' }, h('summary', {}, 'In your own calendar'),
      h('p', { class: 'muted' }, 'Subscribe to this address in your calendar app. Keep it to yourself: whoever has it can read your agenda.'), h(FeedLine, {})));
}

/** Notes agents left at your door: their words, nothing asked of your data. Your agent hears of them too. */
function NoteItem({ n }: { n: DoorNote }) {
  return h('li', { class: 'item' },
    h('div', { class: 'item-head' }, h('span', { class: 'item-from' }, `Note from ${shortName(n.from.name)}`),
      h('span', { class: `chip ${n.from.checked || n.from.speaks_for?.checked ? 'ok' : ''}`, title: n.from.checked ? 'its domain is proved' : 'anyone could send this' }, n.from.web ? 'From the web' : n.from.speaks_for?.checked ? 'Speaks for a house' : n.from.checked ? 'Verified' : 'Unverified')),
    h('p', { class: 'item-text' }, `“${n.text}”`),
    h('p', { class: 'item-meta' }, `${n.from.web ? 'left over the web; nobody checked who' : n.from.domain} · ${time(n.at)}`),
    n.from.web ? (n.answered ? h('p', { class: 'item-meta' }, `${n.answered.by === 'you' ? 'You' : shortName(n.answered.by)} answered: “${n.answered.text}”`) : h(Reply, { label: 'Answer', placeholder: 'Your answer', send: (text: string) => call({ kind: 'panel.note.reply', id: n.id, text }) })) : null,
    h('div', { class: 'item-actions' },
      h(Act, { label: 'Done', run: () => call({ kind: 'panel.note.dismiss', id: n.id }) }),
      h(Act, { label: 'Mute sender', cls: 'quiet', run: () => call({ kind: 'panel.note.mute', id: n.id }) })));
}

/** Your own words back: folded until you want it. */
function Reply({ label, placeholder, send }: { label: string; placeholder: string; send: (text: string) => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null);
  return h('details', { class: 'reply' }, h('summary', {}, label),
    h('div', { class: 'row' }, h('input', { ref: input, type: 'text', maxlength: 1000, placeholder }),
      h(Act, { label: 'Send', cls: 'primary', run: async () => { const t = input.current!.value.trim(); if (t) { await send(t); input.current!.value = ''; } } })));
}

/** Your agent's suggestions: what it says, what it advises, and your tap. */
function SuggestionItem({ x }: { x: Note }) {
  const dismiss = () => call({ kind: 'panel.assistant.dismiss', id: x.id });
  const fail = (r: { ok?: boolean; error?: string }) => { if (r.error) throw new Error(r.error); };
  return h('li', { class: 'item' },
    h('div', { class: 'item-head' }, h('span', { class: 'item-from' }, `From ${shortName(x.from)}, your agent`),
      x.advice ? h('span', { class: `chip ${x.advice === 'do' ? 'ok' : x.advice === 'dont' ? 'no' : ''}` }, { do: 'Advises yes', dont: 'Advises no', your_call: 'Your call' }[x.advice]) : null),
    h('p', { class: 'item-text' }, x.text),
    x.door ? h('blockquote', {}, x.door.about) : null,
    x.ask?.answered ? h('p', { class: 'item-meta' }, `You answered: ${x.ask.answered}`) : null,
    // A question: each choice is a button; the one your agent advises stands out.
    x.ask && !x.ask.answered ? h('div', { class: 'choices' }, ...x.ask.choices.map((c, i) => h(Act, { key: c, label: c, cls: x.ask!.recommend === i ? 'primary' : '', run: () => call({ kind: 'panel.assistant.answer', id: x.id, choice: c }) }))) : null,
    h('div', { class: 'item-actions' },
      // Each is still your tap, on your key.
      x.offer ? h(Act, { label: 'Accept the offer', cls: 'primary', run: async () => { const r = await acceptOffer(x.offer!); if (r.error) throw new Error(r.error); if (!r.cancelled) await dismiss(); } }) : null,
      x.note && x.mute ? h(Act, { label: 'Mute this sender', run: async () => { await call({ kind: 'panel.note.mute', id: x.note }); await dismiss(); } }) : null,
      x.rules ? h(Act, { label: 'Apply these rules', cls: 'primary', run: async () => { fail(await call({ kind: 'panel.rules.set', text: x.rules })); rulesDraft = null; await dismiss(); } }) : null,
      x.door ? h(Act, { label: 'Use this line', cls: 'primary', run: async () => { const cur = await call<{ name?: string }>({ kind: 'panel.door' }); fail(await call({ kind: 'panel.door.set', open: true, about: x.door!.about, ...(cur.name ? { name: cur.name } : {}) })); await dismiss(); } }) : null,
      x.pledge ? h(Act, { label: 'Sign the pledge', cls: 'primary', run: async () => { fail(await call({ kind: 'panel.pledge.sign', tally: x.pledge!.tally, id: x.pledge!.id })); await dismiss(); } }) : null),
    h('div', { class: 'item-foot' },
      x.reply ? h('p', { class: 'item-meta' }, `You wrote: “${x.reply}”`) : h(Reply, { label: 'Reply', placeholder: 'In your own words', send: (text: string) => call({ kind: 'panel.assistant.answer', id: x.id, text }) }),
      h(Act, { label: 'Dismiss', cls: 'quiet', run: dismiss })));
}

/**
 * One person, one house: a stamp from a person checker says a real, single person owns this house, without saying who.
 * Things that count people (pledges, strikes) count each person once, whatever number of houses.
 */
function PersonCard({ p }: { p?: { stamped: boolean; by?: string; person?: string; checker?: boolean } }) {
  const [msg, setMsg] = useState('');
  const tally = useRef<HTMLInputElement>(null), pid = useRef<HTMLInputElement>(null);
  if (!p) return null;
  return h('div', { class: `card ${p.stamped ? 'ok' : ''}` },
    h('h3', {}, p.stamped ? 'One person, one house: stamped' : 'One person, one house'),
    h('p', { class: 'muted' }, p.stamped
      ? `${p.by ?? 'A person checker'} says a real, single person owns this house, without saying who (person …${p.person}). Pledges that count people count you once.`
      : p.checker ? 'Get a stamp that says a real, single person owns this house, without saying who. Pledges and strikes that count people only count stamped houses, once per person.' : 'No person checker is set for this house.'),
    !p.stamped && p.checker ? h(Act, { label: 'Get a person stamp', run: async () => {
      // Your consent, signed here on your device: the checker stamps the house only with it.
      const consent = signEnvelope({ kind: 'personhood.consent', house: webId }, key, webId || 'owner');
      const r = await call<{ error?: string }>({ kind: 'panel.person.request', consent }).catch((e) => ({ error: (e as Error).message }));
      if (r.error) setMsg(r.error);
    } }) : null,
    h('details', { style: 'margin-top:8px' }, h('summary', {}, 'Sign a pledge from your house'),
      h('input', { ref: tally, placeholder: 'tally address, e.g. https://…/s/tally', style: 'width:100%' }),
      h('input', { ref: pid, placeholder: 'pledge id', style: 'width:100%;margin-top:6px' }),
      h(Act, { label: 'Sign this pledge', run: async () => {
        const r = await call<{ kind?: string; count?: number; threshold?: number; error?: string; problems?: string[] }>({ kind: 'panel.pledge.sign', tally: tally.current!.value.trim(), id: pid.current!.value.trim() }).catch((e): { error: string; problems?: string[]; kind?: string; count?: number; threshold?: number } => ({ error: (e as Error).message }));
        setMsg(r.error ?? (r.problems ? r.problems.join('; ') : r.kind === 'tally.triggered' ? `Signed, and that was the last one needed: ${r.count} of ${r.threshold}. Everyone has been told.` : `Signed: ${r.count} of ${r.threshold}. Nobody knows who until it's full.`));
      } })),
    msg ? h('p', { class: 'muted' }, msg) : null);
}

/** Sandbox houses are leased: shown on Home, with a way to hand the house back early. */
function LeaseCard() {
  const until = new Date(leaseUntil!);
  return h('div', { class: 'card' },
    h('h3', {}, `Yours until ${until.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`),
    h('p', { class: 'muted' }, 'A sandbox house is a lease. When it ends, every key is revoked, the rules reset and the next person can claim it. Want to keep a house? Run your own: it stays yours.'),
    h('button', { class: 'btn danger small', type: 'button', onClick: async () => {
      if (!confirm('Hand this house back? Every key is revoked and the next person gets it fresh.')) return;
      await call({ kind: 'release' });
      location.reload();
    } }, 'Hand it back now'));
}

// ---- Requests ----
function Requests() {
  const v = useHouse<ListView>({ kind: 'list' });
  if (!v.data) return h(Failed, { error: v.error });
  return h('div', {},
    h('p', { class: 'lede' }, 'Your rules answer the easy ones. These are the ones they left to you.'),
    v.data.requests.length ? h('div', {}, ...sameAsks(v.data.requests).map((all) => h(RequestCard, { key: all[0]!.id, all }))) : h('p', { class: 'empty' }, 'Nothing to decide. Your rules are handling it.'));
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

function RequestCard({ all }: { all: Request[] }) {
  // The house folds repeats into one request (asked); older houses may still send several identical ones.
  const r = all[0]!, n = all.length, times = all.reduce((t, x) => t + (x.asked ?? 1), 0);
  // On a risky ask the safe answer is the easy one to hit.
  const risky = !!r.warnings?.length;
  const allow = async () => {
    for (const q of all) {
      // The key is cut here, on this device, with your key: the house drafted the grant (a Solid Access Grant saying exactly
      // what you were shown), this device dates and signs it, and the house only checks it.
      const draft = structuredClone(q.grantDraft) as { credentialSubject: { providedConsent: { hasStatus: string } } };
      // The draft asks; signing it here is the owner giving consent.
      draft.credentialSubject.providedConsent.hasStatus = 'https://w3id.org/GConsent#ConsentStatusExplicitlyGiven';
      const grant = signCredential({ ...draft, issuer: webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 48 * 3_600_000).toISOString() }, key);
      await call({ kind: 'answer', request: q.id, answer: 'allow', grant });
    }
  };
  const deny = async () => { for (const q of all) await call({ kind: 'answer', request: q.id, answer: 'deny' }).catch(() => {}); };
  return h('article', { class: risky ? 'req risky' : 'req' },
    h('div', { class: 'who' }, r.visitor.domain, times > 1 ? h('span', { class: 'count' }, `asked ${times} times`) : null),
    r.question ? h('p', { class: 'q' }, `“${r.question}”`) : null,
    r.warnings?.length ? h('ul', { class: 'warn' }, ...r.warnings.map((w) => h('li', {}, `It ${w}`))) : null,
    r.note ? h('p', { class: 'note' }, h('b', {}, 'Their note, in their words (not checked): '), `“${r.note}”`) : null,
    h('dl', { class: 'facts' },
      ...([['Purpose', r.purpose], ['Fields', h('span', {}, ...r.fields.map((f) => h('span', { class: 'chip' }, nice(f))))], ['Keeps it', r.retention === 'none' ? 'no, deleted after the study' : `yes, for ${duration(r.retention)}`], ['Pays', `$${r.priceUsd}`], ['Key for', '48 hours, revocable']] as [string, Child][])
        .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
    h('p', { class: 'advice' }, h('b', {}, 'Your housekeeper says'), r.recommendation),
    h('div', { class: 'actions' },
      h(Act, { label: n > 1 ? `Allow all ${n}` : 'Allow', cls: risky ? 'deny' : 'allow', run: allow }),
      h(Act, { label: n > 1 ? `Deny all ${n}` : 'Deny', cls: risky ? 'danger-fill' : 'deny', run: deny })));
}

// ---- Keys: who you've said yes to ----
/** One consent record from your pod (ISO/IEC TS 27560 in DPV terms), as the house reads it for you. */
interface Consent {
  id: string; visitor: string; fields: { name: string; label: string }[]; purpose: string; purposeLabel: string; given: string; until: string; retention: string;
  how: { live?: true; rule?: number | null }; status: 'active' | 'withdrawn' | 'used' | 'ended'; withdrawnAt?: string;
}

function Keys() {
  const v = useHouse<ListView>({ kind: 'list' });
  const c = useHouse<Consent[]>({ kind: 'panel.consents' });
  if (!v.data || !c.data) return h(Failed, { error: v.error ?? c.error });
  const consents = c.data;
  // Taking a consent back is revoking its key: the house marks the record withdrawn, with the date.
  const takeBack = (id: string, label = 'Take it back') => h(Act, { label, cls: 'danger', run: () => call({ kind: 'revoke', revoke: id }) });
  const row = (x: Consent) => h('li', { key: x.id },
    h('div', {},
      h('div', { class: 'r-title' }, `${x.visitor}, for ${x.purposeLabel}`),
      h('div', { style: 'margin-top:6px' }, ...x.fields.map((f) => h('span', { class: 'chip' }, f.label))),
      h('div', { class: 'r-meta' }, [
        x.how.live ? 'you tapped Allow' : x.how.rule ? `your rule ${x.how.rule} said yes` : 'one of your rules said yes',
        x.retention === 'none' ? 'they keep nothing' : `they keep it for ${duration(x.retention)}`,
        { active: `until ${dayTime(x.until)} (${hoursLeft(x.until)} left)`, withdrawn: x.withdrawnAt ? `you took it back on ${dayTime(x.withdrawnAt)}` : 'you took it back', used: 'used once, can’t be used again', ended: `ended ${dayTime(x.until)}` }[x.status],
      ].join(' · '))),
    x.status === 'active' ? takeBack(x.id) : h('span', { class: `chip ${x.status === 'withdrawn' ? '' : 'neutral'}` }, { withdrawn: 'taken back', used: 'used', ended: 'ended' }[x.status]));
  // Keys with no consent record beside them (cut before records were kept): still yours to revoke.
  const recorded = new Set(consents.map((x) => x.id));
  const loose = v.data.keys.filter((k) => !recorded.has(k.id));
  const live = consents.filter((x) => x.status === 'active').length + loose.length;
  return h('div', {},
    h('p', { class: 'lede' }, 'Everyone you’ve said yes to. Take one back any time: they’re cut off on their next request.'),
    consents.length ? h(Paged, { items: consents, render: row, cls: 'rows' }) : h('p', { class: 'empty' }, 'You haven’t said yes to anyone yet.'),
    loose.length ? h('div', {}, h('h2', {}, 'Other keys'), h('ul', { class: 'rows' }, ...loose.map((k) => h('li', { key: k.id },
      h('div', {}, h('div', { class: 'r-title' }, `${k.visitor} · ${k.purpose}`), h('div', { class: 'r-meta' }, `${k.fields.map(nice).join(', ')} · ${hoursLeft(k.until)} left · ${k.authorizedBy}`)),
      takeBack(k.id, 'Revoke'))))) : null,
    live ? h('div', { class: 'savebar' }, h(Act, { label: 'Take every key back', cls: 'danger', run: async () => { if (confirm('Take back every key to your house?')) await call({ kind: 'revoke', revoke: 'all' }); } })) : null);
}

// ---- Rules ----
// The fields rules can name come from the packs this house takes part in (and the identifying ones they warn about).
type Purpose = { name: string; label: string; within?: string };
/** Your edits, kept until you save or undo (across redraws and tab changes). */
let rulesDraft: Rules | null = null;
/** Rules as they'd be saved: drawing the editor adds an empty trust section, which is no change. */
const normalRules = (r: Rules): Rules => { const c = structuredClone(r); if (c.trust && !Object.values(c.trust).some((v) => v?.length)) delete c.trust; return c; };

function RulesTab() {
  const res = useHouse<{ rules: Rules; text: string; fields?: { name: string; label: string; pack: string }[]; purposes?: Purpose[] }>({ kind: 'panel.rules' });
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const free = useHouse<FreeState>({ kind: 'panel.free' });
  const redraw = useRedraw();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const bump = useBump();
  if (!res.data) return h(Failed, { error: res.error });
  const saved = stringify(normalRules(res.data.rules));
  if (!rulesDraft) rulesDraft = structuredClone(res.data.rules);
  const r = rulesDraft;
  const trust = (r.trust ??= {});
  const fields = res.data.fields ?? [];
  const purposes = res.data.purposes?.length ? res.data.purposes : ['research', 'care', 'marketing', 'insurance'].map((name) => ({ name, label: name }));
  const changed = stringify(normalRules(r)) !== saved;
  const save = async () => {
    const res2 = await call<{ ok: boolean; error?: string }>({ kind: 'panel.rules.set', text: stringify(normalRules(r)) });
    setMessage(res2.ok ? { ok: true, text: 'Saved. Your housekeeper uses these from now on.' } : { ok: false, text: res2.error ?? 'not saved' });
    if (res2.ok) rulesDraft = null;
  };
  return h('div', {},
    door.data && !door.data.error ? h(DoorCard, { d: door.data }) : null,
    h(FreeCard, { f: free.data ?? { set: false, slots: [] }, av: res.data.rules.availability }),
    h('h2', { class: 'section' }, 'Who gets what'),
    h('p', { class: 'muted' }, 'Your housekeeper follows these, top to bottom; the first rule that fits decides. Nothing an agent writes can change them.'),
    ...r.rules.map((rule, i) => h(RuleCard, { key: i, r: rule, i, all: r.rules, fields, purposes, redraw })),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', onClick: () => { r.rules.push({ match: { purpose: 'research' }, decision: 'ask' }); redraw(); } }, '+ Add a rule')),
    h('details', { class: 'fold', style: 'margin-top:24px' }, h('summary', {}, 'More settings'),
      h('h3', {}, 'Everything else'),
      h('div', { class: 'card' },
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('span', { class: 'lab' }, 'When no rule fits'), h(Seg, { value: r.default, onPick: (d: Decision) => { r.default = d; redraw(); } })),
          h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Bargaining'), h(Toggle, { label: 'bargain together with neighbours (a bloc gets better terms)', checked: !!r.negotiation?.join_collectives, onChange: (v: boolean) => { r.negotiation = { ...(r.negotiation ?? {}), join_collectives: v }; redraw(); } })),
          h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Your house in public'), h(Toggle, { label: 'say what kinds of data my house holds (so agents with matching offers can find it)', checked: r.privacy?.show_packs !== false, onChange: (v: boolean) => { if (v) delete r.privacy; else r.privacy = { show_packs: false }; redraw(); } })),
          h('div', { class: 'field' }, h('span', { class: 'lab' }, 'My interests (for guilds)'), h(Chips, { values: r.tags ?? [], placeholder: 'add, then Enter', onChange: (v: string[]) => { r.tags = v; redraw(); } })))),
      h('h3', {}, 'Whose word counts'),
      h('div', { class: 'card' },
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Approvals and signatures count only from these domains. Anyone else’s counts as none.'),
        h('div', { class: 'grid2' }, ...(['ethics', 'auditors', 'issuers', 'payments'] as const).map((k) =>
          h('div', { class: 'field' }, h('span', { class: 'lab' }, { ethics: 'Ethics bodies', auditors: 'Auditors', issuers: 'Record issuers', payments: 'Payments' }[k]),
            h(Chips, { values: trust[k] ?? [], placeholder: 'domain, then Enter', onChange: (v: string[]) => { trust[k] = v; redraw(); } }))))),
      h('details', { style: 'margin-top:16px' }, h('summary', {}, 'See it as rules.yaml'), h('pre', {}, stringify(r)))),
    changed || message ? h('div', { class: 'savebar' },
      changed ? h(Act, { label: 'Save my rules', cls: 'primary', run: save }) : null,
      changed ? h('button', { class: 'btn', type: 'button', onClick: () => { rulesDraft = null; setMessage(null); bump(); } }, 'Undo changes') : null,
      message ? h('span', { class: `msg ${message.ok ? 'ok' : 'bad'}` }, message.text) : null) : null);
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

function Seg({ value, onPick }: { value: Decision; onPick: (d: Decision) => void }) {
  return h('div', { class: 'seg', role: 'group' }, ...(['join', 'ask', 'decline'] as Decision[]).map((d) =>
    h('button', { type: 'button', class: d, 'aria-pressed': String(value === d), onClick: () => onPick(d) }, { join: 'Join', ask: 'Ask me', decline: 'Decline' }[d])));
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked, onChange: (e: Event) => onChange((e.currentTarget as HTMLInputElement).checked) }), label);
}

function Chips({ values, placeholder, onChange }: { values: string[]; placeholder: string; onChange: (v: string[]) => void }) {
  return h('div', {}, ...values.map((v) => h('button', { type: 'button', class: 'chip', title: 'Remove', onClick: () => onChange(values.filter((x) => x !== v)) }, v, ' ✕')),
    h('input', { type: 'text', placeholder, onKeyDown: (e: KeyboardEvent) => { const i = e.currentTarget as HTMLInputElement; if (e.key === 'Enter' && i.value.trim()) { onChange([...values, i.value.trim()]); i.value = ''; } } }));
}

function RuleCard({ r, i, all, fields, purposes, redraw }: { r: Rule; i: number; all: Rule[]; fields: { name: string }[]; purposes: Purpose[]; redraw: () => void }) {
  const set = (k: string, v: string | boolean | number | undefined) => { if (v === undefined || v === '' || v === false) delete r.match[k]; else r.match[k] = v; redraw(); };
  const val = (e: Event) => (e.currentTarget as HTMLInputElement).value;
  // Each field cycles: not mentioned → share → never.
  const fieldChip = (f: string) => {
    const state = r.allow_fields?.includes(f) ? 'share' : r.deny_fields?.includes(f) ? 'never' : 'neutral';
    return h('button', { type: 'button', class: `chip ${state}`, title: 'Tap to cycle: not mentioned → share → never', onClick: () => {
      r.allow_fields = (r.allow_fields ?? []).filter((x) => x !== f);
      r.deny_fields = (r.deny_fields ?? []).filter((x) => x !== f);
      if (state === 'neutral') r.allow_fields.push(f);
      else if (state === 'share') r.deny_fields.push(f);
      if (!r.allow_fields.length) delete r.allow_fields;
      if (!r.deny_fields.length) delete r.deny_fields;
      redraw();
    } }, state === 'share' ? '✓ ' : state === 'never' ? '✕ ' : '', nice(f));
  };
  const move = (d: number) => { const j = i + d; if (j < 0 || j >= all.length) return; [all[i], all[j]] = [all[j]!, all[i]!]; redraw(); };
  // Each rule reads as one sentence; its settings are a tap away (a page of open forms was too much at once).
  return h('details', { class: 'rule' },
    h('summary', {}, h('span', { class: 'rule-n' }, String(i + 1)), h('span', { class: 'sum' }, ...summary(r))),
    h('div', { class: 'tools' },
      h('button', { class: 'btn small', type: 'button', onClick: () => move(-1), disabled: i === 0 }, '↑ Earlier'),
      h('button', { class: 'btn small', type: 'button', onClick: () => move(1), disabled: i === all.length - 1 }, '↓ Later'),
      h('button', { class: 'btn small danger', type: 'button', onClick: () => { all.splice(i, 1); redraw(); } }, 'Remove')),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', {}, 'When the purpose is'), h('select', { value: String(r.match.purpose ?? ''), onChange: (e: Event) => set('purpose', val(e)) },
        h('option', { value: '' }, 'any purpose'), ...purposes.map((p) => h('option', { value: p.name }, p.within ? `  ${p.label} (part of ${p.within})` : p.label)))),
      h('div', { class: 'field' }, h('label', {}, 'From'), h('input', { type: 'text', value: String(r.match.requester ?? ''), placeholder: 'any agent, or e.g. gp.example', onChange: (e: Event) => set('requester', val(e).trim()) })),
      h('div', { class: 'field' }, h('label', {}, 'Paying less than ($)'), h('input', { type: 'number', min: 0.5, step: 0.5, value: r.match.price_below ?? '', placeholder: 'any price', onChange: (e: Event) => set('price_below', val(e) === '' ? undefined : Number(val(e))) })),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Only if'),
        h(Toggle, { label: 'an ethics body I trust approved it', checked: !!r.match.ethics_approved, onChange: (v: boolean) => set('ethics_approved', v || undefined) }),
        h(Toggle, { label: 'an auditor I trust certified the study', checked: !!r.match.audit_certified, onChange: (v: boolean) => set('audit_certified', v || undefined) }),
        h(Toggle, { label: 'the sponsor is verified', checked: !!r.match.sponsor_verified, onChange: (v: boolean) => set('sponsor_verified', v || undefined) })),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Then'), h(Seg, { value: r.decision, onPick: (d: Decision) => { r.decision = d; redraw(); } }))),
    r.decision === 'join' ? h('div', { class: 'grid2', style: 'margin-top:14px' },
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Fields (tap to cycle)'), h('div', {}, ...fields.map((f) => fieldChip(f.name)))),
      h('div', { class: 'field' },
        h('label', {}, 'At least ($ per study)'), h('input', { type: 'number', min: 0, step: 0.5, value: r.min_price_usd ?? '', placeholder: 'any', onChange: (e: Event) => { if (val(e) === '') delete r.min_price_usd; else r.min_price_usd = Number(val(e)); redraw(); } }),
        h('div', { style: 'height:10px' }),
        h(Toggle, { label: 'they keep nothing after the study', checked: r.retention === 'none', onChange: (v: boolean) => { if (v) r.retention = 'none'; else delete r.retention; redraw(); } }),
        h('div', { style: 'height:10px' }),
        h('label', {}, 'Key lasts (hours)'), h('input', { type: 'number', min: 1, max: 720, value: r.grant_hours ?? '', placeholder: '48', onChange: (e: Event) => { if (val(e) === '') delete r.grant_hours; else r.grant_hours = Number(val(e)); redraw(); } }))) : null);
}

/**
 * Your door (SPEC §9.0): open it to give your house's address out, in a signature or as a QR code, so people's AI can knock
 * or leave a note. The address is the identifier; a name only if you add one. Saved in your rules, like any setting.
 */
function DoorCard({ d }: { d: DoorState }) {
  const about = useRef<HTMLInputElement>(null), name = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const save = (open: boolean) => async () => {
    const r = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.door.set', open, about: about.current!.value, name: name.current!.value });
    if (!r.ok) setMsg(r.error ?? 'not saved'); else { setMsg(''); rulesDraft = null; }
  };
  return h('section', { class: 'block', id: 'door' },
    h('h2', {}, d.open ? 'Your door is open' : 'Your door is closed'),
    h('p', { class: 'muted' }, d.open ? 'Anyone\'s AI can leave you a note at your address; your rules and your agent answer. Share it from Home.' : 'Open it to give your house\'s address out, so people can reach you through their AI. No name needed.'),
    d.open ? h('div', { class: 'row' }, h('a', { class: 'btn small', href: d.address, target: '_blank', rel: 'noopener' }, 'See it as others do')) : null,
    h('details', { class: 'fold', open: !d.open }, h('summary', {}, d.open ? 'Change what it says' : 'What it says'),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, 'One line on your door'), h('input', { ref: about, type: 'text', maxlength: 200, placeholder: 'e.g. Send your AI over: mine knows when I\'m free.', defaultValue: d.about ?? '' })),
      h('label', { class: 'field' }, h('span', { class: 'lab' }, 'A name to show (optional)'), h('input', { ref: name, type: 'text', maxlength: 60, placeholder: 'Optional: the address is enough', defaultValue: d.name ?? '' })),
      h('div', { class: 'row' }, h(Act, { label: d.open ? 'Save' : 'Open my door', cls: 'primary', run: save(true) }),
        d.open ? h(Act, { label: 'Close my door', run: save(false) }) : null, msg ? h('span', { class: 'muted' }, msg) : null)));
}

/**
 * Your door's address to hand out: your phone's own share sheet (Web Share), Copy, and a QR code a tap away, for a slide
 * or a sign on the wall.
 */
function ShareDoor({ address }: { address: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const share = 'share' in navigator;
  return h('section', { class: 'block' }, h('h2', {}, 'Your door'),
    h('div', { class: 'address' },
      h('div', {}, h('code', {}, address),
        h('div', { class: 'row' },
          share ? h('button', { class: 'btn small primary', type: 'button', onClick: () => void navigator.share({ title: 'Knock on my door', text: 'Talk to my agent:', url: address }).catch(() => {}) }, 'Share') : null,
          h(CopyButton, { text: address }),
          h('button', { class: 'btn small', type: 'button', onClick: async () => setQr(qr ? null : await QRCode.toDataURL(address, { margin: 1, width: 480 })) }, qr ? 'Hide QR code' : 'QR code'))),
      qr ? h('img', { class: 'qr', alt: 'QR code of your door\'s address', width: 200, height: 200, src: qr }) : null));
}

/**
 * When you're free to meet: windows like "mon-fri 09:00-12:00" in your own time zone. Your agent offers those times, around
 * what is already in your agenda, instead of asking you each time. Saved in your rules.
 */
function FreeCard({ f, av }: { f: FreeState; av?: { tz: string; free: string[]; meetings?: number } }) {
  const free = useRef<HTMLTextAreaElement>(null), len = useRef<HTMLSelectElement>(null);
  const [msg, setMsg] = useState('');
  const tz = av?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = (clear: boolean) => async () => {
    const lines = free.current!.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const res = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.availability.set', availability: clear || !lines.length ? null : { tz, free: lines, meetings: Number(len.current!.value) } });
    if (!res.ok) setMsg(res.error ?? 'not saved'); else { setMsg(''); rulesDraft = null; }
  };
  return h('section', { class: 'block', id: 'free' },
    h('h2', {}, 'When you\'re free to meet'),
    h('p', { class: 'muted' }, f.set ? `Your agent offers these times to people who want to meet you, around your agenda: ${f.slots.length} free in the next two weeks.` : 'Say when you\'re usually free, and your agent can offer people a time without asking you first.'),
    h('label', { class: 'field' }, h('span', { class: 'lab' }, `One window a line, in ${tz}`), h('textarea', { ref: free, rows: 3, placeholder: 'mon-fri 09:00-12:00\nsat 10:00-11:00', defaultValue: (av?.free ?? []).join('\n') })),
    h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Meetings last ', h('select', { ref: len }, ...[30, 45, 60, 90].map((m) => h('option', { value: String(m), selected: (av?.meetings ?? 60) === m }, `${m} min`)))),
      h(Act, { label: 'Save', cls: 'primary', run: save(false) }), av ? h(Act, { label: 'Clear', run: save(true) }) : null, msg ? h('span', { class: 'muted' }, msg) : null));
}

// ---- Offers ----
type Term = { kind: string; label: string; options: (string | number)[]; unit?: string; names?: Record<string, string> };
type Offer = {
  id: string; pack: string; quoter: { name: string; domain: string }; title: string; status: string; groupSize: number; fee?: number; currency?: string;
  result: { eligible: boolean; outputs: Record<string, number>; notes?: string[] }; labels?: Record<string, { label: string; unit?: string }>; answer?: Record<string, unknown>;
};
type Market = { intents: { pack: string; terms: Record<string, string | number>; members: number; group: string; agentsTold?: number; turnedAway?: { agent: string; code: string; why: string; at: string }[]; warning?: string }[]; offers: Offer[]; packs: { id: string; title: string; terms: Record<string, Term> }[] };
const isCurrency = (unit?: string) => !!unit && /^[A-Z]{3}$/.test(unit);
// In the reader's own locale: an Australian browser shows $1,269, a British one A$1,269.
// Whole amounts stay whole (a loan's monthly payment); a grocery total keeps its cents.
const money0 = (n: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
const fmt = (v: number, unit?: string) => (isCurrency(unit) ? money0(v, unit) : unit === '%' ? `${v}%` : unit === 'yes/no' ? (v ? 'yes' : 'no') : String(v));
/** One choice of an intent term, as the owner reads it: a price range in its currency, a state's name. */
const choice = (t: Term | undefined, x: string | number) =>
  t?.kind === 'band' && isCurrency(t.unit) ? String(x).split('-').map((y) => money0(Number(y), t.unit)).join('–') : t?.names?.[String(x)] ?? String(x);

function Offers() {
  const m = useHouse<Market>({ kind: 'panel.market' });
  if (!m.data) return h(Failed, { error: m.error });
  if (!m.data.packs.length) return h('p', { class: 'muted' }, 'This house takes part in no use case that has offers yet.');
  return h('div', {}, h('p', { class: 'lede' }, 'Say what you’re looking for. Authorised agents price it inside your house, on your own data, and only you see the result. Nothing leaves until you accept.'),
    ...m.data.packs.map((p) => h(PackOffers, { key: p.id, p, m: m.data! })));
}

function PackOffers({ p, m }: { p: Market['packs'][number]; m: Market }) {
  const form = useRef<HTMLDivElement>(null);
  const intent = m.intents.find((i) => i.pack === p.id);
  if (!intent) {
    // The form: the pack's coarse terms, each a choice, plus "work it out for me" where the pack can.
    const taken = m.offers.filter((o) => o.pack === p.id && o.status !== 'open');
    return h('div', {},
      h('div', { class: 'card', ref: form }, h('h3', {}, p.title),
        h('div', { class: 'grid2', style: 'margin-top:12px' }, ...Object.entries(p.terms).map(([k, t]) => h('div', { class: 'field' }, h('label', {}, t.label),
          h('select', { name: k }, ...(t.kind === 'band' ? [h('option', { value: 'auto' }, 'What I can afford (worked out in my house)')] : []), ...t.options.map((o) => h('option', { value: String(o) }, choice(t, o))))))),
        h('div', { style: 'margin-top:14px' }, h(Act, { label: `Ask for ${p.title.toLowerCase()}`, cls: 'primary', run: async () => {
          const terms = Object.fromEntries(Array.from(form.current!.querySelectorAll('select')).map((s) => [s.name, /^\d+$/.test(s.value) ? Number(s.value) : s.value]));
          await call({ kind: 'panel.intent.open', pack: p.id, terms });
        } }))),
      // Accepting closes the request; what you took stays here, with whether your agent has paid for it.
      taken.length ? h('ul', { class: 'rows' }, ...taken.map((o) => { const first = Object.keys(o.result.outputs)[0]!; const lab = o.labels?.[first] ?? { label: first }; return h('li', { key: o.id },
        h('div', {}, h('div', { class: 'r-title' }, `${o.quoter.name}: ${fmt(o.result.outputs[first]!, lab.unit)}`), h('div', { class: 'r-meta' }, `${lab.label} · ${o.status === 'paid' ? 'paid by your agent' : 'accepted, not paid yet'}`)),
        h('span', { class: `chip ${o.status === 'paid' ? 'share' : ''}` }, o.status)); })) : null);
  }
  const mine = m.offers.filter((o) => o.pack === p.id);
  const eligible = mine.filter((o) => o.result.eligible);
  return h('div', {},
    h('div', { class: 'card ok' },
      h('h3', {}, `Looking for ${p.title.toLowerCase()}`),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, Object.entries(intent.terms).map(([k, x]) => `${p.terms[k]?.label ?? k}: ${choice(p.terms[k], x)}`).join(' · ')),
      h('div', { class: 'r-meta' }, `${intent.members} household${intent.members === 1 ? '' : 's'} in your group · ${intent.agentsTold ?? 0} agent${intent.agentsTold === 1 ? '' : 's'} told · ${mine.length} priced it · ${eligible.length} offer${eligible.length === 1 ? '' : 's'} for you`),
      // Why the board is empty, when it is: the house's own record, or the agents it turned away and why.
      intent.warning ? h('p', { style: 'margin:10px 0 0;padding:8px 12px;border-left:3px solid var(--threat)' }, `${intent.warning.charAt(0).toUpperCase()}${intent.warning.slice(1)}.`) : null,
      intent.turnedAway?.length ? h('ul', { class: 'r-meta', style: 'margin:8px 0 0 18px' }, ...intent.turnedAway.map((t) => h('li', {}, `${t.agent}: ${t.why} (${t.code}, ${new Date(t.at).toLocaleTimeString()})`))) : null,
      h('div', { style: 'margin-top:12px' }, h(Act, { label: 'Stop looking', run: () => call({ kind: 'panel.intent.close', pack: p.id }) }))),
    !mine.length && !intent.warning ? h('p', { class: 'muted' }, 'Waiting for authorised agents to price it…') : null,
    ...mine.map((o) => h(OfferCard, { key: o.id, o, locked: eligible.some((x) => x.status === 'accepted') })));
}

function OfferCard({ o, locked }: { o: Offer; locked: boolean }) {
  const out = o.result.outputs;
  const lab = (k: string) => o.labels?.[k] ?? { label: k };
  // The headline: a loan's rate and monthly payment, or else the program's first output under its own label.
  const first = Object.keys(out)[0]!;
  const sub = (s: string) => h('span', { class: 'muted', style: 'font-size:14px;margin-left:10px' }, s);
  const headline = out.rate !== undefined ? [`${out.rate}%`, sub(`${fmt(out.monthly ?? 0, lab('monthly').unit)} a month`)] : [fmt(out[first]!, lab(first).unit), sub(lab(first).label)];
  const shown = out.rate !== undefined ? ['rate', 'monthly', 'group_off'] : [first, 'group_off'];
  const done = o.status === 'accepted' || o.status === 'paid';
  return h('article', { class: 'req', style: `border-color:${o.result.eligible ? 'var(--mint)' : 'var(--line)'}` },
    h('div', { class: 'who', style: 'font-size:16px' }, o.quoter.name, (out.group_off ?? 0) > 0 ? h('span', { class: 'chip share', style: 'margin-left:8px' }, `group rate −${out.group_off}%`) : null),
    o.result.eligible ? h('div', { class: 'r-title', style: 'font-size:22px' }, ...headline) : h('div', { class: 'r-title muted' }, 'Not for you this time'),
    // Every other output the program declares, by its own labels; the headline ones are above, and zeros say nothing.
    o.result.eligible ? h('dl', { class: 'facts' }, ...Object.keys(out).filter((k) => !shown.includes(k) && out[k]).map((k) => h('div', {}, h('dt', {}, lab(k).label), h('dd', {}, fmt(out[k]!, lab(k).unit)))),
      o.fee ? h('div', {}, h('dt', {}, 'Pays you'), h('dd', {}, `${money0(o.fee, o.currency)} if you accept`)) : null) : null,
    // The quoter's notes, worked out in your house: why it's not for you, or what would change.
    o.result.notes?.length ? h('ul', { class: 'r-meta', style: 'margin:8px 0 0 18px' }, ...o.result.notes.map((n) => h('li', {}, n))) : null,
    o.answer ? h('p', { class: 'advice' }, h('b', {}, o.quoter.name), String(o.answer.kind === 'agreed' ? `Yes: ${o.answer.what ?? 'agreed'}. ${o.answer.feePaid ? `${money0(Number(o.answer.feePaid), o.currency)} paid to you.` : ''} Next: ${o.answer.next ?? ''}` : o.answer.why ?? o.answer.kind)) : null,
    o.result.eligible ? h('div', { class: 'actions', style: 'grid-template-columns:1fr' },
      done || locked ? h('button', { class: 'btn allow', type: 'button', disabled: true }, o.status === 'paid' ? 'Paid' : o.status === 'accepted' ? 'Accepted' : 'Accept')
        : h(Act, { label: 'Accept', cls: 'allow', run: async () => {
          if (!confirm(`Accept ${o.quoter.name}'s offer? Your signed record goes to them, and only them, so they can confirm it.`)) return;
          const r = await acceptOffer(o.id);
          if (r.error) throw new Error(r.error);
        } })) : null);
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

// ---- Visitors ----
function Visitors() {
  const v = useHouse<{ agent: string; knocks: number; last: string; lastDecision?: string; blocked: number; reputation: number | null }[]>({ kind: 'panel.agents' });
  if (!v.data) return h(Failed, { error: v.error });
  // Keys that never proved who they are and only got blocked are noise next to real visitors: fold them away.
  const junk = v.data.filter((a) => a.agent.startsWith('key:') && a.blocked && !a.knocks);
  const row = (a: (typeof v.data)[number]) => h('li', { key: a.agent },
    h('div', {}, h('div', { class: 'r-title' }, a.agent.replace(/^agent:/, '').replace(/^key:/, 'unverified key ')),
      h('div', { class: 'r-meta' }, `${a.knocks} knock${a.knocks === 1 ? '' : 's'} · last ${time(a.last)}${a.lastDecision ? ` · you said ${a.lastDecision}` : ''}${a.blocked ? ` · ${a.blocked} blocked` : ''}`)),
    h('div', { class: 'r-meta' }, a.reputation === null ? (a.blocked ? 'blocked' : '') : h('span', {}, `reputation ${a.reputation}`, h('span', { class: 'rep' }, h('i', { style: `width:${Math.round(a.reputation * 100)}%` })))));
  const real = v.data.filter((a) => !junk.includes(a));
  return h('div', {},
    h('p', { class: 'lede' }, 'Agents that came to your door lately, and what your house told them.'),
    real.length ? h(Paged, { items: real, render: row, cls: 'rows' }) : h('p', { class: 'empty' }, 'No visitors yet.'),
    junk.length ? h('details', { class: 'fold' }, h('summary', {}, `${junk.length} unproven key${junk.length === 1 ? '' : 's'} tried something and ${junk.length === 1 ? 'was' : 'were'} blocked`), h('ul', { class: 'rows' }, ...junk.map(row))) : null);
}

// ---- My agent ----
/** The code you hand your agent, kept here so a tab change doesn't lose it while you copy it. */
let invite: { msg: string; until: number } | null = null;

/** Your own AI agent, inside your house: a key that may look and suggest, never decide. */
function MyAgent() {
  const v = useHouse<ListView>({ kind: 'list' });
  const redraw = useRedraw();
  // The code's minutes count down on screen; when it runs out, the button is back.
  useEffect(() => { const t = setInterval(redraw, 30_000); return () => clearInterval(t); }, []);
  if (!v.data) return h(Failed, { error: v.error });
  const houseUrl = location.origin + location.pathname.replace(/\/owner\/.*$/, '');
  if (invite && invite.until < Date.now()) invite = null;
  const give = h(Act, { label: v.data.assistants.length ? 'Connect another AI' : 'Give my AI a key', cls: v.data.assistants.length ? '' : 'primary', run: async () => {
    const r = await call<{ code: string; until: string }>({ kind: 'panel.assistant.invite', label: 'my assistant' });
    invite = { msg: `Connect to my house as my assistant: use lake_house_connect with house_url ${houseUrl} and code ${r.code}. Then look around inside and tell me what you see.`, until: Date.parse(r.until) };
  } });
  const mins = invite ? Math.max(1, Math.round((invite.until - Date.now()) / 60_000)) : 0;
  return h('div', {},
    h('p', { class: 'lede' }, 'Your own AI, with a key to your house: it sees what comes to your door and suggests. Only you decide.'),
    v.data.assistants.length ? h('section', { class: 'block' }, h('ul', { class: 'items' }, ...v.data.assistants.map((a) => h('li', { key: a.kid, class: 'item' },
      h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, shortName(a.label)), h('span', { class: 'chip ok' }, 'Connected')),
      h('p', { class: 'item-meta' }, `Since ${time(a.addedAt)} · looks and suggests${a.allowance ? ` · may spend ${money$(a.allowance.amount, a.allowance.currency)} until ${new Date(a.allowance.until).toLocaleDateString()}` : ''}`),
      h('div', { class: 'item-foot' },
        a.allowance || !a.canHaveAllowance ? h('span', {}, h(Allowance, { a })) : h('details', { class: 'more' }, h('summary', {}, 'Give it spending money'), h(Allowance, { a })),
        h(Act, { label: 'Revoke', cls: 'danger', run: async () => { if (confirm('Take its key back? It can no longer look inside or suggest.')) await call({ kind: 'panel.assistant.revoke', kid: a.kid }); } })))))) : null,
    invite ? h('section', { class: 'block start' }, h('h2', {}, 'Paste this to your AI'),
      h('p', { class: 'muted' }, `It needs the Lake connector. The code works once, for the next ${mins} minute${mins === 1 ? '' : 's'}.`),
      h('textarea', { readonly: true, rows: 5, class: 'copybox', value: invite.msg, onFocus: (e: Event) => (e.currentTarget as HTMLTextAreaElement).select() }),
      h('div', { class: 'row' }, h(CopyButton, { text: invite.msg }), h('button', { class: 'btn small quiet', type: 'button', onClick: () => { invite = null; redraw(); } }, 'Done')))
      : h('div', { class: 'block' }, give),
    h('section', { class: 'block' }, h('h2', {}, 'What it suggests'),
      v.data.suggestions.length ? h('ul', { class: 'items' }, ...v.data.suggestions.map((x) => h(SuggestionItem, { key: x.id, x }))) : h('p', { class: 'empty' }, 'Nothing yet. Its suggestions show up here and on Home.')));
}

/**
 * A spending allowance for one assistant (SPEC §6.2): the house drafts it, this device signs it with your key, and the
 * house checks it matches. Your assistant spends under it with lake_pay; payments refuse anything over it, after its
 * date, or once you take it back.
 */
function Allowance({ a }: { a: Assistant }) {
  const amount = useRef<HTMLInputElement>(null), currency = useRef<HTMLSelectElement>(null), days = useRef<HTMLSelectElement>(null);
  if (a.allowance) return h(Act, { label: 'Take the spending money back', cls: 'quiet', run: () => call({ kind: 'panel.allowance.revoke', kid: a.kid }) });
  if (!a.canHaveAllowance) return h('div', { class: 'r-meta' }, 'To give it spending money, connect it again with a new code.');
  return h('div', { class: 'row' },
    // The currency the shops you use quote in: nothing converts, so an allowance pays in its own currency only.
    h('select', { ref: currency }, ...CURRENCIES.map((c) => h('option', { value: c }, c))),
    h('input', { ref: amount, type: 'number', min: 1, max: 500, step: 1, defaultValue: '10' }),
    h('span', { class: 'muted' }, 'for'),
    h('select', { ref: days }, ...[1, 3, 7, 30].map((d) => h('option', { value: String(d), selected: d === 7 }, `${d} day${d === 1 ? '' : 's'}`))),
    h(Act, { label: 'Sign and give', run: async () => {
      const d = await call<{ id: string; draft: Record<string, unknown>; error?: string }>({ kind: 'panel.allowance.draft', kid: a.kid, amount: Number(amount.current!.value), currency: currency.current!.value, days: Number(days.current!.value) });
      if (d.error) throw new Error(d.error);
      const r = await call<{ ok?: boolean; error?: string }>({ kind: 'panel.allowance.set', id: d.id, credential: signCredential({ ...d.draft, validFrom: new Date().toISOString() }, loadKey()) });
      if (!r.ok) throw new Error(r.error ?? 'refused');
    } }));
}

// ---- Money ----
function Money() {
  const m = useHouse<{ total: number; receipts: { amount: number; currency: string; agreement: string; from: string; payer?: string; at: string; settlement: string }[]; spent?: { amount: number; currency: string; agreement: string; to: string; at: string }[] }>({ kind: 'panel.money' });
  if (!m.data) return h(Failed, { error: m.error });
  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return h('div', {},
    h('p', { class: 'lede' }, 'Every payment comes with a signed receipt, filed in your pod. On the sandbox, money is simulated.'),
    h('dl', { class: 'tiles' }, h('div', { class: 'tile mint' }, h('dt', {}, 'Earned'), h('dd', {}, `$${m.data.total}`)), h('div', { class: 'tile' }, h('dt', {}, 'Receipts'), h('dd', {}, String(m.data.receipts.length)))),
    m.data.receipts.length ? h('div', { style: 'margin-top:14px' }, h(Paged, { items: m.data.receipts, cls: 'rows', render: (r: (typeof m.data.receipts)[number]) => h('li', { key: `${r.at}-${r.agreement}` },
      h('div', { title: r.agreement }, h('div', { class: 'r-title' }, r.payer ? `${money$(r.amount, r.currency)} from ${who(r.payer)}` : money$(r.amount, r.currency)), h('div', { class: 'r-meta' }, `${when(r.at)} · signed by ${who(r.from)} · ${r.settlement}`)),
      h('span', { class: 'chip share' }, 'signed')) })) : h('p', { class: 'empty' }, 'No payments yet.'),
    // What your own agent paid for you, under the allowance you signed: its receipts, handed back to your house.
    m.data.spent?.length ? h('div', {}, h('h2', {}, 'Spent by your agent'), h('ul', { class: 'rows' }, ...m.data.spent.map((r, i) => h('li', { key: i },
      h('div', { title: r.agreement }, h('div', { class: 'r-title' }, `${money$(r.amount, r.currency)} to ${who(r.to)}`), h('div', { class: 'r-meta' }, `${when(r.at)} · under your allowance · ${r.agreement.replace(/^urn:(lake:order|ap2:cart):/, 'order ').slice(0, 40)}`)),
      h('span', { class: 'chip share' }, 'signed'))))) : null);
}

// ---- Data ----
function DataTab() {
  type Source = { pack: string; title: string; folder: string; issuer: string | null; converter: string; certifiedBy: string | null; ok: boolean; why?: string };
  const d = useHouse<{ claims: { field: string; label?: string; value: string; code?: string; observedAt?: string }[]; record: { ok: boolean; why?: string }; sources: Source[]; folders: Record<string, number> }>({ kind: 'panel.data' });
  if (!d.data) return h(Failed, { error: d.error });
  const by = new Map<string, typeof d.data.claims>();
  for (const c of d.data.claims) by.set(c.label ?? nice(c.field), [...(by.get(c.label ?? nice(c.field)) ?? []), c]);
  return h('div', {},
    h('p', { class: 'lede' }, 'What your house holds. It never leaves: programs run here, and only what you agreed to comes out.'),
    h('h2', {}, 'Where it came from'),
    h('ul', { class: 'items' }, ...d.data.sources.map((s) => h('li', { key: s.pack, class: 'item' },
      h('div', { class: 'item-head' }, h('span', { class: 'item-title' }, s.title), h('span', { class: `chip ${s.ok ? 'ok' : 'no'}` }, s.ok ? 'Verified' : 'Failed its check')),
      h('p', { class: 'item-meta' }, `Signed by ${s.issuer ?? 'unknown'}`),
      h('details', { class: 'more' }, h('summary', {}, 'Details'),
        h('dl', { class: 'facts' }, ...([['Converted by', s.converter], ['Certified by', s.certifiedBy ?? 'not certified'], ['Kept in', `/${s.folder}`], ['Check', s.ok ? 'every signature verifies, and the claims pass their shapes' : s.why ?? 'failed']] as [string, string][])
          .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))))))),
    h('h2', {}, 'What it says about you'),
    h('ul', { class: 'items' }, ...[...by].map(([label, cs]) => h('li', { key: label, class: 'item' }, h('div', { class: 'item-title' }, label),
      h('div', { class: 'row' }, ...cs.map((c) => h('span', { class: 'chip' }, c.value, c.observedAt ? ` · ${new Date(c.observedAt).toLocaleDateString()}` : '')))))),
    h('details', { class: 'fold' }, h('summary', {}, 'Folders in your pod'),
      h('ul', { class: 'rows' }, ...Object.entries(d.data.folders).map(([f, n]) => h('li', { key: f }, h('div', { class: 'r-title' }, `/${f}`), h('span', { class: 'count' }, `${n} item${n === 1 ? '' : 's'}`))))));
}

// ---- Move house ----
function Move() {
  const [note, setNote] = useState('');
  return h('div', {},
    h('p', { class: 'lede' }, 'Your house is yours. Take everything with you, to another host or to your own machine, whenever you like. No one can stop you.'),
    h('div', { class: 'row' }, h(Act, { label: 'Download everything', cls: 'primary', run: async () => {
      setNote('Collecting every file in your pod…');
      const x = await call<{ files: Record<string, string>; webId: string }>({ kind: 'panel.export' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(x, null, 2)], { type: 'application/json' }));
      a.download = `my-house-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setNote(`${Object.keys(x.files).length} files downloaded, including your agreements, receipts, audit log and wallet. Keep it safe: your wallet is in there.`);
    } })),
    note ? h('p', { class: 'muted' }, note) : null);
}

// ---- the app ----
const VIEWS: Record<Tab, (p: { go: (t: Tab) => void }) => VNode | null> = { home: Home, requests: Requests, offers: Offers, myagent: MyAgent, keys: Keys, rules: RulesTab, agents: Visitors, money: Money, data: DataTab, move: Move };

function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash());
  const [version, setVersion] = useState(0);
  // live: the house's stream is open; 'reconnecting' while a phone that went to another app gets it back (grey, not red).
  const [live, setLive] = useState<boolean | 'reconnecting'>(true);
  // Whether the house answers at all, from every call: red only when it doesn't.
  const [ok, setOk] = useState(reachable);
  useEffect(() => { reachWatchers.add(setOk); return () => { reachWatchers.delete(setOk); }; }, []);
  const bump = () => setVersion((v) => v + 1);
  const [list, setList] = useState<{ requests: Request[] } | null>(null);
  const [name, setName] = useState('');
  const [noOffers, setNoOffers] = useState(false);
  const go = (t: Tab) => { setTab(t); if (location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`); scrollTo(0, 0); };
  useEffect(() => { const f = () => setTab(tabFromHash()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  // The house's "something changed" (SSE), opened with a one-use token from a signed call (an EventSource can't sign);
  // a burst of changes is one refetch. A look every minute anyway, and when you come back to the page.
  useEffect(() => {
    let es: EventSource | null = null, timer: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const changed = () => { clearTimeout(timer); timer = setTimeout(bump, 150); };
    const open = () => call<{ path: string }>({ kind: 'panel.stream' }).then((s) => {
      if (stopped) return;
      es = new EventSource(`${api}${s.path}`);
      let first = true;
      es.addEventListener('changed', () => { if (first) first = false; else changed(); });
      es.onopen = () => setLive(true);
      es.onerror = () => { es?.close(); es = null; setLive('reconnecting'); clearTimeout(retry); retry = setTimeout(open, 3_000); };
    }).catch(() => { setLive(false); clearTimeout(retry); retry = setTimeout(open, 10_000); });
    void open();
    const every = setInterval(() => { if (!document.hidden) changed(); }, 60_000);
    // Back from another app: reconnect now if the phone dropped the stream, and catch up.
    const back = () => { if (document.hidden) return; if (!es) { clearTimeout(retry); void open(); } changed(); };
    addEventListener('visibilitychange', back);
    return () => { stopped = true; es?.close(); clearTimeout(timer); clearTimeout(retry); clearInterval(every); removeEventListener('visibilitychange', back); };
  }, []);
  // The badge, a buzz for a new request, the house's name.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    void call<{ requests: Request[] }>({ kind: 'list' }).then((v) => {
      if (v.requests.some((r) => !seen.current.has(r.id)) && seen.current.size) navigator.vibrate?.([120, 60, 120]);
      seen.current = new Set(v.requests.map((r) => r.id));
      setList(v);
    }).catch(() => {});
  }, [version]);
  useEffect(() => {
    void call<{ name: string }>({ kind: 'panel.overview' }).then((o) => setName(o.name)).catch(() => {});
    void call<{ packs: unknown[] }>({ kind: 'panel.market' }).then((m) => setNoOffers(!m.packs?.length)).catch(() => {});
  }, []);
  return h(Version.Provider, { value: { version, bump } },
    h('div', { class: 'shell' },
      h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('span', { class: 'sq' }), 'Your house'),
        h(Nav, { tab, go, pending: list?.requests.length ?? 0, noOffers })),
      h('main', {},
        h('header', { class: 'top' },
          h('div', { class: 'eyebrow' }, h('span', { class: `dot ${!ok ? 'down' : live === true ? 'live' : ''}`, title: !ok ? 'can\'t reach your house' : live === true ? 'live' : 'reconnecting' }), h('span', {}, 'Your house on the Lake')),
          h('h1', {}, name ? `House ${name}` : 'Your house')),
        h('section', { id: 'view' }, h(VIEWS[tab], { key: tab, go })))));
}

/** Not yours yet: just this house's name and the one thing to do. */
function Pair({ onPaired }: { onPaired: () => void }) {
  const [msg, setMsg] = useState('');
  const name = /\/t\/([^/]+)\/owner\//.exec(location.pathname)?.[1];
  const pair = async () => {
    const token = new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined;
    const res = await fetch(`${api}pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: key.jwk, token }) });
    const body = await res.json();
    if (!res.ok) return setMsg(body.error ?? 'pairing failed');
    webId = body.webId;
    leaseUntil = body.until ?? null;
    history.replaceState(null, '', location.pathname);
    onPaired();
  };
  // A link that carries a token pairs at once.
  useEffect(() => { if (location.hash.includes('pair=')) void pair(); }, []);
  return h('div', { class: 'shell unpaired' }, h('main', {},
    h('header', { class: 'top' }, h('div', { class: 'eyebrow' }, h('span', { class: 'dot' }), h('span', {}, 'A house on the Lake')), h('h1', {}, name ? `House ${name}` : 'A house on the Lake')),
    h('section', { id: 'pair' },
      h('p', { class: 'big' }, 'Make this phone its key'),
      h('p', { class: 'muted' }, 'A key is made here, on this phone, and never leaves it. From then on, only this phone can say yes for your house.'),
      h('button', { class: 'btn primary', type: 'button', onClick: () => void pair() }, 'Pair this device'),
      msg ? h('p', { class: 'muted' }, msg) : null)));
}

function Root() {
  // Paired before on this device (its last answers are kept): open straight away and check behind.
  const seen = cached<{ webId: string; until?: string }>(JSON.stringify({ kind: 'list' }));
  if (seen && !webId) { webId = seen.webId; leaseUntil = seen.until ?? null; }
  const [state, setState] = useState<'checking' | 'paired' | 'unpaired'>(seen ? 'paired' : 'checking');
  // Already paired? A signed "list" answers. Otherwise offer to pair (automatically when the link carries a token).
  useEffect(() => {
    void call<{ webId: string; until?: string }>({ kind: 'list' }).then((v) => { webId = v.webId; leaseUntil = v.until ?? null; remember(JSON.stringify({ kind: 'list' }), v); setState('paired'); }, (e: Error) => { if (reachable || !seen) setState('unpaired'); void e; });
  }, []);
  if (state === 'checking') return null;
  return state === 'paired' ? h(App, {}) : h(Pair, { onPaired: () => setState('paired') });
}

render(h(Root, {}), document.getElementById('app')!);
