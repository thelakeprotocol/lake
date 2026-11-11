import { useEffect, useState } from 'preact/hooks';
import { call, houseBase, must, useHouse, useRedraw } from './api';
import { Avatar, Btn, Child, CopyBtn, Empty, Failed, Page, Pill, Row, Section, Sheet, h, toast } from './ion';
import { CURRENCIES, DUTY_KINDS, dutyLine, dutyLive, lastHere, money$, receiptWords, shortName, signDraft, time, waitingLine, watching, type Assistant, type DutyLog, type ListView } from './logic';
import { back, push } from './nav';

// My AI: your own AI with a key to your house. Your AIs first, then AI on duty, then what it did while you were away.
// Its questions and suggestions live in the Inbox, once.

/** The code you hand your AI, kept so a tab change doesn't lose it while you copy it. */
let invite: { msg: string; until: number; made: number } | null = null;
let dutyCode: { code: string; cmd: string; until: number; made: number } | null = null;

export function AiTab({ tabbar, status }: { tabbar: Child; status: Child }) {
  const v = useHouse<ListView>({ kind: 'list' });
  const duty = useHouse<DutyLog>({ kind: 'panel.duty.log' });
  const [connect, setConnect] = useState(false);
  const [setup, setSetup] = useState(false);
  if (!v.data) return h(Page, { title: 'My AI', big: true, status, footer: tabbar }, h(Failed, { error: v.error }));
  const live = (duty.data?.duties ?? []).filter(dutyLive);
  const onDuty = new Set(live.map((d) => d.kid));
  const ais = v.data.assistants;
  return h(Page, { title: 'My AI', big: true, status, footer: tabbar },
    ais.length ? h(Section, { title: 'Your AIs' },
      ...ais.map((a) => h(Row, { key: a.kid, start: h('div', { slot: 'start' }, h(Avatar, { name: shortName(a.label), size: 40 })), label: shortName(a.label), sub: [onDuty.has(a.kid) ? 'On duty' : 'Can suggest', lastHere(a.seenAt).text, a.waiting ? `${a.waiting.count} waiting` : ''].filter(Boolean).join(' · '), onClick: () => push(`#aikey=${encodeURIComponent(a.kid)}`), cls: 'ai-row' })),
      h(Row, { icon: 'add', label: 'Connect another AI', onClick: () => setConnect(true), detail: false }))
      : h('ion-card', { class: 'lake-card hero-card' }, h('ion-card-content', {},
        h('div', { class: 'hero-icon' }, h('ion-icon', { name: 'sparkles' })),
        h('h2', {}, 'Bring your own AI'),
        h('p', {}, 'Give Claude, ChatGPT or another AI a key to your house. It sees who writes to you and suggests. Only you decide.'),
        h('ion-button', { shape: 'round', onClick: () => setConnect(true) }, 'Give my AI a key'))),
    h(Section, { title: 'AI on duty' },
      live.length ? live.map((d) => h('ion-item', { key: d.kid, lines: 'full', class: 'lake-row duty-row' },
        h('div', { slot: 'start', class: `row-icon tint-${d.state.on ? 'mint' : 'amber'}` }, h('ion-icon', { name: 'moon-outline' })),
        h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, shortName(d.label), ' ', h(Pill, { text: d.state.on ? 'On duty' : d.off?.night ? 'Paused tonight' : 'Off hours', tone: d.state.on ? 'mint' : 'amber' })),
          h('p', {}, `${d.hours ? `${d.hours.from}–${d.hours.to}` : 'While you\'re away'} · ${d.state.on ? d.state.used : d.summary.handled} of ${d.cap} tonight · until ${new Date(d.until).toLocaleDateString([], { day: 'numeric', month: 'short' })}`),
          d.runner ? h('p', {}, watching(d.runner)) : null, !d.state.on ? h('p', { class: 'warn-text' }, d.state.why) : null),
        h('div', { slot: 'end' }, h(Btn, { label: 'Turn off', size: 'small', fill: 'outline', color: 'danger', run: () => call({ kind: 'panel.duty.off', kid: d.kid }), ask: { header: 'Take your AI off duty?', sub: 'It stops now.', button: 'Turn off' } }))))
        : h(Row, { icon: 'moon-outline', tint: 'violet', label: 'Set up AI on duty', sub: 'Replies to people you know while you\'re away. Never money.', onClick: () => setSetup(true) })),
    h(Night, { log: duty.data }),
    h(Sheet, { open: connect, onClose: () => setConnect(false), title: 'Give your AI a key' }, h(ConnectSheet, { houseUrl: houseBase(), ais })),
    h(Sheet, { open: setup || !!dutyCode, onClose: () => { setSetup(false); dutyCode = null; }, title: 'AI on duty' }, h(DutySetup, { houseUrl: houseBase(), log: duty.data, done: () => setSetup(false) })));
}

