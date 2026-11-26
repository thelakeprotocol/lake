import { useState } from 'preact/hooks';
import { call, key, must, state, useBump, useHouse } from './api';
import { signEnvelope } from '../owner-crypto';
import { Avatar, Btn, Child, Empty, Failed, Info, Page, Pill, Row, Section, Sheet, askLine, h, toast } from './ion';
import { adviceOf, doorOf, dutyStrip, duration, grantFor, time, when, money$, needsDecision, waitingOn, ago, nice, plural, sameAsks, shortName, signDraft, signPledge, tableLine, taskCards, waitingLine, type AgendaItem, type CircleItem, type Connect, type DutyLog, type ListView, type DoorState, type Note, type Reads, type Request } from './logic';
import { ReadsToggles } from './ai';
import { WantRow, WelcomeCard, blockAsk, wantNeedsYou } from './chats';
import { push } from './nav';
import { AskBox, TaskCard, TellButton } from './tasks';

// Inbox: everything that waits for your tap, newest first. Data requests your rules left to you, your AI's questions and
// suggestions, app sign-ins, your circle's calls; and what's coming up.

/** What the last sign-in answer did, kept past the refetch that takes the request away. */
let connectedNote = '';
/** What an AI app's sign-in just came to, shown once wherever the owner is (Home or Today). */
/** A pledge that closed or lapsed: its card says so first, and asks nothing (run 131: four said a closed card still looked live). */
const pledgeEnded = (x: Note) => !!(x.pledge?.ended || x.pledge?.signed?.closed || x.pledge?.signed?.lapsed);
export function ConnectedNote() {
  return connectedNote ? h('ion-card', { class: 'lake-card ok-card', key: 'cn' }, h('ion-card-content', {}, h('p', {}, connectedNote), h('ion-button', { size: 'small', fill: 'clear', onClick: () => { connectedNote = ''; } }, 'OK'))) : null;
}

type TodayLine = { by: 'rules' | 'ai' | 'house' | 'shops' | 'money'; text: string; at: string; to: string; undo?: string; person?: { key: string; name: string }; tile?: { big: string; label: string; detail?: string } };
const BY: Record<TodayLine['by'], { label: string; icon: string; tint: string }> = {
  rules: { label: 'Your rules', icon: 'list-outline', tint: 'mint' },
  ai: { label: 'Your AI', icon: 'sparkles-outline', tint: 'violet' },
  house: { label: 'Your house', icon: 'shield-checkmark-outline', tint: 'blue' },
  money: { label: 'Money', icon: 'wallet-outline', tint: 'mint' },
  shops: { label: 'Shops', icon: 'pricetags-outline', tint: 'amber' },
};

/**
 * Today: what needs you, on top, and what was handled for you since this morning, one line each, saying who did it
 * (your rules, your AI, your house) and when, with Undo where it can be undone (12 Nov: outcomes, not screens).
 */
