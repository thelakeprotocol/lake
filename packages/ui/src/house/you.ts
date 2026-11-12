import QRCode from 'qrcode';
import { useState } from 'preact/hooks';
import { call, iosNotInstalled, key, must, notifyDismiss, notifyOffer, pushable, signOut, state, turnOffNotifications, turnOnNotifications, useBump, useHouse } from './api';
import { Avatar, Btn, Child, CopyBtn, Failed, Page, Row, Section, Sheet, confirm, h, toast } from './ion';
import { date, dayTime, dataState, doorState, hoursLeft, lastHere, leftLine, moneyState, phoneState, plural, rulesState, shortName, shortShop, useLine, type AccessRow, type Assistant, type DoorState, type Left, type ListView, type Receipt, type RowState, type Rules } from './logic';
import { push } from './nav';

// You: who you are here, then five rows that each say how they stand; everything else is one tap further, under the
// row it belongs to (Fable's design, step 7: fourteen rows said nothing until opened).

type AccessView = { now: number; askedToday: number; blockedToday: number; agents: AccessRow[] };
type Overview = { claims: number; holds: string[]; record: { ok: boolean; why?: string } };
type MoneyView = { total: number; held?: number; receipts: Receipt[]; spent?: { amount: number; currency: string; settlement?: string }[] };
const tz = () => new Date().getTimezoneOffset();
const notifyOn = () => pushable() && Notification.permission === 'granted';
const keyLine = () => (key.store === 'device' ? 'Held by this browser: it signs here and can\'t be copied out' : location.protocol === 'https:' ? 'Kept where this page can read it: this browser\'s key store didn\'t open' : 'Kept where this page can read it (opened without https)');
/** A row under You: its state under its name, amber or red when it wants a look. */
const stateRow = (icon: string, tint: string, label: string, st: RowState, hash: string, cls: string) => h(Row, { icon, tint: st.tone ?? tint, label, sub: st.text || undefined, cls: `you-row ${cls}${st.tone ? ` tone-${st.tone}` : ''}`, onClick: () => push(hash) });

export function YouTab({ tabbar, status }: { tabbar: Child; status: Child }) {
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const rules = useHouse<{ rules: Rules }>({ kind: 'panel.rules' });
  const access = useHouse<AccessView>({ kind: 'panel.access', tz_offset: tz() });
  const over = useHouse<Overview>({ kind: 'panel.overview', tz_offset: tz() });
  const money = useHouse<MoneyView>({ kind: 'panel.money' });
  const k = useHouse<{ recovery: { at: string } | null }>({ kind: 'panel.key' });
  const d = door.data && !door.data.error ? door.data : null;
  return h(Page, { title: 'You', big: true, status, footer: tabbar },
    !d ? h(Failed, { error: door.error }) : h('div', { class: 'profile' },
      h(Avatar, { name: d.handle ?? d.name ?? 'You', size: 72 }),
      h('div', { class: 'profile-text' },
        h('h2', { class: 'handle' }, d.handle ? `@${d.handle}` : 'No handle yet'),
        h('p', {}, d.name ?? (d.open ? 'Anyone\'s AI can write to you' : 'Nobody can write to you now')))),
    h(Section, {},
      stateRow('at-outline', 'mint', 'Your door', doorState(d), '#door', 'door'),
      stateRow('list-outline', 'mint', 'Rules', rulesState(rules.data?.rules), '#rules', 'rules'),
      stateRow('eye-outline', 'blue', 'My data', dataState(access.data, over.data?.record), '#mydata', 'mydata'),
      stateRow('wallet-outline', 'mint', 'Money', moneyState(money.data), '#money', 'money'),
      stateRow('phone-portrait-outline', 'blue', 'This phone', phoneState({ keyInDevice: key.store === 'device', recovery: k.data?.recovery, notify: notifyOn() }), '#phone', 'phone')));
}

