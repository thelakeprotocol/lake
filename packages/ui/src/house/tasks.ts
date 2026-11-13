import { useState } from 'preact/hooks';
import { must, useHouse } from './api';
import { Btn, Child, Pill, Sheet, h, toast } from './ion';
import { chatKeyOf, chatsOf, plural, shortName, type Assistant, type Chat, type ListView, type Note, type TaskV } from './logic';
import { push } from './nav';

// Telling your AI what to do (13 Nov: "a button to delegate to AI with a small instructions"): a few words about one
// chat, signed by this phone, and the AI does it: it reads that chat and writes to that person, a few messages at most,
// and reports back. The card on Today then says how far it got and how it ended.

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The chats an AI can be sent into: someone with a key (or a web thread) who can be answered. */
const reachable = (v: ListView) => chatsOf(v.notes, v.assistants).filter((c) => c.canMode && !c.forwarded);
/**
 * Whom an AI's note is about: the chat of the message it names, else its sender, else the one person its text names
 * (an AI on duty writes "Opal Lumen (introduced as Sam) wrote…" and names no message).
 */
export function aboutWhom(x: Note, v: ListView): { chat: Chat; sure: boolean } | undefined {
  const chats = reachable(v);
  const exact = (x.note ? chats.find((c) => c.notes.some((n) => n.id === x.note)) : undefined) ?? (x.sender ? chats.find((c) => c.notes.some((n) => n.from.webId === x.sender)) : undefined);
  if (exact) return { chat: exact, sure: true };
  const named = (c: Chat) => [c.name, c.agent].filter((n) => n.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}($|[^\\p{L}\\p{N}])`, 'u').test(x.text)).sort((a, b) => b.length - a.length)[0];
  const hit = chats.map((c) => ({ c, n: named(c) })).filter((m) => m.n).sort((a, b) => b.n!.length - a.n!.length)[0];
  return hit ? { chat: hit.c, sure: false } : undefined;
}
const aiOf = (label: string) => shortName(label) || 'your AI';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** When an AI gets to it, from where it runs: said before the instruction is sent, so nobody waits on an AI that's asleep. */
const starts = (a: Assistant | undefined, ai: string) => (!a ? ''
  : a.awake || a.runs === 'house' ? `${cap(ai)} starts within a minute.`
    : a.runs === 'computer' ? `${cap(ai)} isn't running now. It starts when its computer is back on.`
      : `${cap(ai)} isn't running by itself. It sees this the next time you open a chat with it.`);

const IDEAS = ['Say no thanks, politely', 'Ask for more details', 'Say I\'ll answer later'];

/**
 * "Tell <AI> what to do": whom it's about, a few words, what the AI may do with them, and when it gets to it. Opened
 * from an AI's note (x), from a chat or an earlier instruction (note: any message in that chat).
 */
