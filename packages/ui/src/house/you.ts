import QRCode from 'qrcode';
import { useState } from 'preact/hooks';
import { call, iosNotInstalled, key, must, notifyDismiss, notifyOffer, pushable, signOut, state, turnOffNotifications, turnOnNotifications, useBump, useHouse } from './api';
import { Avatar, Btn, Child, CopyBtn, Failed, Page, Row, Section, Sheet, confirm, h, toast } from './ion';
import { type Address, type DoorState, type ListView } from './logic';
import { push } from './nav';

// You: your handle and how people reach you, then every setting as one grouped list of rows, each a page.

export function YouTab({ tabbar, status }: { tabbar: Child; status: Child }) {
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const circles = useHouse<{ url: string; id: string; view: { text?: string; promise?: string } }[]>({ kind: 'panel.circles' });
  const market = useHouse<{ packs: unknown[] }>({ kind: 'panel.market' });
  const list = useHouse<ListView>({ kind: 'list' });
  const addr = useHouse<{ address: Address | null }>({ kind: 'panel.address' });
  const bump = useBump();
  const [share, setShare] = useState(false);
  const [invite, setInvite] = useState(false);
  const d = door.data && !door.data.error ? door.data : null;
  const notifyOn = pushable() && Notification.permission === 'granted';
  return h(Page, { title: 'You', big: true, status, footer: tabbar },
    !d ? h(Failed, { error: door.error }) : h('div', { class: 'profile' },
      h(Avatar, { name: d.handle ?? d.name ?? 'You', size: 72 }),
      h('div', { class: 'profile-text' },
        h('h2', { class: 'handle' }, d.handle ? `@${d.handle}` : 'No handle yet'),
        h('p', {}, d.name ?? (d.open ? 'Anyone\'s AI can write to you' : 'Nobody can write to you now'))),
      h('div', { class: 'profile-actions' },
        d.handle ? h('ion-button', { shape: 'round', onClick: () => setShare(true) }, h('ion-icon', { name: 'share-outline', slot: 'start' }), 'Share') : h('ion-button', { shape: 'round', onClick: () => push('#door') }, 'Choose a handle'),
        h('ion-button', { shape: 'round', fill: 'outline', onClick: () => push('#door') }, 'Edit'))),
    h(Section, { title: 'Reaching you' },
      h(Row, { icon: 'at-outline', label: 'Handle and public page', note: d?.handle ?? 'Not set', onClick: () => push('#door') }),
      h(Row, { icon: 'notifications-outline', tint: 'amber', label: 'Notifications', note: notifyOn ? 'On' : h('span', { class: 'mint' }, 'Turn on'), onClick: () => push('#notify') }),
      h(Row, { icon: 'time-outline', tint: 'blue', label: 'When you can meet', onClick: () => push('#free') }),
      h(Row, { icon: 'person-add-outline', tint: 'violet', label: 'Invite someone', onClick: () => setInvite(true), detail: false })),
    h(Section, { title: 'Your data' },
      h(Row, { icon: 'list-outline', label: 'Rules', onClick: () => push('#rules') }),
      h(Row, { icon: 'eye-outline', tint: 'blue', label: 'Who has access', onClick: () => push('#access') }),
      market.data?.packs?.length ? h(Row, { icon: 'pricetags-outline', tint: 'amber', label: 'Offers for you', onClick: () => push('#offers') }) : null,
      h(Row, { icon: 'wallet-outline', tint: 'mint', label: 'Money', onClick: () => push('#money') }),
      h(Row, { icon: 'home-outline', tint: 'blue', label: 'Delivery address', note: addr.data?.address ? addr.data.address.addressLocality : 'Not set', onClick: () => push('#address') }),
      h(Row, { icon: 'folder-open-outline', tint: 'violet', label: 'What your house holds', onClick: () => push('#data') })),
    circles.data?.length ? h(Section, { title: 'Circles' }, h(Row, { icon: 'people-outline', tint: 'violet', label: 'Your promise circles', note: String(circles.data.length), onClick: () => push('#circles') })) : null,
    h(Section, { title: 'This phone' },
      // Where this phone keeps your key (SPEC §6.1): said plainly, since over plain HTTP the page itself can read it.
      h(Row, { icon: 'key-outline', tint: key.store === 'device' ? 'mint' : 'amber', label: 'Your key', cls: 'key-store', detail: false, sub: key.store === 'device' ? 'Held by this browser: it signs here and can\'t be copied out' : location.protocol === 'https:' ? 'Kept where this page can read it: this browser\'s key store didn\'t open' : 'Kept where this page can read it (opened without https)' }),
      h(Row, { icon: 'phone-portrait-outline', tint: 'blue', label: 'New or lost phone', onClick: () => push('#key') }),
      h(Row, { icon: 'download-outline', tint: 'muted', label: 'Download everything', onClick: () => push('#move') }),
      h(Row, { icon: 'information-circle-outline', tint: 'muted', label: 'About this house', onClick: () => push('#about') })),
    h(Section, {}, h('ion-item', { button: true, detail: false, class: 'danger', onClick: async () => { if (await confirm({ header: 'Sign out on this phone?', sub: 'To get back in you\'ll need a pairing link or your recovery code.', button: 'Sign out' })) await signOut(); } }, h('ion-label', { color: 'danger' }, 'Sign out on this device'))),
    d ? h(Sheet, { open: share, onClose: () => setShare(false), title: 'How people reach you' }, h(ShareSheet, { d })) : null,
    h(Sheet, { open: invite, onClose: () => setInvite(false), title: 'Invite someone' }, h(InviteSheet, {})),
    void list);
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

/** Your handle, a name, the line people see, and whether anyone can write to you. Saved in your rules. */
export function DoorPage({ backTo }: { backTo: () => void }) {
  const door = useHouse<DoorState>({ kind: 'panel.door' });
  const d = door.data && !door.data.error ? door.data : null;
  const [form, setForm] = useState<{ handle: string; name: string; about: string; note: string } | null>(null);
  if (!d) return h(Page, { title: 'Handle and public page', back: backTo, backLabel: 'You' }, h(Failed, { error: door.error }));
  const f = form ?? { handle: d.handle ?? '', name: d.name ?? '', about: d.about ?? '', note: d.note ?? '' };
  const set = (k: keyof typeof f) => (e: CustomEvent) => setForm({ ...f, [k]: k === 'handle' ? String(e.detail.value ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '') : String(e.detail.value ?? '') });
  const save = (open: boolean) => async () => { await must({ kind: 'panel.door.set', open, about: f.about, name: f.name, handle: f.handle.trim().toLowerCase(), note: f.note.trim() }); setForm(null); };
  return h(Page, { title: 'Handle and public page', back: backTo, backLabel: 'You' },
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