/** My data: who can use it now, what has left the house, and what is kept here. */
export function MyDataPage({ backTo }: { backTo: () => void }) {
  const access = useHouse<AccessView>({ kind: 'panel.access', tz_offset: tz() });
  const over = useHouse<Overview>({ kind: 'panel.overview', tz_offset: tz() });
  const list = useHouse<ListView>({ kind: 'list' });
  const left = useHouse<{ total: number; left: Left[] }>({ kind: 'panel.left' });
  const [all, setAll] = useState(false);
  if (!access.data) return h(Page, { title: 'My data', back: backTo, backLabel: 'You' }, h(Failed, { error: access.error }));
  const holders = access.data.agents.filter((r) => r.canSee);
  const ais = (list.data?.assistants ?? []).filter((a) => a.reads?.includes('records'));
  // The same thing to the same one is one row (a study that asks every round said one thing sixty times).
  const out: { x: Left; n: number }[] = [];
  for (const x of left.data?.left ?? []) { const same = out.find((o) => o.x.to === x.to && leftLine(o.x) === leftLine(x)); if (same) same.n++; else out.push({ x, n: 1 }); }
  const rec = over.data?.record;
  // An AI that reads the records and hasn't been here for days still reads them: said, since nothing else would.
  const stale = (a: Assistant) => !!a.seenAt && Date.now() - Date.parse(a.seenAt) > 3 * 86_400_000;
  return h(Page, { title: 'My data', back: backTo, backLabel: 'You' },
    h('p', { class: 'muted-line pad top-line' }, `${holders.length ? `${holders.length === 1 ? '1 agent has' : `${holders.length} agents have`} your yes now.` : 'No agent has your yes now.'} ${ais.length ? `${ais.length === 1 ? '1 of your AIs' : `${ais.length} of your AIs`} can read your records.` : 'No AI reads your records.'}`),
    h(Section, { title: 'Who can use it', cls: 'data-who' },
      ...holders.slice(0, 5).map((r) => {
        const open = r.yeses.filter((c) => c.status === 'active'), latest = [...open].sort((x, y) => y.until.localeCompare(x.until))[0]!;
        return h(Row, { key: r.id, icon: 'eye-outline', tint: 'blue', label: r.domain ?? r.id.replace(/^key:/, 'unverified key '), sub: `${useLine(open)} · ${hoursLeft(latest.until)} left`, cls: 'holder', onClick: () => push('#access') });
      }),
      ...ais.map((a) => h(Row, { key: a.kid, icon: 'sparkles-outline', tint: stale(a) ? 'amber' : 'violet', label: shortName(a.label), sub: stale(a) ? `Not here for ${Math.round((Date.now() - Date.parse(a.seenAt!)) / 86_400_000)} days. Still reads your records.` : `Your AI · reads your records · ${lastHere(a.seenAt).text.toLowerCase()}`, cls: 'reader', onClick: () => push(`#aikey=${encodeURIComponent(a.kid)}`) })),
      h(Row, { icon: 'people-outline', tint: 'muted', label: 'Who has access', sub: 'Everyone who asked, and every yes you gave', onClick: () => push('#access') })),
    left.error && !left.data ? null : h(Section, { title: 'What left your house', cls: 'data-left' },
      ...(out.length ? (all ? out : out.slice(0, 4)).map(({ x, n }, i) => h('ion-item', { key: i, lines: 'full', class: 'left-row' },
        h('div', { slot: 'start', class: `row-icon tint-${x.kind === 'study' ? 'mint' : 'amber'}` }, h('ion-icon', { name: x.kind === 'study' ? 'git-network-outline' : 'arrow-up-outline' })),
        h('ion-label', { class: 'ion-text-wrap' }, h('h3', {}, shortShop(x.to)), h('p', {}, leftLine(x)), h('p', {}, n > 1 ? `${n} times, last ${dayTime(x.at)}` : dayTime(x.at)))))
        : [h('ion-item', { key: 'none', lines: 'none', class: 'left-none' }, h('ion-label', { class: 'ion-text-wrap' }, h('p', {}, left.data ? 'Nothing has left your house yet. A study answered, or what an offer you accept sends, is listed here.' : 'Looking…')))]),
      !all && out.length > 4 ? h(Row, { icon: 'chevron-down', tint: 'muted', label: `Show all ${out.length}`, detail: false, onClick: () => setAll(true) }) : null,
      left.data && left.data.total > left.data.left.length ? h('p', { class: 'muted-line pad' }, `The last ${left.data.left.length} of ${left.data.total}. Download everything has them all.`) : null),
    h(Section, { title: 'Kept here' },
      h(Row, { icon: rec && !rec.ok ? 'alert-circle-outline' : 'folder-open-outline', tint: rec && !rec.ok ? 'red' : 'violet', label: 'What your house holds', sub: rec && !rec.ok ? 'Your record failed its check' : over.data ? `${plural(over.data.claims, 'fact')} about you · signed and unchanged` : undefined, onClick: () => push('#data') }),
      h(Row, { icon: 'download-outline', tint: 'muted', label: 'Download everything', onClick: () => push('#move') })));
}

