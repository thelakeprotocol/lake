import { useEffect, useRef, useState } from 'preact/hooks';
import { call, must, useBump, useHouse } from './api';
import { Avatar, Btn, Child, CopyBtn, Empty, Failed, Info, Page, Pill, Row, Section, Sheet, confirm, h, toast } from './ion';
import { addressLine, chatKeyOf, chatsOf, day, dutyLive, money, peopleOf, plural, seen, shortName, shortShop, signDraft, stale, time, unseen, when, type Address, type Assistant, type Chat, type DoorNote, type DutyEntry, type DoorState, type DutyLog, type ListView, type Note, type TaskV, type WantOfferV, type WantV } from './logic';
import { back, focusNote, push } from './nav';
import { SuggestionCard } from './inbox';
import { TellSheet } from './tasks';

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
  const { known, fresh } = peopleOf(data ? chatsOf(data.notes ?? [], data.assistants ?? []) : []);
  const old = stale(fresh);
  const more = fresh.length > FEW;
  return h(Page, { title: 'People', big: true, status, footer: tabbar },
    !data ? h(Failed, { error: list.error }) : [
      // Two chats under one name are told apart by the AI each wrote through (21 Nov: People listed "Alex" three times).
      known.length ? h(Section, { title: 'People you know', key: 'known', cls: 'chat-list people-known' }, ...known.map((c) => h(ChatRow, { key: c.key, c, twin: known.filter((x) => x.name === c.name).length > 1 }))) : null,
      fresh.length ? h(Section, { title: `New people · ${fresh.length}`, key: 'new', cls: 'chat-list people-new' },
        ...(all ? fresh : fresh.slice(0, FEW)).map((c) => h(ChatRow, { key: c.key, c })),
        more || old.length ? h('div', { class: 'people-more', key: 'more' },
          more ? h('ion-button', { fill: 'clear', size: 'small', class: 'show-all', onClick: () => setAll(!all) }, all ? 'Show fewer' : `Show all ${fresh.length}`) : null,
          old.length ? h(Btn, { label: `Clear ${old.length} old ${old.length === 1 ? 'chat' : 'chats'} (quiet for a week)`, fill: 'clear', color: 'medium', size: 'small', cls: 'clear-old', run: () => clearChats(old, bump) })
            : more && all ? h(Btn, { label: `Clear all ${fresh.length}`, fill: 'clear', color: 'medium', size: 'small', cls: 'clear-new', run: () => clearChats(fresh, bump) }) : null) : null) : null,
      h(Blocked, { key: 'blocked' }),
      known.length || fresh.length ? null
        : h(Empty, { key: 'empty', icon: 'people-outline', title: 'Nobody has written yet', text: door.data?.handle ? `People reach you by asking their AI to ping ${door.data.handle}.` : 'Pick a handle, and anyone\'s AI can reach you.', action: h('ion-button', { shape: 'round', fill: 'outline', onClick: () => push('#door') }, door.data?.handle ? 'Share your handle' : 'Pick your handle') }),
    ]);
}

/** A lookalike's line in the list: calm when the new key writes from the same house, careful when not. */
const twinLine = (name: string, sameHouse?: boolean) => sameHouse === true ? `Says they're ${name}: new key, same house as before` : sameHouse === false ? `Says they're ${name}, from a different house: careful` : `Says they're ${name}, with a different key`;

function ChatRow({ c, twin }: { c: Chat; twin?: boolean }) {
  const ai = c.lastBy === 'ai' ? shortName(c.notes.at(-1)?.answered?.by ?? '') || 'Your AI' : '';
  return h('ion-item', { button: true, detail: false, lines: 'full', class: `chatrow${c.unread ? ' unread' : ''}`, onClick: () => push(`#chat=${encodeURIComponent(c.key)}`) },
    h('div', { slot: 'start' }, h(Avatar, { name: c.name, ring: c.trust === 'lookalike' ? 'lookalike' : undefined })),
    h('ion-label', {},
      h('div', { class: 'row-top' }, h('h3', {}, c.name), h('span', { class: 'row-time' }, when(c.at))),
      c.trust === 'lookalike' ? h('div', { class: `row-via${c.twin?.sameHouse ? '' : ' careful'}` }, twinLine(shortName(c.twin?.name ?? c.name), c.twin?.sameHouse)) : null,
      c.toAi ? h('div', { class: 'row-via to-ai' }, h('ion-icon', { name: 'sparkles-outline' }), c.via) : null,
      twin && !c.toAi && c.trust !== 'lookalike' && c.agent ? h('div', { class: 'row-via' }, `Through ${shortName(c.agent)}`) : null,
      // What a new sender is, before it's opened (round 84: "Visitor from early.example: a person, a bot, spam?").
      !c.toAi && c.trust === 'new' ? h('div', { class: 'row-via' }, c.via) : null,
      h('div', { class: 'row-last' }, h('p', { class: 'chatlast' }, c.lastBy === 'you' ? 'You: ' : ai ? `${ai}: ` : '', c.last), c.unread ? h('ion-badge', { color: 'primary', class: 'unread-badge' }, String(c.unread)) : null)));
}