export function TellSheet({ open, onClose, onSent, x, note, suggestion, by }: { open: boolean; onClose: () => void; onSent?: () => void; x?: Note; note?: string; suggestion?: string; by?: string }) {
  const list = useHouse<ListView>({ kind: 'list' });
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [aiKid, setAiKid] = useState<string | null>(null);
  const v = list.data;
  const body = (): Child => {
    if (!v) return h('p', { class: 'muted-line pad' }, 'Loading…');
    const ais = v.assistants;
    if (!ais.length) return h('div', { class: 'tell' },
      h('p', { class: 'sug-text' }, 'No AI is connected yet.'),
      h('p', { class: 'muted-line' }, 'Connect one and it can answer people for you, on your instruction.'),
      h('div', { class: 'card-actions' }, h('ion-button', { shape: 'round', class: 'lake-btn', onClick: () => { onClose(); push('#ai'); } }, 'Connect an AI')));
    const chats = reachable(v);
    const given = note ? chats.find((c) => c.notes.some((n) => n.id === note)) : undefined;
    const guess = given ? { chat: given, sure: true } : x ? aboutWhom(x, v) : undefined;
    // A name read off the AI's own words is only a suggestion: the chat is the owner's pick, the guess listed first.
    const chat = (picked ? chats.find((c) => c.key === picked) : undefined) ?? (guess?.sure ? guess.chat : undefined);
    // Someone who wrote to one of your AIs is answered by that one, from its own address: no other can.
    const a = chat?.toAi ? ais.find((q) => q.kid === chat.toAi) : ais.find((q) => q.kid === (aiKid ?? by ?? x?.by)) ?? (ais.length === 1 ? ais[0] : undefined), ai = a ? aiOf(a.label) : 'your AI';
    const latest = chat?.notes[chat.notes.length - 1];
    // Whom it's about can be changed while it was only read off the note's words.
    const others = guess?.sure ? [] : [...(guess ? [guess.chat] : []), ...chats.filter((c) => c.key !== guess?.chat.key)].slice(0, 6);
    // Two people by one name are told apart by their latest words.
    const words = (c: Chat) => { const t = (c.notes[c.notes.length - 1]?.text ?? '').replace(/\s+/g, ' ').trim(); return t.length > 30 ? `${t.slice(0, 28).trimEnd()}…` : t; };
    const chip = (c: Chat) => others.filter((o) => o.name === c.name).length < 2 ? c.name : `${c.name}: “${words(c)}”`;
    return h('div', { class: 'tell' },
      ais.length > 1 && !chat?.toAi ? h('div', { class: 'tell-chips', role: 'group', 'aria-label': 'Which AI' }, ...ais.map((q) => h('button', { key: q.kid, type: 'button', class: `chip${a?.kid === q.kid ? ' on' : ''}`, 'aria-pressed': String(a?.kid === q.kid), onClick: () => setAiKid(q.kid) }, aiOf(q.label)))) : null,
      chat && latest ? h('div', { class: 'tell-about' }, h('small', {}, `About ${chat.name}'s message${chat.toAi ? ` to ${ai}` : ''}`), h('p', {}, latest.text)) : h('p', { class: 'muted-line' }, chats.length ? 'Who is this about?' : 'Nobody has written to you yet, so there is nobody to write to.'),
      others.length ? h('div', { class: 'tell-chips', role: 'group', 'aria-label': 'Who it is about' }, ...others.map((c) => h('button', { key: c.key, type: 'button', class: `chip${chat?.key === c.key ? ' on' : ''}`, 'aria-pressed': String(chat?.key === c.key), onClick: () => setPicked(c.key) }, chip(c)))) : null,
      h('ion-textarea', { value: text, autoGrow: true, rows: 2, maxlength: 300, placeholder: `What should ${ai} do? A few words.`, 'aria-label': 'Your instruction', class: 'tell-input', onionInput: (e: CustomEvent) => setText(String(e.detail.value ?? '')) }),
      h('div', { class: 'tell-chips ideas' }, ...IDEAS.map((t) => h('button', { key: t, type: 'button', class: 'chip', onClick: () => setText(t) }, t))),
      chat?.toAi && !a ? h('p', { class: 'muted-line' }, 'The AI they wrote to is no longer connected, so nobody can answer them from there.') : null,
      chat ? h('p', { class: 'muted-line tell-scope' }, `${cap(ai)} can read this chat and send ${chat.name} up to 5 messages${chat.toAi ? ' from its own address' : ''}, until this time tomorrow. ${chat.toAi ? 'Your house counts them, and they don\'t learn where it is. ' : ''}This doesn't let it spend money or change your rules. ${starts(a, ai)}`) : null,
      h('div', { class: 'card-actions' }, h(Btn, { label: `Send to ${ai}`, icon: 'sparkles', expand: 'block', cls: 'tell-send', disabled: !text.trim() || !chat || !a,
        run: async () => { await must({ kind: 'panel.task.set', suggestion: suggestion ?? x?.id, note: latest!.id, by: a!.kid, text: text.trim() }); setText(''); void toast(`Sent to ${ai}`); onClose(); onSent?.(); } })));
  };
  return h(Sheet, { open, onClose, title: `Tell ${v?.assistants.length === 1 ? aiOf(v.assistants[0]!.label) : 'your AI'} what to do` }, open ? body() : null);
}

/** The button that opens it, on an AI's note that is about someone who can be answered. */
export function TellButton({ x, onSent }: { x: Note; onSent?: () => void }) {
  const list = useHouse<ListView>({ kind: 'list' });
  const [open, setOpen] = useState(false);
  const v = list.data;
  if (!v || !x.by || x.booking || !aboutWhom(x, v)) return null;
  const a = v.assistants.find((q) => q.kid === x.by);
  return h('div', { class: 'tell-row' },
    h('ion-button', { fill: 'outline', shape: 'round', class: 'lake-btn tell-btn', onClick: () => setOpen(true) }, h('ion-icon', { name: 'sparkles-outline', slot: 'start' }), `Tell ${a ? aiOf(a.label) : 'your AI'} what to do`),
    h(TellSheet, { open, onClose: () => setOpen(false), onSent, x }));
}