/** This phone: its notifications, where it keeps your key, the way back in, and signing out. */
export function PhonePage({ backTo }: { backTo: () => void }) {
  const k = useHouse<{ recovery: { at: string } | null }>({ kind: 'panel.key' });
  const on = notifyOn();
  return h(Page, { title: 'This phone', back: backTo, backLabel: 'You' },
    h(Section, {},
      h(Row, { icon: 'notifications-outline', tint: 'amber', label: 'Notifications', note: on ? 'On' : h('span', { class: 'mint' }, 'Turn on'), onClick: () => push('#notify') }),
      // Where this phone keeps your key (SPEC §6.1): said plainly, since over plain HTTP the page itself can read it.
      h(Row, { icon: 'key-outline', tint: key.store === 'device' ? 'mint' : 'amber', label: 'Your key', cls: 'key-store', detail: false, sub: keyLine() }),
      h(Row, { icon: 'phone-portrait-outline', tint: k.data && !k.data.recovery ? 'amber' : 'blue', label: 'New or lost phone', sub: k.data ? (k.data.recovery ? `Recovery code made ${date(k.data.recovery.at)}` : 'No recovery code yet') : undefined, onClick: () => push('#key') }),
      h(Row, { icon: 'information-circle-outline', tint: 'muted', label: 'About this house', onClick: () => push('#about') })),
    h(Section, {}, h('ion-item', { button: true, detail: false, class: 'danger', onClick: async () => { if (await confirm({ header: 'Sign out on this phone?', sub: 'To get back in you\'ll need a pairing link or your recovery code.', button: 'Sign out' })) await signOut(); } }, h('ion-label', { color: 'danger' }, 'Sign out on this device'))));
}

/** What to tell people, their AI's line, your address and a QR code: Share and Copy each. */
function ShareSheet({ d }: { d: DoorState }) {
  const [qr, setQr] = useState<string | null>(null);
  const say = d.handle ? `Ask your AI to "ping ${d.handle}" on the Lake` : '';
  const canShare = 'share' in navigator;
  return h('div', { class: 'sheet-body' },
    say ? h('div', { class: 'say-card' }, h('p', { class: 'say' }, say),
      h('div', { class: 'sheet-actions' }, canShare ? h('ion-button', { shape: 'round', onClick: () => void navigator.share({ title: 'Reach me on the Lake', text: `${say}: my phone gets it, or my AI answers.` }).catch(() => {}) }, h('ion-icon', { name: 'share-outline', slot: 'start' }), 'Share') : null, h(CopyBtn, { text: say, label: 'Copy the line', fill: canShare ? 'outline' : 'solid' }))) : null,
    h('p', { class: 'muted-line' }, 'Your address'),
    h('div', { class: 'copybox mono' }, d.address),
    h('div', { class: 'sheet-actions' }, h(CopyBtn, { text: d.address, label: 'Copy the address' }), h('ion-button', { shape: 'round', fill: 'outline', size: 'small', onClick: async () => setQr(qr ? null : await QRCode.toDataURL(d.address, { margin: 1, width: 480 })) }, h('ion-icon', { name: 'qr-code-outline', slot: 'start' }), qr ? 'Hide QR code' : 'QR code')),
    qr ? h('img', { class: 'qr', alt: 'QR code of your address', width: 220, height: 220, src: qr }) : null);
}