const wantState = (w: WantV) => {
  const b = w.offers.find((o) => o.id === w.bought);
  if (b) return b.state === 'arrived' ? `Arrived · ${shortShop(b.seller.name)} is paid` : b.problem ? `You reported a problem · waiting for ${shortShop(b.seller.name)}` : b.state === 'shipped' ? `${b.shipped?.again ? 'Sent again by' : 'On its way from'} ${shortShop(b.seller.name)}` : `Bought from ${shortShop(b.seller.name)} · held until it arrives`;
  const open = w.offers.filter((o) => o.state === 'open' && !o.over && !ranOut(o));
  // Paid for and refunded (the shop couldn't send it): the money is back, and the want is open again while its date holds.
  const back = w.offers.find((o) => o.state === 'refunded');
  if (!open.length) return Date.parse(w.want.availabilityEnds) < Date.now() ? (back ? `Refunded by ${shortShop(back.seller.name)}` : 'Closed: no offers') : back ? `Refunded by ${shortShop(back.seller.name)} · open again` : 'Waiting for offers';
  return `${open.length} offer${open.length === 1 ? '' : 's'} · from ${money(open.map((o) => o.total).sort((a, b) => a.value - b.value)[0]!)}`;
};
/** Replies through a shared link come first in the row's line while it's open: a person answered. */
const wantLine = (w: WantV) => {
  if (w.bought) return wantState(w);
  const people = (w.matches ?? []).filter((m) => m.state !== 'revealed').length;
  const lead = [people ? `${people} ${people === 1 ? 'person matches' : 'people match'}` : '', w.replies ? `${w.replies} repl${w.replies === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(' · ');
  // A want for someone's help has no shop offers to speak of.
  const forPeople = w.want.itemOffered['@type'] === 'Service';
  return lead ? (forPeople ? lead : `${lead} · ${wantState(w)}`) : forPeople ? 'Waiting for someone who matches' : wantState(w);
};
/** A shop's cart is good for a day or so: after that it can't be bought, until the shop sends it again. */
const ranOut = (o: WantOfferV) => Date.parse(o.expires) < Date.now();
/** A want needs the owner while an offer waits for a yes, or what they bought is on its way (their "It arrived" pays the shop). */
export const wantNeedsYou = (w: WantV) => { const b = w.offers.find((o) => o.id === w.bought); return !w.closed && (b ? b.state === 'shipped' : !!w.repliesWaiting || (w.matches ?? []).some((m) => m.state === 'open') || w.offers.some((o) => o.state === 'open' && !o.over && !ranOut(o))); };

export function WantRow({ w }: { w: WantV }) {
  return h('ion-item', { button: true, detail: false, lines: 'full', class: `chatrow want-row${wantNeedsYou(w) ? ' unread' : ''}`, onClick: () => push(`#want=${encodeURIComponent(w.want.id)}`) },
    h('div', { slot: 'start' }, h(Avatar, { name: w.want.name, iconName: 'search' })),
    h('ion-label', {},
      h('div', { class: 'row-top' }, h('h3', {}, w.want.name), h('span', { class: 'row-time' }, when(w.offers.at(-1)?.at ?? w.at))),
      h('p', { class: 'chatlast' }, wantLine(w))));
}

/** One conversation, full screen: the messages as bubbles, who replies, and a reply bar. Tap the name for its details. */
export function ChatPage({ arg }: { arg: string }) {
  const list = useHouse<ListView>({ kind: 'list' });
  if (!list.data) return h(Page, { title: '', back: () => back('#chats'), backLabel: 'People' }, h(Failed, { error: list.error }));
  const chats = chatsOf(list.data.notes ?? [], list.data.assistants ?? []);
  const c = chats.find((x) => x.key === arg || x.keys.includes(arg) || x.notes.some((n) => n.id === arg));
  // A link to a chat that's gone (cleared, say): back to the list.
  if (!c) return h(Page, { title: 'Chat', back: () => back('#chats'), backLabel: 'People' }, h(Empty, { icon: 'chatbubble-outline', title: 'This chat isn\'t here any more', action: h('ion-button', { shape: 'round', onClick: () => back('#chats') }, 'Back to People') }));
  return h(ChatView, { c, all: chats, held: (list.data.suggestions ?? []).filter((x) => x.booking && x.note), ais: list.data.assistants ?? [], task: (list.data.tasks ?? []).find((t) => t.state === 'open' && c.keys.includes(t.to.key)) });
}

