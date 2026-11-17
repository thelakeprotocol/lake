import { hostname } from 'node:os';

const LOOPBACK = (h: string) =>
  h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '0.0.0.0' || h === '::1' || h === '::' || /^::ffff:(127\.|0\.0\.0\.0|7f[0-9a-f]{2}:|0:0$)/i.test(h); // the URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1
const LINK_LOCAL = (h: string) => /^169\.254\./.test(h) || /^fe80:/i.test(h) || /^::ffff:(169\.254\.|a9fe:)/i.test(h);

/**
 * Why a URL an outsider gave would make this house call into its own machine, or null if it wouldn't (round 76, an
 * attacker: a seller's card named http://127.0.0.1:<pod port>, and the house posted to it when the offer ended, with no
 * owner action). Loopback, link-local (a cloud's metadata address), the unspecified address, this machine's own name,
 * or the pod's own host and port. A house that itself runs on loopback (a laptop, the tests) may call anything; other
 * services on the operator's own network (a private address, a one-word name) pass: the operator chose them.
 */
export function callsHome(url: string, house: { publicUrl: string; podRoot?: string }): string | null {
  let u: URL, me: URL;
  try { u = new URL(url); me = new URL(house.publicUrl); } catch { return 'not an http address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'not an http address';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK(me.hostname.replace(/^\[|\]$/g, '').toLowerCase())) return null;
  if (LOOPBACK(host)) return 'it points at this machine';
  if (LINK_LOCAL(host)) return 'it points at a link-local address';
  if (host === hostname().toLowerCase()) return 'it points at this machine';
  if (house.podRoot) {
    try { const pod = new URL(house.podRoot); if (pod.hostname.toLowerCase() === host && (pod.port || '80') === (u.port || (u.protocol === 'https:' ? '443' : '80'))) return 'it points at this house\'s pod'; } catch { /* no pod address */ }
  }
  return null;
}
