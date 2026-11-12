import { useEffect, useRef, useState } from 'preact/hooks';
import { call, must, useBump, useHouse } from './api';
import { Avatar, Btn, Child, Empty, Failed, Info, Page, Pill, Row, Section, Sheet, confirm, h, toast } from './ion';
import { addressLine, chatKeyOf, chatsOf, day, dutyLive, money, peopleOf, plural, seen, shortName, shortShop, signDraft, stale, time, unseen, when, type Address, type Assistant, type Chat, type DoorNote, type DutyEntry, type DoorState, type DutyLog, type ListView, type Note, type WantOfferV, type WantV } from './logic';
import { back, focusNote, push } from './nav';
import { SuggestionCard } from './inbox';

// People: one row per person, the ones you know above the new ones, and a chat with each. What you're looking for (a
// thread of shops' offers each) shows on Today while it needs you, and under Money.

const trustPill = (c: Chat) => h(Pill, { text: c.trust === 'known' ? 'Known' : c.trust === 'lookalike' ? 'Careful' : 'New', tone: c.trust === 'known' ? 'mint' : c.trust === 'lookalike' ? 'red' : 'amber' });

/** How many new people show before "Show all". */
const FEW = 3;

/** Clears chats at once, on every device; Undo puts them back (the house keeps them ten minutes). */
export async function clearChats(chats: Chat[], bump: () => void, said?: string) {
  const ids = chats.flatMap((c) => c.notes.map((n) => n.id));
  if (!ids.length) return;
  const r = await must<{ cleared: number; undo?: string }>({ kind: 'panel.notes.clear', ids });
  bump();
  void toast(said ?? `Cleared ${plural(chats.length, 'chat')}`, { duration: 8000, buttons: r.undo ? [{ text: 'Undo', handler: () => { void call<{ error?: string }>({ kind: 'panel.notes.restore', undo: r.undo }).then((x) => { if (x.error) void toast(x.error, { color: 'danger' }); bump(); }); } }] : [] });
}

export function ChatsTab({ tabbar, status }: { tabbar: Child; status: Child }) {
  const bump = useBump();
  const list = useHouse<ListView>({ kind: 'list' });
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const [all, setAll] = useState(false);
  const data = list.data;
  if (data) seen.at = { ...(data.seen ?? {}), ...seen.at };
  const { known, fresh } = peopleOf(data ? chatsOf(data.notes ?? []) : []);
  const old = stale(fresh);
  const more = fresh.length > FEW;
  return h(Page, { title: 'People', big: true, status, footer: tabbar },
    !data ? h(Failed, { error: list.error }) : [
      known.length ? h(Section, { title: 'People you know', key: 'known', cls: 'chat-list people-known' }, ...known.map((c) => h(ChatRow, { key: c.key, c }))) : null,
      fresh.length ? h(Section, { title: `New people · ${fresh.length}`, key: 'new', cls: 'chat-list people-new' },
        ...(all ? fresh : fresh.slice(0, FEW)).map((c) => h(ChatRow, { key: c.key, c })),
        more || old.length ? h('div', { class: 'people-more', key: 'more' },
          more ? h('ion-button', { fill: 'clear', size: 'small', class: 'show-all', onClick: () => setAll(!all) }, all ? 'Show fewer' : `Show all ${fresh.length}`) : null,
          old.length ? h(Btn, { label: `Clear older than 7 days (${old.length})`, fill: 'clear', color: 'medium', size: 'small', cls: 'clear-old', run: () => clearChats(old, bump) })
            : more && all ? h(Btn, { label: `Clear all ${fresh.length}`, fill: 'clear', color: 'medium', size: 'small', cls: 'clear-new', run: () => clearChats(fresh, bump) }) : null) : null) : null,
      known.length || fresh.length ? null
        : h(Empty, { key: 'empty', icon: 'people-outline', title: 'Nobody has written yet', text: door.data?.handle ? `People reach you by asking their AI to ping ${door.data.handle}.` : 'Pick a handle, and anyone\'s AI can reach you.', action: h('ion-button', { shape: 'round', fill: 'outline', onClick: () => push('#door') }, door.data?.handle ? 'Share your handle' : 'Pick your handle') }),
    ]);
}

