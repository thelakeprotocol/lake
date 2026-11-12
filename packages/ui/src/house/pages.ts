import QRCode from 'qrcode';
import { stringify } from 'yaml';
import { useRef, useState } from 'preact/hooks';
import { call, key, must, state, useBump, useHouse, useRedraw } from './api';
import { Btn, CopyBtn, Empty, Failed, Info, Page, Pill, Row, Section, Sheet, h, toast } from './ion';
import { addressLine, ago, date, dayTime, duration, forWhat, hoursLeft, money$, named, nice, pledgeOf, said, signPledge, time, who, WEEK, readWindow, writeWindow, ZONES, type AccessRow, type Address, type Consent, type Decision, type FreeState, type Receipt, type Rule, type Rules, type Signed, type Win } from './logic';
import { signEnvelope } from '../owner-crypto';

// The pages under You. Each is one job, with its back to You.

type P = { backTo: () => void };
const page = (title: string, backTo: () => void, ...children: unknown[]) => h(Page, { title, back: backTo, backLabel: 'You' }, ...(children as never[]));

// ---- when you can meet ----
export function FreePage({ backTo }: P) {
  const res = useHouse<{ rules: Rules }>({ kind: 'panel.rules' });
  const free = useHouse<FreeState>({ kind: 'panel.free' });
  if (!res.data) return page('When you can meet', backTo, h(Failed, { error: res.error }));
  return page('When you can meet', backTo, h(FreeForm, { f: free.data ?? { set: false, slots: [] }, av: res.data.rules.availability }));
}
function FreeForm({ f, av }: { f: FreeState; av?: { tz: string; free: string[]; meetings?: number } }) {
  const [wins, setWins] = useState<Win[]>(() => (av?.free ?? []).map(readWindow).filter((w): w is Win => !!w));
  const [tz, setTz] = useState(av?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [len, setLen] = useState(av?.meetings ?? 60);
  const edit = (i: number, w: Partial<Win>) => setWins(wins.map((x, k) => (k === i ? { ...x, ...w } : x)));
  const save = (clear: boolean) => async () => {
    const ok = wins.filter((w) => w.days.length && w.from < w.to);
    if (!clear && wins.length && ok.length < wins.length) throw new Error('Each time needs a day, and to end after it starts.');
    await must({ kind: 'panel.availability.set', availability: clear || !ok.length ? null : { tz, free: ok.map(writeWindow), meetings: len } });
    if (clear) setWins([]);
  };
  const zones = ZONES.includes(tz) ? ZONES : [tz, ...ZONES];
  return h('div', {},
    h('p', { class: 'muted-line pad' }, f.set ? `Your AI offers these times around your agenda: ${f.slots.length} free in the next two weeks.` : 'Say when you\'re usually free, and your AI can offer a time without asking you.'),
    ...wins.map((w, i) => h('ion-card', { class: 'lake-card window', key: i }, h('ion-card-content', {},
      h('div', { class: 'days', role: 'group', 'aria-label': 'Days' }, ...WEEK.map((d) => h('button', { key: d, type: 'button', class: `day${w.days.includes(d) ? ' on' : ''}`, 'aria-pressed': String(w.days.includes(d)), onClick: () => edit(i, { days: w.days.includes(d) ? w.days.filter((x) => x !== d) : WEEK.filter((x) => x === d || w.days.includes(x)) }) }, d[0]!.toUpperCase() + d.slice(1, 2)))),
      h('div', { class: 'times' },
        h('ion-input', { type: 'time', value: w.from, 'aria-label': 'From', onionInput: (e: CustomEvent) => edit(i, { from: String(e.detail.value) }) }),
        h('span', {}, 'to'),
        h('ion-input', { type: 'time', value: w.to, 'aria-label': 'To', onionInput: (e: CustomEvent) => edit(i, { to: String(e.detail.value) }) }),
        h('ion-button', { fill: 'clear', color: 'medium', 'aria-label': 'Remove this time', onClick: () => setWins(wins.filter((_, k) => k !== i)) }, h('ion-icon', { name: 'trash-outline', slot: 'icon-only' })))))),
    h('div', { class: 'pad' }, h('ion-button', { shape: 'round', fill: 'outline', expand: 'block', onClick: () => setWins([...wins, { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '12:00' }]) }, h('ion-icon', { name: 'add', slot: 'start' }), wins.length ? 'Add another time' : 'Add a time')),
    h(Section, {},
      h('ion-item', {}, h('ion-select', { label: 'Time zone', class: 'tz', value: tz, interface: 'action-sheet', onionChange: (e: CustomEvent) => setTz(String(e.detail.value)) }, ...zones.map((z) => h('ion-select-option', { key: z, value: z }, z.replace(/_/g, ' '))))),
      h('ion-item', { lines: 'none' }, h('ion-select', { label: 'Meetings last', value: len, interface: 'popover', onionChange: (e: CustomEvent) => setLen(Number(e.detail.value)) }, ...[30, 45, 60, 90].map((m) => h('ion-select-option', { key: m, value: m }, `${m} min`))))),
    h('div', { class: 'pad stack' }, h(Btn, { label: 'Save', expand: 'block', run: save(false), done: 'Saved' }), av ? h(Btn, { label: 'Clear my times', expand: 'block', fill: 'clear', color: 'medium', run: save(true), ask: { header: 'Clear your times?', button: 'Clear' } }) : null));
}

// ---- rules ----
type Purpose = { name: string; label: string; within?: string };
let rulesDraft: Rules | null = null;
let rulesBase = '';
const normalRules = (r: Rules): Rules => { const c = structuredClone(r); if (c.trust && !Object.values(c.trust).some((v) => v?.length)) delete c.trust; return c; };
export const forgetRulesDraft = () => { rulesDraft = null; };
function summary(r: Rule): string {
  const w: string[] = [];
  if (r.match.purpose) w.push(`${r.match.purpose} requests`);
  if (r.match.requester) w.push(`from ${r.match.requester}`);
  if (r.match.ethics_approved) w.push('ethics-approved');
  if (r.match.audit_certified) w.push('certified');
  if (r.match.sponsor_verified) w.push('verified sponsor');
  if (r.match.price_below !== undefined) w.push(`paying under $${r.match.price_below}`);
  if (r.match.asks_identifying) w.push('asking for anything that identifies you');
  const head = w.length ? w.join(', ') : 'Any request';
  return `${head[0]!.toUpperCase()}${head.slice(1)} → ${{ join: 'join', ask: 'ask me first', decline: 'decline' }[r.decision]}`;
}
export function RulesPage({ backTo }: P) {
  const res = useHouse<{ rules: Rules; fields?: { name: string; label: string }[]; purposes?: Purpose[] }>({ kind: 'panel.rules' });
  const redraw = useRedraw();
  const bump = useBump();
  const [open, setOpen] = useState<number | null>(null);
  if (!res.data) return page('Rules', backTo, h(Failed, { error: res.error }));
  const saved = stringify(normalRules(res.data.rules));
  // A draft nobody touched follows the house's rules as they change (else a save's own refetch looked like an edit).
  if (!rulesDraft || (rulesBase !== saved && stringify(normalRules(rulesDraft)) === rulesBase)) { rulesDraft = structuredClone(res.data.rules); rulesBase = saved; }
  const r = rulesDraft;
  const trust = (r.trust ??= {});
  const fields = res.data.fields ?? [];
  const purposes = res.data.purposes?.length ? res.data.purposes : ['research', 'care', 'marketing', 'insurance'].map((name) => ({ name, label: name }));
  const changed = stringify(normalRules(r)) !== saved;
  const footer = changed ? h('div', { class: 'savebar' }, h(Btn, { label: 'Save my rules', run: async () => { await must({ kind: 'panel.rules.set', text: stringify(normalRules(r)) }); rulesDraft = null; void toast('Saved. Your house answers by these from now on.'); } }), h('ion-button', { fill: 'clear', color: 'medium', shape: 'round', onClick: () => { rulesDraft = null; bump(); } }, 'Undo changes')) : undefined;
  return h(Page, { title: 'Rules', back: backTo, backLabel: 'You', footer },
    h('p', { class: 'muted-line pad' }, 'Top to bottom; the first rule that fits decides. Nothing an agent writes can change them.'),
    h(Section, {}, ...r.rules.map((rule, i) => h('ion-item', { key: i, button: true, detail: true, class: 'rule', onClick: () => setOpen(open === i ? null : i) },
      h('div', { slot: 'start', class: `rule-n d-${rule.decision}` }, String(i + 1)), h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, summary(rule))))),
      h(Row, { icon: 'add', label: 'Add a rule', detail: false, onClick: () => { r.rules.push({ match: { purpose: 'research' }, decision: 'ask' }); setOpen(r.rules.length - 1); redraw(); } })),
    // A rule opens in a sheet over the list, where it was tapped (it had opened below the whole list).
    h(Sheet, { open: open !== null && !!r.rules[open], onClose: () => setOpen(null), title: open !== null ? `Rule ${open + 1}` : undefined },
      open !== null && r.rules[open] ? h(RuleEditor, { key: open, r: r.rules[open]!, i: open, all: r.rules, fields, purposes, redraw, close: () => setOpen(null) }) : null),
    h(Section, { title: 'More' },
      h('ion-item', {}, h('ion-label', {}, 'When no rule fits'), h(Seg, { value: r.default, onPick: (d: Decision) => { r.default = d; redraw(); } })),
      h('ion-item', {}, h('ion-toggle', { checked: !!r.negotiation?.join_collectives, onionChange: (e: CustomEvent) => { r.negotiation = { ...(r.negotiation ?? {}), join_collectives: e.detail.checked }; redraw(); } }, 'Bargain with neighbours')),
      h('ion-item', { lines: 'none' }, h('ion-toggle', { checked: r.privacy?.show_packs !== false, onionChange: (e: CustomEvent) => { if (e.detail.checked) delete r.privacy; else r.privacy = { show_packs: false }; redraw(); } }, 'Say what kinds of data I hold'))),
    h('ion-accordion-group', { class: 'lake-accordion' },
      h('ion-accordion', { value: 'adv' }, h('ion-item', { slot: 'header' }, h('ion-label', {}, 'Advanced')), h('div', { slot: 'content', class: 'pad' },
        h('p', { class: 'muted-line' }, 'Interests you bargain with, and whose approvals count (by domain).'),
        h(Chips, { label: 'Interests', values: r.tags ?? [], onChange: (v: string[]) => { r.tags = v; redraw(); } }),
        ...(['ethics', 'auditors', 'issuers', 'payments'] as const).map((k) => h(Chips, { key: k, label: { ethics: 'Ethics bodies', auditors: 'Auditors', issuers: 'Record issuers', payments: 'Payments' }[k], values: trust[k] ?? [], onChange: (v: string[]) => { trust[k] = v; redraw(); } })),
        h('details', {}, h('summary', {}, 'As rules.yaml'), h('pre', { class: 'yaml' }, stringify(r)))))));
}
const Seg = ({ value, onPick }: { value: Decision; onPick: (d: Decision) => void }) => h('ion-segment', { value, slot: 'end', class: 'decision-seg', onionChange: (e: CustomEvent) => onPick(e.detail.value as Decision) },
  ...(['join', 'ask', 'decline'] as Decision[]).map((d) => h('ion-segment-button', { key: d, value: d }, h('ion-label', {}, { join: 'Join', ask: 'Ask me', decline: 'Decline' }[d]))));
