import { call, key, state } from './api';
import { loadKey, signCredential } from '../owner-crypto';

// What the house says, typed, and the pure helpers the screens share (no drawing here).

export interface Request { id: string; offerId: string; visitor: { webId: string; domain: string }; purpose: string; fields: string[]; retention: string; priceUsd: number; price?: { amount: number; currency: string }; study: string | null; question?: string; warnings?: string[]; note?: string; asked?: number; recommendation: string; grantDraft?: unknown }
export type Decision = 'join' | 'ask' | 'decline';
export interface Rule { match: Record<string, string | boolean | number>; allow_fields?: string[]; deny_fields?: string[]; min_price_usd?: number; retention?: string; grant_hours?: number; decision: Decision }
export interface Rules { owner: string; device?: string; default: Decision; tags?: string[]; rules: Rule[]; negotiation?: { join_collectives?: boolean }; trust?: Record<string, string[]>; privacy?: { show_packs?: boolean }; availability?: { tz: string; free: string[]; meetings?: number } }
export type DoorState = { open: boolean; about?: string; name?: string; handle?: string; address: string; error?: string };
export type Address = { '@type': 'PostalAddress'; name?: string; streetAddress: string; addressLocality: string; addressRegion?: string; postalCode: string; addressCountry: string };
export const addressLine = (a: Address) => `${a.streetAddress}, ${[a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(' ')}`;
export type FreeState = { set: boolean; tz?: string; meetings?: number; slots: unknown[] };
export type PledgeMoney = { amount: number; currency: string; payee: string; threshold: number; deadline: string; count: number; bond?: number; text: string };
export type CircleItem = { tally: string; id: string; call: string; need: string; when?: string; promise?: string; help?: string; role: 'ask' | 'caller' | 'kept' | 'unmet' | 'cleared' | 'pass' | 'passed' | 'vote' | 'voted'; state: string; contact?: string };
export type PledgeQuorum = { text: string; options: string[]; closes: string; least: number; answered?: boolean };
export type Note = { id: string; from: string; text: string; at: string; invitedBy?: { name: string; known: boolean }; offer?: string; pledge?: { tally: string; id: string; money?: PledgeMoney; quorum?: PledgeQuorum; circle?: { promise: string; times: number; kinds?: string[] } }; circle?: CircleItem; circleCall?: { need: string; help?: string; sent?: boolean }; circleVote?: { sent?: boolean }; favourPay?: { paid?: boolean; sellerName?: string }; count?: { id: string; label: string; mine?: string; answered?: boolean }; advice?: 'do' | 'dont' | 'your_call'; ask?: { choices: string[]; recommend?: number; answered?: string; private?: boolean }; reply?: string; rules?: string; door?: { about: string }; note?: string; mute?: boolean; sender?: string; allowance?: { amount: number; currency: string; days: number }; by?: string };
export type AgendaItem = { id: string; what: string; when: string; where?: string; with?: string; note?: string; start?: string; by: string; agreed?: { by: string; said: string; speaks_for?: { house: string; checked: boolean } } };
export type DoorNote = { id: string; mode?: 'ai' | 'me'; known?: boolean; known_why?: string; lookalike?: boolean; from: { web?: boolean; as?: string; key?: string; webId?: string; name: string; domain: string; checked?: boolean; speaks_for?: { house: string; checked: boolean } }; text: string; at: string; answered?: { text: string; by: string; at?: string } };
export interface Assistant { kid: string; label: string; addedAt: string; seenAt?: string; waiting?: { count: number; senders: number; since: string }; canHaveAllowance?: boolean; allowance?: { amount: number; currency: string; until: string } }
export interface Connect { id: string; app: string; from: string; number: string; at: string }
export type WantOfferV = { id: string; at: string; seller: { name: string; domain: string }; total: { currency: string; value: number }; items: { label: string; amount: { currency: string; value: number } }[]; expires: string; matched?: string[]; delivery?: string; note?: string; over?: boolean; state: 'open' | 'paid' | 'shipped' | 'arrived'; shipped?: { note: string; at: string } };
export type WantV = { want: { id: string; name: string; description?: string; areaServed?: string; availabilityEnds: string; eligibleQuantity?: { value: number }; itemOffered: { additionalProperty: { name: string; value: string }[] } }; limit?: { amount: number; currency: string }; closed?: string; bought?: string; at: string; offers: WantOfferV[] };
export interface ListView { seen?: Record<string, string>; wants?: WantV[]; connects?: Connect[]; webId: string; until?: string; requests: Request[]; suggestions: Note[]; assistants: Assistant[]; notes: DoorNote[]; agenda?: AgendaItem[] }
export interface Consent { id: string; visitor: string; fields: { name: string; label: string }[]; purpose: string; purposeLabel: string; given: string; until: string; retention: string; how: { live?: true; rule?: number | null }; status: 'active' | 'withdrawn' | 'used' | 'ended'; withdrawnAt?: string }
export interface StandingYes { jkt: string; domain: string; purpose: string; fields: string[]; retention: string; floor?: { amount: number; currency: string }; added: string; until: string; uses: number }
export type AccessRow = { id: string; domain?: string; webId?: string; reputation: number | null; yeses: Consent[]; standing: StandingYes[]; asked: number; blocked: number; lastAsked?: string; last?: { decision: string; reason: string; at: string }; asks: { at: string; decision: string; reason: string }[]; canSee: boolean };
export type DutyEntry = { id: string; by: string; at: string; tool: string; action: string; to?: { name?: string; webId?: string; key?: string; url?: string }; text?: string; reply?: unknown; refused?: string; receipt?: string; undo?: { kind: string; ref: string }; undone?: string };
export type DutyInfo = { kid: string; label: string; seenAt?: string; kinds: string[]; cap: number; until: string; hours?: { from: string; to: string; tz: string }; state: { on: true; used: number } | { on: false; why: string }; off?: { at: string; why: string; night?: boolean }; runner?: { host: string; since: string; last: string; every: number; gaps: { from: string; to: string }[] }; summary: { handled: number; waiting: number; blocked: number; refused: number } };
export type DutyLog = { duties: DutyInfo[]; entries: DutyEntry[] };
export type Signed = { kind?: string; count?: number; threshold?: number; error?: string; problems?: string[] };

