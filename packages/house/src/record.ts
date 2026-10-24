import {
  checkAttachment, claimsToTurtle, digestSRI, issueCredential, packPaths, sendLake, signMessage, verifyCredential, verifyLakeCard, verifyLakeData,
  type AgentCard, type Claim, type Identity, type JWK, type LakeData, type LakePack,
} from '@thelakeprotocol/core';
import { checkShapes } from './shapes.js';

/** Where one pack's record lives in this pod (from the Type Index, or the pack's default folder). */
export type RecordPaths = ReturnType<typeof packPaths>;

export interface Trust { issuers: string[]; auditors: string[]; ethics: string[]; payments: string[]; regulators: string[]; tellers: string[] }

export interface Issued {
  recordId: string;
  original: string;
  credential: string;
  issuerCard: AgentCard;
}

/** Asks the pack's issuer for this person's (synthetic) record and checks the signature before keeping it. */
export async function fetchRecord(issuerUrl: string, webId: string, p: LakePack, tries = 40): Promise<Issued> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const issuerCard = (await (await fetch(`${issuerUrl}/.well-known/agent-card.json`)).json()) as AgentCard;
      const profile = await verifyLakeCard(issuerCard);
      const res = await fetch(`${issuerUrl}/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: webId, pack: p.id }) });
      if (!res.ok) throw new Error(`issuer said ${res.status}`);
      const r = (await res.json()) as { recordId: string; original?: string; bundle?: string; credential: string };
      const original = r.original ?? r.bundle ?? '';
      await verifyCredential(r.credential, profile.publicJwk, { id: r.recordId, bytes: original });
      return { recordId: r.recordId, original, credential: r.credential, issuerCard };
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  throw new Error(`no ${p.id} record from issuer at ${issuerUrl}: ${(last as Error)?.message}`);
}

/** Asks an Auditor to certify the pack's converter. Without it, the house's data for that pack can't be used. */
export async function fetchConverterCert(auditorUrl: string, me: { id: Identity; card: AgentCard; webId: string }, p: LakePack, tries = 40): Promise<{ credential: string; card: AgentCard }> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const envelope = await signMessage({ kind: 'audit-converter', package: p.source!.converter }, me.id, { iss: me.webId });
      const reply = await sendLake(auditorUrl, { lake: '0.1', card: me.card, envelope: envelope as LakeData['envelope'] });
      const v = await verifyLakeData<{ kind: string; credential?: string; problems?: string[] }>(reply as never, { sandbox: true });
      if (!v.ok) throw new Error(v.rejection.why);
      if (v.payload.kind !== 'certified') throw new Error((v.payload.problems ?? []).join('; '));
      return { credential: v.payload.credential!, card: reply!.card };
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  throw new Error(`no converter certificate from ${auditorUrl}: ${(last as Error)?.message}`);
}

/** Converts the original to the pack's claims, checks them against its shapes, and signs the result as the housekeeper (SPEC §10). */
export async function convertRecord(r: Issued, p: LakePack, o: { webId: string; claimsUrl: string; id: Identity; converterCert?: string }) {
  const originalHash = digestSRI(r.original);
  const issuer = (await verifyLakeCard(r.issuerCard)).webId;
  const claims: Claim[] = p.source!.convert(r.original);
  const turtle = claimsToTurtle(p, claims, o.claimsUrl, { subject: o.webId, issuer, originalHash, converter: p.source!.converter, converterCert: o.converterCert });
  const shaped = await checkShapes(turtle, p, o.claimsUrl);
  if (!shaped.ok) throw new Error(`converted ${p.id} claims fail the pack's shapes: ${shaped.why}`);
  const credential = await issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'LakeConvertedRecordCredential'],
      issuer: o.webId,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: o.webId, original: r.recordId, originalHash, converter: p.source!.converter, pack: p.id },
      relatedResource: [{ id: o.claimsUrl, digestSRI: digestSRI(turtle), mediaType: 'text/turtle' }],
    },
    o.id,
  );
  return { turtle, claims, credential };
}