function ChatRow({ c }: { c: Chat }) {
  const ai = c.lastBy === 'ai' ? shortName(c.notes.at(-1)?.answered?.by ?? '') || 'Your AI' : '';
  return h('ion-item', { button: true, detail: false, lines: 'full', class: `chatrow${c.unread ? ' unread' : ''}`, onClick: () => push(`#chat=${encodeURIComponent(c.key)}`) },
    h('div', { slot: 'start' }, h(Avatar, { name: c.name, ring: c.trust === 'lookalike' ? 'lookalike' : undefined })),
    h('ion-label', {},
      h('div', { class: 'row-top' }, h('h3', {}, c.name), h('span', { class: 'row-time' }, when(c.at))),
      c.trust === 'lookalike' ? h('div', { class: 'row-via careful' }, `Says they're ${shortName(c.twin?.name ?? c.name)}, with a different key`) : null,
      h('div', { class: 'row-last' }, h('p', { class: 'chatlast' }, c.lastBy === 'you' ? 'You: ' : ai ? `${ai}: ` : '', c.last), c.unread ? h('ion-badge', { color: 'primary', class: 'unread-badge' }, String(c.unread)) : null)));
}

const wantState = (w: WantV) => {
  const b = w.offers.find((o) => o.id === w.bought);
  if (b) return b.state === 'arrived' ? `Arrived · ${shortShop(b.seller.name)} is paid` : b.state === 'shipped' ? `On its way from ${shortShop(b.seller.name)}` : `Bought from ${shortShop(b.seller.name)} · held until it arrives`;
  const open = w.offers.filter((o) => o.state === 'open' && !o.over);
  // Paid for and refunded (the shop couldn't send it): the money is back, and the want is open again while its date holds.
  const back = w.offers.find((o) => o.state === 'refunded');
  if (!open.length) return Date.parse(w.want.availabilityEnds) < Date.now() ? (back ? `Refunded by ${shortShop(back.seller.name)}` : 'Closed: no offers') : back ? `Refunded by ${shortShop(back.seller.name)} · open again` : 'Waiting for offers';
  return `${open.length} offer${open.length === 1 ? '' : 's'} · from ${money(open.map((o) => o.total).sort((a, b) => a.value - b.value)[0]!)}`;
};
/** A want needs the owner while an offer waits for a yes, or what they bought is on its way (their "It arrived" pays the shop). */
export const wantNeedsYou = (w: WantV) => { const b = w.offers.find((o) => o.id === w.bought); return !w.closed && (b ? b.state === 'shipped' : w.offers.some((o) => o.state === 'open' && !o.over)); };

export function WantRow({ w }: { w: WantV }) {
  return h('ion-item', { button: true, detail: false, lines: 'full', class: `chatrow want-row${wantNeedsYou(w) ? ' unread' : ''}`, onClick: () => push(`#want=${encodeURIComponent(w.want.id)}`) },
    h('div', { slot: 'start' }, h(Avatar, { name: w.want.name, iconName: 'search' })),
    h('ion-label', {},
      h('div', { class: 'row-top' }, h('h3', {}, w.want.name), h('span', { class: 'row-time' }, when(w.offers.at(-1)?.at ?? w.at))),
      h('p', { class: 'chatlast' }, wantState(w))));
}

/** One conversation, full screen: the messages as bubbles, who replies, and a reply bar. Tap the name for its details. */
export function ChatPage({ arg }: { arg: string }) {
  const list = useHouse<ListView>({ kind: 'list' });
  if (!list.data) return h(Page, { title: '', back: () => back('#chats'), backLabel: 'People' }, h(Failed, { error: list.error }));
  const chats = chatsOf(list.data.notes ?? []);
  const c = chats.find((x) => x.key === arg || x.keys.includes(arg) || x.notes.some((n) => n.id === arg));
  // A link to a chat that's gone (cleared, say): back to the list.
  if (!c) return h(Page, { title: 'Chat', back: () => back('#chats'), backLabel: 'People' }, h(Empty, { icon: 'chatbubble-outline', title: 'This chat isn\'t here any more', action: h('ion-button', { shape: 'round', onClick: () => back('#chats') }, 'Back to People') }));
  return h(ChatView, { c, all: chats, held: (list.data.suggestions ?? []).filter((x) => x.booking && x.note), ais: list.data.assistants ?? [] });
}