function Chips({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const [v, setV] = useState('');
  return h('div', { class: 'chips-field' }, h('p', { class: 'chips-label' }, label),
    h('div', { class: 'chips' }, ...values.map((x) => h('ion-chip', { key: x, onClick: () => onChange(values.filter((y) => y !== x)) }, x, h('ion-icon', { name: 'close-circle' })))),
    h('ion-input', { value: v, placeholder: 'Add, then Enter', 'aria-label': `Add to ${label}`, onionInput: (e: CustomEvent) => setV(String(e.detail.value ?? '')), onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' && v.trim()) { onChange([...values, v.trim()]); setV(''); } } }));
}
function RuleEditor({ r, i, all, fields, purposes, redraw, close }: { r: Rule; i: number; all: Rule[]; fields: { name: string; label?: string }[]; purposes: Purpose[]; redraw: () => void; close: () => void }) {
  const set = (k: string, v: string | boolean | number | undefined) => { if (v === undefined || v === '' || v === false) delete r.match[k]; else r.match[k] = v; redraw(); };
  const move = (d: number) => { const j = i + d; if (j < 0 || j >= all.length) return; [all[i], all[j]] = [all[j]!, all[i]!]; close(); redraw(); };
  const fieldChip = (f: string) => {
    const st = r.allow_fields?.includes(f) ? 'share' : r.deny_fields?.includes(f) ? 'never' : 'neutral';
    return h('ion-chip', { key: f, class: `field-chip ${st}`, onClick: () => {
      r.allow_fields = (r.allow_fields ?? []).filter((x) => x !== f); r.deny_fields = (r.deny_fields ?? []).filter((x) => x !== f);
      if (st === 'neutral') r.allow_fields.push(f); else if (st === 'share') r.deny_fields.push(f);
      if (!r.allow_fields.length) delete r.allow_fields; if (!r.deny_fields.length) delete r.deny_fields; redraw();
    } }, st === 'share' ? '✓ ' : st === 'never' ? '✕ ' : '', nice(f));
  };
  return h('div', { class: 'rule-editor sheet-body' }, h('div', {},
    h('ion-list', { class: 'lake-list flat' },
      h('ion-item', {}, h('ion-select', { label: 'Purpose', value: String(r.match.purpose ?? ''), interface: 'action-sheet', onionChange: (e: CustomEvent) => set('purpose', String(e.detail.value)) }, h('ion-select-option', { value: '' }, 'Any'), ...purposes.map((p) => h('ion-select-option', { key: p.name, value: p.name }, p.label)))),
      h('ion-item', {}, h('ion-input', { label: 'From', value: String(r.match.requester ?? ''), placeholder: 'any agent', onionChange: (e: CustomEvent) => set('requester', String(e.detail.value ?? '').trim()) })),
      h('ion-item', {}, h('ion-input', { label: 'When it pays less than ($)', type: 'number', value: r.match.price_below ?? '', placeholder: 'any', onionChange: (e: CustomEvent) => set('price_below', e.detail.value === '' ? undefined : Number(e.detail.value)) })),
      h('ion-item', {}, h('ion-toggle', { checked: !!r.match.ethics_approved, onionChange: (e: CustomEvent) => set('ethics_approved', e.detail.checked || undefined) }, 'Only if ethics-approved')),
      h('ion-item', {}, h('ion-toggle', { checked: !!r.match.audit_certified, onionChange: (e: CustomEvent) => set('audit_certified', e.detail.checked || undefined) }, 'Only if certified')),
      h('ion-item', {}, h('ion-label', {}, 'Then'), h(Seg, { value: r.decision, onPick: (d: Decision) => { r.decision = d; redraw(); } }))),
    r.decision === 'join' ? h('div', {},
      h('p', { class: 'chips-label' }, 'Fields (tap: share, never)'), h('div', { class: 'chips' }, ...fields.map((f) => fieldChip(f.name))),
      h('ion-list', { class: 'lake-list flat' },
        h('ion-item', {}, h('ion-input', { label: 'At least ($)', type: 'number', value: r.min_price_usd ?? '', placeholder: 'any', onionChange: (e: CustomEvent) => { if (e.detail.value === '') delete r.min_price_usd; else r.min_price_usd = Number(e.detail.value); redraw(); } })),
        h('ion-item', {}, h('ion-toggle', { checked: r.retention === 'none', onionChange: (e: CustomEvent) => { if (e.detail.checked) r.retention = 'none'; else delete r.retention; redraw(); } }, 'They keep nothing')),
        h('ion-item', { lines: 'none' }, h('ion-input', { label: 'Access lasts (hours)', type: 'number', value: r.grant_hours ?? '', placeholder: '48', onionChange: (e: CustomEvent) => { if (e.detail.value === '') delete r.grant_hours; else r.grant_hours = Number(e.detail.value); redraw(); } })))) : null,
    h('div', { class: 'card-actions wrap' },
      h('ion-button', { size: 'small', fill: 'outline', shape: 'round', disabled: i === 0, onClick: () => move(-1) }, h('ion-icon', { name: 'arrow-up', slot: 'start' }), 'Earlier'),
      h('ion-button', { size: 'small', fill: 'outline', shape: 'round', disabled: i === all.length - 1, onClick: () => move(1) }, h('ion-icon', { name: 'arrow-down', slot: 'start' }), 'Later'),
      h('ion-button', { size: 'small', fill: 'clear', color: 'danger', shape: 'round', onClick: () => { all.splice(i, 1); close(); redraw(); } }, 'Remove'),
      h('ion-button', { size: 'small', fill: 'clear', shape: 'round', onClick: close }, 'Done'))));
}

// ---- who has access ----
export function AccessPage({ backTo }: P) {
  const a = useHouse<{ now: number; askedToday: number; blockedToday: number; agents: AccessRow[] }>({ kind: 'panel.access', tz_offset: new Date().getTimezoneOffset() });
  const [filter, setFilter] = useState<'now' | 'asked' | 'all'>('now');
  const [openRow, setOpenRow] = useState<string | null>(null);
  if (!a.data) return page('Who has access', backTo, h(Failed, { error: a.error }));
  const { now, askedToday, blockedToday, agents } = a.data;
  const junk = agents.filter((r) => !r.domain && !r.yeses.length && !r.asked && r.blocked);
  const shown = agents.filter((r) => !junk.includes(r)).filter((r) => (filter === 'now' ? r.canSee : filter === 'asked' ? !!r.lastAsked : true));
  const why = (c: Consent) => (c.how.live ? 'you tapped Allow' : c.how.rule ? `your rule ${c.how.rule}` : 'your rules');
  const footer = now ? h('div', { class: 'savebar' }, h(Btn, { label: 'Take everything back', color: 'danger', fill: 'outline', run: () => call({ kind: 'revoke', revoke: 'all' }), ask: { header: 'Take every yes back?', sub: 'Every agent is cut off on its next request.', button: 'Take everything back' }, done: 'Taken back' })) : undefined;
  return h(Page, { title: 'Who has access', back: backTo, backLabel: 'You', footer },
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat mint' }, h('b', {}, String(now)), h('span', {}, 'can see now')),
      h('div', { class: 'stat' }, h('b', {}, String(askedToday)), h('span', {}, 'asked today')),
      h('div', { class: 'stat' }, h('b', {}, String(blockedToday)), h('span', {}, 'blocked today'))),
    h('div', { class: 'pad' }, h('ion-segment', { value: filter, onionChange: (e: CustomEvent) => setFilter(e.detail.value), 'aria-label': 'Show' },
      h('ion-segment-button', { value: 'now' }, h('ion-label', {}, 'Can see now')), h('ion-segment-button', { value: 'asked' }, h('ion-label', {}, 'Asked lately')), h('ion-segment-button', { value: 'all' }, h('ion-label', {}, 'Everyone')))),
    shown.length ? h(Section, {}, ...shown.slice(0, 40).map((r) => {
      const open = r.yeses.filter((c) => c.status === 'active');
      const fields = [...new Set(open.flatMap((c) => c.fields.map((f) => f.label)))];
      const latest = [...open].sort((x, y) => y.until.localeCompare(x.until))[0];
      const expanded = openRow === r.id;
      return [
        h('ion-item', { key: r.id, button: true, detail: false, lines: expanded ? 'none' : 'full', class: 'access-row', onClick: () => setOpenRow(expanded ? null : r.id) },
          h('div', { slot: 'start', class: `row-icon tint-${r.canSee ? 'blue' : 'muted'}` }, h('ion-icon', { name: r.canSee ? 'eye-outline' : 'eye-off-outline' })),
          h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, r.domain ?? r.id.replace(/^key:/, 'unverified key ')),
            h('p', {}, latest ? `Can see ${fields.join(', ')} · ${hoursLeft(latest.until)} left · ${why(latest)}` : 'Can\'t see anything now'),
            r.asked || r.last ? h('p', {}, `Asked ${r.asked}×${r.lastAsked ? `, ${ago(r.lastAsked)}` : ''}${r.last ? ` · your house ${said(r.last.decision)}` : ''}`) : null,
            open.length ? h('div', { class: 'row-below', onClick: (e: Event) => e.stopPropagation() }, h(Btn, { label: 'Take it back', size: 'small', fill: 'outline', color: 'danger', run: async () => { for (const c of open) await call({ kind: 'revoke', revoke: c.id }); }, ask: { header: `Take back ${r.domain ?? 'this agent'}'s access?`, button: 'Take back' }, done: 'Taken back' })) : null)),
        expanded ? h('div', { key: `${r.id}-x`, class: 'access-more' },
          ...r.standing.map((st) => h('div', { key: st.purpose, class: 'more-line' }, h('span', {}, `Always yes to ${st.domain || 'this agent'}, for ${st.purpose} · used ${st.uses} time${st.uses === 1 ? '' : 's'}`), h(Btn, { label: 'Remove', size: 'small', fill: 'clear', color: 'danger', run: () => call({ kind: 'panel.standing.remove', jkt: st.jkt, purpose: st.purpose }) }))),
          ...r.yeses.slice(0, 15).map((c) => h('div', { key: c.id, class: 'more-line' }, h('span', {}, `${dayTime(c.given)} · ${c.fields.map((f) => f.label).join(', ')} · ${{ active: `until ${dayTime(c.until)}`, withdrawn: 'taken back', used: 'used', ended: 'ended' }[c.status]}`), c.status === 'active' ? h(Btn, { label: 'Take back', size: 'small', fill: 'clear', color: 'danger', run: () => call({ kind: 'revoke', revoke: c.id }) }) : null)),
          ...r.asks.slice(0, 8).map((q, k) => h('div', { key: `q${k}`, class: 'more-line muted' }, `${time(q.at)} · your house ${said(q.decision)}${q.reason ? `: ${q.reason}` : ''}`)),
          r.webId ? h('p', { class: 'mono small' }, r.webId) : null) : null];
    }).flat()) : h(Empty, { icon: 'eye-off-outline', title: filter === 'now' ? 'Nobody can see your data' : filter === 'asked' ? 'Nobody has asked lately' : 'Nobody has come yet' }),
    junk.length ? h('p', { class: 'muted-line pad' }, `${junk.length} unproven key${junk.length === 1 ? '' : 's'} tried something and ${junk.length === 1 ? 'was' : 'were'} blocked.`) : null);
}

// ---- offers for you ----
type Term = { kind: string; label: string; options: (string | number)[]; unit?: string; names?: Record<string, string> };
type Offer = { id: string; pack: string; quoter: { name: string; domain: string }; title: string; status: string; groupSize: number; fee?: number; currency?: string; result: { eligible: boolean; outputs: Record<string, number>; notes?: string[] }; labels?: Record<string, { label: string; unit?: string }>; answer?: Record<string, unknown> };
type Market = { intents: { pack: string; terms: Record<string, string | number>; members: number; group: string; agentsTold?: number; warning?: string }[]; offers: Offer[]; packs: { id: string; title: string; terms: Record<string, Term> }[] };
const isCurrency = (u?: string) => !!u && /^[A-Z]{3}$/.test(u);
const money0 = (n: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
const fmt = (v: number, unit?: string) => (isCurrency(unit) ? money0(v, unit) : unit === '%' ? `${v}%` : unit === 'yes/no' ? (v ? 'yes' : 'no') : String(v));
const choice = (t: Term | undefined, x: string | number) => (t?.kind === 'band' && isCurrency(t.unit) ? String(x).split('-').map((y) => money0(Number(y), t.unit)).join('–') : t?.names?.[String(x)] ?? String(x));
export function OffersPage({ backTo }: P) {
  const m = useHouse<Market>({ kind: 'panel.market' });
  if (!m.data) return page('Offers for you', backTo, h(Failed, { error: m.error }));
  if (!m.data.packs.length) return page('Offers for you', backTo, h(Empty, { icon: 'pricetags-outline', title: 'No offers here yet' }));
  return page('Offers for you', backTo, h('p', { class: 'muted-line pad' }, 'Shops price what you need inside your house; only you see it.'), ...m.data.packs.map((p) => h(PackOffers, { key: p.id, p, m: m.data! })));
}
function PackOffers({ p, m }: { p: Market['packs'][number]; m: Market }) {
  const form = useRef<Record<string, string | number>>({});
  const intent = m.intents.find((i) => i.pack === p.id);
  if (!intent) return h('ion-card', { class: 'lake-card' }, h('ion-card-content', {}, h('h3', {}, p.title),
    h('ion-list', { class: 'lake-list flat' }, ...Object.entries(p.terms).map(([k, t]) => h('ion-item', { key: k }, h('ion-select', { label: t.label, interface: 'action-sheet', value: t.kind === 'band' ? 'auto' : t.options[0], onionChange: (e: CustomEvent) => { form.current[k] = e.detail.value; } },
      ...(t.kind === 'band' ? [h('ion-select-option', { value: 'auto' }, 'What I can afford')] : []), ...t.options.map((o) => h('ion-select-option', { key: String(o), value: o }, choice(t, o))))))),
    h(Btn, { label: `Ask for ${p.title.toLowerCase()}`, expand: 'block', run: () => call({ kind: 'panel.intent.open', pack: p.id, terms: Object.fromEntries(Object.entries(p.terms).map(([k, t]) => [k, form.current[k] ?? (t.kind === 'band' ? 'auto' : t.options[0])])) }) })));
  const mine = m.offers.filter((o) => o.pack === p.id);
  return h('div', {},
    h('ion-card', { class: 'lake-card ok-card' }, h('ion-card-content', {}, h('h3', {}, `Looking for ${p.title.toLowerCase()}`),
      h('p', { class: 'muted-line' }, Object.entries(intent.terms).map(([k, x]) => `${p.terms[k]?.label ?? k}: ${choice(p.terms[k], x)}`).join(' · ')),
      h('p', { class: 'muted-line' }, `${intent.members} in your group · ${mine.length} priced it`), intent.warning ? h('p', { class: 'warn-text' }, intent.warning) : null,
      h(Btn, { label: 'Stop looking', fill: 'clear', color: 'medium', run: () => call({ kind: 'panel.intent.close', pack: p.id }) }))),
    ...mine.map((o) => { const out = o.result.outputs, first = Object.keys(out)[0]!, lab = (k: string) => o.labels?.[k] ?? { label: k }; const done = o.status === 'accepted' || o.status === 'paid';
      return h('ion-card', { key: o.id, class: `lake-card offer${o.result.eligible ? '' : ' dim'}` }, h('ion-card-content', {},
        h('div', { class: 'offer-head' }, h('h3', { class: 'offer-shop' }, o.quoter.name), o.result.eligible ? h('b', { class: 'offer-total' }, fmt(out[first]!, lab(first).unit)) : h(Pill, { text: 'Not for you' })),
        o.result.eligible ? h('p', { class: 'muted-line' }, Object.keys(out).filter((k) => k !== first && out[k]).map((k) => `${lab(k).label}: ${fmt(out[k]!, lab(k).unit)}`).join(' · ')) : null,
        o.result.notes?.length ? h('p', { class: 'muted-line' }, o.result.notes.join(' ')) : null,
        o.result.eligible ? (done ? h(Pill, { text: o.status === 'paid' ? 'Paid' : 'Accepted', tone: 'mint' }) : h(Btn, { label: 'Accept', expand: 'block', run: async () => { const r = await call<{ error?: string }>({ kind: 'panel.offer.accept', offer: o.id, even_over_allowance: true }); if (r.error) throw new Error(r.error); }, ask: { header: `Accept ${o.quoter.name}?`, sub: 'What it needs goes to that one shop.', button: 'Accept', destructive: false } })) : null)); }));
}

// ---- money ----
export function MoneyPage({ backTo }: P) {
  const m = useHouse<{ total: number; held?: number; receipts: Receipt[]; spent?: { amount: number; currency: string; agreement: string; to: string; at: string; settlement?: string }[] }>({ kind: 'panel.money' });
  const [open, setOpen] = useState<string | null>(null);
  if (!m.data) return page('Money', backTo, h(Failed, { error: m.error }));
  const status = (r: Receipt) => (r.settlement === 'held' ? 'held' : r.settlement === 'voided' ? 'refunded' : 'paid');
  // The same thing paid by the same payer is one row (a study pays every house each round: 36 rows said one thing).
  const groups = new Map<string, Receipt[]>();
  for (const r of m.data.receipts) { const k = `${forWhat(r)}|${named(r.payerName, r.payer)}|${status(r)}|${r.currency}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const spent = m.data.spent ?? [];
  const spentIn = new Set(spent.map((r) => r.currency));
  return page('Money', backTo,
    h('div', { class: 'stat-row' }, h('div', { class: 'stat mint' }, h('b', {}, `$${m.data.total}`), h('span', {}, 'Earned')),
      m.data.held ? h('div', { class: 'stat' }, h('b', {}, `$${m.data.held}`), h('span', {}, 'Held')) : null,
      spent.length ? h('div', { class: 'stat' }, h('b', {}, spentIn.size === 1 ? money$(Math.round(spent.reduce((t, r) => t + r.amount, 0) * 100) / 100, spent[0]!.currency) : String(spent.length)), h('span', {}, 'Spent')) : null),
    groups.size ? h(Section, { title: 'Received' }, ...[...groups].slice(0, 50).map(([k, rs]) => {
      const r = rs[0]!, n = rs.length, sum = Math.round(rs.reduce((t, x) => t + x.amount, 0) * 100) / 100;
      return [
        h('ion-item', { key: k, button: true, detail: false, lines: open === k ? 'none' : 'full', class: 'pay', onClick: () => setOpen(open === k ? null : k) },
          h('div', { slot: 'start', class: 'row-icon tint-mint' }, h('ion-icon', { name: 'arrow-down-outline' })),
          h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, `${money$(sum, r.currency)} · ${forWhat(r)}`),
            h('p', {}, `from ${named(r.payerName, r.payer)}${r.via ? ` · sold by ${named(r.viaName, r.via)}` : ''} · ${n > 1 ? `${n} payments, last ${dayTime(r.at)}` : dayTime(r.at)}`)),
          h(Pill, { text: status(r), tone: status(r) === 'held' ? 'amber' : 'mint' })),
        open === k ? h('div', { key: `${k}x`, class: 'access-more' }, ...rs.slice(0, 20).map((x, i) => h('div', { key: i },
          h('p', { class: 'more-line muted' }, `${n > 1 ? `${money$(x.amount, x.currency)} · ${dayTime(x.at)} · ` : ''}Signed by ${who(x.from)}`),
          x.heldUntil ? h('p', { class: 'more-line muted' }, `Held until the buyer accepts, ${dayTime(x.heldUntil)} at the latest`) : null))) : null];
    }).flat()) : h(Empty, { icon: 'wallet-outline', title: 'No payments yet' }),
    m.data.spent?.length ? h(Section, { title: 'What you spent' }, ...m.data.spent.slice(0, 50).map((r, i) => h('ion-item', { key: `s${i}`, lines: 'full', class: 'pay' },
      h('div', { slot: 'start', class: 'row-icon tint-amber' }, h('ion-icon', { name: 'arrow-up-outline' })),
      h('ion-label', {}, h('h3', {}, pledgeOf(r.agreement) ? `${money$(r.amount, r.currency)} for "${pledgeOf(r.agreement)!.id}"` : `${money$(r.amount, r.currency)} to ${who(r.to)}`), h('p', {}, dayTime(r.at))),
      h(Pill, { text: r.settlement === 'held' ? 'held' : r.settlement === 'voided' ? 'returned' : 'paid', tone: r.settlement === 'held' ? 'amber' : 'muted' })))) : null);
}

// ---- what your house holds ----
export function DataPage({ backTo }: P) {
  type Source = { pack: string; title: string; folder: string; issuer: string | null; converter: string; certifiedBy: string | null; ok: boolean; why?: string };
  const d = useHouse<{ claims: { field: string; label?: string; value: string; observedAt?: string }[]; sources: Source[]; folders: Record<string, number> }>({ kind: 'panel.data' });
  if (!d.data) return page('What your house holds', backTo, h(Failed, { error: d.error }));
  const by = new Map<string, string[]>();
  for (const c of d.data.claims) by.set(c.label ?? nice(c.field), [...(by.get(c.label ?? nice(c.field)) ?? []), c.value]);
  return page('What your house holds', backTo,
    h('p', { class: 'muted-line pad' }, 'It never leaves: programs run here, and only what you agree to comes out.'),
    h(Section, { title: 'Where it came from' }, ...d.data.sources.map((s) => h(Row, { key: s.pack, icon: s.ok ? 'shield-checkmark-outline' : 'alert-circle-outline', tint: s.ok ? 'mint' : 'red', label: s.title, sub: `Signed by ${s.issuer ?? 'unknown'}${s.ok ? '' : ` · ${s.why ?? 'failed its check'}`}` }))),
    h(Section, { title: 'What it says about you' }, ...[...by].map(([label, vs]) => h('ion-item', { key: label, lines: 'full' }, h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, label), h('p', {}, vs.join(' · ')))))),
    h(Info, {}, h('p', {}, Object.entries(d.data.folders).map(([f, n]) => `/${f}: ${n}`).join(' · '))));
}

// ---- circles ----
type CircleRow = { tally: string; url: string; id: string; rule?: { kinds?: string[]; perWeek: number }; view: { text?: string; promise?: string; times_a_year?: number; kinds?: string[]; members?: number; open?: boolean; kept?: number; of?: number; you?: { kept: number; offers?: string[]; owed_to_you?: number; you_owe?: number }; problems?: string[] } };
export function CirclesPage({ backTo }: P) {
  const d = useHouse<CircleRow[]>({ kind: 'panel.circles' });
  if (!d.data) return page('Your promise circles', backTo, h(Failed, { error: d.error }));
  const sum = (k: 'owed_to_you' | 'you_owe') => d.data!.reduce((n, c) => n + Number(c.view.you?.[k] ?? 0), 0);
  return page('Your promise circles', backTo,
    d.data.length ? d.data.map((c) => h(CircleCard, { key: `${c.url}|${c.id}`, c })) : h(Empty, { icon: 'people-outline', title: 'You\'re in no circles yet', text: 'Your AI can suggest one.' }),
    sum('owed_to_you') && sum('you_owe') ? h('div', { class: 'pad' }, h(Btn, { label: 'Pass a favour on', expand: 'block', fill: 'outline', run: () => must<Signed>({ kind: 'panel.favour.pass' }), done: 'Offered: once they agree, you\'re square' })) : null);
}
function CircleCard({ c }: { c: CircleRow }) {
  const [mine, setMine] = useState<string[]>(c.view.you?.offers ?? c.view.kinds ?? []);
  const [per, setPer] = useState(c.rule?.perWeek ?? 0);
  const [need, setNeed] = useState(''), [when, setWhen] = useState(''), [help, setHelp] = useState(c.view.kinds?.[0] ?? '');
  const [limit, setLimit] = useState(0);
  const toggle = async (k: string) => { const next = mine.includes(k) ? mine.filter((x) => x !== k) : [...mine, k]; if (!next.length) return; const r = await call<{ kind?: string; offers?: string[] }>({ kind: 'panel.circle.offer', tally: c.url, id: c.id, kinds: next }); if (r.kind === 'circle.offered') setMine(r.offers ?? next); };
  return h('ion-card', { class: 'lake-card circle-card' }, h('ion-card-content', {},
    h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'people-outline' }), 'Your promise circles'),
    h('h3', {}, c.view.text ?? c.id),
    h('p', { class: 'muted-line' }, c.view.promise ? `You promised: ${c.view.promise}, ${c.view.times_a_year === 1 ? 'once' : `${c.view.times_a_year} times`} a year, to ${Math.max(0, (c.view.members ?? 1) - 1)} others.` : (c.view.problems ?? []).join('; ')),
    c.view.promise ? h('p', { class: 'muted-line' }, `Kept ${c.view.kept} of ${c.view.of} calls; you've kept ${c.view.you?.kept ?? 0}.`) : null,
    c.view.open && c.view.kinds ? h('div', { class: 'chips' }, h('span', { class: 'chips-label' }, 'You help with:'), ...c.view.kinds.map((k) => h('ion-chip', { key: k, color: mine.includes(k) ? 'primary' : undefined, outline: !mine.includes(k), onClick: () => void toggle(k) }, k))) : null,
    c.view.open ? h('ion-item', { lines: 'none' }, h('ion-toggle', { checked: per > 0, onionChange: async (e: CustomEvent) => { const n = e.detail.checked ? 1 : 0; const r = await call<{ ok?: boolean }>({ kind: 'panel.circle.rule', tally: c.url, id: c.id, perWeek: n, kinds: mine }); if (r.ok) setPer(n); } }, 'Say yes for me, once a week')) : null,
    c.view.open ? h('div', { class: 'circle-ask' },
      c.view.kinds ? h('ion-select', { label: 'Kind of help', class: 'help-kind', value: help, interface: 'popover', 'aria-label': 'Kind of help', onionChange: (e: CustomEvent) => setHelp(String(e.detail.value)) }, ...c.view.kinds.map((k) => h('ion-select-option', { key: k, value: k }, k))) : null,
      h('ion-input', { value: need, placeholder: 'What do you need?', 'aria-label': 'What do you need', onionInput: (e: CustomEvent) => setNeed(String(e.detail.value ?? '')) }),
      h('ion-input', { value: when, placeholder: 'When (optional)', 'aria-label': 'When', onionInput: (e: CustomEvent) => setWhen(String(e.detail.value ?? '')) }),
      h(Btn, { label: 'Ask my circle', expand: 'block', run: async () => { const r = await must<Signed & { asked?: number }>({ kind: 'panel.circle.call', tally: c.url, id: c.id, need: need.trim(), when: when.trim() || undefined, help: help || undefined }); void toast(`Asked ${r.asked} member${r.asked === 1 ? '' : 's'}, without your name.`); setNeed(''); setWhen(''); } })) : h('p', { class: 'muted-line' }, 'Opens for calls once it has filled.'),
    c.view.open ? h('ion-accordion-group', { class: 'lake-accordion' }, h('ion-accordion', { value: 'vote' }, h('ion-item', { slot: 'header' }, h('ion-label', {}, 'Change a rule, by vote')), h('div', { slot: 'content', class: 'pad' },
      h('ion-select', { label: 'Favours a member may owe', class: 'vote-limit', value: limit, interface: 'popover', 'aria-label': 'Favours a member may owe', onionChange: (e: CustomEvent) => setLimit(Number(e.detail.value)) }, ...[0, 1, 2, 3, 5].map((n) => h('ion-select-option', { key: n, value: n }, n === 0 ? 'no limit' : String(n)))),
      h(Btn, { label: 'Put it to a vote', fill: 'outline', run: async () => { const r = await must<Signed & { text?: string }>({ kind: 'panel.circle.propose', tally: c.url, id: c.id, change: { limit } }); void toast(`Put to a vote: ${r.text}`); } })))) : null));
}

// ---- new or lost phone ----
export function KeyPage({ backTo }: P) {
  const k = useHouse<{ recovery: { at: string } | null }>({ kind: 'panel.key' });
  const [code, setCode] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; qr: string; until: string } | null>(null);
  return page('New or lost phone', backTo,
    h('p', { class: 'muted-line pad' }, 'Your house\'s key is on this phone only. Keep a way back in.'),
    h('ion-card', { class: 'lake-card' }, h('ion-card-content', {},
      h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'key-outline' }), 'Recovery code'),
      code ? [h('p', { key: 'p' }, 'Write it down. It\'s shown only now, and works once.'), h('div', { class: 'recovery', key: 'c' }, h('code', { class: 'recovery' }, code)), h('div', { class: 'card-actions', key: 'a' }, h(CopyBtn, { text: code }), h('ion-button', { shape: 'round', fill: 'clear', onClick: () => setCode(null) }, 'I\'ve written it down'))]
        : [h('p', { key: 'p' }, k.data?.recovery ? `Made on ${date(k.data.recovery.at)}. A new one replaces it.` : 'If you lose this phone, it makes another one your key.'),
          h(Btn, { key: 'b', label: k.data?.recovery ? 'Make a new recovery code' : 'Make a recovery code', fill: k.data?.recovery ? 'outline' : 'solid', run: async () => setCode((await must<{ code: string }>({ kind: 'panel.recovery.make' })).code) })])),
    h('ion-card', { class: 'lake-card' }, h('ion-card-content', {},
      h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'phone-portrait-outline' }), 'Move to another phone'),
      link ? h('div', { class: 'address' }, h('p', {}, `Open this on the new phone, until ${new Date(link.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. This phone is signed out when it's used.`), h('div', { class: 'copybox mono' }, link.url), h(CopyBtn, { text: link.url }), h('img', { class: 'qr', alt: 'QR code of the pairing link', width: 200, height: 200, src: link.qr }))
        : h(Btn, { label: 'Make a pairing link', fill: 'outline', run: async () => { const r = await must<{ hash: string; until: string }>({ kind: 'panel.pair.link' }); const url = `${location.origin}${location.pathname}${r.hash}`; setLink({ url, until: r.until, qr: await QRCode.toDataURL(url, { margin: 1, width: 480 }) }); } }))));
}

