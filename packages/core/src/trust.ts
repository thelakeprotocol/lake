import type { AgentCard } from '@a2a-js/sdk';
import { verifyLakeCard } from './card.js';
import { proveDomain } from './domain.js';
import { verifyCredential, type Credential } from './vc.js';

/** A credential handed over with a message, with the signed card of whoever issued it. */
export interface Attachment {
  credential: string;
  card: AgentCard;
}

export type AttachmentCheck = { ok: true; vc: Credential; domain: string } | { ok: false; why: string };

/**
 * A credential counts only if its issuer's card is genuine, its domain is proved, that domain is one
 * the owner trusts, the signature verifies, and it is about exactly the thing in front of us.
 */
export async function checkAttachment(
  att: Attachment | undefined,
  o: { trusted: string[]; type: string; subject: string; sandbox?: boolean },
): Promise<AttachmentCheck> {
  if (!att?.credential || !att.card) return { ok: false, why: `no ${o.type}` };
  let profile;
  try {
    profile = await verifyLakeCard(att.card);
  } catch (e) {
    return { ok: false, why: `${o.type} issuer card: ${(e as Error).message}` };
  }
  const domain = profile.ownerDomain.toLowerCase();
  if (!o.trusted.map((d) => d.toLowerCase()).includes(domain)) return { ok: false, why: `${o.type} from ${domain}, which you don't trust` };
  const proof = await proveDomain(profile, { sandbox: o.sandbox });
  if (!proof.ok) return { ok: false, why: proof.reason };
  try {
    const vc = await verifyCredential(att.credential, profile.publicJwk);
    if (vc.issuer !== profile.webId) return { ok: false, why: `${o.type} was not issued by its card's owner` };
    if (!vc.type.includes(o.type)) return { ok: false, why: `expected a ${o.type}` };
    if (vc.credentialSubject.id !== o.subject) return { ok: false, why: `${o.type} is for a different study` };
    const until = (vc as Credential & { validUntil?: string }).validUntil;
    if (until && Date.parse(until) < Date.now()) return { ok: false, why: `${o.type} expired` };
    return { ok: true, vc, domain };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}
