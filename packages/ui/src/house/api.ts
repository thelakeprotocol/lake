import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
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

/** One signed call, fetched again whenever something changed; keeps what it had while it fetches, so nothing flickers. */
export function useHouse<T>(payload: Record<string, unknown>): { data?: T; error?: string } {
  const { version } = useContext(Version);
  const k = JSON.stringify(payload);
  const [s, set] = useState<{ data?: T; error?: string }>(() => ({ data: cached<T>(k) }));
  useEffect(() => {
    let live = true;
    call<T>(payload).then((data) => { if (!PRIVATE.has(String(payload.kind))) remember(k, data); if (live) set({ data }); }, (e: Error) => live && set((x) => ({ ...x, error: e.message })));
    return () => { live = false; };
  }, [k, version]);
  return s;
}

/** Your key lives only on this device: signing out forgets it here, and what the screens last showed. */
export async function signOut() {
  forgetting = true;
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
