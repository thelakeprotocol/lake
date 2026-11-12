import { useState } from 'preact/hooks';
import { call, must, useBump, useHouse } from './api';
import { Avatar, Btn, Child, Empty, Failed, Info, Page, Pill, Row, Section, Sheet, h, toast } from './ion';
import { adviceOf, doorOf, duration, grantFor, time, when, money$, needsDecision, nice, plural, sameAsks, shortName, signDraft, signPledge, waitingLine, type AgendaItem, type CircleItem, type Connect, type DutyLog, type ListView, type Note, type Reads, type Request } from './logic';
import { ReadsToggles } from './ai';
import { push } from './nav';

// Inbox: everything that waits for your tap, newest first. Data requests your rules left to you, your AI's questions and
// suggestions, app sign-ins, your circle's calls; and what's coming up.

/** What the last sign-in answer did, kept past the refetch that takes the request away. */
let connectedNote = '';

type TodayLine = { by: 'rules' | 'ai' | 'house' | 'shops' | 'money'; text: string; at: string; to: string; undo?: string };
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
  const today = useHouse<{ since: string; lines: TodayLine[] }>({ kind: 'panel.today', tz_offset: new Date().getTimezoneOffset() });
  const v = list.data;
  if (!v) return h(Page, { title: 'Today', big: true, status, footer: tabbar }, h(Failed, { error: list.error }));
  const groups = sameAsks(v.requests);
  const decide = v.suggestions.filter(needsDecision), notes = v.suggestions.filter((x) => !needsDecision(x));
  const waiting = v.assistants.filter((a) => a.waiting);
  const any = groups.length || decide.length || (v.connects ?? []).length || waiting.length || connectedNote;
  const lines = today.data?.lines ?? [];
  return h(Page, { title: 'Today', big: true, status, footer: tabbar },
    h('h3', { class: 'section-h', key: 'nh' }, 'Needs your attention'),
    connectedNote ? h('ion-card', { class: 'lake-card ok-card', key: 'cn' }, h('ion-card-content', {}, h('p', {}, connectedNote), h('ion-button', { size: 'small', fill: 'clear', onClick: () => { connectedNote = ''; } }, 'OK'))) : null,
    ...(v.connects ?? []).map((c) => h(ConnectCard, { key: `c-${c.id}`, c })),
    ...waiting.map((a) => h('ion-card', { key: `w-${a.kid}`, class: 'lake-card warn-card' }, h('ion-card-content', {},
      h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'alert-circle-outline' }), `${shortName(a.label)} isn't reading`),
      h('p', {}, waitingLine(a))))),
    ...groups.map((all) => h(RequestCard, { key: all[0]!.id, all })),
    ...decide.map((x) => h(SuggestionCard, { key: x.id, x })),
    !any ? h('div', { class: 'all-clear', key: 'clear' }, h('ion-icon', { name: 'checkmark-done-outline' }), h('div', {}, h('b', {}, 'You\'re all clear'), h('p', {}, 'Nothing needs your attention. Your house is keeping an eye on things.'))) : null,
    h(Section, { title: 'Handled for you', key: 'handled', cls: 'handled' },
      ...(lines.length ? lines.map((l, i) => h(Row, { key: i, icon: BY[l.by].icon, tint: BY[l.by].tint, label: l.text, sub: `${BY[l.by].label} · ${time(l.at)}`, onClick: () => push(l.to), cls: 'handled-row',
        below: l.undo ? h(Btn, { label: 'Undo', size: 'small', fill: 'outline', run: () => call({ kind: 'panel.duty.undo', entry: l.undo }), done: 'Undone' }) : undefined }))
        : [h('ion-item', { key: 'none', lines: 'none' }, h('ion-label', { class: 'ion-text-wrap' }, h('p', {}, today.data ? 'Nothing handled yet today.' : 'Looking…')))])),
    // Notes that need nothing from you: one short line each, the newest few; the whole note opens in a sheet (12 Nov: a
    // wall of long notes drowned the few that need you).
    notes.length ? h(Notes, { key: 'notes', notes }) : null,
    v.agenda?.length ? h(Section, { title: 'Coming up', key: 'ag' }, ...v.agenda.map((a) => h(AgendaRow, { key: a.id, a }))) : null);
}