function ChatView({ c, all, held, ais, task }: { c: Chat; all: Chat[]; held: Note[]; ais: Assistant[]; task?: TaskV }) {
  const bump = useBump();
  const [mode, setMode] = useState(c.mode);
  const [info, setInfo] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ text: string; why: string } | null>(null);
  const [pick, setPick] = useState(false);
  const [tell, setTell] = useState(false);
  const duty = useHouse<DutyLog>({ kind: 'panel.duty.log' });
  const live = (duty.data?.duties ?? []).filter(dutyLive), onDuty = live.length > 0;
  // The AI by its name where there is one to name (the one on duty, or the only one connected) and the name is short.
  // Someone who wrote to one of your AIs, at its own address: that AI is the one this chat is about, on duty or off.
  const theirs = c.toAi ? ais.find((q) => q.kid === c.toAi) : undefined;
  const named = shortName(c.toAi ? theirs?.label ?? '' : live[0]?.label ?? (ais.length === 1 ? ais[0]!.label : '')), ai = named && named.length <= 9 ? named : 'My AI';
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
  const setTo = async (m: 'ai' | 'me') => { setMode(m); chose.current = m; try { for (const k of c.keys) await must({ kind: 'panel.chat.mode', key: k, mode: m }); void toast(m === 'ai' ? `${ai} replies to ${c.name} now` : c.toAi ? `${ai} asks you first from now on` : 'You reply from now on'); } catch (e) { setMode(c.mode); void toast((e as Error).message, { color: 'danger' }); } bump(); };
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
      // What was answered here earlier (your AI may write twice under a task; your own answer isn't written over).
      ...(n.answered?.before ?? []).map((b, i) => h('div', { key: `${n.id}-b${i}`, class: `bubble ${b.by === 'you' ? 'me' : 'ai'}` },
        b.by === 'you' ? null : h('span', { class: 'who' }, h('ion-icon', { name: 'sparkles' }), ` ${shortName(b.by)}, ${b.task && n.from.via ? 'from its own address, as you asked' : `your AI${b.task ? ', as you asked' : ''}`}`),
        h('p', {}, b.text), h('div', { class: 'bubble-foot' }, h('time', {}, time(b.at))))),
      n.answered ? ((e) => h('div', { key: `${n.id}-a`, class: `bubble ${n.answered!.by === 'you' ? 'me' : n.answered!.fixed ? 'ai house' : 'ai'}` },
        // Whose words: yours, your AI's by its name, or your house's own (a held time is told in fixed words).
        n.answered!.by === 'you' ? (n.answered!.fixed ? h('span', { class: 'who' }, h('ion-icon', { name: 'home-outline' }), ' Your house, on your answer') : null)
          : n.answered!.fixed ? h('span', { class: 'who' }, h('ion-icon', { name: 'home-outline' }), ` Your house, for ${shortName(n.answered!.by)}`)
            : h('span', { class: 'who' }, h('ion-icon', { name: 'sparkles' }), ` ${shortName(n.answered!.by)}, ${n.answered!.task && n.from.via ? 'from its own address, as you asked' : `your AI${n.answered!.task ? ', as you asked' : ''}`}`),
        h('p', {}, n.answered!.text),
        h('div', { class: 'bubble-foot' },
          e ? h('button', { type: 'button', class: 'link-btn bubble-undo', onClick: () => void undo(e) }, 'Undo') : null,
          n.answered!.at ? h('time', {}, time(n.answered!.at)) : null)))(entryOf(n)) : null,
      // An answer your AI is sending from its own address: the house gave it the go, and hears back when it landed.
      ...(task?.did ?? []).filter((d) => d.pending && d.note === n.id).map((d, i) => h('div', { key: `${n.id}-p${i}`, class: 'bubble ai sending' }, h('span', { class: 'who' }, h('ion-icon', { name: 'sparkles' }), ` ${ai}, from its own address, as you asked`), h('p', {}, d.text), h('time', {}, h('ion-spinner', { name: 'dots' })))),
      // A time your AI pencilled in while answering this: yours to confirm, here as on Today.
      ...held.filter((x) => x.note === n.id).map((x) => h('div', { key: `${n.id}-h`, class: 'chat-card' }, h(SuggestionCard, { x })))];
  });
  const titleNode = h('ion-title', {}, h('button', { type: 'button', class: 'chatwho', onClick: () => setInfo(true), 'aria-label': `About ${c.name}` },
    h(Avatar, { name: c.name, ring: c.trust, size: 34 }), h('span', { class: 'chatwho-text' }, h('b', {}, c.name), h('small', {}, c.via))));
  // Who replies: one control, at the top, saying who does now.
  const shown: 'ai' | 'me' = mode === 'ai' && !hasAi ? 'me' : mode;
  const who = c.canMode ? h('button', { type: 'button', class: `replymode ${shown}`, onClick: () => setPick(true), 'aria-label': `Who replies: ${shown === 'ai' ? `${ai} replies` : c.toAi ? `${ai} asks me first` : 'I reply'}. Change`, 'aria-haspopup': 'dialog' },
    // Beside the name there's room for a dozen letters: a longer AI name stands alone, with its mark.
    shown === 'ai' ? h('ion-icon', { name: 'sparkles' }) : null, h('span', {}, shown !== 'ai' ? (c.toAi ? 'Ask me first' : 'I reply') : ai.length <= 5 ? `${ai} replies` : ai), h('ion-icon', { name: 'chevron-down' })) : null;
  // What the other choice gives an AI, said before it's chosen: this chat's words and the answering, never where a web sender asked to be answered.
  const aiNote = c.toAi ? `It answers from its own address ${onDuty ? 'while it\'s on duty' : 'once it\'s on duty, which is off now (My AI)'}, and doesn't name your house.`
    : !hasAi ? 'No AI is connected yet. Tap to connect one in My AI.'
    : c.web ? `An AI you've connected can read this chat and answer it.${c.replyTo ? ` It doesn't get the ${c.replyTo.kind === 'email' ? 'email address' : 'phone number'} they left.` : ''}` : onDuty ? 'It answers while it\'s on duty. A time it only holds, for you to confirm.' : 'It answers once it\'s on duty, which is off now (My AI).';
  const opt = (m: 'ai' | 'me', icon: string, label: string, sub: string) => h('ion-item', { key: m, button: true, detail: false, lines: m === 'me' ? 'full' : 'none', class: `mode-opt${shown === m ? ' on' : ''}`, 'aria-current': shown === m ? 'true' : undefined, onClick: () => { setPick(false); if (m === 'ai' && !hasAi) push('#ai'); else if (shown !== m) void setTo(m); } },
    h('ion-icon', { slot: 'start', name: icon }), h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, label), h('p', {}, sub)), shown === m ? h('ion-icon', { slot: 'end', name: 'checkmark', color: 'primary', 'aria-label': 'Chosen' }) : null);
  const composer = h('div', { class: 'composer' },
    // Handed to an AI that isn't answering now: said where you'd type, so the chat doesn't sit unanswered unnoticed.
    // An instruction of yours is open here: said where you'd type (typing your own answer ends it).
    task ? h('p', { class: 'mode-note task-note' }, h('ion-icon', { name: 'sparkles' }), ` ${shortName(task.label)} is on it: “${task.text.length > 60 ? `${task.text.slice(0, 58)}…` : task.text}” `,
      h('button', { type: 'button', class: 'link-btn', onClick: async () => { try { await must({ kind: 'panel.task.stop', id: task.id }); void toast('Taken back'); } catch (e) { void toast((e as Error).message, { color: 'danger' }); } bump(); } }, 'Take it back'))
      : c.canMode && shown === 'ai' && !c.web && !onDuty ? h('p', { class: 'mode-note' }, `${ai} isn't on duty, so it won't answer here yet: set that up in My AI, or type your own answer below.`) : null,
    // They wrote to your AI and don't know your house: an answer from here would tell them where it is, so there is
    // nothing to type into. What's said to them is said by that AI, on your word.
    c.toAi ? h('div', { class: 'composer-row via-row' },
      h('p', { class: 'mode-note via-note' }, `${c.name} wrote to ${ai}, not to your house, so answers go from ${ai}.`),
      theirs && !task ? h('ion-button', { shape: 'round', class: 'lake-btn via-tell', onClick: () => setTell(true) }, h('ion-icon', { name: 'sparkles-outline', slot: 'start' }), `Tell ${ai === 'My AI' ? 'my AI' : ai} what to do`) : null)
    : h('div', { class: 'composer-row' },
      h('ion-textarea', { value: draft, autoGrow: true, rows: 1, placeholder: c.forwarded ? 'Passed on by your AI' : 'Message', 'aria-label': 'Message', disabled: !!c.forwarded, class: 'composer-input', onionInput: (e: CustomEvent) => setDraft(String(e.detail.value ?? '')) }),
      h('ion-button', { shape: 'round', class: 'send-btn', disabled: !draft.trim() || !!sending, onClick: () => void send(), 'aria-label': 'Send' }, h('ion-icon', { name: 'arrow-up', slot: 'icon-only' }))));
  return h(Page, { title: c.name, titleNode, back: () => back('#chats'), cls: `chat-page${who ? ' has-mode' : ''}`, footer: composer, end: who },
    c.toAi ? h('div', { class: 'newstrip via-strip', role: 'note' }, h('p', {}, h('b', {}, `Wrote to ${ai}, at its own address.`), ` ${ai === 'My AI' ? 'It' : ai} passed it on to you. They don't know where your house is.`)) : null,
    h(NewStrip, { c, latest }),
    h('div', { class: 'bubbles' }, ...bubbles,
      sending ? h('div', { class: 'bubble me sending' }, h('p', {}, sending), h('time', {}, h('ion-spinner', { name: 'dots' }))) : null,
      failed && !sending ? h('div', { class: 'bubble me failed', role: 'alert' }, h('p', {}, failed.text),
        h('small', { class: 'why' }, `Not sent: ${failed.why}.`),
        h('div', { class: 'bubble-foot' }, h('button', { type: 'button', class: 'link-btn', onClick: () => void send(failed.text) }, 'Retry'), h('button', { type: 'button', class: 'link-btn', onClick: () => { setDraft(failed.text); setFailed(null); } }, 'Edit'))) : null,
      h('div', { ref: end })),
    h(Sheet, { open: pick, onClose: () => setPick(false), title: `Who replies to ${c.name}?`, short: !hasAi || !!c.forwarded, half: hasAi && !c.forwarded },
      h(Section, {}, c.toAi ? opt('me', 'person-outline', 'Ask me first', `Their messages wait here until you tell ${ai === 'My AI' ? 'your AI' : ai} what to answer.`) : opt('me', 'person-outline', 'I reply', hasAi ? 'Their messages wait for you. Your AI doesn\'t get their words.' : 'Their messages wait for you.'), opt('ai', 'sparkles-outline', `${ai} replies`, aiNote)),
      // One instruction about this chat, in place of handing the whole chat over.
      hasAi && !c.forwarded ? h(Section, {}, h('ion-item', { button: true, detail: true, lines: 'none', class: 'mode-opt tell-opt', onClick: () => { setPick(false); setTell(true); } },
        h('ion-icon', { slot: 'start', name: 'create-outline' }), h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, `Tell ${ai === 'My AI' ? 'my AI' : ai} what to do`), h('p', {}, 'One instruction about this chat. It writes to them for you and reports back.')))) : null),
    h(TellSheet, { open: tell, onClose: () => setTell(false), note: latest.id }),
    h(Sheet, { open: info, onClose: () => setInfo(false), title: c.name }, h(ChatInfo, { c, all, who: shown === 'ai' ? `${ai} replies` : c.toAi ? `${ai} asks you first` : 'You reply', change: () => { setInfo(false); setPick(true); }, latest, close: () => setInfo(false) })));
}