export function InboxTab({ tabbar, status }: { tabbar: Child; status: Child }) {
  const list = useHouse<ListView>({ kind: 'list' });
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const today = useHouse<{ since: string; lines: TodayLine[]; waiting?: { people: number; known: number; since?: string; more?: boolean }; duty?: { by: string; since: string; handled: number; needs: number } }>({ kind: 'panel.today', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tz_offset: new Date().getTimezoneOffset() });
  const v = list.data;
  if (!v) return h(Page, { title: 'Today', big: true, status, footer: tabbar }, h(Failed, { error: list.error }));
  const groups = sameAsks(v.requests);
  // What you told an AI to do shows its own card until you've seen how it ended; the note it was about waits under it.
  const tasks = taskCards(v), tasked = new Set(tasks.map((t) => t.suggestion));
  const decide = v.suggestions.filter((x) => needsDecision(x) && !tasked.has(x.id)), notes = v.suggestions.filter((x) => !needsDecision(x) && !waitingOn(x) && !tasked.has(x.id));
  // What your AI asked someone and waits on: apart, as waiting (round 119: titled like an answer, it drew seven taps, and
  // Dismiss quietly told the other side no).
  const waits = v.suggestions.filter(waitingOn);
  const waiting = v.assistants.filter((a) => a.waiting);
  // What you're looking for shows here while it needs you: an offer to say yes to, or a parcel to say arrived (the rest is under Money).
  const wants = (v.wants ?? []).filter(wantNeedsYou);
  // People waiting for an answer in People: Today never says all clear while they wait (round 15).
  const w = today.data?.waiting, knownN = w?.known ?? 0, newN = (w?.people ?? 0) - knownN;
  const any = groups.length || decide.length || tasks.length || (v.connects ?? []).length || waiting.length || connectedNote || w?.people || wants.length;
  const lines = today.data?.lines ?? [];
  return h(Page, { title: 'Today', big: true, status, footer: tabbar },
    h(WelcomeCard, { door: door.data, key: 'welcome' }),
    // Your AI on duty in one line; a tap shows each thing it did, with Undo (Grok: "the number stays abstract" without them).
    today.data?.duty ? h('button', { class: 'duty-strip', key: 'duty', onClick: () => document.querySelector('ion-list.handled')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      h('ion-icon', { name: 'moon-outline' }), h('span', {}, dutyStrip(today.data.duty))) : null,
    h(AskBox, { v, key: 'ask' }),
    h('h3', { class: 'section-h', key: 'nh' }, 'Needs your attention'),
    connectedNote ? h('ion-card', { class: 'lake-card ok-card', key: 'cn' }, h('ion-card-content', {}, h('p', {}, connectedNote), h('ion-button', { size: 'small', fill: 'clear', onClick: () => { connectedNote = ''; } }, 'OK'))) : null,
    ...(v.connects ?? []).map((c) => h(ConnectCard, { key: `c-${c.id}`, c })),
    ...groups.map((all) => h(RequestCard, { key: all[0]!.id, all })),
    ...tasks.map((t) => h(TaskCard, { key: `t-${t.id}`, t, v })),
    ...decide.map((x) => h(SuggestionCard, { key: x.id, x })),
    // An AI that isn't reading: one quiet row each, under what needs a decision (21 Nov: a loud card per AI sat on top).
    waiting.length ? h(Section, { key: 'ais-waiting', cls: 'ais-waiting' }, waiting.length === 1
      ? h(Row, { icon: 'alert-circle-outline', tint: 'amber', label: `${shortName(waiting[0]!.label)} isn't reading`, sub: waitingLine(waiting[0]!), cls: 'warn-row', onClick: () => push(`#aikey=${encodeURIComponent(waiting[0]!.kid)}`) })
      // Several behind: one row (ChatGPT, 21 Nov: "merge them into one compact row").
      : h(Row, { icon: 'alert-circle-outline', tint: 'amber', label: `${waiting.length} AIs aren't reading`, sub: `${waiting.map((a) => shortName(a.label)).join(' and ')} have messages waiting: open your AI app and ask it to check the Lake.`, cls: 'warn-row', onClick: () => push('#ai') })) : null,
    waits.length ? h(Waits, { key: 'waits', waits }) : null,
    wants.length ? h(Section, { title: 'Looking for', key: 'wants', cls: 'chat-list wants' }, ...wants.map((x) => h(WantRow, { key: x.want.id, w: x }))) : null,
    // What you have to sell or give away, on your house while it's up (round 109); a note about one lands in People.
    v.offerings?.length ? h(Section, { title: 'Offering', key: 'offerings', cls: 'offerings' }, ...v.offerings.map((g) => h('ion-item', { key: g.id, lines: 'full', class: 'lake-row offering-row' },
      h('div', { slot: 'start', class: 'row-icon tint-mint' }, h('ion-icon', { name: 'pricetag-outline' })),
      h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, g.name), h('p', {}, [g.price !== undefined ? money$(g.price, g.priceCurrency ?? 'AUD') : 'Free or to agree', 'pick-up', g.asked ? `${plural(g.asked, 'person', 'people')} asked` : 'nobody asked yet', `until ${new Date(g.availabilityEnds).toLocaleDateString([], { day: 'numeric', month: 'short' })}`].join(' · '))),
      h('div', { slot: 'end' }, h(Btn, { label: 'Take down', size: 'small', fill: 'outline', color: 'medium', run: () => must({ kind: 'panel.offering.close', id: g.id }), ask: { header: `Take down "${g.name}"?`, sub: 'Nobody finds it after this. Chats about it stay in People.', button: 'Take down' } }))))) : null,
    w?.people ? h(Section, { key: 'wait', cls: 'waiting' },
      knownN ? h(Row, { icon: 'chatbubbles-outline', tint: 'amber', label: `${plural(knownN, 'person', 'people')} you know ${knownN === 1 ? 'is' : 'are'} waiting`, sub: 'For your answer, in People', onClick: () => push('#chats'), cls: 'wait-known' }) : null,
      newN ? h(Row, { icon: 'people-outline', label: `${newN}${w.more ? '+' : ''} new ${newN === 1 ? 'person' : 'people'} wrote${!w.since ? '' : new Date(w.since).toDateString() === new Date().toDateString() ? ' today' : ` since ${new Date(w.since).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`}`, sub: newN === 1 ? 'No answer yet' : 'None has an answer yet', onClick: () => push('#chats'), cls: 'wait-new' }) : null) : null,
    !any ? h('div', { class: 'all-clear', key: 'clear' }, h('ion-icon', { name: 'checkmark-done-outline' }), h('div', {}, h('b', {}, 'You\'re all clear'), h('p', {}, 'Nothing needs your attention. Your house is keeping an eye on things.'))) : null,
    h(Section, { title: 'Handled for you', key: 'handled', cls: 'handled' },
      // Counts as tiles (the number first, a few words, the names small), what an AI did as rows with Undo (17 Nov: the
      // owner said the list looked "bland, like a blob of text").
      lines.some((l) => l.tile) ? h('div', { class: 'handled-tiles', key: 'tiles' }, ...lines.filter((l) => l.tile).map((l, i) => h('button', { key: `t${i}`, type: 'button', class: `handled-tile tint-${BY[l.by].tint}`, onClick: () => push(l.to), 'aria-label': l.text },
        h('div', { class: 'tile-top' }, h('ion-icon', { name: BY[l.by].icon })),
        h('b', { class: 'tile-big' }, l.tile!.big), h('span', { class: 'tile-label' }, l.tile!.label),
        l.tile!.detail ? h('span', { class: 'tile-detail' }, l.tile!.detail) : null))) : null,
      ...(lines.some((l) => !l.tile) ? lines.filter((l) => !l.tile).map((l, i) => h(Row, { key: i, icon: BY[l.by].icon, tint: BY[l.by].tint, label: l.text, sub: `${BY[l.by].label} · ${time(l.at)}`, onClick: () => (l.to === '#inbox' ? document.querySelector('ion-list.coming-up')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : push(l.to)), cls: 'handled-row',
        below: l.undo || l.person ? h('div', { class: 'handled-acts' },
          l.undo ? h(Btn, { label: 'Undo', size: 'small', fill: 'outline', run: () => call({ kind: 'panel.duty.undo', entry: l.undo }), done: 'Undone' }) : null,
          // Keeps that person for the owner: their messages wait for them, and the AI on duty leaves them alone.
          l.person ? h(Btn, { label: `Always ask me first about ${l.person.name}`, size: 'small', fill: 'clear', color: 'medium', run: () => must({ kind: 'panel.chat.mode', key: l.person!.key, mode: 'me' }), done: `Your AI leaves ${l.person.name} to you from now on.` }) : null) : undefined }))
        : lines.length ? [] : [h('ion-item', { key: 'none', lines: 'none' }, h('ion-label', { class: 'ion-text-wrap' }, today.data ? h('p', {}, 'Nothing handled yet today.') : h('ion-skeleton-text', { animated: true, style: 'width:70%;height:14px' })))])),
    // Notes that need nothing from you: one short line each, the newest few; the whole note opens in a sheet (12 Nov: a
    // wall of long notes drowned the few that need you).
    notes.length ? h(Notes, { key: 'notes', notes }) : null,
    v.agenda?.length ? h(Section, { title: 'Coming up', key: 'ag', cls: 'coming-up' }, ...v.agenda.map((a) => h(AgendaRow, { key: a.id, a }))) : null);
}

