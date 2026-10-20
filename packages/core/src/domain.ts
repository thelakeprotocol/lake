import { resolveTxt } from 'node:dns/promises';
import type { LakeProfile } from './card.js';

export type DomainProof = { ok: true; via: 'dns' | 'well-known' | 'sandbox' } | { ok: false; reason: string };

/**
 * Checks that the card's key is published by its claimed owner domain (SPEC §2.3):
 * a DNS TXT record `_lake.<domain>` containing `lake-key=<kid>`, or `https://<domain>/.well-known/lake.json`
 * listing the kid. A sandbox Lake (synthetic data only) skips the check and says so.
 */
export async function proveDomain(profile: LakeProfile, opts: { sandbox?: boolean; fetch?: typeof fetch } = {}): Promise<DomainProof> {
  const domain = profile.ownerDomain.toLowerCase();
  const kid = profile.publicJwk.kid;
  if (opts.sandbox) return { ok: true, via: 'sandbox' };
  try {
    const records = await resolveTxt(`_lake.${domain}`);
    if (records.some((parts) => parts.join('') === `lake-key=${kid}`)) return { ok: true, via: 'dns' };
  } catch {
    // no TXT record; try the well-known file
  }
  try {
    const res = await (opts.fetch ?? fetch)(`https://${domain}/.well-known/lake.json`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { keys?: string[] };
      if (body.keys?.includes(kid!)) return { ok: true, via: 'well-known' };
    }
  } catch {
    // unreachable
  }
  return { ok: false, reason: `${domain} does not publish key ${kid}` };
}
