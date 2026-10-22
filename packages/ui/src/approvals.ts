import './approvals.css';
import { stringify } from 'yaml';
import { loadKey, signCredential, signEnvelope } from './owner-crypto';

// The control panel that comes with every house (open source). Served by the house at /owner/; every
// call is signed on this device with the owner's key, which never leaves it.

interface Request { id: string; offerId: string; visitor: { webId: string; domain: string }; purpose: string; fields: string[]; retention: string; priceUsd: number; study: string | null; question?: string; recommendation: string }
interface Key { id: string; visitor: string; fields: string[]; purpose: string; until: string; authorizedBy: string }
type Decision = 'join' | 'ask' | 'decline';
interface Rule { match: Record<string, string | boolean | number>; allow_fields?: string[]; deny_fields?: string[]; min_price_usd?: number; retention?: string; grant_hours?: number; decision: Decision }
interface Rules { owner: string; device?: string; default: Decision; tags?: string[]; rules: Rule[]; negotiation?: { join_collectives?: boolean }; trust?: Record<string, string[]> }

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
const TABS = [
  ['home', 'Home'], ['requests', 'Requests'], ['keys', 'Keys'], ['rules', 'Rules'],
  ['offers', 'Offers'], ['agents', 'Agents'], ['money', 'Money'], ['data', 'Data'], ['move', 'Move house'],
] as const;
type Tab = (typeof TABS)[number][0];
let tab: Tab = TABS.find(([id]) => id === location.hash.slice(1))?.[0] ?? 'home';
let pending = 0;

function renderNav() {
  $('nav').replaceChildren(...TABS.map(([id, label]) =>
    h('button', { type: 'button', 'aria-current': id === tab ? 'page' : undefined, onclick: () => go(id) }, label, id === 'requests' && pending ? h('span', { class: 'badge' }, String(pending)) : null)));
}

function go(t: Tab) {
  tab = t;
  if (location.hash !== `#${t}`) history.replaceState(null, '', `#${t}`);
  renderNav();
  void show();
}

const view = () => $('view');
const hoursLeft = (iso: string) => { const hr = (Date.parse(iso) - Date.now()) / 3_600_000; return hr < 1 ? `${Math.max(1, Math.round(hr * 60))} min` : `${Math.round(hr)} h`; };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const nice = (f: string) => f.replace(/_/g, ' ');

async function show() {
  try {
    const render = { home, requests, keys, rules, offers, agents, money, data, move }[tab];
    await render();
    $('status').className = 'dot live';
  } catch (e) {
    $('status').className = 'dot down';
    view().replaceChildren(h('p', { class: 'muted' }, `Couldn't reach your house: ${(e as Error).message}`));
  }
}

