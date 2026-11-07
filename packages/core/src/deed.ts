import { createHash } from 'node:crypto';
import type * as jose from 'jose';
import { issueCredential, verifyCredential, type Credential } from './vc.js';
import type { Identity } from './crypto.js';

/**
 * Certified good deeds (SPEC §6.7): an organisation's agent certifies one hour of help as an Open Badges 3.0
 * credential (W3C VC 2.0, achievementType CommunityService, creditsEarned 1), bound to the helper's key; anyone may
 * accept it as payment for their time, and the organisation redeems each one once, for one cart.
 */
export const DEED_ASSET = 'HUR';
/** A favour note as payment (SPEC §11.4c): one favour owed, passed to the seller. */
export const FAVOUR_ASSET = 'FAV';
/** What a deed is counted in, as Open Payments writes an amount: one hour, whole. */
export const DEED_AMOUNT = { value: 1, assetCode: DEED_ASSET, assetScale: 0 } as const;

export const OB3_CONTEXT = 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json';

/** One task an organisation certifies when it's done, with a check anyone can read: no person judges the answer. */
export interface DeedTask {
  id: string;
  title: string;
  /** What to do, with the material to do it on (synthetic). */
  ask: string;
  /** The answer's shape, for the helper's AI: e.g. { "apples": "fresh" }. */
  answer_shape?: Record<string, string>;
  /** How it's checked: every key's value matches, at least `min` of them (0 to 1, default 1). */
  check: { expected: Record<string, string>; min?: number };
}

/** Whether an answer passes a task's check (case and spaces aside). */
export function deedAnswerPasses(task: DeedTask, answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false;
  const norm = (x: unknown) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const keys = Object.keys(task.check.expected);
  const right = keys.filter((k) => norm((answer as Record<string, unknown>)[k]) === norm(task.check.expected[k])).length;
  return keys.length > 0 && right / keys.length >= (task.check.min ?? 1);
}

/** An Open Badges 3.0 credential for one hour of community service, bound to the helper's key (cnf.jkt). */
export async function issueDeed(o: { issuer: Identity; issuerWebId: string; issuerName: string; subject: string; jkt: string; task: DeedTask; achievementBase: string; at?: Date }): Promise<string> {
  const at = (o.at ?? new Date()).toISOString();
  return issueCredential({
    '@context': ['https://www.w3.org/ns/credentials/v2', OB3_CONTEXT],
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: { id: o.issuerWebId, type: ['Profile'], name: o.issuerName },
    validFrom: at,
    credentialSubject: {
      id: o.subject, type: ['AchievementSubject'],
      achievement: { id: `${o.achievementBase}#${o.task.id}`, type: ['Achievement'], achievementType: 'CommunityService', name: o.task.title, criteria: { narrative: o.task.ask.slice(0, 300) } },
      creditsEarned: 1, activityStartDate: at.slice(0, 10), activityEndDate: at.slice(0, 10),
      cnf: { jkt: o.jkt },
    },
  } as unknown as Credential, o.issuer);
}

/** A deed's fingerprint: what "spent" is recorded against. */
export const deedDigest = (jws: string) => createHash('sha256').update(jws).digest('hex');

/** Checks a deed against its issuer's key: an hour of community service, to whom, bound to which key. Throws why not. */
export async function checkDeed(jws: string, issuerJwk: jose.JWK): Promise<{ digest: string; issuer: string; subject: string; jkt?: string; credits: number; task: string }> {
  const vc = await verifyCredential(jws, issuerJwk);
  const sub = vc.credentialSubject as { id?: string; creditsEarned?: number; achievement?: { id?: string; achievementType?: string }; cnf?: { jkt?: string } };
  if (!vc.type.includes('OpenBadgeCredential') || sub.achievement?.achievementType !== 'CommunityService') throw new Error('not a certified hour of community service');
  if (sub.creditsEarned !== 1 || !sub.id) throw new Error('a deed is one hour, for one person');
  const issuer = typeof vc.issuer === 'string' ? vc.issuer : (vc.issuer as { id: string }).id;
  return { digest: deedDigest(jws), issuer, subject: sub.id, ...(sub.cnf?.jkt ? { jkt: sub.cnf.jkt } : {}), credits: 1, task: String(sub.achievement.id ?? '') };
}