/** A data request your rules left to you: what it wants, what your rules suggest, the suggested answer first. */
export function RequestCard({ all, compact }: { all: Request[]; compact?: boolean }) {
  const r = all[0]!, n = all.length, times = all.reduce((t, x) => t + (x.asked ?? 1), 0);
  const risky = !!r.warnings?.length;
  const a = adviceOf(r.recommendation);
  const suggest = a.suggest || (risky ? 'deny' : '');
  const [terms, setTerms] = useState(false);
  const after = (allowed: boolean) => void toast(`${allowed ? 'Allowed' : 'Declined'} ${r.visitor.domain}`, { buttons: [{ text: allowed ? 'Always allow' : 'Always decline', handler: async () => { try { await must({ kind: 'panel.request.always', request: r.id, answer: allowed ? 'allow' : 'decline' }); void toast(allowed ? `${r.visitor.domain} gets a yes for this from now on (90 days)` : `You won't hear from ${r.visitor.domain} again`); } catch (e) { void toast(`Not set: ${(e as Error).message}`, { color: 'danger', duration: 6000 }); } } }] });
  const allow = async () => { for (const q of all) await call({ kind: 'answer', request: q.id, answer: 'allow', grant: await grantFor(q) }); after(true); };
  // Each answer must land: a failure was swallowed, the toast said "Declined" and the card stayed (14 Nov: denied again and again).
  const deny = async () => { for (const q of all) await must({ kind: 'answer', request: q.id, answer: 'deny' }); after(false); };
  const allowBtn = h(Btn, { key: 'a', label: n > 1 ? `Allow all ${n}` : 'Allow', fill: suggest === 'deny' ? 'outline' : 'solid', color: suggest === 'deny' ? 'medium' : 'primary', run: allow, ...(risky ? { ask: { header: `Let ${r.visitor.domain} use your ${r.fields.map(nice).join(', ')}?`, sub: 'Your rules advise against it.', button: 'Allow anyway' } } : {}) });
  const denyBtn = h(Btn, { key: 'd', label: n > 1 ? `Deny all ${n}` : 'Deny', fill: suggest === 'deny' ? 'solid' : 'outline', color: suggest === 'deny' ? 'primary' : 'medium', run: deny });
  const pays = r.price ? money$(r.price.amount, r.price.currency) : `$${r.priceUsd}`;
  // Compact, on Home: who, what in one line, which way your rules lean, the two taps; the rest a tap away (25 Nov: "it should be
  // very simple").
  const [open, setOpen] = useState(false);
  if (compact && !open) return h('ion-card', { class: `lake-card req compact${risky ? ' risky' : ''}` }, h('ion-card-content', {},
    h('div', { class: 'req-who' }, h(Avatar, { name: r.visitor.domain, size: 36 }),
      h('div', { class: 'req-who-text' }, h('h3', {}, r.visitor.domain), h('p', {}, r.question ? `Asks a yes/no question, for ${r.purpose}` : `Wants your ${r.fields.map(nice).join(', ')}`)),
      h('span', { class: 'req-pay' }, pays)),
    r.question ? h('p', { class: 'req-q compact-q' }, `“${r.question}”`) : null,
    h('p', { class: 'req-lean' }, r.counts?.length ? 'Only a yes or no leaves your house. ' : '', suggest === 'allow' ? 'Your rules lean yes.' : suggest === 'deny' ? 'Your rules lean no.' : 'Your call.'),
    h('div', { class: 'decide' }, ...(suggest === 'deny' ? [allowBtn, denyBtn] : [denyBtn, allowBtn])),
    h('button', { type: 'button', class: 'link-btn terms-link', onClick: () => setOpen(true) }, 'Details', h('ion-icon', { name: 'chevron-down' }))));
  return h('ion-card', { class: `lake-card req${risky ? ' risky' : ''}` }, h('ion-card-content', {},
    h('div', { class: 'req-who' }, h(Avatar, { name: r.visitor.domain, size: 42 }),
      h('div', { class: 'req-who-text' }, h('h3', {}, r.visitor.domain), h('p', {}, `Wants your data · for ${r.purpose}${times > 1 ? ` · asked ${times}×` : ''}`)),
      h('span', { class: 'req-pay' }, pays)),
    // A study: the question is the researcher's own sentence and nothing checks it against what is counted, so the
    // card shows both, the counted lines in the house's words (from the packs' labels).
    r.question ? h('p', { class: 'req-q' }, r.counts?.length ? h('span', { class: 'req-q-by' }, 'Their question') : null, r.question) : null,
    r.counts?.length ? h('div', { class: 'req-counts' }, h('p', {}, `What your house would answer, yes or no, to ${r.counts.length === 1 ? 'this' : 'each'}:`), h('ul', {}, ...r.counts.map((c) => h('li', { key: c }, c))), h('p', { class: 'req-counts-note' }, `Only the yes or no leaves, split in two halves that nobody can read alone.${r.table ? ` The one who asked sees only how many said yes, ${tableLine(r.table)}.` : ''}`)) : null,
    r.counts?.length ? null : h('div', { class: 'field-tags', 'aria-label': 'What it wants' }, ...r.fields.map((f) => h('span', { key: f, class: 'field-tag' }, nice(f)))),
    h('div', { class: `advice ${suggest === 'deny' ? 'deny' : suggest === 'allow' ? 'allow' : ''}` }, h('ion-icon', { name: suggest === 'deny' ? 'shield-outline' : 'shield-checkmark-outline' }),
      h('div', {}, h('b', {}, a.verdict), [...a.why, ...(r.warnings ?? []).map((w) => `It ${w}`)].map((w) => h('p', { key: w }, w)))),
    h('div', { class: 'decide' }, ...(suggest === 'deny' ? [allowBtn, denyBtn] : [denyBtn, allowBtn])),
    h('button', { type: 'button', class: 'link-btn terms-link', 'aria-expanded': String(terms), onClick: () => setTerms(!terms) }, terms ? 'Hide the terms' : 'All the terms', h('ion-icon', { name: terms ? 'chevron-up' : 'chevron-down' })),
    terms ? h('dl', { class: 'facts' },
      r.note ? [h('dt', { key: 'nt' }, 'Their note'), h('dd', { key: 'nd' }, `“${r.note}” (not checked)`)] : null,
      ...([['Fields', r.fields.map(nice).join(', ')], ['Keeps it', r.retention === 'none' ? 'No, deleted after' : `Yes, ${duration(r.retention)}`], ['Pays', pays], ['Access', '48 hours; you can take it back']] as [string, string][]).flatMap(([k, val]) => [h('dt', { key: `${k}t` }, k), h('dd', { key: `${k}d` }, val)])) : null));
}

/** An AI app signing in through this house, from its own sign-in page: approved here, where the key is. */
export function ConnectCard({ c }: { c: Connect }) {
  const [reads, setReads] = useState<Reads[]>([]);
  return h('ion-card', { class: 'lake-card warn-card' }, h('ion-card-content', {},
    h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'link-outline' }), 'Wants to connect'),
    h('h3', {}, `${c.app} wants to connect to your house`),
    h('p', {}, `As your assistant${c.from ? `, from ${c.from}` : ''}: it sees who writes to you and suggests what to do, and reads a chat's words only when you hand it that chat; only you decide. Connect only if your sign-in page shows:`),
    h('div', { class: 'connect-number' }, c.number),
    h(ReadsToggles, { value: reads, onChange: setReads }),
    h('div', { class: 'card-actions' },
      h(Btn, { label: 'Connect', run: async () => { const r = await must<{ name?: string }>({ kind: 'panel.connect.answer', id: c.id, yes: true, reads }); connectedNote = `Connected.${r.name ? ` On the Lake your ${c.app} is called ${shortName(r.name)}.` : ''} Go back to ${c.app}.`; } }),
      h(Btn, { label: 'No', fill: 'outline', color: 'medium', run: async () => { await call({ kind: 'panel.connect.answer', id: c.id, yes: false }); connectedNote = 'Turned down.'; } }))));
}

// An agreement both houses hold (round 113): its status as both phones show it, and the owner's own Cancel or Done.
const agreementPill = (g: NonNullable<AgendaItem['agreement']>, due?: string): [string, 'mint' | 'amber' | 'muted' | 'red'] =>
  g.status === 'proposed' ? [`Waiting for ${g.with.name}`, 'amber'] : g.status === 'agreed' ? [due ? 'Owed' : 'Agreed', due ? 'amber' : 'mint']
    : g.status === 'done' ? [g.auto ? 'Done (nobody answered)' : 'Done', 'mint']
    : g.status === 'done_asked' ? [g.asked?.by === 'you' ? `Done, waiting for ${g.with.name}` : `${g.with.name} says done`, 'amber']
    : g.status === 'not_kept' ? [`Not kept, says ${g.changed.by === 'them' ? g.with.name : 'you'}`, 'red']
    : g.status === 'disputed' ? ['Disputed', 'red']
    : [`${{ declined: 'Declined', cancelled: 'Cancelled', withdrawn: 'Withdrawn' }[g.status]}${g.changed.by === 'them' ? ` by ${g.with.name}` : ''}`, g.status === 'cancelled' ? 'red' : 'muted'];
