import { h as ph, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { initialize, actionSheetController, toastController } from '@ionic/core/components';
import { addIcons } from 'ionicons';
import { add, alertCircleOutline, arrowDown, arrowDownOutline, arrowUndoOutline, arrowUp, arrowUpOutline, atOutline, callOutline, mailOutline, calendarOutline, chatbubbleOutline, chatbubbles, chatbubblesOutline, checkmark, checkmarkCircleOutline, checkmarkDoneOutline, chevronBack, chevronDown, chevronUp, close, closeCircle, closeCircleOutline, cloudOfflineOutline, copyOutline, createOutline, downloadOutline, eyeOffOutline, eyeOutline, fileTray, fileTrayOutline, fingerPrintOutline, folderOpenOutline, gitNetworkOutline, globeOutline, handLeftOutline, homeOutline, hourglassOutline, informationCircleOutline, keyOutline, laptopOutline, linkOutline, listOutline, lockClosedOutline, moonOutline, notificationsOffOutline, notificationsOutline, openOutline, people, peopleOutline, personAddOutline, personCircle, personCircleOutline, personOutline, phonePortraitOutline, pricetagsOutline, qrCodeOutline, search, searchOutline, shareOutline, shieldCheckmarkOutline, shieldOutline, sparkles, sparklesOutline, timeOutline, today, todayOutline, trashOutline, walletOutline, warningOutline } from 'ionicons/icons';
import { defineCustomElement as app } from '@ionic/core/components/ion-app.js';
import { defineCustomElement as header } from '@ionic/core/components/ion-header.js';
import { defineCustomElement as toolbar } from '@ionic/core/components/ion-toolbar.js';
import { defineCustomElement as title } from '@ionic/core/components/ion-title.js';
import { defineCustomElement as buttons } from '@ionic/core/components/ion-buttons.js';
import { defineCustomElement as button } from '@ionic/core/components/ion-button.js';
import { defineCustomElement as content } from '@ionic/core/components/ion-content.js';
import { defineCustomElement as footer } from '@ionic/core/components/ion-footer.js';
import { defineCustomElement as tabBar } from '@ionic/core/components/ion-tab-bar.js';
import { defineCustomElement as tabButton } from '@ionic/core/components/ion-tab-button.js';
import { defineCustomElement as icon } from 'ionicons/components/ion-icon.js';
import { defineCustomElement as label } from '@ionic/core/components/ion-label.js';
import { defineCustomElement as badge } from '@ionic/core/components/ion-badge.js';
import { defineCustomElement as list } from '@ionic/core/components/ion-list.js';
import { defineCustomElement as listHeader } from '@ionic/core/components/ion-list-header.js';
import { defineCustomElement as item } from '@ionic/core/components/ion-item.js';
import { defineCustomElement as note } from '@ionic/core/components/ion-note.js';
import { defineCustomElement as avatar } from '@ionic/core/components/ion-avatar.js';
import { defineCustomElement as spinner } from '@ionic/core/components/ion-spinner.js';
import { defineCustomElement as skeleton } from '@ionic/core/components/ion-skeleton-text.js';
import { defineCustomElement as refresher } from '@ionic/core/components/ion-refresher.js';
import { defineCustomElement as refresherContent } from '@ionic/core/components/ion-refresher-content.js';
import { defineCustomElement as toggle } from '@ionic/core/components/ion-toggle.js';
import { defineCustomElement as segment } from '@ionic/core/components/ion-segment.js';
import { defineCustomElement as segmentButton } from '@ionic/core/components/ion-segment-button.js';
import { defineCustomElement as card } from '@ionic/core/components/ion-card.js';
import { defineCustomElement as cardContent } from '@ionic/core/components/ion-card-content.js';
import { defineCustomElement as chip } from '@ionic/core/components/ion-chip.js';
import { defineCustomElement as input } from '@ionic/core/components/ion-input.js';
import { defineCustomElement as textarea } from '@ionic/core/components/ion-textarea.js';
import { defineCustomElement as select } from '@ionic/core/components/ion-select.js';
import { defineCustomElement as selectOption } from '@ionic/core/components/ion-select-option.js';
import { defineCustomElement as modal } from '@ionic/core/components/ion-modal.js';
import { defineCustomElement as toastEl } from '@ionic/core/components/ion-toast.js';
import { defineCustomElement as actionSheet } from '@ionic/core/components/ion-action-sheet.js';
import { defineCustomElement as accordion } from '@ionic/core/components/ion-accordion.js';
import { defineCustomElement as accordionGroup } from '@ionic/core/components/ion-accordion-group.js';
import { defineCustomElement as text } from '@ionic/core/components/ion-text.js';
import { defineCustomElement as checkbox } from '@ionic/core/components/ion-checkbox.js';
import { useBump } from './api';
import { backLabel } from './nav';

// Ionic's components (team-maintained, built for phones: lists, sheets, toasts, skeletons, pull to refresh, safe areas),
// drawn by Preact as plain custom elements, with the Lake's own look on top (theme.css). Animations off under automation,
// so tests see the end state at once.
initialize({ mode: 'ios', animated: !navigator.webdriver });
for (const define of [app, header, toolbar, title, buttons, button, content, footer, tabBar, tabButton, icon, label, badge, list, listHeader, item, note, avatar, spinner, skeleton, refresher, refresherContent, toggle, segment, segmentButton, card, cardContent, chip, input, textarea, select, selectOption, modal, toastEl, actionSheet, accordion, accordionGroup, text, checkbox]) define();
// Only the icons used here, by their kebab-case names (the whole set would weigh a megabyte).
const icons = { add, alertCircleOutline, arrowDown, arrowDownOutline, arrowUndoOutline, arrowUp, arrowUpOutline, atOutline, callOutline, mailOutline, calendarOutline, chatbubbleOutline, chatbubbles, chatbubblesOutline, checkmark, checkmarkCircleOutline, checkmarkDoneOutline, chevronBack, chevronDown, chevronUp, close, closeCircle, closeCircleOutline, cloudOfflineOutline, copyOutline, createOutline, downloadOutline, eyeOffOutline, eyeOutline, fileTray, fileTrayOutline, fingerPrintOutline, folderOpenOutline, gitNetworkOutline, globeOutline, handLeftOutline, homeOutline, hourglassOutline, informationCircleOutline, keyOutline, laptopOutline, linkOutline, listOutline, lockClosedOutline, moonOutline, notificationsOffOutline, notificationsOutline, openOutline, people, peopleOutline, personAddOutline, personCircle, personCircleOutline, personOutline, phonePortraitOutline, pricetagsOutline, qrCodeOutline, search, searchOutline, shareOutline, shieldCheckmarkOutline, shieldOutline, sparkles, sparklesOutline, timeOutline, today, todayOutline, trashOutline, walletOutline, warningOutline };
addIcons(Object.fromEntries(Object.entries(icons).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v])));
// The logo, an arc over a dot, as Today's tab icon: filled when selected, outlined otherwise.
// (Ionicons parses an svg data URL's text as it stands, so it isn't percent-encoded.)
const LAKE = (dot: string) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' class='ionicon' viewBox='0 0 512 512'><path d='M88 304a168 168 0 0 1 336 0' fill='none' stroke='currentColor' stroke-width='40' stroke-linecap='round'/>${dot}</svg>`;
addIcons({ lake: LAKE("<circle cx='256' cy='328' r='64' fill='currentColor'/>"), 'lake-outline': LAKE("<circle cx='256' cy='328' r='52' fill='none' stroke='currentColor' stroke-width='32'/>") });