/** A one-time link to a house of their own. */
function InviteSheet() {
  const [inv, setInv] = useState<{ link: string; left: number } | null>(null);
  const canShare = 'share' in navigator;
  return h('div', { class: 'sheet-body' },
    h('p', {}, 'They open it on their phone, pick a handle and get a house of their own. Works once.'),
    inv ? [h('div', { class: 'copybox mono', key: 'l' }, inv.link),
      h('div', { class: 'sheet-actions', key: 'a' }, canShare ? h('ion-button', { shape: 'round', onClick: () => void navigator.share({ title: 'Your invite to the Lake', text: 'Your invite to the Lake: open it on your phone and pick a handle.', url: inv.link }).catch(() => {}) }, h('ion-icon', { name: 'share-outline', slot: 'start' }), 'Share') : null, h(CopyBtn, { text: inv.link })),
      h('p', { class: 'muted-line', key: 'n' }, `${inv.left} invite${inv.left === 1 ? '' : 's'} left.`)]
      : h(Btn, { label: 'Make an invite link', expand: 'block', run: async () => { const r = await must<{ link?: string; left?: number }>({ kind: 'panel.invite' }); if (!r.link) throw new Error('no link'); setInv({ link: r.link, left: r.left ?? 0 }); } }));
}

/** Your door: your handle, a name, the line people see, whether anyone can write to you (saved in your rules), and
 *  how you hand it out: Share, when you can meet, an invite. */
export function DoorPage({ backTo }: { backTo: () => void }) {
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const d = door.data && !door.data.error ? door.data : null;
  const [form, setForm] = useState<{ handle: string; name: string; about: string; note: string } | null>(null);
  const [share, setShare] = useState(false);
  const [invite, setInvite] = useState(false);
  if (!d) return h(Page, { title: 'Your door', back: backTo, backLabel: 'You' }, h(Failed, { error: door.error }));
  const f = form ?? { handle: d.handle ?? '', name: d.name ?? '', about: d.about ?? '', note: d.note ?? '' };
  const set = (k: keyof typeof f) => (e: CustomEvent) => setForm({ ...f, [k]: k === 'handle' ? String(e.detail.value ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '') : String(e.detail.value ?? '') });
  const save = (open: boolean) => async () => { await must({ kind: 'panel.door.set', open, about: f.about, name: f.name, handle: f.handle.trim().toLowerCase(), note: f.note.trim() }); setForm(null); };
  return h(Page, { title: 'Your door', back: backTo, backLabel: 'You' },
    h(Section, {},
      h('ion-item', {}, h('ion-input', { label: 'Handle', labelPlacement: 'stacked', value: f.handle, placeholder: 'e.g. stan', maxlength: 30, autocapitalize: 'none', autocorrect: 'off', spellcheck: false, 'aria-label': 'Your handle', helperText: f.handle ? `People tell their AI: "ping ${f.handle}"` : 'People tell their AI to "ping" it', onionInput: set('handle') })),
      h('ion-item', {}, h('ion-input', { label: 'Name (optional)', labelPlacement: 'stacked', value: f.name, maxlength: 60, 'aria-label': 'Name', onionInput: set('name') })),
      h('ion-item', { lines: 'none' }, h('ion-input', { label: 'A line people see (optional)', labelPlacement: 'stacked', value: f.about, maxlength: 200, placeholder: 'e.g. Your AI can book a call with mine', 'aria-label': 'A line people see', onionInput: set('about') }))),
    // The door note (round 15): the owner's standing reply to people writing for the first time, sent once each by the house.
    h(Section, { title: 'Door note', cls: 'door-note' },
      h('ion-item', { lines: 'none' }, h('ion-textarea', { label: 'Sent once to each new person who writes', labelPlacement: 'stacked', value: f.note, maxlength: 500, counter: true, autoGrow: true, rows: 3, placeholder: 'e.g. Thanks for writing. I read these on Fridays. Bugs: https://…', 'aria-label': 'Door note', onionInput: set('note') })),
      !f.note ? h('ion-item', { lines: 'none' }, h('ion-button', { fill: 'outline', size: 'small', onClick: () => setForm({ ...f, note: 'Thanks for writing. I read these about once a week; I\'ll answer if I can.' }) }, 'Use a suggested text')) : null,
      h('ion-item', { lines: 'none' }, h('ion-label', { class: 'ion-text-wrap' }, h('p', {}, d.note_sent?.sent ? `Went to ${d.note_sent.sent} new ${d.note_sent.sent === 1 ? 'person' : 'people'} in 30 days; ${d.note_sent.wrote_again} wrote again.` : 'Your house sends it, marked as automatic. They stay new people until you answer them.')))),
    h('div', { class: 'pad' }, h(Btn, { label: d.open ? 'Save' : 'Save, and let people write to me', expand: 'block', run: save(true), done: 'Saved' })),
    h(Section, {},
      d.handle ? h(Row, { icon: 'share-outline', label: 'Share how to reach you', cls: 'share-row', detail: false, onClick: () => setShare(true) }) : null,
      h(Row, { icon: 'time-outline', tint: 'blue', label: 'When you can meet', onClick: () => push('#free') }),
      h(Row, { icon: 'person-add-outline', tint: 'violet', label: 'Invite someone', detail: false, onClick: () => setInvite(true) })),
    h(Sheet, { open: share, onClose: () => setShare(false), title: 'How people reach you' }, h(ShareSheet, { d })),
    h(Sheet, { open: invite, onClose: () => setInvite(false), title: 'Invite someone' }, h(InviteSheet, {})),
    d.open ? h(Section, {},
      h(Row, { icon: 'open-outline', tint: 'muted', label: 'Open my public page', onClick: () => window.open(d.address, '_blank', 'noopener') }),
      h('ion-item', { button: true, detail: false, class: 'danger', onClick: async () => { if (await confirm({ header: 'Stop people writing to you?', sub: 'Nobody can write to you until you open it again.', button: 'Stop' })) { await save(false)(); void toast('Nobody can write to you now'); } } }, h('ion-label', { color: 'danger' }, 'Stop people writing to me'))) : null);
}