/** When the thing itself is over: a time's start plus its length, or a promise's due date (the house's own rule). */
const endOf = (a: AgendaItem) => (a.start ? Date.parse(a.start) + (a.minutes ?? 60) * 60_000 : a.due ? Date.parse(a.due) : 0);
function AgreementRow({ a }: { a: AgendaItem }) {
  const g = a.agreement!, [pill, tone] = agreementPill(g, a.due), over = ['declined', 'cancelled', 'withdrawn'].includes(g.status);
  // Earlier lines one tap away; the latest is always shown (run 109: four dispute replies, and the record kept only the last).
  const [thread, setThread] = useState(false), earlier = (g.lines ?? []).slice(0, -1), who = (by: string) => (by === 'them' ? g.with.name : 'You');
  const set = (status: string, reason?: string) => must({ kind: 'panel.agreement.set', id: a.id, status, ...(reason ? { reason } : {}) });
  // A line of words for a not kept or a dispute: the other side sees it as yours, unchecked.
  const withReason = (status: string, header: string) => async () => { const r = await askLine({ header, sub: `${g.with.name} sees this line as your words.`, button: 'Send', placeholder: 'What happened, in a few words' }); if (!r) return; await set(status, r); };
  const btn = (key: string, label: string, run: () => Promise<unknown>, extra: Record<string, unknown> = {}) => h(Btn, { key, label, size: 'small', fill: 'clear', run, ...extra });
  const ended = Date.now() >= endOf(a);
  // The owner's own two buttons for each state, no more (round 134: done needs both sides; not kept and disputed carry a line).
  const begun = !a.start || Date.now() >= Date.parse(a.start);
  const acts = g.status === 'agreed' ? [...(begun ? [btn('d', 'Done', () => set('done'), { done: `${g.with.name} is asked to confirm it.` })] : []),
      ended ? btn('nk', 'Not kept', withReason('not_kept', `"${a.what}" wasn't kept?`), { color: 'danger' })
        : btn('c', 'Cancel', async () => { const r = await askLine({ header: `Cancel "${a.what}"?`, sub: `${g.with.name}'s house is told. A reason is optional.`, button: 'Cancel it', placeholder: 'A reason, if you like' }); await set('cancelled', r); }, { color: 'danger' })]
    : g.status === 'done_asked' && g.asked?.by === 'them' ? [btn('ok', 'Confirm', async () => { const r = await askLine({ header: `Confirm "${a.what}" is done?`, sub: `Anything ${g.with.name} should know, like "done, but it came back broken"? Optional.`, button: 'Confirm', placeholder: 'Optional', optional: true }); if (r === undefined) return; await set('done', r || undefined); }, { done: 'Done on both sides.' }), btn('no', 'Not done', withReason('disputed', `${g.with.name} says it's done. Not so?`), { color: 'danger' })]
    : g.status === 'done_asked' ? [btn('back', 'Not after all', () => set('agreed'), { color: 'medium' })]
    : g.status === 'disputed' ? [btn('re', 'Reply', withReason('disputed', 'Your side, in a line'), { color: 'medium' }), btn('da', 'Done after all', () => set('done'), { done: `${g.with.name} is asked to confirm it.` }), btn('drop', 'Drop it', () => set('cancelled'), { color: 'medium', ask: { header: `Drop "${a.what}"?`, sub: 'Both sides see it cancelled.', button: 'Drop it' } })]
    : g.status === 'proposed' && g.role === 'proposed' ? [btn('w', 'Withdraw', () => set('withdrawn'), { color: 'medium' })] : [];
  return h('ion-item', { lines: 'full', class: `lake-row agreement-row ${g.status}` },
    h('div', { slot: 'start', class: `row-icon tint-${tone === 'red' ? 'amber' : tone === 'muted' ? 'muted' : tone}` }, h('ion-icon', { name: a.due ? 'hand-right-outline' : 'calendar-outline' })),
    h('ion-label', { class: 'ion-text-wrap' }, h('h3', { class: over ? 'struck' : '' }, a.what),
      // Its state in the words, so the row's full width is theirs and its buttons' (round 148: a pill at the end left them a narrow column).
      h('p', { class: 'agreement-meta' }, h(Pill, { text: pill, tone }), ' ', [whenOf(a), a.where, `with ${g.with.name}`].filter(Boolean).join(' · ')),
      thread ? earlier.map((l, i) => h('p', { key: `l${i}`, class: 'muted-line agreement-line' }, `${who(l.by)}, ${time(l.at)}: “${l.text}”`)) : null,
      g.reason ? h('p', { class: 'muted-line' }, `${g.changed.by === 'them' ? g.with.name : 'You'}: “${g.reason}”`) : null,
      earlier.length && !thread ? h('button', { class: 'link-btn agreement-thread', onClick: (e: Event) => { e.stopPropagation(); setThread(true); } }, `${plural(earlier.length, 'earlier line')}`) : null,
      g.reason ? null : g.changed.by === 'them' && g.status !== 'agreed' ? h('p', { class: 'muted-line' }, `${g.with.name} changed it ${time(g.changed.at)}`) : null,
      // Under the words, where they can wrap (round 146: three buttons beside a disputed row left its words no width at phone size).
      acts.length ? h('div', { class: 'agreement-acts' }, ...acts) : null));
}
// In this phone's own time, from the start or due date when there is one (round 121: the house wrote them in UTC).
const whenOf = (a: AgendaItem) => (a.start ? dayTime(a.start) : a.due ? `by ${dayTime(a.due)}` : a.when);
function AgendaRow({ a }: { a: AgendaItem }) {
  if (a.agreement) return h(AgreementRow, { a });
  return h('ion-item', { lines: 'full', class: 'lake-row' },
    h('div', { slot: 'start', class: `row-icon tint-${!a.held && (a.confirmed || a.agreed) ? 'mint' : 'amber'}` }, h('ion-icon', { name: 'calendar-outline' })),
    h('ion-label', {}, h('h3', {}, a.what), h('p', {}, [whenOf(a), a.where, a.with ? `with ${a.with}` : ''].filter(Boolean).join(' · '))),
    h(Pill, { text: a.held ? 'Held' : a.confirmed ? 'Confirmed' : a.agreed ? 'Agreed' : 'Proposed', tone: !a.held && (a.confirmed || a.agreed) ? 'mint' : 'amber' }),
    h('div', { slot: 'end' }, h(Btn, { fill: 'clear', color: 'medium', size: 'small', label: h('ion-icon', { name: 'close', slot: 'icon-only' }), label2: `Remove ${a.what}`, cls: 'agenda-remove', run: async () => { const r = await must<{ note?: string }>({ kind: 'panel.agenda.remove', id: a.id }); void toast(r.note ?? 'Removed', r.note ? { duration: 6000 } : {}); } })));
}