export type Child = ComponentChildren;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const h = (tag: any, props?: Record<string, unknown> | null, ...children: Child[]): VNode => ph(tag, (props ?? null) as never, ...(children as never[]));

// Above the tab bar; in a chat, above the message box (a toast over it hid what you were typing).
const anchor = () => document.querySelector<HTMLElement>('.chat-page ion-footer') ?? document.getElementById('tabbar') ?? undefined;

let shown: HTMLIonToastElement | undefined;

/** A short message at the bottom, gone by itself; with buttons when there's something to do next (Undo, Always allow). */
export async function toast(message: string, o: { color?: string; duration?: number; buttons?: { text: string; handler: () => void | Promise<void> }[] } = {}) {
  const t = await toastController.create({ message, duration: o.duration ?? (o.buttons ? 6000 : 2400), color: o.color ?? 'dark', position: 'bottom', positionAnchor: anchor(), buttons: o.buttons?.map((b) => ({ text: b.text, handler: () => { void b.handler(); } })), cssClass: 'lake-toast' });
  // One at a time: a newer one takes the older one's place (two used to sit on top of each other).
  void shown?.dismiss().catch(() => {});
  shown = t;
  await t.present();
}

/** Asked before anything that can't be undone: a sheet from the bottom with the action in red and Cancel. */
export async function confirm(o: { header: string; button: string; sub?: string; destructive?: boolean }): Promise<boolean> {
  const s = await actionSheetController.create({ header: o.header, subHeader: o.sub, buttons: [{ text: o.button, role: o.destructive === false ? 'selected' : 'destructive', data: true }, { text: 'Cancel', role: 'cancel' }] });
  await s.present();
  const r = await s.onDidDismiss();
  return r.data === true;
}