/** On success, the digests the verified credentials pin for the original and the converted record. */
export type RecordCheck = { ok: true; pins: { original: string; claims: string } } | { ok: false; why: string; transient?: boolean };

/** A pod that can't be read right now is busy, not broken: say so, and let the visitor come back. */
const unreadable = (e: unknown): RecordCheck => ({ ok: false, why: `could not read my record just now (${(e as Error).message})`, transient: true });

/**
 * Between full checks: re-read the two data files and compare them with the digests the verified
 * credentials pin. Any change to the original or the converted record is caught; swapping a credential
 * file can't help a forger, because the pins come from the credentials as they were verified.
 */
export async function quickCheck(read: (path: string) => Promise<string>, paths: RecordPaths, pins: { original: string; claims: string }): Promise<RecordCheck> {
  let original: string, turtle: string;
  try {
    [original, turtle] = await Promise.all([read(paths.original), read(paths.claims)]);
  } catch (e) {
    return unreadable(e);
  }
  try {
    if (digestSRI(original) !== pins.original) return { ok: false, why: `${paths.original} was changed after it was signed` };
    if (digestSRI(turtle) !== pins.claims) return { ok: false, why: `${paths.claims} was changed after it was signed` };
    return { ok: true, pins };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}

/**
 * Re-verifies the whole chain from what is in the pod right now (SPEC §10): a trusted issuer signed
 * the original, the original is unchanged, a trusted auditor certified the converter, the converted
 * record is the housekeeper's signed conversion of exactly that original, and it passes the pack's shapes.
 */
export async function checkRecord(read: (path: string) => Promise<string>, p: LakePack, paths: RecordPaths, o: { claimsUrl: string; ownJwk: JWK; webId: string; trust: Trust; sandbox: boolean }): Promise<RecordCheck> {
  const converter = p.source!.converter;
  let original: string, credential: string, issuerRaw: string, turtle: string, claimsCredential: string, certRaw: string;
  try {
    [original, credential, issuerRaw, turtle, claimsCredential, certRaw] = await Promise.all([
      read(paths.original), read(paths.credential), read(paths.issuer), read(paths.claims), read(paths.claimsCredential), read(paths.converterCert).catch(() => ''),
    ]);
  } catch (e) {
    return unreadable(e);
  }
  try {
    const issuer = JSON.parse(issuerRaw) as { recordId: string; card: AgentCard };
    const signed = await checkAttachment({ credential, card: issuer.card }, { trusted: o.trust.issuers, type: p.source!.credentialType, subject: o.webId, sandbox: o.sandbox });
    if (!signed.ok) return { ok: false, why: `original record: ${signed.why}` };
    await verifyCredential(credential, (await verifyLakeCard(issuer.card)).publicJwk, { id: issuer.recordId, bytes: original });

    if (!certRaw) return { ok: false, why: `converter ${converter} has no auditor certificate` };
    const cert = JSON.parse(certRaw) as { credential: string; card: AgentCard };
    const certified = await checkAttachment(cert, { trusted: o.trust.auditors, type: 'LakeConverterCertificate', subject: `urn:lake:converter:${converter}`, sandbox: o.sandbox });
    if (!certified.ok) return { ok: false, why: `converter: ${certified.why}` };

    const converted = await verifyCredential(claimsCredential, o.ownJwk, { id: o.claimsUrl, bytes: turtle });
    if (converted.credentialSubject.originalHash !== digestSRI(original)) return { ok: false, why: 'converted record does not match the original' };
    if (converted.credentialSubject.converter !== converter) return { ok: false, why: 'converted by an uncertified converter' };
    const shaped = await checkShapes(turtle, p, o.claimsUrl);
    if (!shaped.ok) return { ok: false, why: `claims fail the ${p.id} shapes: ${shaped.why}` };
    return { ok: true, pins: { original: digestSRI(original), claims: digestSRI(turtle) } };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}