/**
 * On top of a new person's chat: that they're new and whether your door note went to them, and the ways out. A new key
 * that gives a known name says so, with "This is Alex" for when it really is them (a new phone, another AI app).
 */
function NewStrip({ c, latest }: { c: Chat; latest: DoorNote }) {
  const bump = useBump();
  if (c.trust === 'known') return null;
  const twin = c.trust === 'lookalike' ? c.twin : undefined, name = shortName(twin?.name ?? '');
  // It turns them away at the door and tells them so: what messaging apps call Block, so it says Block (13 Nov).
  const mute = latest.from.key ? h(Btn, { key: 'mute', label: 'Block', fill: 'outline', color: 'medium', size: 'small', run: async () => { const r = await must<{ key?: string }>({ kind: 'panel.note.mute', id: latest.id }); blockedToast(c.name, r.key); back('#chats'); }, ask: blockAsk(c.name) }) : null;
  if (c.trust === 'lookalike') return h('div', { class: 'newstrip threat', role: 'note' },
    // What it is and what to do next (run 100: "the warning never tells me what to do next"); Grok's words, adapted.
    twin?.sameHouse === true ? h('p', {}, h('b', {}, `Says they're ${name}: a new key, from the same house as before.`), ' Most likely a new phone or AI app. Still check with them another way before you send an address, money or codes.')
      : twin?.sameHouse === false ? h('p', {}, h('b', {}, `Says they're ${name}, but writes from a different house.`), ` Don't send an address, money or codes here. Check with ${name} another way first.`)
      : h('p', {}, h('b', {}, `Says they're ${name || c.name}, with a different key.`), ' A new phone or AI app does that; so does someone pretending. Check with them another way before you send an address, money or codes.'),
    h('div', { class: 'newstrip-acts' },
      twin && latest.from.key ? h(Btn, { key: 'same', label: `This is ${name}`, fill: 'outline', size: 'small', cls: 'same-person',
        run: async () => { await must({ kind: 'panel.person.same', key: latest.from.key, as: twin.key }); void toast(`Filed with ${name}`); bump(); },
        ask: { header: `File this with ${name}?`, sub: `These messages join ${name}'s chat, and your AI answers them as it answers ${name}. Do it only if you're sure, for example they told you in person.`, button: `This is ${name}`, destructive: false } }) : null,
      mute));
  return h('div', { class: 'newstrip', role: 'note' },
    c.replyTo ? h('p', { class: 'reach' }, `Left ${c.replyTo.kind === 'email' ? 'an email address' : 'a phone number'} for your answer: `, h(ReachLinks, { r: c.replyTo })) : null,
    h('p', {}, c.web ? 'New, from your public page. Nothing is checked about who wrote it.' : `New: their AI wrote this for them.${c.doorNote ? ` They got your door note ${when(c.doorNote)}.` : ''} The message is signed, so it's the same sender each time; the name is only what their AI says, and nobody has checked it. They see nothing in your house. Type below and your answer goes to their AI, which passes it on; or Block.`),
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
      c.toAi ? h(Row, { icon: 'sparkles-outline', label: c.via, sub: 'At its own address, not at your house. Answers go from there, and they don\'t learn where your house is.', cls: 'wrote-to-ai' }) : null,
      c.name !== c.agent && !c.web ? h(Row, { icon: 'person-outline', tint: 'amber', label: `"${c.name}"`, sub: 'The name its AI gives. Not checked.' }) : null,
      c.replyTo ? h(Row, { icon: c.replyTo.kind === 'email' ? 'mail-outline' : 'call-outline', tint: 'muted', label: c.replyTo.value, sub: 'Where they asked to be answered. Not checked; your AI doesn\'t get it.', cls: 'reach-row', below: h(ReachLinks, { r: c.replyTo, plain: true }) }) : null,
      // The house's word is about the AI, never the name it gives (round 110: "Priya" sat over a real house's check).
      f.speaks_for ? h(Row, { icon: 'home-outline', label: f.speaks_for.checked ? 'Its AI is vouched for by a house' : 'Says it speaks for a house', sub: `${f.speaks_for.house}${f.speaks_for.checked ? ' (checked). The name it gives is not.' : ' (not checked)'}` }) : null,
      h(Row, { icon: c.trust === 'known' ? 'checkmark-circle-outline' : 'sparkles-outline', tint: c.trust === 'known' ? 'mint' : 'amber', label: c.trust === 'known' ? 'Known' : c.trust === 'lookalike' ? 'Careful' : 'New', sub: c.trust === 'known' ? (c.why ?? 'You\'ve answered before') : c.trust === 'lookalike' ? (c.why ?? 'A name like someone you know') : 'Becomes known once you answer' }),
      c.keys.length > 1 ? h(Row, { icon: 'link-outline', label: `Writes with ${c.keys.length} keys`, sub: 'You said they\'re the same person', cls: 'joined',
        below: h(Btn, { label: 'Separate them', size: 'small', fill: 'outline', color: 'medium', run: async () => { for (const k of c.keys) if (k !== c.key) await must({ kind: 'panel.person.same', key: k, as: '' }); close(); bump(); }, done: 'Separated' }) }) : null,
      namesakes.length ? h(Row, { icon: 'people-outline', tint: 'amber', label: `Also called ${c.name}`, sub: `${namesakes.length} other chat${namesakes.length === 1 ? '' : 's'}, through ${namesakes.map((x) => x.agent).join(', ')}: maybe not the same person` }) : null),
    c.canMode ? h(Section, {}, h(Row, { icon: 'chatbubbles-outline', label: 'Who replies', sub: who, onClick: change, cls: 'who-replies' })) : null,
    h(Section, {},
      h('ion-item', { button: true, detail: false, onClick: async () => { if (!(await confirm(blockAsk(c.name)))) return; let r: { key?: string }; try { r = await must<{ key?: string }>({ kind: 'panel.note.mute', id: latest.id }); } catch (e) { void toast(`Not done: ${(e as Error).message}`, { color: 'danger', duration: 8000, buttons: [{ text: 'OK', handler: () => {} }] }); return; } close(); blockedToast(c.name, r.key); back('#chats'); } }, h('ion-icon', { name: 'hand-left-outline', slot: 'start' }), h('ion-label', {}, 'Block')),
      h('ion-item', { button: true, detail: false, class: 'danger', onClick: async () => { close(); await clearChats([c], bump, 'Chat cleared').catch((e: Error) => void toast(e.message, { color: 'danger' })); back('#chats'); } }, h('ion-icon', { name: 'trash-outline', slot: 'start', color: 'danger' }), h('ion-label', { color: 'danger' }, 'Clear chat'))),
    f.key ? h(Info, {}, h('p', {}, 'Its key: ', h('code', {}, f.key))) : null);
}
export const blockAsk = (name?: string) => ({ header: `Block ${name || 'this sender'}?`, sub: 'Your house turns their messages away and tells them it doesn\'t take them. You can unblock them later, under People.', button: 'Block' });
/** Blocked, with Undo for a moment (run 104: Mia blocked the real Priya's AI and couldn't take it back). */
const blockedToast = (name: string, key?: string) => void toast(`${name} blocked`, key ? { buttons: [{ text: 'Undo', handler: () => { void call({ kind: 'panel.note.unmute', key }).then(() => toast(`${name} unblocked`)); } }] } : {});
/** Who this owner has blocked, by the name they wrote as, each with Unblock. */
function Blocked() {
  const b = useHouse<{ key: string; name: string; at?: string }[]>({ kind: 'panel.blocked' });
  const [open, setOpen] = useState(false);
  if (!b.data?.length) return null;
  return h('div', {}, h(Section, { cls: 'blocked-list' }, h(Row, { icon: 'hand-left-outline', tint: 'muted', label: `Blocked · ${b.data.length}`, sub: 'Their messages are turned away at your door', onClick: () => setOpen(true) })),
    h(Sheet, { open, onClose: () => setOpen(false), title: 'Blocked' }, h(Section, {}, ...b.data.map((x) => h('ion-item', { key: x.key, lines: 'full', class: 'lake-row blocked-row' },
      h('ion-label', {}, h('h3', {}, x.name), x.at ? h('p', {}, `Blocked ${when(x.at)}`) : null),
      h('div', { slot: 'end' }, h(Btn, { label: 'Unblock', size: 'small', fill: 'clear', run: () => must({ kind: 'panel.note.unmute', key: x.key }), done: `${x.name} can reach you again.` })))))));
}