/** One of a few answers, on a sheet from the bottom; nothing when it's cancelled. */
export async function choose(o: { header: string; sub?: string; options: { text: string; value: string }[] }): Promise<string | undefined> {
  const s = await actionSheetController.create({ header: o.header, subHeader: o.sub, buttons: [...o.options.map((x) => ({ text: x.text, data: x.value })), { text: 'Cancel', role: 'cancel' }] });
  await s.present();
  const r = await s.onDidDismiss();
  return typeof r.data === 'string' ? r.data : undefined;
}

/**
 * A button that does something at the house: a spinner while it runs (the label stays, so it doesn't jump), an error as a
 * toast, and everything fetched again after. With `ask`, a confirm sheet first; with `pick`, a sheet of answers, and the
 * one chosen is given to `run`.
 */
export function Btn(p: { label: Child; run: (picked?: string) => Promise<unknown>; pick?: Parameters<typeof choose>[0]; fill?: 'solid' | 'outline' | 'clear'; color?: string; expand?: 'block' | 'full'; size?: 'small' | 'default' | 'large'; icon?: string; ask?: { header: string; button: string; sub?: string; destructive?: boolean }; done?: string; cls?: string; disabled?: boolean; label2?: string }) {
  const bump = useBump();
  const [busy, setBusy] = useState(false);
  return h('ion-button', {
    class: `lake-btn ${p.cls ?? ''}`, fill: p.fill ?? 'solid', color: p.color ?? 'primary', expand: p.expand, size: p.size ?? 'default', shape: 'round',
    // Always a real boolean: Ionic reads an empty value (what an unset prop becomes after being true) as disabled.
    disabled: !!(busy || p.disabled),
    'aria-label': p.label2,
    onClick: async () => {
      if (busy) return;
      if (p.ask && !(await confirm(p.ask))) return;
      const picked = p.pick ? await choose(p.pick) : undefined;
      if (p.pick && !picked) return;
      setBusy(true);
      try { await p.run(picked); if (p.done) void toast(p.done); } catch (e) { void toast((e as Error).message, { color: 'danger', duration: 5000 }); } finally { setBusy(false); bump(); }
    },
  }, busy ? h('ion-spinner', { name: 'crescent', slot: 'start', class: 'btn-spin' }) : p.icon ? h('ion-icon', { name: p.icon, slot: 'start' }) : null, p.label);
}

