import { randomUUID } from 'node:crypto';
import { Role, type AgentCard, type Message } from '@a2a-js/sdk';
import { CardError, verifyLakeCard, type LakeProfile } from './card.js';
import { ReplayGuard, SignatureError, verifyMessage, type Signed } from './crypto.js';
import { proveDomain } from './domain.js';
import { LAKE_EXTENSION_URI } from './lake.js';

/** What travels in the data part of every Lake A2A message: the sender's card and a signed envelope. */
export interface LakeData<T = Record<string, unknown>> {
  lake: '0.1';
  card: AgentCard;
  envelope: Signed<T>;
}

export function lakeMessage(data: LakeData, role: 'user' | 'agent', contextId: string = randomUUID()): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId: '',
    role: role === 'user' ? Role.ROLE_USER : Role.ROLE_AGENT,
    parts: [{ content: { $case: 'data', value: data }, metadata: undefined, filename: '', mediaType: 'application/json' }],
    metadata: undefined,
    extensions: [LAKE_EXTENSION_URI],
    referenceTaskIds: [],
  };
}

export function readLakeData(msg: Message | undefined): LakeData | null {
  const part = msg?.parts.find((p) => p.content?.$case === 'data');
  const v = part?.content?.$case === 'data' ? (part.content.value as Partial<LakeData>) : null;
  return v && v.lake && v.card && v.envelope ? (v as LakeData) : null;
}

export type Rejection = { code: 'malformed' | 'unsigned-card' | 'forged-card' | 'domain' | 'bad-signature' | 'replayed' | 'expired' | 'impersonation'; why: string };

/**
 * Everything a receiver checks before reading a single field (SPEC §2, §3):
 * the card is a signed Lake card, its domain is proved, the envelope is signed by that card's key,
 * not expired, not replayed, and issued by the card's own WebID.
 */
export async function verifyLakeData<T>(
  data: LakeData<T> | null,
  opts: { replay?: ReplayGuard; sandbox?: boolean; fetch?: typeof fetch } = {},
): Promise<{ ok: true; profile: LakeProfile; payload: Signed<T>['payload']; domainVia: string } | { ok: false; rejection: Rejection }> {
  if (!data) return { ok: false, rejection: { code: 'malformed', why: 'not a Lake message' } };
  let profile: LakeProfile;
  try {
    profile = await verifyLakeCard(data.card);
  } catch (e) {
    const code = e instanceof CardError && (e.code === 'unsigned' || e.code === 'not-lake') ? 'unsigned-card' : 'forged-card';
    return { ok: false, rejection: { code, why: (e as Error).message } };
  }
  const proof = await proveDomain(profile, opts);
  if (!proof.ok) return { ok: false, rejection: { code: 'domain', why: proof.reason } };
  try {
    const payload = await verifyMessage(data.envelope, async (kid) => (kid === profile.publicJwk.kid ? profile.publicJwk : null), { replay: opts.replay });
    if (payload.iss !== profile.webId) return { ok: false, rejection: { code: 'impersonation', why: `message issued by ${payload.iss}, card belongs to ${profile.webId}` } };
    return { ok: true, profile, payload, domainVia: proof.via };
  } catch (e) {
    const code = e instanceof SignatureError ? (e.code === 'replayed' ? 'replayed' : e.code === 'expired' ? 'expired' : 'bad-signature') : 'bad-signature';
    return { ok: false, rejection: { code, why: (e as Error).message } };
  }
}
