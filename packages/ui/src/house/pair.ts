import { useEffect, useState } from 'preact/hooks';
import { api, call, houseBase, key, state } from './api';
import { ReadsToggles } from './ai';
import { Btn, h } from './ion';
import type { Reads } from './logic';

// Before the house is yours on this phone: make this phone its key. And an AI app signing in through this house.

/** Not yours yet: this house's name and the one thing to do. */
export function Pair({ onPaired, why }: { onPaired: () => void; why?: string }) {
  const [msg, setMsg] = useState(why ?? '');
  const [code, setCode] = useState('');
  const name = /\/t\/([^/]+)\/owner\//.exec(location.pathname)?.[1];
  const pair = async (withCode?: string) => {
    const token = new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined;
    const res = await fetch(`${api}pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicJwk: key.jwk, token, ...(withCode ? { recovery: withCode } : {}) }) });
    const body = await res.json();
    if (!res.ok) { setMsg(body.error ?? 'pairing failed'); return; }
    state.webId = body.webId;
    state.leaseUntil = body.until ?? null;
    history.replaceState(null, '', location.pathname);
    onPaired();
  };
  // A link that carries a token pairs at once. Without one, only a house nobody holds can be paired with a tap.
  const [open, setOpen] = useState<boolean | null>(null);
  const [handle, setHandle] = useState('');
  useEffect(() => {
    if (location.hash.includes('pair=')) void pair();
    else void fetch(`${api}pair`).then((r) => r.json()).then((b: { open?: boolean; handle?: string }) => { setOpen(!!b.open); setHandle(b.handle ?? ''); }, () => setOpen(true));
  }, []);
  const owned = open === false;
  return h('div', { class: 'ion-page lake-page welcome' }, h('ion-content', { class: 'lake-content' }, h('div', { class: 'welcome-inner' },
    h('div', { class: 'welcome-mark', 'aria-hidden': 'true' }, h('svg', { viewBox: '0 0 64 64', width: 52, height: 52 }, h('path', { d: 'M11 38 A21 21 0 0 1 53 38', fill: 'none', stroke: 'currentColor', 'stroke-width': 5.5, 'stroke-linecap': 'round' }), h('circle', { cx: 32, cy: 41, r: 8, fill: 'currentColor' }))),
    h('p', { class: 'welcome-kicker' }, handle && !owned ? 'Your house, almost ready' : 'A house on the Lake'),
    h('h1', {}, handle || (name ? `House ${name}` : 'A house on the Lake')),
    h('p', { class: 'welcome-text' }, owned
      ? 'This house already has a key. Open a pairing link from the phone that has it (You → New or lost phone), or use your recovery code.'
      : 'This phone becomes the only thing that can answer for you. The key is made here and never leaves it.'),
    owned ? null : h(Btn, { label: 'Use this phone', expand: 'block', size: 'large', disabled: open === null, run: () => pair() }),
    msg ? h('p', { class: 'welcome-msg', role: 'alert' }, msg) : null,
    h('ion-accordion-group', { class: 'lake-accordion', value: owned ? 'rec' : undefined }, h('ion-accordion', { value: 'rec' },
      h('ion-item', { slot: 'header' }, h('ion-label', {}, 'Have a recovery code?')),
      h('div', { slot: 'content', class: 'pad stack' },
        h('ion-input', { class: 'recovery-input', value: code, placeholder: 'XXXXX-XXXXX-XXXXX', autocomplete: 'off', 'aria-label': 'Recovery code', fill: 'outline', onionInput: (e: CustomEvent) => setCode(String(e.detail.value ?? '')) }),
        h(Btn, { label: 'Use it', fill: 'outline', expand: 'block', disabled: !code.trim(), run: () => pair(code.trim()) })))))));
}

/**
 * An AI app signing in through this house (the connector's sign-in page sent the person here): read once, before
 * pairing (which may clear the address), so it survives it.
 */
export const connecting = (() => {
  const q = new URLSearchParams(location.hash.slice(1));
  const ask = q.get('connect'), back = q.get('back');
  if (!ask || !back) return null;
  history.replaceState(null, '', location.pathname);
  return { ask, back, app: (q.get('app') ?? 'An AI app').slice(0, 60), from: (q.get('from') ?? '').slice(0, 100) };
})();

/** "Connect Claude to your house?": one tap with your key makes it your assistant here, and sends you back to it. */
export function ConnectAI({ c, done }: { c: NonNullable<typeof connecting>; done: () => void }) {
  const [reads, setReads] = useState<Reads[]>([]);
  // The code goes only to a sign-in on this house's own Lake: a link from anywhere else can't collect one.
  let ok = false;
  try { const u = new URL(c.back, location.href); ok = u.origin === location.origin && u.pathname.endsWith('/oauth/approve'); } catch { /* not a URL */ }
  const go = async () => {
    const r = await call<{ code: string }>({ kind: 'panel.assistant.invite', label: c.app, reads });
    const f = document.createElement('form');
    f.method = 'post';
    f.action = c.back;
    for (const [k, v] of Object.entries({ ask: c.ask, house: houseBase(), code: r.code })) {
      const i = document.createElement('input');
      i.type = 'hidden'; i.name = k; i.value = v;
      f.append(i);
    }
    document.body.append(f);
    f.submit();
    await new Promise(() => {}); // leaving the page
  };
  return h('div', { class: 'ion-page lake-page welcome' }, h('ion-content', { class: 'lake-content' }, h('div', { class: 'welcome-inner' },
    h('div', { class: 'welcome-mark ai', 'aria-hidden': 'true' }, h('ion-icon', { name: 'sparkles' })),
    h('p', { class: 'welcome-kicker' }, 'Your house on the Lake'),
    h('h1', {}, `Connect ${c.app}?`),
    ok ? [
      h('ul', { class: 'welcome-points', key: 'p' },
        h('li', {}, h('ion-icon', { name: 'eye-outline' }), 'Reads the messages at your door and suggests'),
        h('li', {}, h('ion-icon', { name: 'hand-left-outline' }), 'Only you decide anything'),
        h('li', {}, h('ion-icon', { name: 'trash-outline' }), 'Remove it any time, on My AI')),
      h('div', { key: 'r', class: 'welcome-reads' }, h(ReadsToggles, { value: reads, onChange: setReads })),
      c.from ? h('p', { class: 'welcome-text', key: 'f' }, `It goes back to ${c.from}.`) : null,
      h(Btn, { key: 'b', label: 'Connect', expand: 'block', size: 'large', run: go }),
      h('ion-button', { key: 'n', expand: 'block', fill: 'clear', color: 'medium', onClick: done }, 'Not now'),
    ] : [
      h('p', { class: 'welcome-text', key: 't' }, 'This sign-in didn\'t come from this house\'s own Lake, so it isn\'t offered here.'),
      h('ion-button', { key: 'b', expand: 'block', shape: 'round', onClick: done }, 'Back to my house'),
    ])));
}