/** Copies, and says so. */
export function CopyBtn({ text, label = 'Copy', fill = 'outline' }: { text: string; label?: string; fill?: 'solid' | 'outline' | 'clear' }) {
  return h('ion-button', { fill, shape: 'round', size: 'small', class: 'lake-btn', onClick: async () => { try { await navigator.clipboard.writeText(text); void toast('Copied'); } catch { void toast('Copy failed', { color: 'danger' }); } } }, h('ion-icon', { name: 'copy-outline', slot: 'start' }), label);
}

/** A page: a header (big title that shrinks as you scroll on the tabs; back and a small title on pages), pull to refresh. */
export function Page(p: { title: string; big?: boolean; back?: () => void; backLabel?: string; end?: Child; status?: Child; children: Child; footer?: Child; cls?: string; titleNode?: Child }) {
  const bump = useBump();
  const label = p.titleNode ? undefined : backLabel(p.backLabel);
  // The title is centred, so a long one leaves no room for Back's word at phone width: the chevron stays, as on a phone's own apps.
  const fits = !!label && label.length * 2 + p.title.length <= 30;
  return h('div', { class: `ion-page lake-page ${p.cls ?? ''}` },
    h('ion-header', { translucent: true, class: 'lake-header' },
      h('ion-toolbar', {},
        p.back ? h('ion-buttons', { slot: 'start' }, h('ion-button', { class: 'back', fill: 'clear', onClick: p.back, 'aria-label': `Back${label ? ` to ${label}` : ''}` }, h('ion-icon', { name: 'chevron-back', slot: 'start' }), fits ? label : '')) : null,
        p.titleNode ?? h('ion-title', {}, p.title),
        p.end || p.status ? h('ion-buttons', { slot: 'end' }, p.status, p.end) : null)),
    h('ion-content', { fullscreen: true, class: 'lake-content' },
      h('ion-refresher', { slot: 'fixed', onionRefresh: (e: CustomEvent) => { bump(); setTimeout(() => (e.target as HTMLElement & { complete: () => void }).complete(), 700); } }, h('ion-refresher-content', {})),
      p.big ? h('ion-header', { collapse: 'condense' }, h('ion-toolbar', {}, h('ion-title', { size: 'large' }, p.title))) : null,
      h('div', { class: 'lake-body' }, p.children)),
    p.footer ? h('ion-footer', { class: 'lake-footer' }, p.footer) : null);
}

/** Lists load as grey rows, not as a blank page. */
export const Skel = ({ rows = 4 }: { rows?: number }) => h('ion-list', { inset: true, class: 'lake-list' }, ...Array.from({ length: rows }, (_, i) => h('ion-item', { key: i, lines: 'full' },
  h('ion-avatar', { slot: 'start' }, h('ion-skeleton-text', { animated: true })),
  h('ion-label', {}, h('h3', {}, h('ion-skeleton-text', { animated: true, style: 'width:55%' })), h('p', {}, h('ion-skeleton-text', { animated: true, style: 'width:85%' }))))));

/** The first answer didn't come: say so, with Retry. */
export function Failed({ error }: { error?: string }) {
  const bump = useBump();
  if (!error) return h(Skel, {});
  return h(Empty, { icon: 'cloud-offline-outline', title: 'Can\'t reach your house', text: error, action: h('ion-button', { shape: 'round', onClick: bump }, 'Try again') });
}

/** Nothing here yet: an icon, one line, and the one thing to do. */
export const Empty = ({ icon, title, text, action }: { icon: string; title: string; text?: string; action?: Child }) => h('div', { class: 'lake-empty' },
  h('div', { class: 'empty-icon' }, h('ion-icon', { name: icon })), h('h3', {}, title), text ? h('p', {}, text) : null, action ?? null);

/** A group of rows, inset, with a small heading. */
export const Section = ({ title, children, cls }: { title?: string; children: Child; cls?: string }) => h('ion-list', { inset: true, class: `lake-list ${cls ?? ''}` }, title ? h('ion-list-header', {}, h('ion-label', {}, title)) : null, children);