/** A data request your rules left to you: what it wants, what your rules suggest, the suggested answer first. */
function RequestCard({ all }: { all: Request[] }) {
  const r = all[0]!, n = all.length, times = all.reduce((t, x) => t + (x.asked ?? 1), 0);
  const risky = !!r.warnings?.length;
  const a = adviceOf(r.recommendation);
  const suggest = a.suggest || (risky ? 'deny' : '');
  const [terms, setTerms] = useState(false);
  const after = (allowed: boolean) => void toast(`${allowed ? 'Allowed' : 'Declined'} ${r.visitor.domain}`, { buttons: [{ text: allowed ? 'Always allow' : 'Always decline', handler: async () => { await call({ kind: 'panel.request.always', request: r.id, answer: allowed ? 'allow' : 'decline' }); void toast(allowed ? `${r.visitor.domain} gets a yes for this from now on (90 days)` : `You won't hear from ${r.visitor.domain} again`); } }] });
  const allow = async () => { for (const q of all) await call({ kind: 'answer', request: q.id, answer: 'allow', grant: await grantFor(q) }); after(true); };
  const deny = async () => { for (const q of all) await call({ kind: 'answer', request: q.id, answer: 'deny' }).catch(() => {}); after(false); };
  const allowBtn = h(Btn, { key: 'a', label: n > 1 ? `Allow all ${n}` : 'Allow', fill: suggest === 'deny' ? 'outline' : 'solid', color: suggest === 'deny' ? 'medium' : 'primary', run: allow, ...(risky ? { ask: { header: `Let ${r.visitor.domain} use your ${r.fields.map(nice).join(', ')}?`, sub: 'Your rules advise against it.', button: 'Allow anyway' } } : {}) });
  const denyBtn = h(Btn, { key: 'd', label: n > 1 ? `Deny all ${n}` : 'Deny', fill: suggest === 'deny' ? 'solid' : 'outline', color: suggest === 'deny' ? 'primary' : 'medium', run: deny });
  const pays = r.price ? money$(r.price.amount, r.price.currency) : `$${r.priceUsd}`;
  return h('ion-card', { class: `lake-card req${risky ? ' risky' : ''}` }, h('ion-card-content', {},
    h('div', { class: 'req-who' }, h(Avatar, { name: r.visitor.domain, size: 42 }),
      h('div', { class: 'req-who-text' }, h('h3', {}, r.visitor.domain), h('p', {}, `Wants your data · for ${r.purpose}${times > 1 ? ` · asked ${times}×` : ''}`)),
      h('span', { class: 'req-pay' }, pays)),
    r.question ? h('p', { class: 'req-q' }, r.question) : null,
    h('div', { class: 'field-tags', 'aria-label': 'What it wants' }, ...r.fields.map((f) => h('span', { key: f, class: 'field-tag' }, nice(f)))),
    h('div', { class: `advice ${suggest === 'deny' ? 'deny' : suggest === 'allow' ? 'allow' : ''}` }, h('ion-icon', { name: suggest === 'deny' ? 'shield-outline' : 'shield-checkmark-outline' }),
      h('div', {}, h('b', {}, a.verdict), [...a.why, ...(r.warnings ?? []).map((w) => `It ${w}`)].map((w) => h('p', { key: w }, w)))),
    h('div', { class: 'decide' }, ...(suggest === 'deny' ? [allowBtn, denyBtn] : [denyBtn, allowBtn])),
    h('button', { type: 'button', class: 'link-btn terms-link', 'aria-expanded': String(terms), onClick: () => setTerms(!terms) }, terms ? 'Hide the terms' : 'All the terms', h('ion-icon', { name: terms ? 'chevron-up' : 'chevron-down' })),
    terms ? h('dl', { class: 'facts' },
      r.note ? [h('dt', { key: 'nt' }, 'Their note'), h('dd', { key: 'nd' }, `“${r.note}” (not checked)`)] : null,
      ...([['Fields', r.fields.map(nice).join(', ')], ['Keeps it', r.retention === 'none' ? 'No, deleted after' : `Yes, ${duration(r.retention)}`], ['Pays', pays], ['Access', '48 hours; you can take it back']] as [string, string][]).flatMap(([k, val]) => [h('dt', { key: `${k}t` }, k), h('dd', { key: `${k}d` }, val)])) : null));
}

