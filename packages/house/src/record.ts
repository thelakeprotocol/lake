import {
  checkAttachment, digestSRI, issueCredential, sendLake, signMessage, verifyCredential, verifyLakeCard, verifyLakeData,
  type AgentCard, type Identity, type JWK, type LakeData,
} from '@thelakeprotocol/core';
import { CONVERTER, fhirToLake, type FhirBundle } from '@thelakeprotocol/convert-fhir';

/** Where a house keeps its record. The original stays untouched; the converted copy carries the chain. */
export const RECORD = {
  bundle: 'health/original/bundle.json',
  credential: 'health/original/bundle.vc.jwt',
  issuer: 'health/original/issuer.json',
  claims: 'health/claims.ttl',
  claimsCredential: 'health/claims.vc.jwt',
  converterCert: 'health/converter.cert.json',
} as const;

export interface Trust { issuers: string[]; auditors: string[]; ethics: string[]; payments: string[] }

export interface Issued {
  recordId: string;
  bundle: string;
  credential: string;
  issuerCard: AgentCard;
}

/** Asks the issuer for this person's (synthetic) record and checks the signature before keeping it. */
export async function fetchRecord(issuerUrl: string, webId: string, tries = 40): Promise<Issued> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const issuerCard = (await (await fetch(`${issuerUrl}/.well-known/agent-card.json`)).json()) as AgentCard;
      const profile = await verifyLakeCard(issuerCard);
      const res = await fetch(`${issuerUrl}/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: webId }) });
      if (!res.ok) throw new Error(`issuer said ${res.status}`);
      const r = (await res.json()) as Omit<Issued, 'issuerCard'>;
      await verifyCredential(r.credential, profile.publicJwk, { id: r.recordId, bytes: r.bundle });
      return { ...r, issuerCard };
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  throw new Error(`no record from issuer at ${issuerUrl}: ${(last as Error)?.message}`);
}

/** Asks an Auditor to certify the converter this house runs. Without it, the house's data can't be used. */
export async function fetchConverterCert(auditorUrl: string, me: { id: Identity; card: AgentCard; webId: string }, tries = 40): Promise<{ credential: string; card: AgentCard }> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const envelope = await signMessage({ kind: 'audit-converter', package: CONVERTER }, me.id, { iss: me.webId });
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

/** Converts the original to the canonical model and signs the result as the housekeeper (SPEC §10). */
export async function convertRecord(r: Issued, o: { webId: string; claimsUrl: string; id: Identity; converterCert?: string }) {
  const originalHash = digestSRI(r.bundle);
  const issuer = (await verifyLakeCard(r.issuerCard)).webId;
  const { turtle, claims } = fhirToLake(JSON.parse(r.bundle) as FhirBundle, { subject: o.webId, base: o.claimsUrl, issuer, originalHash, converterCert: o.converterCert });
  const credential = await issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'LakeConvertedRecordCredential'],
      issuer: o.webId,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: o.webId, original: r.recordId, originalHash, converter: CONVERTER },
      relatedResource: [{ id: o.claimsUrl, digestSRI: digestSRI(turtle), mediaType: 'text/turtle' }],
    },
    o.id,
  );
  return { turtle, claims, credential };
}

export type RecordCheck = { ok: true } | { ok: false; why: string };

/**
 * Re-verifies the whole chain from what is in the pod right now (SPEC §10): a trusted issuer signed
 * the original, the original is unchanged, a trusted auditor certified the converter, and the
 * converted record is the housekeeper's signed conversion of exactly that original.
 */
export async function checkRecord(read: (path: string) => Promise<string>, o: { claimsUrl: string; ownJwk: JWK; webId: string; trust: Trust; sandbox: boolean }): Promise<RecordCheck> {
  try {
    const [bundle, credential, issuerRaw, turtle, claimsCredential] = await Promise.all([
      read(RECORD.bundle), read(RECORD.credential), read(RECORD.issuer), read(RECORD.claims), read(RECORD.claimsCredential),
    ]);
    const issuer = JSON.parse(issuerRaw) as { recordId: string; card: AgentCard };
    const signed = await checkAttachment({ credential, card: issuer.card }, { trusted: o.trust.issuers, type: 'LakeHealthRecordCredential', subject: o.webId, sandbox: o.sandbox });
    if (!signed.ok) return { ok: false, why: `original record: ${signed.why}` };
    await verifyCredential(credential, (await verifyLakeCard(issuer.card)).publicJwk, { id: issuer.recordId, bytes: bundle });

    const certRaw = await read(RECORD.converterCert).catch(() => '');
    if (!certRaw) return { ok: false, why: `converter ${CONVERTER} has no auditor certificate` };
    const cert = JSON.parse(certRaw) as { credential: string; card: AgentCard };
    const certified = await checkAttachment(cert, { trusted: o.trust.auditors, type: 'LakeConverterCertificate', subject: `urn:lake:converter:${CONVERTER}`, sandbox: o.sandbox });
    if (!certified.ok) return { ok: false, why: `converter: ${certified.why}` };

    const converted = await verifyCredential(claimsCredential, o.ownJwk, { id: o.claimsUrl, bytes: turtle });
    if (converted.credentialSubject.originalHash !== digestSRI(bundle)) return { ok: false, why: 'converted record does not match the original' };
    if (converted.credentialSubject.converter !== CONVERTER) return { ok: false, why: 'converted by an uncertified converter' };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}
