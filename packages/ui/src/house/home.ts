import { useHouse } from './api';
import { Child, Failed, Page, Row, Section, h } from './ion';
import { chatsOf, needsDecision, sameAsks, shortName, taskCards, waitingOn, type ListView } from './logic';
import { push } from './nav';
import { ConnectCard, ConnectedNote, RequestCard, SuggestionCard } from './inbox';
import { AskBox, TaskCard } from './tasks';
import { ChatRow, WelcomeCard } from './chats';
import type { DoorState } from './logic';

type TodayLine = { by: string; text: string; at: string; to: string; tile?: { big: string; label: string } };

/**
 * One screen (the owner, 25 Nov: "it should be very simple… the current complexity is too much"; Fable, ChatGPT and Grok
 * agreed): your AI at the top, one sentence for what was handled, the few things only you can decide, who wrote lately,
 * and one box to tell your AI what you want. The house's machinery stays behind You.
 */
export function HomeTab({ tabbar, status }: { tabbar: Child; status: Child }) {
  const list = useHouse<ListView>({ kind: 'list' });
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const today = useHouse<{ lines: TodayLine[] }>({ kind: 'panel.today', tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const v = list.data;
  if (!v) return h(Page, { title: 'Home', big: true, status, footer: tabbar }, h(Failed, { error: list.error }));
  // Your AI, here or not: the one thing the screen is built around.
  const ais = v.assistants ?? [], ai = ais[0], here = ais.find((a) => a.seenAt && Date.now() - Date.parse(a.seenAt) < 30 * 60_000);
  const aiName = ai ? shortName(ai.label) : '';
  const chip = h('button', { type: 'button', class: `ai-chip ${here ? 'here' : ai ? 'away' : 'none'}`, onClick: () => push('#ai'), 'aria-label': ai ? `${aiName}, ${here ? 'here now' : 'not here now'}` : 'Connect your AI' },
    h('span', { class: 'ai-dot' }), ai ? aiName : 'Connect your AI');
  // What only you can decide.
  const groups = sameAsks(v.requests), tasks = taskCards(v), tasked = new Set(tasks.map((t) => t.suggestion));
  const decide = v.suggestions.filter((x) => needsDecision(x) && !tasked.has(x.id));
  const n = groups.length + decide.length + (v.connects ?? []).length;
  // What was handled, in one sentence (the tiles' numbers, as words).
  const said = (big: string, label: string) => /allowed/.test(label) ? `let ${big} in` : /declined/.test(label) ? `said no to ${big}` : /turned away/.test(label) ? `turned ${big} away` : /stud/.test(label) ? `answered ${big} ${big === '1' ? 'study' : 'studies'}` : /came in/.test(label) ? '' : `${big} ${label}`;
  const ls = (today.data?.lines ?? []).filter((l) => l.tile), money = ls.find((l) => /came in/.test(l.tile!.label));
  const parts = ls.map((l) => said(l.tile!.big, l.tile!.label)).filter(Boolean);
  const handled = parts.length || money ? `Today your house ${parts.join(', ')}${money ? `${parts.length ? '. ' : ''}${money.tile!.big} came in` : ''}.` : 'Quiet so far today.';
  // Who wrote lately, newest first, a few.
  const recent = chatsOf(v.notes ?? [], ais).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  const waits = v.suggestions.filter(waitingOn);
  return h(Page, { title: 'Home', big: true, status, end: chip, footer: h('div', { class: 'home-foot' }, h('div', { class: 'home-ask' }, h(AskBox, { v })), tabbar) },
    h(WelcomeCard, { door: door.data, key: 'welcome' }),
    h('button', { type: 'button', class: 'handled-line', key: 'handled', onClick: () => push('#inbox') }, handled, ' ', h('span', { class: 'see-all' }, 'See everything ›')),
    h('h3', { class: 'section-h', key: 'nh' }, n ? `${n === 1 ? '1 thing needs' : `${n} things need`} you` : 'Nothing needs you'),
    h(ConnectedNote, { key: 'cn' }),
    ...(v.connects ?? []).map((c) => h(ConnectCard, { key: `c-${c.id}`, c })),
    ...groups.map((all) => h(RequestCard, { key: all[0]!.id, all, compact: true })),
    ...decide.map((x) => h(SuggestionCard, { key: x.id, x })),
    tasks.length || waits.length ? h('h3', { class: 'section-h', key: 'ah' }, ai ? `${aiName} is on it` : 'Waiting on others') : null,
    ...tasks.map((t) => h(TaskCard, { key: `t-${t.id}`, t, v })),
    recent.length ? h(Section, { title: 'Lately', key: 'lately', cls: 'chat-list' }, ...recent.map((c) => h(ChatRow, { key: c.key, c })),
      h(Row, { key: 'all', icon: 'people-outline', label: 'Everyone', onClick: () => push('#chats') })) : null);
}