/** The one-time code to paste into your AI app; gone once your AI uses it. */
function ConnectSheet({ houseUrl, ais }: { houseUrl: string; ais: Assistant[] }) {
  const redraw = useRedraw();
  useEffect(() => { const t = setInterval(redraw, 30_000); return () => clearInterval(t); }, []);
  if (invite && (invite.until < Date.now() || ais.some((a) => Date.parse(a.addedAt) >= invite!.made - 1000))) invite = null;
  if (!invite) return h('div', { class: 'sheet-body' },
    h('p', {}, 'Your AI needs the Lake connector. You get a message with a one-time code to paste into it.'),
    h(Btn, { label: 'Make the code', expand: 'block', run: async () => { const r = await call<{ code: string; until: string }>({ kind: 'panel.assistant.invite', label: 'my assistant' }); invite = { msg: `Connect to my house as my assistant: use lake_house_connect with house_url ${houseUrl} and code ${r.code}. Then look around inside and tell me what you see.`, until: Date.parse(r.until), made: Date.now() }; redraw(); } }));
  const mins = Math.max(1, Math.round((invite.until - Date.now()) / 60_000));
  return h('div', { class: 'sheet-body' },
    h('p', {}, `Paste this to your AI. It works once, for ${mins} minute${mins === 1 ? '' : 's'}.`),
    h('div', { class: 'copybox' }, invite.msg),
    h('div', { class: 'sheet-actions' }, h(CopyBtn, { text: invite.msg, label: 'Copy message', fill: 'solid' })));
}

/** What your AI on duty may do, in which hours, how many things a night, for how long; signed here; then the command. */
function DutySetup({ houseUrl, log, done }: { houseUrl: string; log?: DutyLog; done: () => void }) {
  const [kinds, setKinds] = useState<string[]>(['reply', 'book']);
  const [from, setFrom] = useState('22:00');
  const [to, setTo] = useState('07:00');
  const [cap, setCap] = useState(10);
  const [days, setDays] = useState(7);
  const redraw = useRedraw();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (dutyCode && (dutyCode.until < Date.now() || (log?.duties ?? []).some((d) => d.seenAt && Date.parse(d.seenAt) >= dutyCode!.made - 1000))) dutyCode = null;
  if (dutyCode) return h('div', { class: 'sheet-body' },
    h('p', {}, `Run this on the computer where your AI app is. The code works once, for ${Math.max(1, Math.round((dutyCode.until - Date.now()) / 60_000))} minutes.`),
    h('div', { class: 'copybox mono' }, dutyCode.cmd),
    h('div', { class: 'sheet-actions' }, h(CopyBtn, { text: dutyCode.cmd, label: 'Copy command', fill: 'solid' })));
  return h('div', { class: 'sheet-body' },
    h('p', { class: 'muted-line' }, 'It runs on your computer with your own AI app. Never money; anything new waits for you.'),
    h('ion-list', { inset: true, class: 'lake-list' },
      ...DUTY_KINDS.map(([k, label]) => h('ion-item', { key: k }, h('ion-checkbox', { checked: kinds.includes(k), onionChange: (e: CustomEvent) => setKinds(e.detail.checked ? [...new Set([...kinds, k])] : kinds.filter((x) => x !== k)), labelPlacement: 'end', justify: 'start' }, label))),
      h('ion-item', {}, h('ion-input', { type: 'time', label: 'From', value: from, 'aria-label': 'On duty from', onionInput: (e: CustomEvent) => setFrom(String(e.detail.value)) })),
      h('ion-item', {}, h('ion-input', { type: 'time', label: 'To', value: to, 'aria-label': 'On duty until', onionInput: (e: CustomEvent) => setTo(String(e.detail.value)) })),
      h('ion-item', {}, h('ion-input', { type: 'number', label: 'Things a night, at most', value: cap, min: 1, max: 50, 'aria-label': 'Most things a night', onionInput: (e: CustomEvent) => setCap(Number(e.detail.value)) })),
      h('ion-item', { lines: 'none' }, h('ion-input', { type: 'number', label: 'For how many days', value: days, min: 1, max: 31, 'aria-label': 'Days on duty', onionInput: (e: CustomEvent) => setDays(Number(e.detail.value)) }))),
    h('p', { class: 'muted-line' }, `Your time zone: ${tz.replace(/_/g, ' ')}`),
    h('div', { class: 'sheet-actions' },
      h(Btn, { label: 'Sign and get the command', expand: 'block', run: async () => {
        if (!kinds.length) throw new Error('Pick at least one thing it may do.');
        if (!(cap >= 1 && cap <= 50)) throw new Error('From 1 to 50 things a night.');
        if (!(Number.isInteger(days) && days >= 1 && days <= 31)) throw new Error('From 1 to 31 days.');
        if (from === to) throw new Error('The hours need to start and end at different times.');
        const d = await must<{ id: string; draft: Record<string, unknown> }>({ kind: 'panel.duty.draft', kinds, cap, days, hours: { from, to, tz } });
        const r = await must<{ code: string; until: string }>({ kind: 'panel.duty.set', id: d.id, label: 'AI on duty', credential: signDraft(d.draft) });
        dutyCode = { code: r.code, until: Date.parse(r.until), made: Date.now(), cmd: `npx -y @thelakeprotocol/agent duty --lake ${location.origin}/mcp --house ${houseUrl} --code ${r.code}${kinds.includes('deliver') ? ' --menu menu.json' : ''}` };
        redraw();
      } }),
      h('ion-button', { fill: 'clear', color: 'medium', expand: 'block', onClick: done }, 'Not now')));
}