// ---- download everything ----
export function MovePage({ backTo }: P) {
  const [note, setNote] = useState('');
  return page('Download everything', backTo,
    h('div', { class: 'bigwho' }, h('div', { class: 'hero-icon' }, h('ion-icon', { name: 'download-outline' })), h('p', { class: 'muted-line' }, 'Your house is yours. Take everything, to another host or your own machine.')),
    h('div', { class: 'pad' }, h(Btn, { label: 'Download everything', expand: 'block', run: async () => {
      const x = await call<{ files: Record<string, string> }>({ kind: 'panel.export' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(x, null, 2)], { type: 'application/json' }));
      a.download = `my-house-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setNote(`${Object.keys(x.files).length} files, including your wallet: keep it safe.`);
    } })), note ? h('p', { class: 'muted-line pad' }, note) : null);
}

// ---- about this house ----
export function AboutPage({ backTo }: P) {
  const o = useHouse<{ record: { ok: boolean; why?: string }; claims: number; holds: string[]; relayed: boolean; person?: { stamped: boolean; by?: string; person?: string; checker?: boolean } }>({ kind: 'panel.overview', tz_offset: new Date().getTimezoneOffset() });
  const feed = useHouse<{ at: string; kind: string; text: string }[]>({ kind: 'panel.activity' });
  const [tally, setTally] = useState(''), [pid, setPid] = useState('');
  const [all, setAll] = useState(false);
  if (!o.data) return page('About this house', backTo, h(Failed, { error: o.error }));
  const p = o.data.person;
  const plain = (t: string) => t.replace(/^house:\S+ told agent:(\S+?):? (join|decline|ask)\b/, (_, w: string, d: string) => `${w}: ${d === 'join' ? 'your house said yes' : d === 'decline' ? 'your house said no' : 'it asks you'}`).replace(/\b(house|agent):(?=\S)/g, '');
  return page('About this house', backTo,
    h(Section, {},
      h(Row, { icon: o.data.record.ok ? 'shield-checkmark-outline' : 'alert-circle-outline', tint: o.data.record.ok ? 'mint' : 'red', label: o.data.record.ok ? 'Your record checks out' : 'Your record failed its check', sub: o.data.record.ok ? `${o.data.claims} claims, signed and unchanged` : o.data.record.why }),
      h(Row, { icon: 'git-network-outline', tint: 'blue', label: o.data.relayed ? 'Reached through the Lake' : 'Reached at its own address' }),
      p ? h(Row, { icon: 'finger-print-outline', tint: p.stamped ? 'mint' : 'muted', label: p.stamped ? 'One person, one house: stamped' : 'One person, one house', sub: p.stamped ? `By ${p.by ?? 'a person checker'}` : p.checker ? 'A stamp counts you once in pledges' : 'No person checker set', below: !p.stamped && p.checker ? h(Btn, { label: 'Get a person stamp', size: 'small', run: async () => must({ kind: 'panel.person.request', consent: await signEnvelope({ kind: 'personhood.consent', house: state.webId }, key, state.webId || 'owner') }) }) : undefined }) : null),
    state.leaseUntil ? h(Section, { title: 'Sandbox lease' }, h(Row, { icon: 'hourglass-outline', tint: 'amber', label: `Yours until ${new Date(state.leaseUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` }),
      h('div', { class: 'pad' }, h(Btn, { label: 'Hand it back now', fill: 'outline', color: 'danger', expand: 'block', run: async () => { await call({ kind: 'release' }); location.reload(); }, ask: { header: 'Hand this house back?', sub: 'Every key is revoked and the rules reset.', button: 'Hand it back' } }))) : null,
    h('h3', { class: 'section-h' }, 'Recent at your door'),
    feed.data?.length ? h(Section, {}, ...feed.data.slice(0, all ? 30 : 5).map((a, i) => h('ion-item', { key: i, lines: 'full', class: 'feed-row' }, h('ion-label', { class: 'ion-text-wrap' }, h('p', {}, h('span', { class: 'feed-time' }, time(a.at)), ' ', plain(a.text))))), feed.data.length > 5 && !all ? h(Row, { label: 'See all', detail: false, cls: 'see-all', onClick: () => setAll(true) }) : null) : h('p', { class: 'muted-line pad' }, 'Quiet so far.'),
    h('ion-accordion-group', { class: 'lake-accordion' }, h('ion-accordion', { value: 'pledge' }, h('ion-item', { slot: 'header' }, h('ion-label', {}, 'Sign a pledge from your house')), h('div', { slot: 'content', class: 'pad' },
      h('ion-input', { value: tally, placeholder: 'tally address, e.g. https://…/s/tally', 'aria-label': 'Tally address', onionInput: (e: CustomEvent) => setTally(String(e.detail.value ?? '')) }),
      h('ion-input', { value: pid, placeholder: 'pledge id', 'aria-label': 'Pledge id', onionInput: (e: CustomEvent) => setPid(String(e.detail.value ?? '')) }),
      h(Btn, { label: 'Sign this pledge', fill: 'outline', run: async () => { const r = await signPledge(tally.trim(), pid.trim()); void toast(r.kind === 'tally.triggered' ? `Signed: that was the last one needed (${r.count} of ${r.threshold}).` : `Signed: ${r.count} of ${r.threshold}.`); } })))),
    h('p', { class: 'mono small pad' }, state.webId));
}

// ---- delivery address ----
const COUNTRIES = ['AU', 'NZ', 'GB', 'IE', 'US', 'CA'];
export function AddressPage({ backTo }: P) {
  const a = useHouse<{ address: Address | null }>({ kind: 'panel.address' });
  const [form, setForm] = useState<Record<string, string> | null>(null);
  if (!a.data) return page('Delivery address', backTo, h(Failed, { error: a.error }));
  const cur = a.data.address;
  const guess = /-(\w\w)$/.exec(navigator.language)?.[1]?.toUpperCase() ?? 'AU';
  const f = form ?? { name: cur?.name ?? '', streetAddress: cur?.streetAddress ?? '', addressLocality: cur?.addressLocality ?? '', addressRegion: cur?.addressRegion ?? '', postalCode: cur?.postalCode ?? '', addressCountry: cur?.addressCountry ?? (COUNTRIES.includes(guess) ? guess : 'AU') };
  const set = (k: string) => (e: CustomEvent) => setForm({ ...f, [k]: String(e.detail.value ?? '') });
  const field = (k: string, label: string, o: Record<string, unknown> = {}) => h('ion-item', { key: k }, h('ion-input', { label, labelPlacement: 'stacked', value: f[k], 'aria-label': label, onionInput: set(k), ...o }));
  return page('Delivery address', backTo,
    h('p', { class: 'muted-line pad' }, 'Kept in your house. It goes only to a shop you buy from, when you buy.'),
    h(Section, {},
      field('name', 'Name on the parcel (optional)', { autocomplete: 'name', maxlength: 80 }),
      field('streetAddress', 'Street address', { autocomplete: 'street-address', maxlength: 160 }),
      field('addressLocality', 'Suburb or town', { autocomplete: 'address-level2', maxlength: 80 }),
      field('addressRegion', 'State (optional)', { autocomplete: 'address-level1', maxlength: 40 }),
      field('postalCode', 'Postcode', { autocomplete: 'postal-code', maxlength: 16, inputmode: 'numeric' }),
      h('ion-item', { lines: 'none' }, h('ion-select', { label: 'Country', class: 'country', value: f.addressCountry, interface: 'popover', onionChange: (e: CustomEvent) => setForm({ ...f, addressCountry: String(e.detail.value) }) }, ...COUNTRIES.map((c) => h('ion-select-option', { key: c, value: c }, new Intl.DisplayNames(undefined, { type: 'region' }).of(c) ?? c))))),
    h('div', { class: 'pad stack' },
      h(Btn, { label: 'Save', expand: 'block', run: async () => { await must({ kind: 'panel.address.set', address: f }); setForm(null); }, done: 'Saved' }),
      cur ? h(Btn, { label: 'Remove my address', expand: 'block', fill: 'clear', color: 'medium', run: async () => { await must({ kind: 'panel.address.set', address: null }); setForm(null); }, ask: { header: 'Remove your address?', sub: 'You\'ll be asked for it next time you buy.', button: 'Remove' } }) : null));
}
