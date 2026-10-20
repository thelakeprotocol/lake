import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The inspector and the sparring partner fetch and message URLs strangers give them. On a public server
 * that must never reach the machine's own network (cloud metadata, other containers), so private and
 * link-local addresses are refused there. On a dev machine everything is local, so they're allowed.
 */
export async function checkTarget(raw: string, publicOnly: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) URLs');
  if (!publicOnly) return url;
  if (url.protocol !== 'https:') throw new Error('the public sandbox only inspects https URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivate)) throw new Error(`${host} is a private address`);
  return url;
}

function isPrivate(ip: string): boolean {
  if (ip.includes(':')) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:') && isPrivate(ip.slice(7));
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** At most `n` uses per key per window: strangers can ask, but not flood. */
export function rateLimit(n: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= n) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

/** The node's view of the Lake, or nothing if there's no node or it's down. */
export async function fromNode<T>(nodeUrl: string | undefined, path: string): Promise<T | null> {
  if (!nodeUrl) return null;
  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}