function ChatView({ c, all, held, ais }: { c: Chat; all: Chat[]; held: Note[]; ais: Assistant[] }) {
  const bump = useBump();
  const [mode, setMode] = useState(c.mode);
  const [info, setInfo] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ text: string; why: string } | null>(null);
  const [pick, setPick] = useState(false);
  const duty = useHouse<DutyLog>({ kind: 'panel.duty.log' });
  const live = (duty.data?.duties ?? []).filter(dutyLive), onDuty = live.length > 0;
  // The AI by its name where there is one to name (the one on duty, or the only one connected) and the name is short.
  const named = shortName(live[0]?.label ?? (ais.length === 1 ? ais[0]!.label : '')), ai = named && named.length <= 9 ? named : 'My AI';
  // The house hands a known person's chat to the owner's AI; with none connected nobody but the owner replies, and the
  // chat says that (round 18: a first-time owner answered a note and the header turned to "My AI replies").
  const hasAi = ais.length > 0;
  const end = useRef<HTMLDivElement>(null);
  const latest = c.notes[c.notes.length - 1]!;
  // Answering someone new makes them someone you know, and a chat with someone you know is your AI's while it's on duty:
  // the house changed who replies here without a tap, so the chat says so, once, where the control is.
  const chose = useRef(c.mode), sent = useRef(false);
  useEffect(() => {
    if (c.canMode && hasAi && c.mode === 'ai' && chose.current === 'me' && sent.current) void toast(`You've answered ${c.name}, so ${ai} replies here while it's on duty.`, { duration: 8000, buttons: [{ text: 'I reply', handler: () => setTo('me') }] });
    chose.current = c.mode; setMode(c.mode);
  }, [c.mode]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [c.notes.length, sending]);
  // Open is seen: its badge goes (the house keeps how far you read, for every device).
  useEffect(() => {
    for (const k of c.keys) {
      const at = c.notes.filter((n) => chatKeyOf(n) === k).at(-1)!.at;
      if ((seen.at[k] ?? '') < at) { seen.at = { ...seen.at, [k]: at }; void call({ kind: 'panel.chat.seen', key: k, at }).then(bump); }
    }
  }, [c.notes.length]);
  const setTo = async (m: 'ai' | 'me') => { setMode(m); chose.current = m; try { for (const k of c.keys) await must({ kind: 'panel.chat.mode', key: k, mode: m }); void toast(m === 'ai' ? `${ai} replies to ${c.name} now` : 'You reply from now on'); } catch (e) { setMode(c.mode); void toast((e as Error).message, { color: 'danger' }); } bump(); };
  const send = async (again?: string) => {
    const t = (again ?? draft).trim(); if (!t) return;
    // Shown at once, sending; then the house's answer redraws it as sent, or it stays, not sent, with Retry.
    setSending(t); setFailed(null); if (!again) setDraft('');
    try { await must({ kind: 'panel.note.reply', id: latest.id, text: t }); sent.current = true; } catch (e) { setFailed({ text: t, why: e instanceof TypeError ? 'your house can\'t be reached right now' : (e as Error).message.replace(/\.$/, '') }); }
    setSending(null); bump();
  };
  // What your AI sent on duty can be taken back from its bubble while the night's log has it: the house names the entry.
  const entryOf = (n: DoorNote): DutyEntry | undefined => (n.answered?.entry ? (duty.data?.entries ?? []).find((e) => e.id === n.answered!.entry && e.undo && !e.undone) : undefined);
  const undo = async (e: DutyEntry) => {
    try { await must({ kind: 'panel.duty.undo', entry: e.id }); setMode('me'); chose.current = 'me'; void toast(`Taken back. ${c.name} is told to set it aside, and you reply from now on.`, { duration: 6000 }); } catch (x) { void toast((x as Error).message, { color: 'danger' }); }
    bump();
  };
  let lastDay = '';
  const bubbles = c.notes.flatMap((n) => {
    const d = day(n.at), divider = d !== lastDay ? ((lastDay = d), h('div', { key: `d-${n.id}`, class: 'daydiv' }, d)) : null;
    return [divider,
      h('div', { key: n.id, class: `bubble them${focusNote() === n.id ? ' lit' : ''}` }, h('p', {}, n.text), h('time', {}, time(n.at))),
      // What your AI said here and you took back stays, struck through: they did read it.
      n.retracted ? h('div', { key: `${n.id}-r`, class: 'bubble ai undone' }, h('span', { class: 'who' }, h('ion-icon', { name: 'sparkles' }), ` ${shortName(n.retracted.by)}, your AI`), h('p', {}, n.retracted.text),
        h('div', { class: 'bubble-foot' }, h('span', { class: 'took-back' }, 'Taken back'), h('time', {}, time(n.retracted.at)))) : null,
      n.answered ? ((e) => h('div', { key: `${n.id}-a`, class: `bubble ${n.answered!.by === 'you' ? 'me' : n.answered!.fixed ? 'ai house' : 'ai'}` },
        // Whose words: yours, your AI's by its name, or your house's own (a held time is told in fixed words).
        n.answered!.by === 'you' ? (n.answered!.fixed ? h('span', { class: 'who' }, h('ion-icon', { name: 'home-outline' }), ' Your house, on your answer') : null)
          : n.answered!.fixed ? h('span', { class: 'who' }, h('ion-icon', { name: 'home-outline' }), ` Your house, for ${shortName(n.answered!.by)}`)
            : h('span', { class: 'who' }, h('ion-icon', { name: 'sparkles' }), ` ${shortName(n.answered!.by)}, your AI`),
        h('p', {}, n.answered!.text),
        h('div', { class: 'bubble-foot' },
          e ? h('button', { type: 'button', class: 'link-btn bubble-undo', onClick: () => void undo(e) }, 'Undo') : null,
          n.answered!.at ? h('time', {}, time(n.answered!.at)) : null)))(entryOf(n)) : null,
      // A time your AI pencilled in while answering this: yours to confirm, here as on Today.
      ...held.filter((x) => x.note === n.id).map((x) => h('div', { key: `${n.id}-h`, class: 'chat-card' }, h(SuggestionCard, { x })))];
  });
  const titleNode = h('ion-title', {}, h('button', { type: 'button', class: 'chatwho', onClick: () => setInfo(true), 'aria-label': `About ${c.name}` },
    h(Avatar, { name: c.name, ring: c.trust, size: 34 }), h('span', { class: 'chatwho-text' }, h('b', {}, c.name), h('small', {}, c.via))));
  // Who replies: one control, at the top, saying who does now.
  const shown: 'ai' | 'me' = mode === 'ai' && !hasAi ? 'me' : mode;
  const who = c.canMode ? h('button', { type: 'button', class: `replymode ${shown}`, onClick: () => setPick(true), 'aria-label': `Who replies: ${shown === 'ai' ? `${ai} replies` : 'I reply'}. Change`, 'aria-haspopup': 'dialog' },
    // Beside the name there's room for a dozen letters: a longer AI name stands alone, with its mark.
    shown === 'ai' ? h('ion-icon', { name: 'sparkles' }) : null, h('span', {}, shown !== 'ai' ? 'I reply' : ai.length <= 5 ? `${ai} replies` : ai), h('ion-icon', { name: 'chevron-down' })) : null;
  // What the other choice gives an AI, said before it's chosen: this chat's words and the answering, never where a web sender asked to be answered.
  const aiNote = !hasAi ? 'No AI is connected yet. Tap to connect one in My AI.'
    : c.web ? `An AI you've connected can read this chat and answer it.${c.replyTo ? ` It doesn't get the ${c.replyTo.kind === 'email' ? 'email address' : 'phone number'} they left.` : ''}` : onDuty ? 'It answers while it\'s on duty. A time it only holds, for you to confirm.' : 'It answers once it\'s on duty, which is off now (My AI).';
  const opt = (m: 'ai' | 'me', icon: string, label: string, sub: string) => h('ion-item', { key: m, button: true, detail: false, lines: m === 'me' ? 'full' : 'none', class: `mode-opt${shown === m ? ' on' : ''}`, 'aria-current': shown === m ? 'true' : undefined, onClick: () => { setPick(false); if (m === 'ai' && !hasAi) push('#ai'); else if (shown !== m) void setTo(m); } },
    h('ion-icon', { slot: 'start', name: icon }), h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, label), h('p', {}, sub)), shown === m ? h('ion-icon', { slot: 'end', name: 'checkmark', color: 'primary', 'aria-label': 'Chosen' }) : null);
  const composer = h('div', { class: 'composer' },
    // Handed to an AI that isn't answering now: said where you'd type, so the chat doesn't sit unanswered unnoticed.
    c.canMode && shown === 'ai' && !c.web && !onDuty ? h('p', { class: 'mode-note' }, `${ai} replies once it's on duty (My AI). Until then, messages here wait.`) : null,
    h('div', { class: 'composer-row' },
      h('ion-textarea', { value: draft, autoGrow: true, rows: 1, placeholder: c.forwarded ? 'Passed on by your AI' : 'Message', 'aria-label': 'Message', disabled: !!c.forwarded, class: 'composer-input', onionInput: (e: CustomEvent) => setDraft(String(e.detail.value ?? '')) }),
      h('ion-button', { shape: 'round', class: 'send-btn', disabled: !draft.trim() || !!sending, onClick: () => void send(), 'aria-label': 'Send' }, h('ion-icon', { name: 'arrow-up', slot: 'icon-only' }))));
  return h(Page, { title: c.name, titleNode, back: () => back('#chats'), cls: `chat-page${who ? ' has-mode' : ''}`, footer: composer, end: who },
    h(NewStrip, { c, latest }),
    h('div', { class: 'bubbles' }, ...bubbles,
      sending ? h('div', { class: 'bubble me sending' }, h('p', {}, sending), h('time', {}, h('ion-spinner', { name: 'dots' }))) : null,
      failed && !sending ? h('div', { class: 'bubble me failed', role: 'alert' }, h('p', {}, failed.text),
        h('small', { class: 'why' }, `Not sent: ${failed.why}.`),
        h('div', { class: 'bubble-foot' }, h('button', { type: 'button', class: 'link-btn', onClick: () => void send(failed.text) }, 'Retry'), h('button', { type: 'button', class: 'link-btn', onClick: () => { setDraft(failed.text); setFailed(null); } }, 'Edit'))) : null,
      h('div', { ref: end })),
    h(Sheet, { open: pick, onClose: () => setPick(false), title: `Who replies to ${c.name}?`, short: true },
      h(Section, {}, opt('me', 'person-outline', 'I reply', hasAi ? 'Their messages wait for you. Your AI doesn\'t get their words.' : 'Their messages wait for you.'), opt('ai', 'sparkles-outline', `${ai} replies`, aiNote))),
    h(Sheet, { open: info, onClose: () => setInfo(false), title: c.name }, h(ChatInfo, { c, all, who: shown === 'ai' ? `${ai} replies` : 'You reply', change: () => { setInfo(false); setPick(true); }, latest, close: () => setInfo(false) })));
}