/** A row you tap: icon, label, a line under it, the current value at the end, a chevron. */
export function Row(p: { icon?: string; tint?: string; label: Child; sub?: Child; note?: Child; below?: Child; onClick?: () => void; detail?: boolean; badge?: Child; cls?: string; lines?: string; danger?: boolean; start?: Child }) {
  return h('ion-item', { button: !!p.onClick, detail: p.detail ?? !!p.onClick, onClick: p.onClick, class: `lake-row ${p.cls ?? ''}${p.danger ? ' danger' : ''}`, lines: p.lines },
    p.start ?? (p.icon ? h('div', { slot: 'start', class: `row-icon tint-${p.tint ?? 'mint'}` }, h('ion-icon', { name: p.icon })) : null),
    h('ion-label', { class: p.below ? 'ion-text-wrap' : undefined }, h('h3', {}, p.label), p.sub ? h('p', {}, p.sub) : null, p.below ? h('div', { class: 'row-below' }, p.below) : null),
    p.badge ? h('ion-badge', { slot: 'end', color: 'primary' }, p.badge) : null,
    p.note ? h('ion-note', { slot: 'end' }, p.note) : null);
}

/** A colourful round avatar from a name (the same name, the same colour), ringed by how much you know them. */
const HUES = [152, 190, 222, 262, 292, 330, 20, 42];
export function Avatar({ name, ring, size = 44, iconName }: { name: string; ring?: 'known' | 'new' | 'lookalike'; size?: number; iconName?: string }) {
  let hsh = 0; for (const c of name) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  const hue = HUES[hsh % HUES.length]!;
  const ini = name.replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return h('div', { class: `lake-avatar${ring ? ` ring-${ring}` : ''}`, style: `--hue:${hue};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`, 'aria-hidden': 'true' }, iconName ? h('ion-icon', { name: iconName }) : ini);
}

/** A small pill: Known, New, AI, On duty. */
export const Pill = ({ text, tone = 'muted' }: { text: string; tone?: 'mint' | 'amber' | 'red' | 'violet' | 'muted' }) => h('span', { class: `lake-pill tone-${tone}` }, text);

/** A bottom sheet with its own content; drag down or tap outside to close. */
export function Sheet({ open, onClose, children, title, full, short, half }: { open: boolean; onClose: () => void; children: Child; title?: string; full?: boolean; short?: boolean; half?: boolean }) {
  // Leaving the screen closes it (Ionic moves an open sheet to the top of the app, out of the screen's reach).
  const ref = useRef<HTMLElement & { dismiss: () => Promise<boolean> }>(null);
  useEffect(() => () => { void ref.current?.dismiss?.(); ref.current?.remove(); }, []);
  return h('ion-modal', { ref, isOpen: open, onionModalDidDismiss: onClose, initialBreakpoint: full ? undefined : short ? 0.38 : half ? 0.55 : 0.9, breakpoints: full ? undefined : short ? [0, 0.38, 0.9] : half ? [0, 0.55, 0.9] : [0, 0.6, 0.9, 1], handle: !full, class: 'lake-sheet' },
    h('div', { class: 'sheet-inner' },
      title ? h('div', { class: 'sheet-head' }, h('h2', {}, title), h('ion-button', { fill: 'clear', shape: 'round', onClick: onClose, 'aria-label': 'Close' }, h('ion-icon', { name: 'close' }))) : null,
      open ? children : null));
}

/** A longer explanation, behind an (i): the screens stay short. */
export function Info({ children }: { children: Child }) {
  const [open, setOpen] = useState(false);
  return h('span', { class: 'lake-info' }, h('button', { type: 'button', class: 'info-btn', 'aria-label': 'More about this', onClick: () => setOpen(!open) }, h('ion-icon', { name: open ? 'close-circle-outline' : 'information-circle-outline' })), open ? h('div', { class: 'info-text' }, children) : null);
}