/** What you told an AI to do, on Today until you've seen how it ended: what it sent, whether they answered, and the ways on. */
export function TaskCard({ t, v }: { t: TaskV; v: ListView }) {
  const [tell, setTell] = useState(false);
  const ai = aiOf(t.label), Ai = cap(ai), name = t.to.name.replace(/ \(.*\)$/, '');
  const a = v.assistants.find((q) => q.kid === t.by);
  const last = t.did[t.did.length - 1];
  const inChat = v.notes.filter((n) => chatKeyOf(n) === t.to.key).sort((p, q) => p.at.localeCompare(q.at));
  const theirs = last ? inChat.filter((n) => n.at > last.at).at(-1) : undefined;
  const open = t.state === 'open';
  const pill = open ? h(Pill, { text: `With ${ai}`, tone: 'violet' }) : t.state === 'done' ? h(Pill, { text: 'Done', tone: 'mint' }) : t.state === 'back' ? h(Pill, { text: 'Back to you', tone: 'amber' }) : h(Pill, { text: 'Not done', tone: 'red' });
  const status = !open ? (t.ended?.text ? null : t.ended?.why ?? null)
    : !last ? (t.seen ? `${Ai} is working on it.` : `Not started yet. ${starts(a, ai)}`)
      : theirs ? `${name} answered. ${t.left > 0 ? `${Ai} can send ${plural(t.left, 'more message')}.` : `${Ai} has sent all its messages.`}`
        : `Waiting for ${name}'s answer.`;
  const toChat = () => push(`#note=${encodeURIComponent(theirs?.id ?? last?.note ?? t.note)}`);
  const ok = (extra?: () => Promise<unknown>) => async () => { await extra?.(); await must({ kind: 'panel.task.ok', id: t.id }); };
  const chatBtn = (label: string) => h('ion-button', { key: 'chat', fill: 'clear', shape: 'round', size: 'small', class: 'lake-btn', onClick: toChat }, label);
  const okBtn = h(Btn, { key: 'ok', label: 'OK', size: 'small', fill: t.state === 'done' ? 'solid' : 'outline', color: t.state === 'done' ? 'primary' : 'medium', run: ok() });
  const again = h('ion-button', { key: 'again', shape: 'round', size: 'small', class: 'lake-btn', onClick: () => setTell(true) }, t.state === 'cant' ? `Tell ${ai} again` : `Tell ${ai} what to do`);
  const handedOver = inChat.at(-1)?.mode === 'ai';
  const acts: Child[] = open ? [h(Btn, { key: 'stop', label: 'Take it back', size: 'small', fill: 'outline', color: 'medium', run: () => must({ kind: 'panel.task.stop', id: t.id }), done: 'Taken back' }), t.did.length ? chatBtn('Open chat') : null]
    : t.state === 'done' ? [okBtn, chatBtn('Open chat'), handedOver ? null : h(Btn, { key: 'keep', label: `Let ${ai} keep answering ${name}`, size: 'small', fill: 'outline', run: ok(() => must({ kind: 'panel.chat.mode', key: t.to.key, mode: 'ai' })), done: `${Ai} replies to ${name} from now on, while it's on duty` })]
      : [again, chatBtn(t.to.via ? 'Open chat' : 'Reply yourself'), okBtn];
  return h('ion-card', { class: `lake-card task-card ${t.state}` }, h('ion-card-content', {},
    h('div', { class: 'card-kicker' }, h('ion-icon', { name: 'sparkles-outline' }), `You told ${ai}`, pill),
    h('p', { class: 'task-words' }, `“${t.text}”`),
    h('p', { class: 'muted-line' }, `About ${name}'s message${t.to.via ? ` to ${ai}` : ''}.`),
    last ? h('div', { class: 'task-did' }, h('small', {}, last.pending ? `${Ai} is sending this to ${name}` : `${Ai} wrote to ${name}${t.to.via ? ', from its own address' : ''}${t.did.length > 1 ? ` (${t.did.length} messages, the latest)` : ''}`), h('p', {}, last.text)) : null,
    theirs ? h('div', { class: 'task-did theirs' }, h('small', {}, `${name} answered`), h('p', {}, theirs.text)) : null,
    !open && t.ended?.text ? h('div', { class: 'task-did report' }, h('small', {}, `${Ai} says`), h('p', {}, t.ended.text)) : null,
    status ? h('p', { class: 'muted-line task-status' }, status) : null,
    h('div', { class: 'card-actions wrap' }, ...acts),
    h(TellSheet, { open: tell, onClose: () => setTell(false), note: inChat.at(-1)?.id ?? t.note, suggestion: t.suggestion, by: t.by })));
}