/** Notifications on this phone: on, a test, off; on an iPhone, how to install first. */
export function NotifyPage({ backTo }: { backTo: () => void }) {
  const [perm, setPerm] = useState(pushable() ? Notification.permission : 'unsupported');
  const ios = iosNotInstalled();
  const re = () => setPerm(pushable() ? Notification.permission : 'unsupported');
  return h(Page, { title: 'Notifications', back: backTo, backLabel: 'You' },
    h('div', { class: 'bigwho' }, h('div', { class: `hero-icon${perm === 'granted' ? ' on' : ''}` }, h('ion-icon', { name: perm === 'granted' ? 'notifications' : 'notifications-off-outline' })), h('h2', {}, perm === 'granted' ? 'On for this phone' : 'Off for this phone'),
      h('p', { class: 'muted-line' }, 'A notification says who wrote. What they wrote stays in your house.')),
    ios ? h('p', { class: 'muted-line pad' }, 'On iPhone: Share → Add to Home Screen, then open your house from that icon and turn them on.')
      : perm === 'unsupported' ? h('p', { class: 'muted-line pad' }, 'This browser can\'t take notifications.')
      : perm === 'denied' ? h('p', { class: 'muted-line pad' }, 'Blocked in this browser: allow them in its site settings.') : null,
    !ios && perm !== 'unsupported' ? h('div', { class: 'pad stack' },
      h(Btn, { label: perm === 'granted' ? 'Turn on again' : 'Turn on', expand: 'block', fill: perm === 'granted' ? 'outline' : 'solid', run: async () => { void toast(await turnOnNotifications()); re(); } }),
      perm === 'granted' ? h(Btn, { label: 'Send a test', expand: 'block', fill: 'outline', run: async () => { await call({ kind: 'panel.push.test' }); }, done: 'A test is on its way' }) : null,
      perm === 'granted' ? h(Btn, { label: 'Turn off', expand: 'block', fill: 'clear', color: 'danger', run: async () => { void toast(await turnOffNotifications()); re(); } }) : null) : null);
}