/** The morning: what your AI on duty did, each with what the other side signed, and Undo. */
function Night({ log }: { log?: DutyLog }) {
  if (!log) return null;
  const all = log.entries ?? [];
  // Never on duty: nothing to say here (setting it up is the row above).
  if (!all.length && !(log.duties ?? []).some(dutyLive)) return null;
  const done = all.filter((e) => !e.refused && e.action !== 'note'), stopped = all.filter((e) => e.refused);
  const sum = (log.duties ?? []).reduce((t, d) => ({ handled: t.handled + d.summary.handled, waiting: t.waiting + d.summary.waiting, blocked: t.blocked + d.summary.blocked }), { handled: 0, waiting: 0, blocked: 0 });
  return h('div', { class: 'night' },
    h('h3', { class: 'section-h' }, 'While you were away'),
    !all.length ? h('p', { class: 'muted-line pad' }, 'Nothing came in for it to handle.')
      : [h('div', { class: 'stat-row', key: 'st' },
          h('div', { class: 'stat mint' }, h('b', {}, String(sum.handled)), h('span', {}, 'Handled')),
          h('div', { class: 'stat' }, h('b', {}, String(sum.waiting)), h('span', {}, 'Waiting')),
          h('div', { class: 'stat' }, h('b', {}, String(sum.blocked)), h('span', {}, 'Blocked'))),
        h(Section, { key: 'l' }, ...done.slice(0, 20).map((e) => h('ion-item', { key: e.id, lines: 'full', class: 'lake-row slept-row' },
          h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, dutyLine(e)), h('p', {}, `${time(e.at)} · ${receiptWords(e)}`)),
          e.undo ? (e.undone ? h(Pill, { text: 'Undone' }) : h('div', { slot: 'end' }, h(Btn, { label: 'Undo', size: 'small', fill: 'outline', run: () => call({ kind: 'panel.duty.undo', entry: e.id }), done: 'Undone' }))) : null))),
        stopped.length ? h('p', { class: 'muted-line pad', key: 'sp' }, `Stopped ${stopped.length} thing${stopped.length === 1 ? '' : 's'} it may not do.`) : null]);
}

/** One AI: when it was last here, its spending money (signed here), removing it. */
export function AiKeyPage({ arg }: { arg: string }) {
  const v = useHouse<ListView>({ kind: 'list' });
  const duty = useHouse<DutyLog>({ kind: 'panel.duty.log' });
  const a = v.data?.assistants.find((x) => x.kid === arg);
  if (!a) return h(Page, { title: 'Your AI', back: () => back('#ai'), backLabel: 'My AI' }, v.data ? h(Empty, { icon: 'sparkles-outline', title: 'This AI isn\'t connected any more' }) : h(Failed, { error: v.error }));
  const onDuty = (duty.data?.duties ?? []).some((d) => d.kid === a.kid && dutyLive(d));
  return h(Page, { title: shortName(a.label), back: () => back('#ai'), backLabel: 'My AI' },
    h('div', { class: 'bigwho' }, h(Avatar, { name: shortName(a.label), size: 72 }), h('h2', {}, shortName(a.label)), h(Pill, { text: lastHere(a.seenAt).text, tone: lastHere(a.seenAt).now ? 'mint' : 'muted' })),
    a.waiting ? h('ion-card', { class: 'lake-card warn-card' }, h('ion-card-content', {}, h('p', {}, waitingLine(a)))) : null,
    h(Section, {}, h(Row, { icon: 'eye-outline', label: 'Suggests; you decide', sub: `Connected ${time(a.addedAt)}` }), onDuty ? h(Row, { icon: 'moon-outline', tint: 'violet', label: 'On duty', sub: 'Replies and bookings only, never money' }) : null),
    onDuty ? null : h(Allowance, { a }),
    h('div', { class: 'pad' }, h(Btn, { label: 'Remove this AI', fill: 'outline', color: 'danger', expand: 'block', run: async () => { await call({ kind: 'panel.assistant.revoke', kid: a.kid }); back('#ai'); }, ask: { header: `Remove ${shortName(a.label)}?`, sub: 'Its key stops working.', button: 'Remove' }, done: 'Removed' })));
}

