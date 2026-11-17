import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { forgetKey, loadKey, settleSpare, signEnvelope, spareKey } from '../owner-crypto';

// Talking to the house. Every call is signed on this device with the owner's key, which never leaves it; the house only
// checks. Screens are functions of what the house said, fetched again when it says something changed.

export const key = await loadKey();
// A second, readable key beside the device's own: settled by the house's first answer (see call).
let spare = !!spareKey(key);
export const api = new URL('./', location.href).href; // served at /owner/
export const state = { webId: '', leaseUntil: null as string | null };
export const houseBase = () => location.origin + location.pathname.replace(/\/owner\/.*$/, '');

/** Whether the house is answering, as the last call found: the status chip in the header. */
export let reachable = true;
export const reachWatchers = new Set<(ok: boolean) => void>();
const reached = (ok: boolean) => { if (ok !== reachable) { reachable = ok; for (const w of reachWatchers) w(ok); } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call<T = any>(payload: Record<string, unknown>): Promise<T> {
  let res: Response;
  // Never a button that spins for ever: a house that restarted mid-call (13 Nov, a pledge answer) leaves the request hanging.
  try { res = await fetch(`${api}api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signEnvelope({ ...payload, aud: houseBase() }, key, state.webId || 'owner')), signal: AbortSignal.timeout(45_000) }); } catch (e) { reached(false); throw (e as Error).name === 'TimeoutError' ? new Error('Your house didn\'t answer in time. Try again in a moment.') : e; }
  reached(true);
  if (!res.ok) {
    // No words from the house (it threw, or the proxy in front answered for it): say so, never a bare number.
    const error = (await res.json().catch(() => ({}))).error ?? (res.status >= 500 ? `Your house couldn't do that just now (${res.status}). Try again in a moment.` : `Your house said no (${res.status}).`);
    // Two keys on this device (an earlier version's slip) and the house knows the other one: that one moves in, once.
    if (res.status === 403 && spare && /^no key \S+ for /.test(String(error))) { spare = false; if (await settleSpare(key, false)) { location.reload(); return new Promise<T>(() => {}); } }
    // This device's key isn't the house's any more (moved to another device, or recovered there): back to pairing.
    // Only that answer ("no key … for …"): an expired or replayed signature, or a phone's clock off, is not a lost key.
    if (res.status === 403 && state.webId && /^no key \S+ for /.test(String(error))) dispatchEvent(new CustomEvent('lake:not-the-key', { detail: error }));
    throw new Error(error);
  }
  if (spare) { spare = false; void settleSpare(key, true); }
  return res.json();
}

/** A call whose answer may carry { error } or { kind: 'refused', problems }: thrown, so a button shows it. */
export async function must<T = Record<string, unknown>>(payload: Record<string, unknown>): Promise<T> {
  const r = await call<T & { error?: string; kind?: string; problems?: string[]; ok?: boolean }>(payload);
  if (r?.error || r?.kind === 'refused') throw new Error(r.error ?? (r.problems ?? ['refused']).join('; '));
  return r;
}

/**
 * What each screen last showed, shown at once while it's fetched again (stale-while-revalidate). Kept for this tab only
 * (sessionStorage) and for at most 12 hours: what a house holds is private, and a phone may be shared.
 */
export const CACHE = `lake-panel:${location.pathname}:`;
const CACHE_MS = 12 * 3_600_000;
export const cached = <T>(k: string): T | undefined => {
  try {
    const v = JSON.parse(sessionStorage.getItem(CACHE + k) ?? 'null') as { at: number; v: T } | null;
    return v && Date.now() - v.at < CACHE_MS ? v.v : undefined;
  } catch { return undefined; }
};
// Set on sign-out: a fetch still landing must not put back what was just cleared.
let forgetting = false;
export const remember = (k: string, v: unknown) => { if (forgetting) return; try { sessionStorage.setItem(CACHE + k, JSON.stringify({ at: Date.now(), v })); } catch { /* full or private */ } };
try { for (const k of Object.keys(localStorage)) if (k.startsWith('lake-panel:')) localStorage.removeItem(k); } catch { /* nothing kept */ }

/** `version` goes up when the house says something changed (its stream), and after anything done here (bump). */
export const Version = createContext({ version: 0, bump: () => {} });
export const useBump = () => useContext(Version).bump;
export const useRedraw = () => { const [, set] = useState(0); return () => set((n) => n + 1); };

/** Kept off the phone's quick-start cache: what the house holds about its owner, their money, an export (round 10). */
const PRIVATE = new Set(['panel.data', 'panel.money', 'panel.export', 'panel.address', 'panel.consents', 'panel.left']);
/**
 * Those are kept in this page's memory only, never written to the phone, so opening one again shows what it last said at
 * once while it fetches (18 Nov, the owner: "the loading states are very long": Money and My data started from a skeleton
 * on every visit). Gone when the app is closed or signed out.
 */
const inMemory = new Map<string, unknown>();
const lastSaid = <T>(k: string): T | undefined => cached<T>(k) ?? (inMemory.get(k) as T | undefined);
/** The slow private looks, fetched once in the background after the app opens, so the first tap on them is quick too. */
export function warmPrivate(version: number) {
  for (const payload of [{ kind: 'panel.money' }, { kind: 'panel.left' }, { kind: 'panel.data' }]) {
    const k = JSON.stringify(payload);
    if (!inMemory.has(k)) shared(payload, version).then((d) => { if (!forgetting && !inMemory.has(k)) inMemory.set(k, d); }, () => {});
  }
}

/** The same look asked again for the same change, while it is still on its way, waits for that one: every screen asking at
 *  once made a slow house slower (14 Nov). Never across a change (an answer from before it would be stale), and only for
 *  looks (useHouse and the list), never for something done. */
const inflight = new Map<string, Promise<unknown>>();
export function shared<T>(payload: Record<string, unknown>, version: number): Promise<T> {
  const k = `${version}|${JSON.stringify(payload)}`;
  let p = inflight.get(k) as Promise<T> | undefined;
  if (!p) { p = call<T>(payload).finally(() => inflight.delete(k)); inflight.set(k, p); }
  return p;
}

/**
 * One signed call, fetched again whenever something changed; keeps what it had while it fetches, so nothing flickers.
 * A call on its way is never thrown away for a newer change: whichever answer is newest so far is shown (17 Nov: on a
 * busy house "changed" came every second or two, each threw away the call before it, and a look that took longer than
 * that never showed: Money, What your house holds and What left your house loaded for ever).
 */
export function useHouse<T>(payload: Record<string, unknown>): { data?: T; error?: string } {
  const { version } = useContext(Version);
  const k = JSON.stringify(payload);
  const [s, set] = useState<{ data?: T; error?: string }>(() => ({ data: lastSaid<T>(k) }));
  // Each fetch numbered as it starts; an answer is shown unless a newer one already was. Two on their way at most: a
  // change while two are out waits for one of them, then fetches once more.
  const me = useRef({ k, payload, version, started: 0, shown: 0, flying: 0, again: false, mounted: true });
  me.current.k = k; me.current.payload = payload; me.current.version = version;
  useEffect(() => () => { me.current.mounted = false; }, []);
  useEffect(() => {
    const m = me.current;
    const run = () => {
      if (m.flying >= 2) { m.again = true; return; }
      const key = m.k, body = m.payload, n = ++m.started;
      m.flying++;
      shared<T>(body, m.version).then((data) => {
        if (!PRIVATE.has(String(body.kind))) remember(key, data); else if (!forgetting) inMemory.set(key, data);
        if (m.mounted && m.k === key && n > m.shown) { m.shown = n; set({ data }); }
      }, (e: Error) => { if (m.mounted && m.k === key && n > m.shown) set((x) => ({ ...x, error: e.message })); })
        .finally(() => { m.flying--; if (m.again && m.mounted) { m.again = false; run(); } });
    };
    run();
  }, [k, version]);
  return s;
}

/** Your key lives only on this device: signing out forgets it here, and what the screens last showed. */
export async function signOut() {
  forgetting = true;
  inMemory.clear();
  await forgetKey();
  try {
    localStorage.setItem('lake-houses', JSON.stringify((JSON.parse(localStorage.getItem('lake-houses') ?? '[]') as string[]).filter((x) => x !== houseBase())));
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(CACHE)) sessionStorage.removeItem(k);
  } catch { /* nothing kept */ }
  location.reload();
}

// ---- notifications (Web Push) ----
export const pushable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const iosNotInstalled = () => /iPhone|iPad/.test(navigator.userAgent) && !(navigator as unknown as { standalone?: boolean }).standalone && !matchMedia('(display-mode: standalone)').matches;
export const notifyOffer = () => {
  try { if (localStorage.getItem('lake-notify') === 'dismissed') return false; } catch { /* private mode */ }
  return (pushable() && Notification.permission !== 'granted') || iosNotInstalled();
};
export const notifyDismiss = () => { try { localStorage.setItem('lake-notify', 'dismissed'); } catch { /* private mode */ } };
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
export async function turnOnNotifications(): Promise<string> {
  const reg = await navigator.serviceWorker.register('./owner-sw.js', { scope: './' });
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site: allow them in your browser settings.');
  const { publicKey } = await call<{ publicKey: string }>({ kind: 'panel.push.key' });
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(publicKey) }));
  await call({ kind: 'panel.push.subscribe', subscription: sub.toJSON() });
  await call({ kind: 'panel.push.test' });
  return 'On for this phone. A test notification is on its way.';
}
export async function turnOffNotifications(): Promise<string> {
  const reg = await navigator.serviceWorker.getRegistration('./');
  const sub = await reg?.pushManager.getSubscription();
  await call({ kind: 'panel.push.off', ...(sub ? { endpoint: sub.endpoint } : {}) });
  await sub?.unsubscribe().catch(() => false);
  notifyDismiss();
  return 'Off for this phone.';
}