// ---- Home ----
async function home() {
  const o = await call({ kind: 'panel.overview' });
  const feed = await call<{ at: string; kind: string; text: string }[]>({ kind: 'panel.activity' });
  houseName = o.name;
  $('title').textContent = `House ${o.name}`;
  const tile = (label: string, value: string | number, cls = '') => h('div', { class: `tile ${cls}` }, h('dt', {}, label), h('dd', {}, String(value)));
  view().replaceChildren(
    h('dl', { class: 'tiles' },
      tile('Knocks today', o.knocksToday),
      tile('Waiting for you', o.pending, o.pending ? 'amber' : ''),
      tile('Live keys', o.keys),
      tile('Earned', `$${o.earned}`, 'mint'),
      tile('Attacks blocked today', o.blockedToday, o.blockedToday ? 'threat' : ''),
    ),
    h('div', { class: `card ${o.record.ok ? 'ok' : 'bad'}` },
      h('h3', {}, o.record.ok ? 'Your record checks out' : 'Your record failed its check'),
      h('p', { class: 'muted' }, o.record.ok
        ? `Signed by a trusted issuer, unchanged since, converted by a certified converter. Your house holds ${o.claims} claims: ${o.holds.map(nice).join(', ') || 'none'}.`
        : `${o.record.why}. Your house won't join studies until this is fixed.`)),
    leaseUntil ? leaseCard() : '',
    h('div', { class: 'card' },
      h('h3', {}, o.relayed ? 'Reached through the Lake' : 'Reached directly'),
      h('p', { class: 'muted' }, o.relayed ? 'Your house is behind a router; agents reach it through the nodes it follows.' : 'Agents reach your house at its own address.'),
      ...o.reachedAt.map((u: string) => h('div', {}, h('code', {}, u)))),
    h('h2', {}, 'At your door'),
    feed.length ? h('ul', { class: 'feed' }, ...feed.slice(0, 12).map((a) => h('li', {}, h('time', {}, time(a.at)), h('span', { class: a.kind === 'attack.blocked' ? 'k-threat' : a.kind === 'grant.issued' || a.kind === 'compute.done' ? 'k-mint' : a.kind === 'approval.requested' ? 'k-amber' : '' }, a.text))))
      : h('p', { class: 'muted' }, 'Quiet so far.'),
  );
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
async function requests() {
  const v = await call<{ requests: Request[] }>({ kind: 'list' });
  view().replaceChildren(
    h('p', { class: 'lede' }, 'Your rules answer the easy ones. These are the ones they left to you.'),
    v.requests.length ? h('div', {}, ...v.requests.map(requestCard)) : h('p', { class: 'muted' }, 'Nothing to decide. Your rules are handling it.'),
  );
}

function requestCard(r: Request) {
  const allow = h('button', { class: 'btn allow', type: 'button' }, 'Allow');
  const deny = h('button', { class: 'btn deny', type: 'button' }, 'Deny');
  allow.onclick = async () => {
    allow.disabled = deny.disabled = true;
    // The key is cut here, on this device, with your key. The house only checks it.
    const grant = signCredential({
      '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeAccessGrant'], issuer: webId,
      validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      credentialSubject: { id: r.visitor.webId, offer: r.offerId, study: r.study, fields: r.fields, purpose: r.purpose, authorizedBy: 'owner, live' },
    }, key);
    await call({ kind: 'answer', request: r.id, answer: 'allow', grant }).catch((e) => alert(e.message));
    void refreshBadge(); void show();
  };
  deny.onclick = async () => { allow.disabled = deny.disabled = true; await call({ kind: 'answer', request: r.id, answer: 'deny' }); void refreshBadge(); void show(); };
  return h('article', { class: 'req' },
    h('div', { class: 'who' }, r.visitor.domain),
    r.question ? h('p', { class: 'q' }, `“${r.question}”`) : null,
    h('dl', { class: 'facts' },
      ...([['Purpose', r.purpose], ['Fields', h('span', {}, ...r.fields.map((f) => h('span', { class: 'chip' }, nice(f))))], ['Keeps it', r.retention === 'none' ? 'no, deleted after the study' : r.retention], ['Pays', `$${r.priceUsd}`], ['Key for', '48 hours, revocable']] as [string, Child][])
        .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
    h('p', { class: 'advice' }, h('b', {}, 'Your housekeeper says'), r.recommendation),
    h('div', { class: 'actions' }, allow, deny));
}

// ---- Keys ----
async function keys() {
  const v = await call<{ keys: Key[] }>({ kind: 'list' });
  view().replaceChildren(
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
const PURPOSES = ['research', 'care', 'marketing', 'insurance'];
let draft: Rules | null = null;

async function rules() {
  if (!draft) {
    const r = await call<{ rules: Rules; fields?: { name: string; label: string; pack: string }[] }>({ kind: 'panel.rules' });
    draft = structuredClone(r.rules);
    FIELDS = r.fields ?? [];
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
    h('option', { value: '' }, 'any purpose'), ...PURPOSES.map((p) => h('option', { value: p, selected: r.match.purpose === p }, p)));
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
  view().replaceChildren(
    h('p', { class: 'lede' }, 'Your housekeeper follows these, top to bottom; the first rule that fits decides. They run as code, and nothing an agent writes can change them.'),
    ...r.rules.map((rule, i) => ruleCard(rule, i, r.rules)),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', onclick: () => { r.rules.push({ match: { purpose: 'research' }, decision: 'ask' }); renderRules(); } }, '+ Add a rule')),
    h('h2', {}, 'Everything else'),
    h('div', { class: 'card', style: 'max-width:820px' },
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'When no rule fits'), seg(r.default, (d) => { r.default = d; renderRules(); })),
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Bargaining'), toggle('bargain together with neighbours (a bloc gets better terms)', !!r.negotiation?.join_collectives, (v) => { r.negotiation = { ...(r.negotiation ?? {}), join_collectives: v }; renderRules(); })),
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
      h('button', { class: 'btn', type: 'button', onclick: async () => { draft = null; await rules(); } }, 'Undo changes'),
      message ? h('span', { class: `msg ${message.ok ? 'ok' : 'bad'}` }, message.text) : null),
  );
}

// ---- Offers ----
type Term = { kind: string; label: string; options: (string | number)[] };
type Offer = {
  id: string; pack: string; quoter: { name: string; domain: string }; title: string; status: string; groupSize: number; fee?: number;
  result: { eligible: boolean; outputs: Record<string, number> }; labels?: Record<string, { label: string; unit?: string }>; answer?: Record<string, unknown>;
};
const money0 = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const fmt = (v: number, unit?: string) => (unit === 'GBP' ? money0(v) : unit === '%' ? `${v}%` : String(v));

async function offers() {
  const m = await call<{ intents: { pack: string; terms: Record<string, string | number>; members: number; group: string }[]; offers: Offer[]; packs: { id: string; title: string; terms: Record<string, Term> }[] }>({ kind: 'panel.market' });
  if (!m.packs.length) return void view().replaceChildren(h('p', { class: 'muted' }, 'This house takes part in no use case that has offers yet.'));
  const blocks: Child[] = [h('p', { class: 'lede' }, 'Say what you’re looking for. Authorised agents price it inside your house, on your own data, and only you see the result. Nothing leaves until you accept.')];
  for (const p of m.packs) {
    const intent = m.intents.find((i) => i.pack === p.id);
    if (!intent) {
      // The form: the pack's coarse terms, each a choice, plus "work it out for me" where the pack can.
      const selects = Object.entries(p.terms).map(([k, t]) => {
        const sel = h('select', { name: k }, ...(k === 'price_band' ? [h('option', { value: 'auto' }, 'What I can afford (worked out in my house)')] : []), ...t.options.map((o) => h('option', { value: String(o) }, k === 'price_band' ? String(o).split('-').map((x) => money0(Number(x))).join('–') : String(o))));
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
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, `${Object.entries(intent.terms).map(([k, x]) => `${p.terms[k]?.label ?? k}: ${k === 'price_band' ? String(x).split('-').map((y) => money0(Number(y))).join('–') : x}`).join(' · ')}`),
      h('div', { class: 'r-meta' }, `${intent.members} household${intent.members === 1 ? '' : 's'} in your group · ${mine.length} lender${mine.length === 1 ? '' : 's'} priced it · ${eligible.length} offer${eligible.length === 1 ? '' : 's'} for you`),
      h('div', { style: 'margin-top:12px' }, stop)));
    if (!mine.length) blocks.push(h('p', { class: 'muted' }, 'Waiting for authorised lenders to price it…'));
    for (const o of mine) {
      const out = o.result.outputs;
      const lab = (k: string) => o.labels?.[k] ?? { label: k };
      const head = o.result.eligible ? h('div', { class: 'r-title', style: 'font-size:22px;font-family:var(--f-display)' }, `${out.rate}%`, h('span', { class: 'muted', style: 'font-size:14px;margin-left:10px;font-family:var(--f-body)' }, `${money0(out.monthly ?? 0)} a month`)) : h('div', { class: 'r-title muted' }, 'Not for you this time');
      const accept = h('button', { class: 'btn allow', type: 'button' }, o.status === 'accepted' ? 'Accepted' : 'Accept');
      if (o.status === 'accepted' || !o.result.eligible || eligible.some((x) => x.status === 'accepted')) accept.disabled = true;
      accept.onclick = async () => {
        if (!confirm(`Accept ${o.quoter.name}'s offer? Your bank statements go to them, and only them, so they can confirm it.`)) return;
        accept.disabled = true;
        const r = await call<Offer & { error?: string }>({ kind: 'panel.offer.accept', offer: o.id }).catch((e) => ({ error: (e as Error).message }) as never);
        if (r.error) alert(r.error);
        void show();
      };
      blocks.push(h('article', { class: 'req', style: `border-color:${o.result.eligible ? 'var(--mint)' : 'var(--line)'};background:none` },
        h('div', { class: 'who', style: 'font-size:16px' }, o.quoter.name, (out.group_off ?? 0) > 0 ? h('span', { class: 'chip share', style: 'margin-left:8px' }, `group rate −${out.group_off}%`) : ''),
        head,
        o.result.eligible ? h('dl', { class: 'facts' }, ...['loan', 'ltv_pct', 'max_loan'].filter((k) => out[k] !== undefined).map((k) => h('div', {}, h('dt', {}, lab(k).label), h('dd', {}, fmt(out[k]!, lab(k).unit)))),
          o.fee ? h('div', {}, h('dt', {}, 'Pays you'), h('dd', {}, `${money0(o.fee)} if you accept`)) : '') : '',
        o.answer ? h('p', { class: 'advice' }, h('b', {}, o.quoter.name), String(o.answer.kind === 'agreed' ? `Agreed in principle. ${o.answer.feePaid ? `${money0(Number(o.answer.feePaid))} paid to you.` : ''} Next: ${o.answer.next ?? ''}` : o.answer.why ?? o.answer.kind)) : '',
        o.result.eligible ? h('div', { class: 'actions', style: 'grid-template-columns:1fr' }, accept) : ''));
    }
  }
  view().replaceChildren(...blocks.filter((b): b is Node | string => !!b));
}

// ---- Agents ----
async function agents() {
  const list = await call<{ agent: string; knocks: number; last: string; lastDecision?: string; blocked: number; reputation: number | null }[]>({ kind: 'panel.agents' });
  view().replaceChildren(
    h('p', { class: 'lede' }, 'Every agent that has come to your door lately, what your house told it, and how it behaves across the Lake.'),
    list.length ? h('ul', { class: 'rows' }, ...list.map((a) => h('li', {},
      h('div', {}, h('div', { class: 'r-title' }, a.agent.replace(/^agent:/, '').replace(/^key:/, 'unverified key ')),
        h('div', { class: 'r-meta' }, `${a.knocks} knock${a.knocks === 1 ? '' : 's'} · last ${time(a.last)}${a.lastDecision ? ` · you said ${a.lastDecision}` : ''}${a.blocked ? ` · ${a.blocked} blocked` : ''}`)),
      h('div', { class: 'r-meta' }, a.reputation === null ? (a.blocked ? 'blocked' : '') : h('span', {}, `reputation ${a.reputation}`, h('span', { class: 'rep' }, h('i', { style: `width:${Math.round(a.reputation * 100)}%` })))))))
      : h('p', { class: 'muted' }, 'No visitors yet.'),
    h('h2', {}, 'Your own assistant'),
    h('p', { class: 'lede' }, 'Give your AI assistant (Claude, or any MCP client) read access to your claims. Your wallet stays shut. Add this to its MCP settings, on the machine your house runs on:'),
    h('pre', {}, JSON.stringify({ mcpServers: { 'my-house': { command: 'docker', args: ['exec', '-i', '-e', `LAKE_OWNER=${houseName}`, '<your house container>', 'node', 'dist/pod-mcp-stdio.js'] } } }, null, 2)),
  );
}

// ---- Money ----
async function money() {
  const m = await call<{ total: number; receipts: { amount: number; currency: string; agreement: string; from: string; at: string; settlement: string }[] }>({ kind: 'panel.money' });
  view().replaceChildren(
    h('dl', { class: 'tiles' }, h('div', { class: 'tile mint' }, h('dt', {}, 'Earned'), h('dd', {}, `$${m.total}`)), h('div', { class: 'tile' }, h('dt', {}, 'Receipts'), h('dd', {}, String(m.receipts.length)))),
    h('p', { class: 'lede' }, 'Every payment comes with a receipt signed by a payments agent you trust, filed in your pod. In the sandbox, settlement is simulated.'),
    m.receipts.length ? h('ul', { class: 'rows', style: 'margin-top:14px' }, ...m.receipts.map((r) => h('li', {},
      h('div', {}, h('div', { class: 'r-title' }, `$${r.amount} · ${new Date(r.at).toLocaleDateString()}`), h('div', { class: 'r-meta' }, `${r.agreement.split(':').slice(0, 4).join(':')} · ${r.settlement}`)),
      h('span', { class: 'chip share' }, 'signed'))))
      : h('p', { class: 'muted' }, 'No payments yet.'),
  );
}

// ---- Data ----
async function data() {
  type Source = { pack: string; title: string; folder: string; issuer: string | null; converter: string; certifiedBy: string | null; ok: boolean; why?: string };
  const d = await call<{ claims: { field: string; label?: string; value: string; code?: string; observedAt?: string }[]; record: { ok: boolean; why?: string }; sources: Source[]; folders: Record<string, number> }>({ kind: 'panel.data' });
  const by = new Map<string, typeof d.claims>();
  for (const c of d.claims) by.set(c.label ?? nice(c.field), [...(by.get(c.label ?? nice(c.field)) ?? []), c]);
  view().replaceChildren(
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
async function move() {
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
  view().replaceChildren(
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
  setInterval(refreshBadge, 1500);
  // Live tabs refresh themselves; the rules editor never overwrites what you're typing.
  setInterval(() => { if (['home', 'requests', 'keys', 'offers', 'agents'].includes(tab) && !document.hidden && !document.querySelector('select:focus')) void show(); }, 3000);
}

// Already paired? A signed "list" answers. Otherwise offer to pair (automatically when the link carries a token).
call({ kind: 'list' }).then((v) => { webId = v.webId; leaseUntil = v.until ?? null; start(); }).catch(async () => {
  $('pair').hidden = false;
  if (location.hash.includes('pair=') && (await pair())) start();
});