/** One want, full screen: what it says, then the offers, cheapest first; once bought, how it's going. */
/** Someone who says they could help with a want for a person's help: which points, Say yes / Not this one, then who. */
function MatchCard({ w, m }: { w: WantV; m: NonNullable<WantV['matches']>[number] }) {
  const points = w.want.itemOffered.additionalProperty.map((p) => p.name);
  const r = m.revealed;
  return h('ion-card', { class: 'lake-card want-match' }, h('ion-card-content', {},
    h('div', { class: 'offer-head' }, h('h3', { class: 'offer-shop' }, r ? r.name : `Someone could help · fits ${m.matched.length} of ${points.length}`), h('span', { class: 'row-time' }, when(m.at))),
    r ? h('p', { class: 'muted-line' }, `Both said yes · the name their AI gave${r.handle ? ` · on the Lake they're ${r.handle}` : ''}`) : null,
    h('div', { class: 'spec-chips' }, ...points.map((pt) => h('span', { key: pt, class: `field-tag${m.matched.includes(pt) ? ' match-yes' : ' match-no'}` }, m.matched.includes(pt) ? pt : `${pt}: not said`))),
    h('div', { class: 'offer-tags' }, r ? h(Pill, { text: 'Both in', tone: 'mint' }) : h(Pill, { text: 'Through their AI · not checked', tone: 'amber' })),
    r ? (r.note ? h('ion-button', { size: 'small', shape: 'round', onClick: () => push(`#note=${encodeURIComponent(r.note!)}`) }, 'Say hello') : null)
      : m.state === 'yes' ? [h('p', { class: 'muted-line', key: 'wy' }, 'You said yes · waiting for their house.'),
        h('div', { class: 'card-actions', key: 'wa' },
          h(Btn, { label: 'Try again', size: 'small', fill: 'clear', run: () => must({ kind: 'panel.want.match.yes', want: w.want.id, match: m.id }), done: 'You both said yes.' }),
          h(Btn, { label: 'Not this one', size: 'small', fill: 'clear', color: 'medium', run: () => must({ kind: 'panel.want.match.no', want: w.want.id, match: m.id }), done: 'Set aside' }))]
      : h('div', { class: 'card-actions' },
        h(Btn, { label: 'Say yes', size: 'small', run: () => must({ kind: 'panel.want.match.yes', want: w.want.id, match: m.id }), ask: { header: 'Say yes?', sub: 'They already said yes. If you do, you each see the other\'s name here and can write to each other. Nobody has checked who they are: check before you meet, pay or say where you live.', button: 'Say yes', destructive: false }, done: 'You both said yes.' }),
        h(Btn, { label: 'Not this one', size: 'small', fill: 'clear', color: 'medium', run: () => must({ kind: 'panel.want.match.no', want: w.want.id, match: m.id }), done: 'Set aside' }))));
}

/** A link to send to people you know: they see what you're looking for and can reply, with nothing to install. */
function ShareWant({ id, shared }: { id: string; shared: boolean }) {
  const [link, setLink] = useState<{ link: string; until: string } | null>(null);
  // A link forwarded too far can be stopped without closing the want (its offers stay).
  const stop = (shared || link) ? h(Btn, { label: 'Stop sharing', fill: 'clear', color: 'medium', size: 'small', run: async () => { await must({ kind: 'panel.want.unshare', id }); setLink(null); }, ask: { header: 'Stop the link?', sub: 'Whoever has it can\'t reply any more, and the page says only that it\'s closed. Your offers stay.', button: 'Stop it' }, done: 'Link stopped' }) : null;
  return h('div', { class: 'pad share-want' },
    link ? h('div', {}, h('p', { class: 'muted-line' }, `Anyone with this link sees what you're looking for, not what you'd pay, and can reply here: 10 replies, until ${day(link.until)}.`),
      h('div', { class: 'copybox' }, h('code', {}, link.link)), h(CopyBtn, { text: link.link, label: 'Copy the link' }), stop)
      : h('div', {}, h(Btn, { label: 'Share with people you know', icon: 'share-outline', fill: 'outline', expand: 'block', run: async () => setLink(await must<{ link: string; until: string }>({ kind: 'panel.want.share', id })) }), stop));
}

export function WantPage({ arg }: { arg: string }) {
  const list = useHouse<ListView>({ kind: 'list' });
  const addr = useHouse<{ address: Address | null }>({ kind: 'panel.address' });
  const w = list.data?.wants?.find((x) => x.want.id === arg && !x.closed);
  if (!w) return h(Page, { title: 'Looking for', back: () => back('#inbox'), backLabel: 'Today' }, list.data ? h(Empty, { icon: 'search-outline', title: 'Not looking for this any more' }) : h(Failed, { error: list.error }));
  const bought = w.offers.find((o) => o.id === w.bought);
  const shop = bought ? shortShop(bought.seller.name) : '';
  const people = w.want.itemOffered['@type'] === 'Service';
  // An offer whose cart has run out can't be bought (round 21: it was shown with a Buy button that failed on the tap).
  const open = w.offers.filter((o) => o.state === 'open' && !ranOut(o)).sort((a, b) => a.total.value - b.total.value);
  const gone = w.offers.filter((o) => o.state === 'open' && ranOut(o) && !o.over).length;
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
      h('p', { class: 'spec-limit' }, [people ? '' : addr.data?.address ? `To ${addressLine(addr.data.address)}` : w.want.areaServed ? `To ${w.want.areaServed}` : '', w.limit ? `Most you'd pay: ${money({ currency: w.limit.currency, value: w.limit.amount })} (only your house knows)` : ''].filter(Boolean).join(' · ')))),
    // Send it to people you know (SPEC §6.8): a link that shows what you're looking for, never what you'd pay; replies come
    // here. Ten replies, seven days.
    // People who could help (a want for someone's help): which points, never who until both say yes; nothing is checked.
    // First under the want, with its empty state (round 62's design check).
    ...(people && !bought ? [
      h('h3', { class: 'section-h', key: 'ph' }, (w.matches ?? []).length ? `People (${w.matches!.length})` : 'People'),
      ...(w.matches ?? []).length ? w.matches!.map((m) => h(MatchCard, { key: m.id, w, m }))
        : [h(Empty, { key: 'none-p', icon: 'people-outline', title: 'Nobody yet', text: 'When someone who could help turns up, they appear here and you get a notification. Share the link below to ask people you know.' })],
    ] : []),
    ...(list.data?.notes ?? []).filter((n) => n.want === w.want.id).length ? [
      h('h3', { class: 'section-h', key: 'rh' }, `Replies (${(list.data?.notes ?? []).filter((n) => n.want === w.want.id).length})`),
      h('p', { class: 'muted-line pad', key: 'rw' }, 'Nobody checks who replies. Check them yourself before you meet, pay or say where you live.'),
      ...(list.data?.notes ?? []).filter((n) => n.want === w.want.id).sort((a, b) => b.at.localeCompare(a.at)).map((n) => h('ion-card', { key: n.id, class: 'lake-card want-reply' }, h('ion-card-content', {},
        h('div', { class: 'offer-head' }, h('h3', { class: 'offer-shop' }, n.from.as ?? n.from.name), h('span', { class: 'row-time' }, when(n.at))),
        // Private isn't checked (round 60): anyone with the link can write any name and any claim.
        h('div', { class: 'offer-tags' }, h(Pill, { text: 'Through your link · not checked', tone: 'amber' })),
        h('p', { class: 'offer-note' }, n.text),
        h('div', { class: 'card-actions' },
          h('ion-button', { size: 'small', shape: 'round', onClick: () => push(`#note=${encodeURIComponent(n.id)}`) }, 'Reply'),
          h(Btn, { label: 'Not this one', size: 'small', fill: 'clear', color: 'medium', run: () => must({ kind: 'panel.note.dismiss', id: n.id }), done: 'Set aside' }))))),
    ] : [],
    bought ? null : h(ShareWant, { key: 'share', id: w.want.id, shared: !!w.shared }),
    bought ? [
      h('h3', { class: 'section-h', key: 'bh' }, bought.state === 'arrived' ? 'Arrived' : bought.problem ? 'Problem reported' : bought.state === 'shipped' ? 'On its way' : 'Bought'),
      card(bought, false),
      h('p', { class: 'muted-line pad', key: 'bs' }, bought.state === 'arrived' ? `${shop} is paid${bought.ended ? `: ${bought.ended}` : ''}.` : bought.shipped ? `${shop}${bought.shipped.again ? ' sent it again' : ''}: “${bought.shipped.note}”` : `Paid by your house, held until you say it arrived.`),
      // What the owner said is wrong, and what holds the money now: nobody rules on a parcel, so it waits for the shop or for them.
      bought.problem && bought.state === 'shipped' ? h('p', { class: 'muted-line pad want-problem', key: 'pr' }, `On ${day(bought.problem.at)} you told ${shop} ${bought.problem.code === 'not_arrived' ? 'it hasn\'t arrived' : 'it came damaged or wrong'}. ${bought.problem.held ? `Your ${money(bought.total)} stays held until ${shop} sends it again or refunds you.${bought.problem.until ? ` If it does neither by ${day(bought.problem.until)}, it comes back to you.` : ''}` : `${shop} can send it again or refund you.`}`) : null,
      bought.state === 'shipped' ? h('div', { class: 'pad', key: 'arr' }, h(Btn, { label: bought.problem ? 'It arrived after all' : 'It arrived', icon: 'checkmark', expand: 'block', fill: bought.problem ? 'outline' : 'solid', run: () => must({ kind: 'panel.want.arrived', want: w.want.id }), done: `${shop} is paid` })) : null,
      bought.state === 'shipped' && !bought.problem ? h('div', { class: 'pad want-report', key: 'rep' },
        h(Btn, { label: 'Report a problem', fill: 'clear', color: 'medium', expand: 'block', pick: { header: 'What went wrong?', sub: `${shop} is told, and your ${money(bought.total)} stays held until it sends it again or refunds you, a week at most.`, options: [{ text: 'It hasn\'t arrived', value: 'not_arrived' }, { text: 'It came damaged or wrong', value: 'not_right' }] },
          run: (problem?: string) => must({ kind: 'panel.want.problem', want: w.want.id, problem }), done: `${shop} was told` }),
        bought.payBy ? h('p', { class: 'muted-line', key: 'by' }, `If you say nothing, ${shop} is paid on ${day(bought.payBy)}.`) : null) : null,
    ] : [
      refunded ? h('p', { class: 'muted-line pad', key: 'rf' }, `Your ${money(refunded.total)} came back from ${shortShop(refunded.seller.name)}${refunded.ended ? `: ${refunded.ended}` : ''}.`) : null,
      // A want for someone's help has no shop offers: people answer it (round 62's design check: it said "Shops look every
      // few minutes" under a want no shop answers).
      people ? null : h('h3', { class: 'section-h', key: 'oh' }, fits.length ? `Offers (${fits.length})` : 'Offers'),
      people ? null : fits.length ? fits.map((o) => card(o, true)) : over.length ? h('p', { class: 'muted-line pad', key: 'none' }, `None within the most you'd pay yet. Shops look every few minutes.`)
        : gone ? null : h(Empty, { key: 'none', icon: 'hourglass-outline', title: 'No offers yet', text: 'Shops look every few minutes. You get a notification when one offers.' }),
      gone ? h('p', { class: 'muted-line pad offers-gone', key: 'gone' }, `${gone} offer${gone === 1 ? '' : 's'} ran out: a shop's price holds for about a day. It can send it again.`) : null,
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
    door.sandbox ? h('p', { class: 'muted-line sandbox-line' }, 'This is the sandbox: made-up data and play money, real signatures.') : null,
    // Each promise with its limit (round 84: "You can take anything back" read as more than it is).
    h('ul', { class: 'welcome-points' },
      h('li', {}, h('ion-icon', { name: 'hand-left-outline' }), 'Nothing of yours goes out unless your rules or you say yes'),
      h('li', {}, h('ion-icon', { name: 'eye-off-outline' }), 'A yes can be taken back; what already left is listed under My data'),
      h('li', {}, h('ion-icon', { name: 'shield-checkmark-outline' }), 'Your rules answer at the door; an AI only does what you hand it')),
    h('ion-button', { expand: 'block', onClick: () => push('#door') }, 'Choose your name here'),
    h('p', { class: 'muted-line' }, 'Say it\'s alex, and anyone can tell their AI "ping alex". It isn\'t a login: it\'s how AIs find your door.')));
}