// ---- words ----
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const when = (iso: string) => {
  const d = new Date(iso), days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? time(iso) : days === 1 ? 'Yesterday' : days < 7 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
export const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
export const dayTime = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const date = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
export const hoursLeft = (iso: string) => { const hr = (Date.parse(iso) - Date.now()) / 3_600_000; return hr < 1 ? `${Math.max(1, Math.round(hr * 60))} min` : hr < 48 ? `${Math.round(hr)} h` : `${Math.round(hr / 24)} days`; };
export const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60_000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
export const nice = (f: string) => f.replace(/_/g, ' ');
export const duration = (iso: string) => {
  const units: [RegExp, string][] = [[/(\d+)Y/, 'year'], [/P[^T]*?(\d+)M/, 'month'], [/(\d+)W/, 'week'], [/(\d+)D/, 'day'], [/T.*?(\d+)H/, 'hour']];
  const parts = units.flatMap(([re, u]) => { const n = Number(re.exec(iso)?.[1] ?? 0); return n ? [`${n} ${u}${n === 1 ? '' : 's'}`] : []; });
  return parts.join(' ') || iso;
};
export const who = (id: string) => { try { return new URL(id).hostname; } catch { return id.replace(/^agent:/, '') || 'someone'; } };
export const shortName = (label: string) => label.replace(/\s*\(.*\)$/, '');
export const CURRENCIES = ['USD', 'AUD', 'EUR', 'GBP', 'CAD', 'NZD'];
export const money$ = (amount: number, currency = 'USD') => (currency === 'USD' ? `$${amount}` : currency === 'AUD' ? `A$${amount}` : `${currency} ${amount}`);
export const money = (m: { currency: string; value: number }) => `${m.currency === 'AUD' ? 'A$' : m.currency === 'USD' ? '$' : `${m.currency} `}${m.value.toFixed(2)}`;
export const shortShop = (n: string) => n.replace(/ \(demo\)$/, '');
export const said = (d: string) => (d === 'join' ? 'said yes' : d === 'decline' ? 'said no' : d === 'ask' ? 'asked you' : d === 'counter' ? 'asked for better terms' : d);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- chats ----
export type Chat = { key: string; notes: DoorNote[]; name: string; agent: string; vendor: string; via: string; trust: 'known' | 'new' | 'lookalike'; why?: string; mode: 'ai' | 'me'; last: string; lastBy: '' | 'you' | 'ai'; at: string; unread: number; canMode: boolean; forwarded: boolean; web: boolean };
/** Whose AI an agent is, from its card's name: "Pike (connectors-manager, via MCP)" is Grok's; "Rook (Claude, via MCP)" Claude's. */
export const vendorOf = (name: string) => { const m = /\(([^,)]+)/.exec(name)?.[1]?.trim() ?? ''; return /claude|anthropic/i.test(m) ? 'Claude' : /connectors|grok|xai/i.test(m) ? 'Grok' : /openai|chatgpt|gpt/i.test(m) ? 'ChatGPT' : /gemini|google/i.test(m) ? 'Gemini' : ''; };
/** How far the owner has read each conversation, kept by the house (every device agrees). */
export const seen = { at: {} as Record<string, string> };
export const chatKeyOf = (n: { id: string; from: { key?: string; webId?: string } }) => n.from.key ?? n.from.webId ?? n.id;
export const unseen = (notes: { id: string; at: string; answered?: unknown; from: { key?: string; webId?: string } }[], at = seen.at) => notes.filter((n) => !n.answered && n.at > (at[chatKeyOf(n)] ?? '')).length;
export const chatsOf = (notes: DoorNote[]): Chat[] => {
  const by = new Map<string, DoorNote[]>();
  for (const n of notes) { const k = chatKeyOf(n); by.set(k, [...(by.get(k) ?? []), n]); }
  return [...by].map(([k, ns]) => {
    const sorted = [...ns].sort((a, b) => a.at.localeCompare(b.at)), last = sorted[sorted.length - 1]!, f = last.from;
    const forwarded = / \(to your assistant, while it was away\)$/.test(f.name);
    const agent = f.name.replace(/ \(to your assistant, while it was away\)$/, '').replace(/ \(.*\)$/, '');
    const vendor = vendorOf(f.name);
    const answeredLast = !!last.answered && (!last.answered.at || last.answered.at >= last.at);
    const byYou = ns.some((n) => n.answered?.by === 'you');
    return {
      key: k, notes: sorted, name: f.as ?? agent, agent, vendor, forwarded, web: !!f.web,
      via: f.web ? 'From your public page' : forwarded ? 'Passed on by your AI' : f.as ? `via ${agent}${vendor ? ` · ${vendor}` : ''}` : vendor ? `${vendor} agent` : 'AI agent',
      trust: (last.known || byYou ? 'known' : last.lookalike ? 'lookalike' : 'new') as Chat['trust'], why: last.known_why ?? (byYou ? 'You\'ve answered them before.' : undefined),
      mode: last.mode ?? 'me', canMode: !!f.key && !f.web,
      last: answeredLast ? last.answered!.text : last.text, lastBy: (answeredLast ? (last.answered!.by === 'you' ? 'you' : 'ai') : '') as Chat['lastBy'],
      at: answeredLast && last.answered!.at ? last.answered!.at : last.at, unread: unseen(ns),
    };
  }).sort((a, b) => b.at.localeCompare(a.at));
};

// ---- inbox ----
/** What needs a decision: a question, a pledge, an offer, a circle's call, a payment… not a plain note from your AI. */
export const needsDecision = (x: Note) => !!(x.ask && !x.ask.answered) || !!x.offer || !!x.pledge || !!x.circle || !!x.count || !!x.favourPay || !!x.allowance || !!x.rules || !!x.door || !!x.sender || !!x.note;
/** An agent that knocks seven times with the same ask gets one card, answered once for all seven. */
export function sameAsks(list: Request[]): Request[][] {
  const groups = new Map<string, Request[]>();
  for (const r of list) {
    const k = JSON.stringify([r.visitor.webId ?? r.visitor.domain, r.purpose, r.fields, r.retention, r.priceUsd, r.study, r.question ?? '', r.warnings ?? [], r.recommendation]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()];
}
/** The house's recommendation in sentences: the verdict first, then each reason, capitalised; the sandbox caveat left out. */
export function adviceOf(rec: string): { verdict: string; why: string[]; suggest: 'allow' | 'deny' | '' } {
  const parts = rec.split(/(?<=\.)\s+|;\s+/).map((x) => x.trim().replace(/\.$/, '')).filter((x) => x && !/^sandbox lake/i.test(x));
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const suggest = /^i['’]?d (deny|decline)|^deny/i.test(rec) ? 'deny' : /^i['’]?d (allow|join|say yes)|^allow/i.test(rec) ? 'allow' : '';
  return { verdict: cap((parts[0] ?? rec).replace(/, for the reasons in red/i, '')) + '.', why: parts.slice(1).map((x) => `${cap(x)}.`), suggest };
}
/** Allow: the grant the house drafted (exactly what was shown), dated and signed here, with your key. */
export const grantFor = (r: Request) => {
  const draft = structuredClone(r.grantDraft) as { credentialSubject: { providedConsent: { hasStatus: string } } };
  draft.credentialSubject.providedConsent.hasStatus = 'https://w3id.org/GConsent#ConsentStatusExplicitlyGiven';
  return signCredential({ ...draft, issuer: state.webId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 48 * 3_600_000).toISOString() }, key);
};
/** Signs a pledge from your house; one with money puts its contribution in first, signed here (SPEC §11.4a). */
export async function signPledge(tally: string, id: string): Promise<Signed> {
  const d = await call<{ id?: string; draft?: Record<string, unknown>; free?: boolean; error?: string }>({ kind: 'panel.pledge.draft', tally, id });
  if (d.error) throw new Error(d.error);
  const r = await call<Signed>(d.free ? { kind: 'panel.pledge.sign', tally, id } : { kind: 'panel.pledge.sign', tally, id, draft: d.id, credential: signCredential({ ...d.draft!, validFrom: new Date().toISOString() }, loadKey()) });
  if (r.error || r.kind === 'refused') throw new Error(r.error ?? (r.problems ?? ['refused']).join('; '));
  return r;
}
/** A draft signed on this device and sent back (allowances, duty grants, purchases, pledges). */
export const signDraft = (draft: Record<string, unknown>) => signCredential({ ...draft, validFrom: new Date().toISOString() }, loadKey());
// Only a web address is a door (round 8: a hostile tally could have sent a javascript: link).
export const doorOf = (url?: string) => (url && /^https?:\/\//i.test(url) ? url.replace(/\/a2a\/?$/, '') : '');

// ---- my AI ----
export const waitingLine = (a: Assistant) => { const w = a.waiting!; return `${w.count === 1 ? 'A message' : `${w.count} messages`} waiting since ${time(w.since)}: open your AI app and ask it to check the Lake.`; };
export function lastHere(at?: string): { text: string; now: boolean } {
  const ms = at ? Date.now() - Date.parse(at) : NaN;
  if (Number.isNaN(ms)) return { text: 'Not here yet', now: false };
  if (ms < 15 * 60_000) return { text: 'Here now', now: true };
  return { text: `Here ${ago(at!)}`, now: false };
}
export const DUTY_KINDS: [string, string][] = [['reply', 'Reply to people you know'], ['book', 'Book times you\'re free'], ['deliver', 'Deliver what people buy from your AI']];
/** Off for good (taken off, refused too often, ended): not the same as off for the night or outside its hours. */
export const dutyLive = (d: DutyInfo) => !(d.off && !d.off.night) && Date.parse(d.until) > Date.now() && !(!d.state.on && /took you off duty|has ended/.test(d.state.why));
export const watching = (r: NonNullable<DutyInfo['runner']>) => {
  const late = Date.now() - Date.parse(r.last) > 3 * r.every * 1000;
  return `${r.host === 'house' ? 'Runs in your house' : `On ${r.host}`} since ${time(r.since)} · ${late ? `not looking since ${time(r.last)}${r.host === 'house' ? '' : ' (asleep?)'}` : `last looked ${time(r.last)}`}`;
};
export function dutyLine(e: DutyEntry): string {
  const name = e.to?.name ? shortName(e.to.name) : e.to?.webId ? who(e.to.webId) : '';
  const text = e.text ? `: ${e.text}` : '';
  if (e.refused) return `Stopped${name ? ` (to ${name})` : ''}: ${e.refused}`;
  const verbs: Record<string, string> = { reply: `Replied to ${name || 'someone'}`, book: `Booked with ${name || 'someone'}`, deliver: `Delivered to ${name || 'someone'}`, block: `Blocked ${name || 'someone'}`, note: 'Left you a note' };
  return `${verbs[e.action] ?? `${e.action}${name ? ` ${name}` : ''}`}${text}`;
}
export const receiptWords = (e: { reply?: unknown; to?: { name?: string } }) => {
  const r = e.reply as { kind?: string; delivered?: string; status?: string; id?: string } | null;
  const w = e.to?.name?.replace(/\s*\(.*$/, '') ?? 'They';
  if (r?.kind === 'received') return `${w} signed that they got exactly this message.`;
  if (r?.status?.startsWith('agreed')) return `In your agenda, agreed in ${w}'s signed message.`;
  if (r?.id) return 'Written into your agenda, proposed until the other side agrees.';
  return 'What came back, signed.';
};

// ---- money ----
type About = { question?: string; purpose: string; fields: string[]; to: string };
export type Receipt = { about?: About; amount: number; currency: string; agreement: string; from: string; payer?: string; payerName?: string; via?: string; viaName?: string; at: string; settlement: string; heldUntil?: string; items?: { label: string; amount: { currency: string; value: number } }[] };
export const pledgeOf = (agreement: string) => (agreement.startsWith('urn:lake:pledge:') ? { id: agreement.split('|')[1] ?? '', bond: agreement.endsWith('|bond') } : undefined);
export const forWhat = (r: Receipt) => pledgeOf(r.agreement)?.bond ? `Your share of a bond: "${pledgeOf(r.agreement)!.id}" didn't happen`
  : r.items?.length ? r.items.map((i) => i.label.replace(/^1 × /, '')).join(', ')
  : r.about ? (r.about.question ?? `${r.about.purpose}: ${r.about.fields.join(', ')}`)
  : r.agreement.replace(/^urn:(lake:order|ap2:cart):/, 'order ').slice(0, 40);
export const named = (name: string | undefined, addr: string | undefined) => (name ? name.replace(/ \((.+), via MCP\)$/, ' ($1)') : addr ? who(addr) : 'someone');

// ---- free hours ----
export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export type Win = { days: string[]; from: string; to: string };
export function readWindow(w: string): Win | null {
  const m = /^(\S+)\s+(\d\d:\d\d)-(\d\d:\d\d)$/.exec(w.trim());
  if (!m) return null;
  const days = new Set<string>();
  for (const part of m[1]!.split(',')) {
    const [x, y] = part.split('-'), i = WEEK.indexOf(x!), j = y ? WEEK.indexOf(y) : i;
    if (i < 0 || j < 0) return null;
    for (let k = i; ; k = (k + 1) % 7) { days.add(WEEK[k]!); if (k === j) break; }
  }
  return { days: WEEK.filter((d) => days.has(d)), from: m[2]!, to: m[3] === '24:00' ? '23:59' : m[3]! };
}
export function writeWindow(w: Win): string {
  const runs: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (!w.days.includes(WEEK[i]!)) continue;
    let j = i; while (j + 1 < 7 && w.days.includes(WEEK[j + 1]!)) j++;
    runs.push(j - i >= 2 ? `${WEEK[i]}-${WEEK[j]}` : WEEK.slice(i, j + 1).join(','));
    i = j;
  }
  return `${runs.join(',')} ${w.from}-${w.to === '23:59' ? '24:00' : w.to}`;
}
export const ZONES: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return []; } })();