/**
 * On top of a new person's chat: that they're new and whether your door note went to them, and the ways out. A new key
 * that gives a known name says so, with "This is Alex" for when it really is them (a new phone, another AI app).
 */
function NewStrip({ c, latest }: { c: Chat; latest: DoorNote }) {
  const bump = useBump();
  if (c.trust === 'known') return null;
  const twin = c.trust === 'lookalike' ? c.twin : undefined, name = shortName(twin?.name ?? '');
  const mute = latest.from.key ? h(Btn, { key: 'mute', label: 'Mute', fill: 'outline', color: 'medium', size: 'small', run: async () => { await must({ kind: 'panel.note.mute', id: latest.id }); void toast(`${c.name} muted`); back('#chats'); }, ask: { header: 'Mute this sender?', sub: 'Their messages are turned away.', button: 'Mute' } }) : null;
  if (c.trust === 'lookalike') return h('div', { class: 'newstrip threat', role: 'note' },
    h('p', {}, h('b', {}, `Says they're ${name || c.name}, with a different key.`), ' A new phone or AI app does that; so does someone pretending.'),
    h('div', { class: 'newstrip-acts' },
      twin && latest.from.key ? h(Btn, { key: 'same', label: `This is ${name}`, fill: 'outline', size: 'small', cls: 'same-person',
        run: async () => { await must({ kind: 'panel.person.same', key: latest.from.key, as: twin.key }); void toast(`Filed with ${name}`); bump(); },
        ask: { header: `File this with ${name}?`, sub: `These messages join ${name}'s chat, and your AI answers them as it answers ${name}. Do it only if you're sure, for example they told you in person.`, button: `This is ${name}`, destructive: false } }) : null,
      mute));
  return h('div', { class: 'newstrip', role: 'note' },
    c.replyTo ? h('p', { class: 'reach' }, `Left ${c.replyTo.kind === 'email' ? 'an email address' : 'a phone number'} for your answer: `, h(ReachLinks, { r: c.replyTo })) : null,
    h('p', {}, c.web ? 'New, from your public page. Nothing is checked about who wrote it.' : `New.${c.doorNote ? ` Got your door note ${when(c.doorNote)}.` : ''} The key is checked; the name is the one their AI gives.`),
    mute ? h('div', { class: 'newstrip-acts' }, mute) : null);
}