function Waits({ waits }: { waits: Note[] }) {
  const [open, setOpen] = useState<Note | null>(null);
  return h('div', {},
    h(Section, { title: 'Waiting on others', cls: 'waits' },
      ...waits.map((x) => h('ion-item', { key: x.id, button: true, detail: false, lines: 'full', class: 'lake-row wait-row', onClick: () => setOpen(x) },
        h('div', { slot: 'start', class: 'row-icon tint-amber' }, h('ion-icon', { name: 'hourglass-outline' })),
        h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, x.errand!.what, ' ', h(Pill, { text: 'Waiting', tone: 'amber' })),
          h('p', {}, `${shortName(x.from)} asked ${x.errand!.with?.name ? shortName(x.errand!.with.name) : 'them'} ${ago(x.at)}. Nothing to do until they answer.`))))),
    h(Sheet, { open: !!open, onClose: () => setOpen(null), title: open ? 'Waiting' : undefined }, open ? h(SuggestionCard, { x: open, onDone: () => setOpen(null) }) : null));
}

function Notes({ notes }: { notes: Note[] }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Note | null>(null);
  const shown = [...notes].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, all ? 50 : 3);
  return h('div', {},
    h(Section, { title: `From your AI (${notes.length})`, cls: 'notes' },
      ...shown.map((x) => h('ion-item', { key: x.id, button: true, detail: false, lines: 'full', class: 'note-row', onClick: () => setOpen(x) },
        h('ion-label', {},
          h('div', { class: 'row-top' }, h('h3', {}, shortName(x.from), x.advice ? h(Pill, { text: { do: 'Advises yes', dont: x.sender ? 'Warning' : 'Advises no', your_call: 'Your call' }[x.advice], tone: x.advice === 'do' ? 'mint' : x.advice === 'dont' ? 'red' : 'muted' }) : null), x.at ? h('span', { class: 'row-time' }, when(x.at)) : null),
          h('p', { class: 'note-line' }, x.text)))),
      notes.length > 3 ? h(Row, { label: all ? 'Show fewer' : `Show all ${notes.length}`, detail: false, cls: 'see-all', onClick: () => setAll(!all) }) : null,
      h(Btn, { label: 'Clear all', size: 'small', fill: 'clear', color: 'medium', cls: 'clear-notes', run: async () => { for (const x of notes) await call({ kind: 'panel.assistant.dismiss', id: x.id }); }, ask: { header: `Clear all ${notes.length} notes from your AI?`, button: 'Clear all' } })),
    h(Sheet, { open: !!open, onClose: () => setOpen(null), title: open ? shortName(open.from) : undefined }, open ? h(SuggestionCard, { x: open, onDone: () => setOpen(null) }) : null));
}

const dayTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Your AI's question or suggestion: what it says and advises, and each answer as a button. */
export function SuggestionCard({ x, onDone }: { x: Note; onDone?: () => void }) {
  const bump = useBump();
  const [gone, setGone] = useState(false);
  const [more, setMore] = useState(false);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  // An answer the house took shows at once, before the list comes back (14 Nov: on a slow house the buttons simply
  // came back, as if nothing had happened).
  const [answeredNow, setAnsweredNow] = useState<string | null>(null);
  const answered = x.ask?.answered ?? answeredNow;
  const dismiss = () => call({ kind: 'panel.assistant.dismiss', id: x.id });
  // Who is speaking, once: a warning is the AI's like any other note, and its pill says it's a warning (13 Nov: the card
  // said "A warning" and "Warning" side by side, over the sender's raw address and five buttons).
  const waiter = x.errand?.with?.name ? shortName(x.errand.with.name) : 'an answer';
  const kicker = waitingOn(x) ? `Waiting for ${waiter}` : x.errand?.state === 'held' || x.errand?.state === 'answered' ? `${x.errand.with?.name ? shortName(x.errand.with.name) : 'They'} answered ${shortName(x.from)}` : x.agreementIn ? `${shortName(x.agreementIn.from.name)}'s house proposes` : x.agreementAsk ? `${shortName(x.from)} asks` : x.matchOut ? 'You could help someone' : x.booking ? 'Held for your OK' : x.circle ? 'Your circle' : x.pledge && pledgeEnded(x) ? (x.pledge.ended === 'lapsed' || x.pledge.signed?.lapsed ? 'This pledge closed without enough signatures' : `${shortName(x.pledge.openedBy?.vouched ?? x.from)} closed this pledge`) : x.pledge ? 'A pledge' : x.offer ? 'An offer' : x.ask ? `${shortName(x.from)} asks` : shortName(x.from);
  const block = !!x.sender && /^https?:\/\//.test(x.sender);
  // Its own answers already hold a "no" (Leave it, Not now): no Dismiss beside them (13 Nov: five ways out of one card).
  const ownNo = !!x.ask && !answered && x.ask.choices.length > 1;
  const advice = x.advice ? h(Pill, { text: x.sender && x.advice === 'dont' ? 'Warning' : { do: 'Advises yes', dont: 'Advises no', your_call: 'Your call' }[x.advice], tone: x.advice === 'do' ? 'mint' : x.advice === 'dont' ? 'red' : 'muted' }) : null;
  const acts: Child[] = [];
  // A time your AI pencilled in: yours to confirm (the house tells them either way). Nothing else to do with it.
  // Someone looking for help your AI says you match: Send is your yes (they see the points, not your name, until they say yes).
  // Another house asks you to agree (round 113): your own Yes or No, and their house is told.
  if (x.agreementIn) acts.push(
    h(Btn, { key: 'ay', label: 'Yes, agreed', run: () => must({ kind: 'panel.agreement.answer', id: x.id, yes: true }), done: `Agreed. ${x.agreementIn.from.name} was told, and it's in your agenda.` }),
    h(Btn, { key: 'an', label: 'No', fill: 'outline', color: 'medium', run: () => must({ kind: 'panel.agreement.answer', id: x.id, yes: false }), done: `${x.agreementIn.from.name} was told no.` }));
  // Your AI proposes cancelling or marking done an agreement: only your tap does it.
  else if (x.agreementAsk) acts.push(
    h(Btn, { key: 'aa', label: x.agreementAsk.status === 'cancelled' ? 'Cancel it' : 'Mark done', color: x.agreementAsk.status === 'cancelled' ? 'danger' : 'primary', run: () => must({ kind: 'panel.agreement.set', id: x.agreementAsk!.id, status: x.agreementAsk!.status }) }),
    h(Btn, { key: 'ak', label: 'Keep it', fill: 'outline', color: 'medium', run: () => must({ kind: 'panel.assistant.dismiss', id: x.id }) }));
  else if (x.matchOut && !x.matchOut.sent) acts.push(h(Btn, { key: 'mo', label: 'Offer to help', run: () => must({ kind: 'panel.want.match.send', id: x.id }), ask: { header: 'Offer to help?', sub: 'They see which of their points you fit, not your name. If they say yes too, you each see the other\'s name and can write to each other.', button: 'Offer to help', destructive: false }, done: 'Sent. If they say yes, their name appears here.' }));
  else if (x.booking) acts.push(
    h(Btn, { key: 'bk', label: 'Confirm', run: () => must({ kind: 'panel.assistant.answer', id: x.id, choice: 'Confirm' }), done: `Confirmed. ${x.booking.with} was told.` }),
    h(Btn, { key: 'bd', label: 'Decline', fill: 'outline', color: 'medium', run: () => must({ kind: 'panel.assistant.answer', id: x.id, choice: 'Decline' }), done: `Declined. ${x.booking.with} was told.` }));
  else if (x.ask && !answered) x.ask.choices.forEach((c, i) => acts.push(h(Btn, { key: `c${i}`, label: c, fill: x.ask!.recommend === i ? 'solid' : 'outline', run: async () => { await must({ kind: 'panel.assistant.answer', id: x.id, choice: c }); setAnsweredNow(c); }, done: `Sent to ${shortName(x.from)}: ${c}` })));
  if (x.offer) acts.push(h(Btn, { key: 'of', label: 'Accept the offer', run: async () => { const r = await call<{ error?: string; code?: string }>({ kind: 'panel.offer.accept', offer: x.offer, even_over_allowance: true }); if (r.error) throw new Error(r.error); await dismiss(); }, ask: { header: 'Accept this offer?', sub: 'What it needs goes to that one agent.', button: 'Accept', destructive: false } }));
  if (x.allowance && x.by) acts.push(h(Btn, { key: 'al', label: `Give ${money$(x.allowance.amount, x.allowance.currency)} for ${x.allowance.days} day${x.allowance.days === 1 ? '' : 's'}`, run: async () => { const d = await must<{ id: string; draft: Record<string, unknown> }>({ kind: 'panel.allowance.draft', kid: x.by, amount: x.allowance!.amount, currency: x.allowance!.currency, days: x.allowance!.days }); await must({ kind: 'panel.allowance.set', id: d.id, credential: await signDraft(d.draft) }); await dismiss(); } }));
  if (block) acts.push(h(Btn, { key: 'bl', label: 'Block them', color: 'danger', run: () => call({ kind: 'panel.assistant.block', id: x.id }), ask: { header: 'Block this agent?', sub: 'Your AI turns its messages away from now on.', button: 'Block' } }));
  if (x.rules) acts.push(h(Btn, { key: 'ru', label: 'Apply these rules', run: async () => { await must({ kind: 'panel.rules.set', text: x.rules }); await dismiss(); } }));
  if (x.door) acts.push(h(Btn, { key: 'do', label: 'Use this line', run: async () => { const cur = await call<{ name?: string; handle?: string }>({ kind: 'panel.door' }); await must({ kind: 'panel.door.set', open: true, about: x.door!.about, ...(cur.name ? { name: cur.name } : {}), ...(cur.handle ? { handle: cur.handle } : {}) }); await dismiss(); } }));
  if (x.favourPay && !x.favourPay.paid) acts.push(h(Btn, { key: 'fp', label: 'Pay with a favour you\'re owed', run: () => must({ kind: 'panel.favour.pay', note: x.id }) }));
  if (x.circleVote && !x.circleVote.sent) acts.push(h(Btn, { key: 'cv', label: 'Put it to a vote', run: () => must({ kind: 'panel.circle.propose', note: x.id }) }));
  if (x.circleCall && !x.circleCall.sent) acts.push(h(Btn, { key: 'cc', label: `Ask my circle${x.circleCall.help ? ` (${x.circleCall.help})` : ''}`, run: () => must({ kind: 'panel.circle.call', note: x.id }) }));
  if (x.count?.mine && !x.count.answered) acts.push(h(Btn, { key: 'ct', label: 'Count it in', run: () => must({ kind: 'panel.count.answer', note: x.id }) }));
  if (x.pledge && !x.pledge.quorum && !x.pledge.signed && !x.pledge.ended) acts.push(h(Btn, { key: 'pl', label: x.pledge.money ? `Put in ${money$(x.pledge.money.amount, x.pledge.money.currency)} and sign` : 'Sign the pledge', run: async () => { await signPledge(x.pledge!.tally, x.pledge!.id); await dismiss(); }, ...(x.pledge.money ? { ask: { header: `Put in ${money$(x.pledge.money.amount, x.pledge.money.currency)}?`, sub: `Held until ${new Date(x.pledge.money.deadline).toLocaleDateString()}: paid on only if ${x.pledge.money.threshold} sign; otherwise back to you.`, button: 'Put in and sign', destructive: false } } : {}) }));
  if (gone) return null;
  return h('ion-card', { class: 'lake-card sug' }, h('ion-card-content', {},
    h('div', { class: 'card-kicker' }, h('ion-icon', { name: waitingOn(x) ? 'hourglass-outline' : x.booking ? 'calendar-outline' : x.circle ? 'people-outline' : x.pledge ? 'hand-left-outline' : x.sender ? 'warning-outline' : 'sparkles-outline' }), kicker, advice),
    x.invitedBy ? h('p', { class: `private-line${x.invitedBy.known ? '' : ' warn-text'}` }, h('ion-icon', { name: x.invitedBy.known ? 'person-outline' : 'alert-circle-outline' }), x.invitedBy.known ? ` From ${x.invitedBy.name}, someone your side knows. The terms below are the tally's own.` : ` From ${x.invitedBy.name}, someone your side hasn't dealt with: their words are unchecked. The terms below are the tally's own.`) : null,
    // Who opened it, from the tally's record: a host named in the pledge's words is only the opener's claim (round 117).
    x.pledge?.peopleOnly && !x.pledge.signed && !x.pledge.ended ? h(PersonStamp, {}) : null,
    // Signed: said, with the count then (run 106: the card kept asking 22 minutes after).
    x.pledge?.ended && !x.pledge.signed ? h('p', { class: 'private-line pledge-ended' }, h('ion-icon', { name: 'close-circle-outline' }), x.pledge.ended === 'closed' ? ' Its opener closed it before it filled. Nothing to sign; nobody is bound.' : ' It closed without enough signatures. Nothing to sign; nobody is bound.') : null,
    x.pledge?.signed ? h('p', { class: 'private-line pledge-signed' }, h('ion-icon', { name: 'checkmark-circle-outline' }), x.pledge.signed.filled ? ` You signed, and it's on: ${x.pledge.signed.count ?? x.pledge.threshold ?? 'enough'} signed${x.pledge.threshold && (x.pledge.signed.count ?? 0) > x.pledge.threshold ? `, ${x.pledge.threshold} needed` : ''}.` : x.pledge.signed.withdrawn && (x.pledge.signed.closed || x.pledge.signed.lapsed) ? ` You withdrew, and it has since ${x.pledge.signed.closed ? 'been closed by its opener' : 'closed without enough signatures'}: nobody is bound.` : x.pledge.signed.withdrawn ? ' You withdrew your signature: it doesn\'t count, and nothing binds you.' : x.pledge.signed.closed ? ' You signed, but its opener closed it before it filled: nobody is bound.' : x.pledge.signed.lapsed ? ` You signed, but it closed at ${x.pledge.signed.count ?? 'fewer'} of ${x.pledge.threshold ?? 'enough'}: nobody is bound.` : ` You signed${x.pledge.signed.count !== undefined ? ` · ${x.pledge.signed.count}${x.pledge.threshold ? ` of ${x.pledge.threshold}` : ''} so far` : ''}.${x.pledge.money ? ' Nothing is paid unless it fills.' : ''}`) : null,
    // Its words name someone you know who didn't open it (run 121b: "hosted by Priya", opened by a stranger's AI, and Sam signed).
    x.pledge?.mentions && !x.pledge.signed && !x.pledge.ended ? h('p', { class: 'private-line warn-text pledge-mentions' }, h('ion-icon', { name: 'alert-circle-outline' }), ` It mentions ${x.pledge.mentions}, but nothing shows ${x.pledge.mentions.split(' ')[0]} opened it. Ask them before you sign.`) : null,
    x.pledge?.openedBy ? h('p', { class: 'private-line opened-by' }, h('ion-icon', { name: x.pledge.openedBy.house ? 'home-outline' : 'sparkles-outline' }), x.pledge.openedBy.house ? ` Opened by ${/ \(house\)$/.test(x.pledge.openedBy.name) ? `${x.pledge.openedBy.name.replace(/ \(house\)$/, '')}'s house` : x.pledge.openedBy.name}.` : x.pledge.openedBy.vouched ? ` Opened by ${x.pledge.openedBy.vouched}'s AI, confirmed by their house.` : ` Opened by ${shortName(x.pledge.openedBy.name)}, an AI. Anyone its words name as host is its own claim.`) : null,
    // A held time, from its own fields and in this phone's time (the house's own sentence names the free hours' zone).
    x.booking?.what ? [h('h3', { class: 'held-what', key: 'hw' }, x.booking.what), h('p', { class: 'held-when', key: 'hn' }, `${dayTime(x.booking.start)} · with ${x.booking.with}`),
      h('p', { class: 'muted-line', key: 'ht' }, `Your AI pencilled this in. ${x.booking.with} was told you'll confirm it yourself.`)]
      : x.pledge && pledgeEnded(x) ? h('p', { class: 'sug-text pledge-closed-terms' }, x.text.replace(/^.*? invites you to sign: /, ''))
      : h('p', { class: `sug-text${more || x.text.length < 280 ? '' : ' clamp'}` }, x.text),
    !x.booking?.what && !more && x.text.length >= 280 ? h('button', { type: 'button', class: 'link-btn more-link', onClick: () => setMore(true) }, 'More') : null,
    waitingOn(x) ? h('p', { class: 'muted-line' }, `${shortName(x.from)} asked ${x.errand?.with?.name ? shortName(x.errand.with.name) : 'them'} ${ago(x.at)}. When they answer, it shows here; until ${new Date(x.errand!.until).toLocaleDateString([], { day: 'numeric', month: 'short' })}.`) : null,
    x.matchOut ? h('div', { class: 'spec-chips' }, ...x.matchOut.points.map((pt) => h('span', { key: pt, class: `field-tag${x.matchOut!.matched.includes(pt) ? ' match-yes' : ' match-no'}` }, x.matchOut!.matched.includes(pt) ? pt : `${pt}: not said`))) : null,
    x.matchOut?.revealed ? [h('p', { class: 'offer-note', key: 'mr' }, `You both said yes${x.matchOut.revealedName ? `: ${x.matchOut.revealedName}` : ''}.`), x.matchOut.revealed !== 'yes' ? h('ion-button', { key: 'mh', size: 'small', shape: 'round', onClick: () => push(`#note=${encodeURIComponent(x.matchOut!.revealed!)}`) }, 'Say hello') : null]
      : x.matchOut?.sent ? h('p', { class: 'muted-line' }, 'Sent. If they say yes, their name appears here.') : null,
    x.door ? h('blockquote', {}, x.door.about) : null,
    x.pledge?.money ? h('p', { class: 'muted-line' }, `Puts in ${money$(x.pledge.money.amount, x.pledge.money.currency)}, held until ${new Date(x.pledge.money.deadline).toLocaleDateString()}. Paid on only if ${x.pledge.money.threshold} sign (${x.pledge.money.count} so far); otherwise it comes back.`) : null,
    x.pledge?.circle ? h('p', { class: 'muted-line' }, `A promise circle: you promise ${x.pledge.circle.promise}, ${x.pledge.circle.times === 1 ? 'once' : `${x.pledge.circle.times} times`} a year. No money.`) : null,
    x.pledge?.quorum ? h(Quorum, { x }) : null,
    x.circle && ['ask', 'caller', 'pass', 'vote'].includes(x.circle.role) ? h(CircleNote, { x, c: x.circle }) : null,
    x.count ? h('p', { class: 'muted-line' }, x.count.answered ? 'Counted, privately: only totals come out.' : x.count.mine ? `Your ${x.count.label}: ${x.count.mine.replace(/:/g, ' · ')}. Counted privately; only totals come out.` : `Your record has no ${x.count.label}.`) : null,
    x.ask?.private ? h('p', { class: 'private-line' }, h('ion-icon', { name: 'lock-closed-outline' }), ' Private: your AI won\'t see your answer.') : null,
    answered ? h('p', { class: 'muted-line answered-line' }, `You answered: ${answered}`) : null,
    x.booking ? h('p', { class: 'muted-line held-until' }, `Held until ${dayTime(x.booking.until)}. With no answer by then it's off, and ${x.booking.with} is told.`) : null,
    acts.length ? h('div', { class: 'card-actions wrap' }, ...acts) : null,
    !x.booking && x.reply ? h('p', { class: 'muted-line' }, `You wrote: “${x.reply}”`) : null,
    replying && !x.reply ? h('div', { class: 'card-reply' },
      h('ion-input', { value: reply, placeholder: 'What should it do?', 'aria-label': 'Tell your AI', class: 'reply-input', autofocus: true, onionInput: (e: CustomEvent) => setReply(String(e.detail.value ?? '')) }),
      reply.trim() ? h(Btn, { label: 'Send', size: 'small', run: async () => { await must({ kind: 'panel.assistant.answer', id: x.id, text: reply.trim() }); setReply(''); setReplying(false); void toast('Sent to your AI'); } }) : null) : null,
    // One line under the card's own answers. Your words to your AI go one way: about someone's chat, Tell opens the sheet
    // (it writes to them for you and reports back); otherwise it opens a line to the AI (what used to be Reply).
    x.booking ? null : h('div', { class: 'card-foot quiet' },
      h(TellButton, { x, onSent: onDone, fallback: !x.reply && !replying ? () => setReplying(true) : undefined }),
      x.note && x.mute && !block ? h(Btn, { label: 'Block', fill: 'clear', size: 'small', color: 'medium', run: async () => { await call({ kind: 'panel.note.mute', id: x.note }); await dismiss(); }, ask: blockAsk() }) : null,
      // A spinner while it goes, and the card leaves the moment the house has it (14 Nov: nothing showed, then a few seconds
      // later the card was simply gone); a failure says so, like any other button.
      ownNo ? null : h(Btn, { label: waitingOn(x) ? 'Stop waiting' : 'Dismiss', fill: 'clear', size: 'small', color: 'medium', cls: 'foot-end', run: async () => { await must({ kind: 'panel.assistant.dismiss', id: x.id }); setGone(true); onDone?.(); }, ...(waitingOn(x) ? { ask: { header: `Stop waiting for ${waiter}?`, sub: `${shortName(x.from)} tells them it's off.`, button: 'Stop waiting' } } : {}) }))));
}

/** A pledge that counts people once each needs this owner's person stamp: said on the card, one tap to get it (run 104:
 * three neighbours tapped Sign and were sent to "You, This phone, then About this house"). */
function PersonStamp() {
  const o = useHouse<{ person?: { stamped: boolean; checker?: string } }>({ kind: 'panel.overview' });
  const p = o.data?.person;
  if (!p || p.stamped) return null;
  return h('div', { class: 'private-line person-stamp' }, h('ion-icon', { name: 'finger-print-outline' }),
    // What the stamp is, before anyone presses Sign (run 125: all five were refused at Sign and called it "not explained";
    // ChatGPT's words, round 180).
    p.checker ? [' It counts each person once. Signing needs a quick check on this phone that you\'re one real person; nobody learns who you are. ', h(Btn, { key: 'st', label: 'Get my person stamp', size: 'small', fill: 'outline', run: async () => must({ kind: 'panel.person.request', consent: await signEnvelope({ kind: 'personhood.consent', house: state.webId }, key, state.webId || 'owner') }), done: 'Stamped: you count as one real person for pledges like this, and nobody learns who you are. You can sign it now.' })]
      : ' It counts each person once, and this house has no person checker set, so it can\'t be signed from here.');
}

function Quorum({ x }: { x: Note }) {
  const q = x.pledge!.quorum!;
  const closes = new Date(q.closes).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (q.answered) return h('p', { class: 'private-line' }, h('ion-icon', { name: 'lock-closed-outline' }), ` Answered privately. If enough would join, it opens for signing at ${closes}.`);
  return h('div', {},
    h('p', { class: 'private-line' }, h('ion-icon', { name: 'lock-closed-outline' }), ` Private: I'm in if at least how many are? Nobody sees your answer; only totals.`),
    h('div', { class: 'card-actions wrap' }, ...q.options.map((c) => h(Btn, { key: c, label: c, fill: 'outline', run: () => must({ kind: 'panel.pledge.quorum', tally: x.pledge!.tally, id: x.pledge!.id, choice: c, note: x.id }) }))));
}

/** A promise circle's note: a member needs what you promised, or your own call, a vote, a favour passed on. */
function CircleNote({ x, c }: { x: Note; c: CircleItem }) {
  const send = (payload: Record<string, unknown>) => () => must(payload);
  const line = (t: string) => h('p', { class: 'muted-line' }, t);
  const contact = (t: string) => [line(t), h('a', { href: doorOf(c.contact), target: '_blank', rel: 'noopener', class: 'contact-link' }, doorOf(c.contact))];
  const acts = (...b: Child[]) => h('div', { class: 'card-actions wrap' }, ...b);
  if (c.role === 'ask') return h('div', {},
    c.state === 'open' ? acts(h(Btn, { label: 'Yes, I\'ll do it', run: send({ kind: 'panel.circle.answer', note: x.id, accept: true }) }), h(Btn, { label: 'Not this time', fill: 'outline', run: send({ kind: 'panel.circle.answer', note: x.id, accept: false }) }), h(Btn, { label: 'Report', fill: 'clear', color: 'danger', run: send({ kind: 'panel.circle.answer', note: x.id, report: true }), ask: { header: 'Report this call?', sub: 'It counts against the caller\'s key; they aren\'t told who.', button: 'Report' } })) : null,
    c.state === 'accepted' ? [...contact('You said yes. Reach them at their house:'), acts(h(Btn, { label: 'Something went wrong', fill: 'clear', color: 'medium', run: send({ kind: 'panel.circle.dispute', note: x.id }), ask: { header: 'Mark it disputed?', sub: 'No favour is owed for it.', button: 'Mark disputed' } }))] : null,
    c.state === 'disputed' ? line('Disputed: no favour is owed.') : c.state === 'taken' ? line('Someone else took it.') : c.state === 'declined' ? line('You said not this time.') : c.state === 'reported' ? line('Reported.') : c.state === 'withdrawn' ? line('They withdrew it.') : null);
  if (c.role === 'vote') return c.state === 'open' ? acts(h(Btn, { label: 'Yes', run: send({ kind: 'panel.circle.answer', note: x.id, accept: true }) }), h(Btn, { label: 'No', fill: 'outline', run: send({ kind: 'panel.circle.answer', note: x.id, accept: false }) })) : line('Answered, in secret.');
  if (c.role === 'pass') return c.state === 'open' ? acts(h(Btn, { label: 'OK, I\'ll take it', run: send({ kind: 'panel.circle.answer', note: x.id, accept: true }) }), h(Btn, { label: 'No thanks', fill: 'outline', run: send({ kind: 'panel.circle.answer', note: x.id, accept: false }) })) : line(c.state === 'accepted' ? 'Taken: the favour is owed to you now.' : 'You kept it as it was.');
  return h('div', {},
    c.state === 'asking' ? line('Asked, without your name.') : null,
    c.state === 'matched' ? contact('Someone said yes. Reach them at their house:') : null,
    c.state === 'done' ? line('Thanked: you owe one favour.') : c.state === 'withdrawn' ? line('Withdrawn.') : c.state === 'disputed' ? line('Disputed: no favour is owed.') : null,
    c.state === 'matched' || c.state === 'asking' ? acts(
      c.state === 'matched' ? h(Btn, { label: 'Thanks', run: send({ kind: 'panel.circle.kept', note: x.id }) }) : null,
      h(Btn, { label: 'Withdraw', fill: 'outline', color: 'medium', run: send({ kind: 'panel.circle.kept', note: x.id, withdraw: true }) }),
      c.state === 'matched' ? h(Btn, { label: 'It didn\'t happen', fill: 'clear', color: 'medium', run: send({ kind: 'panel.circle.dispute', note: x.id }), ask: { header: 'Mark it disputed?', sub: 'No favour is owed for it.', button: 'Mark disputed' } }) : null) : null);
}

/** How many things wait for a decision, for the tab's badge. */
export const decisions = (v?: ListView) => (v ? v.requests.length + v.suggestions.filter((x) => needsDecision(x) && !taskCards(v).some((t) => t.suggestion === x.id)).length + taskCards(v).filter((t) => t.state === 'back' || t.state === 'cant').length + (v.connects ?? []).length + (v.wants ?? []).filter(wantNeedsYou).length : 0);