/** A spending allowance (SPEC §6.2): drafted by the house, signed here. Not per day: once spent, it's gone. */
function Allowance({ a }: { a: Assistant }) {
  const guess = /-AU$/i.test(navigator.language) ? 'AUD' : /-NZ$/i.test(navigator.language) ? 'NZD' : /-GB$/i.test(navigator.language) ? 'GBP' : 'USD';
  const [edit, setEdit] = useState(false);
  const [currency, setCurrency] = useState(a.allowance?.currency ?? guess);
  const [amount, setAmount] = useState(a.allowance?.amount ?? 50);
  const [days, setDays] = useState(7);
  if (!a.canHaveAllowance) return h(Section, { title: 'Spending money' }, h(Row, { icon: 'wallet-outline', tint: 'muted', label: 'Connect it again to give it money', sub: 'This connection can\'t hold an allowance' }));
  if (!edit) return h(Section, { title: 'Spending money', cls: 'spend' },
    a.allowance ? h('ion-item', { lines: 'full' }, h('div', { slot: 'start', class: 'row-icon tint-mint' }, h('ion-icon', { name: 'wallet-outline' })), h('ion-label', {}, h('h3', { class: 'spend-amount' }, `Up to ${money$(a.allowance.amount, a.allowance.currency)}`), h('p', {}, `In total, until ${new Date(a.allowance.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`)),
      h('div', { slot: 'end', class: 'row-btns' }, h('ion-button', { size: 'small', fill: 'outline', shape: 'round', onClick: () => setEdit(true) }, 'Change'), h(Btn, { label: 'Stop', size: 'small', fill: 'clear', color: 'danger', run: () => call({ kind: 'panel.allowance.revoke', kid: a.kid }), ask: { header: 'Stop its spending money?', sub: 'It can\'t spend from now on.', button: 'Stop' } })))
      : h(Row, { icon: 'wallet-outline', tint: 'muted', label: 'No spending money', sub: 'It asks you before paying for anything. Tap to give it some.', onClick: () => setEdit(true) }));
  return h(Section, { title: 'Spending money', cls: 'spend' },
    h('ion-item', {}, h('ion-select', { label: 'Currency', value: currency, 'aria-label': 'Currency', interface: 'action-sheet', onionChange: (e: CustomEvent) => setCurrency(String(e.detail.value)) }, ...CURRENCIES.map((c) => h('ion-select-option', { key: c, value: c }, c)))),
    h('ion-item', {}, h('ion-input', { type: 'number', label: 'Total it may spend', value: amount, min: 1, max: 1000, 'aria-label': 'Amount', onionInput: (e: CustomEvent) => setAmount(Number(e.detail.value)) })),
    h('ion-item', {}, h('ion-input', { type: 'number', label: 'For how many days', value: days, min: 1, max: 31, 'aria-label': 'Days it lasts', onionInput: (e: CustomEvent) => setDays(Number(e.detail.value)) })),
    h('ion-item', { lines: 'none' }, h('ion-label', { class: 'ion-text-wrap' }, h('p', {}, `${shortName(a.label)} can spend ${money$(amount || 0, currency)} in total until ${days >= 1 && days <= 31 ? new Date(Date.now() + days * 86_400_000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '…'}. Not per day.`))),
    h('div', { class: 'pad row-btns' },
      h(Btn, { label: a.allowance ? 'Sign the change' : 'Sign and give', run: async () => {
        if (!(amount >= 1 && amount <= 1000)) throw new Error('An amount from 1 to 1000.');
        if (!(Number.isInteger(days) && days >= 1 && days <= 31)) throw new Error('From 1 to 31 days.');
        const d = await must<{ id: string; draft: Record<string, unknown> }>({ kind: 'panel.allowance.draft', kid: a.kid, amount, currency, days });
        await must({ kind: 'panel.allowance.set', id: d.id, credential: signDraft(d.draft) });
        setEdit(false); void toast('Signed');
      } }),
      h('ion-button', { fill: 'clear', color: 'medium', shape: 'round', onClick: () => setEdit(false) }, 'Cancel')));
}