/** Where a web sender asked to be answered, as links the phone opens: its own mail app, dialler or messages. */
function ReachLinks({ r, plain }: { r: NonNullable<Chat['replyTo']>; plain?: boolean }) {
  const a = (href: string, label: string) => h('a', { class: 'link-btn reach-link', href, rel: 'noreferrer' }, label);
  return h('span', { class: 'reach-links' }, plain ? null : h('b', {}, r.value), ' ',
    ...(r.kind === 'email' ? [a(`mailto:${encodeURIComponent(r.value).replace('%40', '@')}`, 'Email')] : [a(`tel:${r.value}`, 'Call'), ' ', a(`sms:${r.value}`, 'Text')]));
}

/** About a conversation (a tap on its name): what's checked and what isn't, who replies, mute and clear. */
function ChatInfo({ c, all, who, change, latest, close }: { c: Chat; all: Chat[]; who: string; change: () => void; latest: DoorNote; close: () => void }) {
  const bump = useBump();
  const f = latest.from;
  const namesakes = all.filter((x) => x.key !== c.key && x.name.toLowerCase() === c.name.toLowerCase());
  return h('div', { class: 'chatinfo' },
    h('div', { class: 'bigwho' }, h(Avatar, { name: c.name, ring: c.trust, size: 76 }), trustPill(c)),
    h(Section, {},
      c.web ? h(Row, { icon: 'globe-outline', tint: 'muted', label: 'From your public page', sub: 'Nothing checked about who wrote it' })
        : h(Row, { icon: 'shield-checkmark-outline', label: `${c.agent}${c.vendor ? ` · ${c.vendor}` : ''}`, sub: 'Its key is checked on every message' }),
      c.name !== c.agent && !c.web ? h(Row, { icon: 'person-outline', tint: 'amber', label: `"${c.name}"`, sub: 'The name its AI gives. Not checked.' }) : null,
      c.replyTo ? h(Row, { icon: c.replyTo.kind === 'email' ? 'mail-outline' : 'call-outline', tint: 'muted', label: c.replyTo.value, sub: 'Where they asked to be answered. Not checked; your AI doesn\'t get it.', cls: 'reach-row', below: h(ReachLinks, { r: c.replyTo, plain: true }) }) : null,
      f.speaks_for ? h(Row, { icon: 'home-outline', label: 'Speaks for a house', sub: `${f.speaks_for.house}${f.speaks_for.checked ? ' (checked)' : ' (not checked)'}` }) : null,
      h(Row, { icon: c.trust === 'known' ? 'checkmark-circle-outline' : 'sparkles-outline', tint: c.trust === 'known' ? 'mint' : 'amber', label: c.trust === 'known' ? 'Known' : c.trust === 'lookalike' ? 'Careful' : 'New', sub: c.trust === 'known' ? (c.why ?? 'You\'ve answered before') : c.trust === 'lookalike' ? (c.why ?? 'A name like someone you know') : 'Becomes known once you answer' }),
      c.keys.length > 1 ? h(Row, { icon: 'link-outline', label: `Writes with ${c.keys.length} keys`, sub: 'You said they\'re the same person', cls: 'joined',
        below: h(Btn, { label: 'Separate them', size: 'small', fill: 'outline', color: 'medium', run: async () => { for (const k of c.keys) if (k !== c.key) await must({ kind: 'panel.person.same', key: k, as: '' }); close(); bump(); }, done: 'Separated' }) }) : null,
      namesakes.length ? h(Row, { icon: 'people-outline', tint: 'amber', label: `Also called ${c.name}`, sub: `${namesakes.length} other chat${namesakes.length === 1 ? '' : 's'}, through ${namesakes.map((x) => x.agent).join(', ')}: maybe not the same person` }) : null),
    c.canMode ? h(Section, {}, h(Row, { icon: 'chatbubbles-outline', label: 'Who replies', sub: who, onClick: change, cls: 'who-replies' })) : null,
    h(Section, {},
      h('ion-item', { button: true, detail: false, onClick: async () => { if (!(await confirmMute())) return; await call({ kind: 'panel.note.mute', id: latest.id }); close(); void toast(`${c.name} muted`); back('#chats'); } }, h('ion-icon', { name: 'notifications-off-outline', slot: 'start' }), h('ion-label', {}, 'Mute')),
      h('ion-item', { button: true, detail: false, class: 'danger', onClick: async () => { close(); await clearChats([c], bump, 'Chat cleared').catch((e: Error) => void toast(e.message, { color: 'danger' })); back('#chats'); } }, h('ion-icon', { name: 'trash-outline', slot: 'start', color: 'danger' }), h('ion-label', { color: 'danger' }, 'Clear chat'))),
    f.key ? h(Info, {}, h('p', {}, 'Its key: ', h('code', {}, f.key))) : null);
}
const confirmMute = () => confirm({ header: 'Mute this sender?', sub: 'Their messages are turned away.', button: 'Mute' });