/** An AI app signing in through this house, from its own sign-in page: approved here, where the key is. */
function ConnectCard({ c }: { c: Connect }) {
  const [reads, setReads] = useState<Reads[]>([]);
  return h('ion-card', { class: 'lake-card warn-card' }, h('ion-card-content', {},
    h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'link-outline' }), 'Wants to connect'),
    h('h3', {}, `${c.app} wants to connect to your house`),
    h('p', {}, `As your assistant${c.from ? `, from ${c.from}` : ''}: it reads the messages at your door and suggests; only you decide. Connect only if your sign-in page shows:`),
    h('div', { class: 'connect-number' }, c.number),
    h(ReadsToggles, { value: reads, onChange: setReads }),
    h('div', { class: 'card-actions' },
      h(Btn, { label: 'Connect', run: async () => { const r = await must<{ name?: string }>({ kind: 'panel.connect.answer', id: c.id, yes: true, reads }); connectedNote = `Connected${r.name ? `: ${shortName(r.name)}` : ''}. Go back to ${c.app}.`; } }),
      h(Btn, { label: 'No', fill: 'outline', color: 'medium', run: async () => { await call({ kind: 'panel.connect.answer', id: c.id, yes: false }); connectedNote = 'Turned down.'; } }))));
}

function AgendaRow({ a }: { a: AgendaItem }) {
  return h('ion-item', { lines: 'full', class: 'lake-row' },
    h('div', { slot: 'start', class: `row-icon tint-${a.agreed ? 'mint' : 'amber'}` }, h('ion-icon', { name: 'calendar-outline' })),
    h('ion-label', {}, h('h3', {}, a.what), h('p', {}, [a.when, a.where, a.with ? `with ${a.with}` : ''].filter(Boolean).join(' · '))),
    h(Pill, { text: a.agreed ? 'Agreed' : 'Proposed', tone: a.agreed ? 'mint' : 'amber' }),
    h('ion-button', { slot: 'end', fill: 'clear', color: 'medium', 'aria-label': `Remove ${a.what}`, onClick: async () => { await call({ kind: 'panel.agenda.remove', id: a.id }); void toast('Removed'); } }, h('ion-icon', { name: 'close', slot: 'icon-only' })));
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

/** Your AI's question or suggestion: what it says and advises, and each answer as a button. */
function SuggestionCard({ x, onDone }: { x: Note; onDone?: () => void }) {
  const bump = useBump();
  const [more, setMore] = useState(false);
  const [reply, setReply] = useState('');
  const dismiss = () => call({ kind: 'panel.assistant.dismiss', id: x.id });
  const kicker = x.circle ? 'Your circle' : x.pledge ? 'A pledge' : x.offer ? 'An offer' : x.sender ? 'A warning' : x.ask ? `${shortName(x.from)} asks` : shortName(x.from);
  const advice = x.advice ? h(Pill, { text: x.sender && x.advice === 'dont' ? 'Warning' : { do: 'Advises yes', dont: 'Advises no', your_call: 'Your call' }[x.advice], tone: x.advice === 'do' ? 'mint' : x.advice === 'dont' ? 'red' : 'muted' }) : null;
  const acts: Child[] = [];
  if (x.ask && !x.ask.answered) x.ask.choices.forEach((c, i) => acts.push(h(Btn, { key: `c${i}`, label: c, fill: x.ask!.recommend === i ? 'solid' : 'outline', run: () => must({ kind: 'panel.assistant.answer', id: x.id, choice: c }) })));
  if (x.offer) acts.push(h(Btn, { key: 'of', label: 'Accept the offer', run: async () => { const r = await call<{ error?: string; code?: string }>({ kind: 'panel.offer.accept', offer: x.offer, even_over_allowance: true }); if (r.error) throw new Error(r.error); await dismiss(); }, ask: { header: 'Accept this offer?', sub: 'What it needs goes to that one agent.', button: 'Accept', destructive: false } }));
  if (x.allowance && x.by) acts.push(h(Btn, { key: 'al', label: `Give ${money$(x.allowance.amount, x.allowance.currency)} for ${x.allowance.days} day${x.allowance.days === 1 ? '' : 's'}`, run: async () => { const d = await must<{ id: string; draft: Record<string, unknown> }>({ kind: 'panel.allowance.draft', kid: x.by, amount: x.allowance!.amount, currency: x.allowance!.currency, days: x.allowance!.days }); await must({ kind: 'panel.allowance.set', id: d.id, credential: await signDraft(d.draft) }); await dismiss(); } }));
  if (x.sender && /^https?:\/\//.test(x.sender)) acts.push(h(Btn, { key: 'bl', label: 'Block them', color: 'danger', run: () => call({ kind: 'panel.assistant.block', id: x.id }), ask: { header: 'Block this agent?', sub: 'Its messages are turned away.', button: 'Block' } }));
  if (x.note && x.mute) acts.push(h(Btn, { key: 'mu', label: 'Mute this sender', fill: 'outline', run: async () => { await call({ kind: 'panel.note.mute', id: x.note }); await dismiss(); } }));
  if (x.rules) acts.push(h(Btn, { key: 'ru', label: 'Apply these rules', run: async () => { await must({ kind: 'panel.rules.set', text: x.rules }); await dismiss(); } }));
  if (x.door) acts.push(h(Btn, { key: 'do', label: 'Use this line', run: async () => { const cur = await call<{ name?: string; handle?: string }>({ kind: 'panel.door' }); await must({ kind: 'panel.door.set', open: true, about: x.door!.about, ...(cur.name ? { name: cur.name } : {}), ...(cur.handle ? { handle: cur.handle } : {}) }); await dismiss(); } }));
  if (x.favourPay && !x.favourPay.paid) acts.push(h(Btn, { key: 'fp', label: 'Pay with a favour you\'re owed', run: () => must({ kind: 'panel.favour.pay', note: x.id }) }));
  if (x.circleVote && !x.circleVote.sent) acts.push(h(Btn, { key: 'cv', label: 'Put it to a vote', run: () => must({ kind: 'panel.circle.propose', note: x.id }) }));
  if (x.circleCall && !x.circleCall.sent) acts.push(h(Btn, { key: 'cc', label: `Ask my circle${x.circleCall.help ? ` (${x.circleCall.help})` : ''}`, run: () => must({ kind: 'panel.circle.call', note: x.id }) }));
  if (x.count?.mine && !x.count.answered) acts.push(h(Btn, { key: 'ct', label: 'Count it in', run: () => must({ kind: 'panel.count.answer', note: x.id }) }));
  if (x.pledge && !x.pledge.quorum) acts.push(h(Btn, { key: 'pl', label: x.pledge.money ? `Put in ${money$(x.pledge.money.amount, x.pledge.money.currency)} and sign` : 'Sign the pledge', run: async () => { await signPledge(x.pledge!.tally, x.pledge!.id); await dismiss(); }, ...(x.pledge.money ? { ask: { header: `Put in ${money$(x.pledge.money.amount, x.pledge.money.currency)}?`, sub: `Held until ${new Date(x.pledge.money.deadline).toLocaleDateString()}: paid on only if ${x.pledge.money.threshold} sign; otherwise back to you.`, button: 'Put in and sign', destructive: false } } : {}) }));
  return h('ion-card', { class: 'lake-card sug' }, h('ion-card-content', {},
    h('div', { class: 'card-kicker' }, h('ion-icon', { name: x.circle ? 'people-outline' : x.pledge ? 'hand-left-outline' : x.sender ? 'warning-outline' : 'sparkles-outline' }), kicker, advice),
    x.sender ? h('p', { class: 'muted-line' }, `About: ${x.sender}`) : null,
    x.invitedBy ? h('p', { class: `private-line${x.invitedBy.known ? '' : ' warn-text'}` }, h('ion-icon', { name: x.invitedBy.known ? 'person-outline' : 'alert-circle-outline' }), x.invitedBy.known ? ` From ${x.invitedBy.name}, someone your side knows. The terms below are the tally's own.` : ` From ${x.invitedBy.name}, someone your side hasn't dealt with: their words are unchecked. The terms below are the tally's own.`) : null,
    h('p', { class: `sug-text${more || x.text.length < 280 ? '' : ' clamp'}` }, x.text),
    !more && x.text.length >= 280 ? h('button', { type: 'button', class: 'link-btn more-link', onClick: () => setMore(true) }, 'More') : null,
    x.door ? h('blockquote', {}, x.door.about) : null,
    x.pledge?.money ? h('p', { class: 'muted-line' }, `Puts in ${money$(x.pledge.money.amount, x.pledge.money.currency)}, held until ${new Date(x.pledge.money.deadline).toLocaleDateString()}. Paid on only if ${x.pledge.money.threshold} sign (${x.pledge.money.count} so far); otherwise it comes back.`) : null,
    x.pledge?.circle ? h('p', { class: 'muted-line' }, `A promise circle: you promise ${x.pledge.circle.promise}, ${x.pledge.circle.times === 1 ? 'once' : `${x.pledge.circle.times} times`} a year. No money.`) : null,
    x.pledge?.quorum ? h(Quorum, { x }) : null,
    x.circle && ['ask', 'caller', 'pass', 'vote'].includes(x.circle.role) ? h(CircleNote, { x, c: x.circle }) : null,
    x.count ? h('p', { class: 'muted-line' }, x.count.answered ? 'Counted, privately: only totals come out.' : x.count.mine ? `Your ${x.count.label}: ${x.count.mine.replace(/:/g, ' · ')}. Counted privately; only totals come out.` : `Your record has no ${x.count.label}.`) : null,
    x.ask?.private ? h('p', { class: 'private-line' }, h('ion-icon', { name: 'lock-closed-outline' }), ' Private: your AI won\'t see your answer.') : null,
    x.ask?.answered ? h('p', { class: 'muted-line' }, `You answered: ${x.ask.answered}`) : null,
    acts.length ? h('div', { class: 'card-actions wrap' }, ...acts) : null,
    x.reply ? h('p', { class: 'muted-line' }, `You wrote: “${x.reply}”`) : h('div', { class: 'card-reply' },
      h('ion-input', { value: reply, placeholder: 'Reply in your own words', 'aria-label': 'Reply', class: 'reply-input', onionInput: (e: CustomEvent) => setReply(String(e.detail.value ?? '')) }),
      reply.trim() ? h(Btn, { label: 'Send', size: 'small', run: async () => { await must({ kind: 'panel.assistant.answer', id: x.id, text: reply.trim() }); setReply(''); void toast('Sent to your AI'); } }) : null),
    h('div', { class: 'card-foot' }, h('ion-button', { fill: 'clear', size: 'small', color: 'medium', onClick: async () => { await dismiss(); onDone?.(); bump(); } }, 'Dismiss'))));
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
export const decisions = (v?: ListView) => (v ? v.requests.length + v.suggestions.filter(needsDecision).length + (v.connects ?? []).length : 0);