/** One want, full screen: what it says, then the offers, cheapest first; once bought, how it's going. */
export function WantPage({ arg }: { arg: string }) {
  const list = useHouse<ListView>({ kind: 'list' });
  const addr = useHouse<{ address: Address | null }>({ kind: 'panel.address' });
  const w = list.data?.wants?.find((x) => x.want.id === arg && !x.closed);
  if (!w) return h(Page, { title: 'Looking for', back: () => back('#inbox'), backLabel: 'Today' }, list.data ? h(Empty, { icon: 'search-outline', title: 'Not looking for this any more' }) : h(Failed, { error: list.error }));
  const bought = w.offers.find((o) => o.id === w.bought);
  const open = w.offers.filter((o) => o.state === 'open').sort((a, b) => a.total.value - b.total.value);
  const refunded = w.offers.find((o) => o.state === 'refunded');
  const fits = open.filter((o) => !o.over), over = open.filter((o) => o.over);
  const buy = (o: WantOfferV) => async () => {
    const d = await must<{ id: string; draft: Record<string, unknown> }>({ kind: 'panel.want.draft', want: w.want.id, offer: o.id });
    await must({ kind: 'panel.want.buy', draft: d.id, credential: await signDraft(d.draft) });
  };
  const card = (o: WantOfferV, canBuy: boolean) => {
    const del = o.items.find((i) => /^Delivery\b/.test(i.label));
    const miss = o.matched ? w.want.itemOffered.additionalProperty.map((p) => p.name).filter((n) => !o.matched!.includes(n)) : [];
    return h('ion-card', { key: o.id, class: `lake-card offer${o.id === w.bought ? ' bought' : ''}` }, h('ion-card-content', {},
      h('div', { class: 'offer-head' }, h('h3', { class: 'offer-shop' }, shortShop(o.seller.name)), h('b', { class: 'offer-total' }, money(o.total))),
      ...o.items.filter((i) => i !== del).map((i) => h('p', { key: i.label, class: 'offer-item' }, i.label.replace(/^1 × /, ''))),
      h('div', { class: 'offer-tags' }, h(Pill, { text: `${o.delivery ?? 'delivery not said'}${del ? ` · ${money(del.amount)}` : ''}`, tone: 'muted' }),
        o.matched?.length ? h(Pill, { text: `Matches ${o.matched.length}/${w.want.itemOffered.additionalProperty.length}`, tone: 'mint' }) : null),
      o.matched ? h('p', { class: 'offer-match' }, `Matches: ${o.matched.join(', ') || 'none'}`) : null,
      miss.length ? h('p', { class: 'offer-miss' }, `Not confirmed: ${miss.join(', ')}`) : null,
      o.note ? h('p', { class: 'offer-note' }, `“${o.note}”`) : null,
      canBuy ? (addr.data?.address
        ? h(Btn, { label: `Buy for ${money(o.total)}`, expand: 'block', run: buy(o), ask: { header: `Pay ${money(o.total)} to ${shortShop(o.seller.name)}?`, sub: `Your house pays; the money is held until you say it arrived. ${shortShop(o.seller.name)} gets your address: ${addressLine(addr.data.address)}.`, button: `Pay ${money(o.total)}`, destructive: false }, done: 'Paid, held until it arrives' })
        : h('ion-button', { expand: 'block', shape: 'round', fill: 'outline', onClick: () => push('#address') }, h('ion-icon', { name: 'home-outline', slot: 'start' }), 'Add your delivery address to buy')) : null));
  };
  return h(Page, { title: w.want.name, back: () => back('#inbox'), backLabel: 'Today', cls: 'want-page' },
    h('ion-card', { class: 'lake-card spec-card' }, h('ion-card-content', {},
      h('div', { class: 'spec-head' }, h(Avatar, { name: w.want.name, iconName: 'search', size: 40 }), h('div', {}, h('h2', {}, w.want.name), h('p', {}, bought ? 'What you asked for' : `Open until ${day(w.want.availabilityEnds)}`))),
      w.want.description ? h('p', { class: 'spec-desc' }, w.want.description) : null,
      h('div', { class: 'spec-chips' }, ...w.want.itemOffered.additionalProperty.map((p) => h('span', { key: p.name, class: 'field-tag' }, h('span', { class: 'tag-k' }, `${p.name} `), p.value))),
      h('p', { class: 'spec-limit' }, [addr.data?.address ? `To ${addressLine(addr.data.address)}` : w.want.areaServed ? `To ${w.want.areaServed}` : '', w.limit ? `Most you'd pay: ${money({ currency: w.limit.currency, value: w.limit.amount })} (only your house knows)` : ''].filter(Boolean).join(' · ')))),
    bought ? [
      h('h3', { class: 'section-h', key: 'bh' }, bought.state === 'arrived' ? 'Arrived' : bought.state === 'shipped' ? 'On its way' : 'Bought'),
      card(bought, false),
      h('p', { class: 'muted-line pad', key: 'bs' }, bought.state === 'arrived' ? `${shortShop(bought.seller.name)} is paid${bought.ended ? `: ${bought.ended}` : ''}.` : bought.shipped ? `${shortShop(bought.seller.name)}: “${bought.shipped.note}”` : `Paid by your house, held until you say it arrived.`),
      bought.state === 'shipped' ? h('div', { class: 'pad', key: 'arr' }, h(Btn, { label: 'It arrived', icon: 'checkmark', expand: 'block', run: () => must({ kind: 'panel.want.arrived', want: w.want.id }), done: `${shortShop(bought.seller.name)} is paid` })) : null,
    ] : [
      refunded ? h('p', { class: 'muted-line pad', key: 'rf' }, `Your ${money(refunded.total)} came back from ${shortShop(refunded.seller.name)}${refunded.ended ? `: ${refunded.ended}` : ''}.`) : null,
      h('h3', { class: 'section-h', key: 'oh' }, fits.length ? `Offers (${fits.length})` : 'Offers'),
      fits.length ? fits.map((o) => card(o, true)) : over.length ? h('p', { class: 'muted-line pad', key: 'none' }, `None within the most you'd pay yet. Shops look every few minutes.`)
        : h(Empty, { key: 'none', icon: 'hourglass-outline', title: 'No offers yet', text: 'Shops look every few minutes. You get a notification when one offers.' }),
      over.length ? h('ion-accordion-group', { key: 'over', class: 'lake-accordion' }, h('ion-accordion', { value: 'over' }, h('ion-item', { slot: 'header' }, h('ion-label', {}, `${over.length} over the most you'd pay`)), h('div', { slot: 'content' }, ...over.map((o) => card(o, true))))) : null,
      h('div', { class: 'pad', key: 'stop' }, h(Btn, { label: 'Stop looking', fill: 'clear', color: 'medium', expand: 'block', run: async () => { await must({ kind: 'panel.want.close', id: w.want.id }); back('#inbox'); }, ask: { header: 'Stop looking?', sub: 'Shops stop offering.', button: 'Stop looking' } })),
    ]);
}

/** How many chats have something new, for the tab's badge. */
export const unreadChats = (v?: ListView) => (v ? unseen(v.notes ?? [], { ...(v.seen ?? {}), ...seen.at }) : 0);

/**
 * A new house: what it is, what it promises, and the one thing to do first (ChatGPT, round 3: a newcomer didn't get it).
 * On Today, where the app opens, until there's a handle: nobody can reach the owner before that.
 */
export function WelcomeCard({ door }: { door?: DoorState }) {
  if (!door || door.error || door.handle) return null;
  return h('ion-card', { class: 'lake-card hero-card welcome-card' }, h('ion-card-content', {},
    h('h2', {}, 'Welcome to your house'),
    h('p', {}, 'Your own place online. People\'s AIs reach you here, and companies ask before they use anything of yours.'),
    h('ul', { class: 'welcome-points' },
      h('li', {}, h('ion-icon', { name: 'hand-left-outline' }), 'You decide what\'s shared'),
      h('li', {}, h('ion-icon', { name: 'eye-off-outline' }), 'You can take anything back'),
      h('li', {}, h('ion-icon', { name: 'shield-checkmark-outline' }), 'No AI can overrule your rules')),
    h('ion-button', { expand: 'block', onClick: () => push('#door') }, 'Pick your handle'),
    h('p', { class: 'muted-line' }, 'Then anyone can ask their AI to ping you.')));
}
