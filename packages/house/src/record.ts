import { digestSRI, issueCredential, verifyCredential, type Identity, type JWK } from '@thelakeprotocol/core';
import { fhirToLake, type FhirBundle } from '@thelakeprotocol/convert-fhir';

/** Where a house keeps its record. The original stays untouched; the converted copy carries the chain. */
export const RECORD = {
  bundle: 'health/original/bundle.json',
  credential: 'health/original/bundle.vc.jwt',
  issuer: 'health/original/issuer.json',
  claims: 'health/claims.ttl',
  claimsCredential: 'health/claims.vc.jwt',
} as const;

export interface Issued {
  recordId: string;
  bundle: string;
  credential: string;
  issuer: string;
  issuerJwk: JWK;
}

/** Asks the issuer for this person's (synthetic) record and checks the signature before keeping it. */
export async function fetchRecord(issuerUrl: string, webId: string, tries = 40): Promise<Issued> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const card = await (await fetch(`${issuerUrl}/.well-known/agent-card.json`)).json();
      const issuerJwk = card.capabilities.extensions[0].params.publicJwk as JWK;
      const res = await fetch(`${issuerUrl}/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: webId }) });
      if (!res.ok) throw new Error(`issuer said ${res.status}`);
      const r = (await res.json()) as Omit<Issued, 'issuerJwk'>;
      await verifyCredential(r.credential, issuerJwk, { id: r.recordId, bytes: r.bundle });
      return { ...r, issuerJwk };
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
  throw new Error(`no record from issuer at ${issuerUrl}: ${(last as Error)?.message}`);
}

/** Converts the original to the canonical model and signs the result as the housekeeper (SPEC §10). */
export async function convertRecord(r: Issued, o: { webId: string; claimsUrl: string; id: Identity }) {
  const originalHash = digestSRI(r.bundle);
  const { turtle, claims } = fhirToLake(JSON.parse(r.bundle) as FhirBundle, { subject: o.webId, base: o.claimsUrl, issuer: r.issuer, originalHash });
  const credential = await issueCredential(
    {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'LakeConvertedRecordCredential'],
      issuer: o.webId,
      validFrom: new Date().toISOString(),
      credentialSubject: { id: o.webId, original: r.recordId, originalHash, converter: '@thelakeprotocol/convert-fhir@0.1.0' },
      relatedResource: [{ id: o.claimsUrl, digestSRI: digestSRI(turtle), mediaType: 'text/turtle' }],
    },
    o.id,
  );
  return { turtle, claims, credential };
}

export type RecordCheck = { ok: true } | { ok: false; why: string };

/**
 * Re-verifies the whole chain from what is in the pod right now: issuer signature over the original,
 * the converted record's hash of that original, and the housekeeper's signature over the converted record.
 */
export async function checkRecord(read: (path: string) => Promise<string>, o: { claimsUrl: string; ownJwk: JWK }): Promise<RecordCheck> {
  try {
    const [bundle, credential, issuerRaw, turtle, claimsCredential] = await Promise.all([
      read(RECORD.bundle), read(RECORD.credential), read(RECORD.issuer), read(RECORD.claims), read(RECORD.claimsCredential),
    ]);
    const issuer = JSON.parse(issuerRaw) as { recordId: string; jwk: JWK };
    await verifyCredential(credential, issuer.jwk, { id: issuer.recordId, bytes: bundle });
    const converted = await verifyCredential(claimsCredential, o.ownJwk, { id: o.claimsUrl, bytes: turtle });
    if (converted.credentialSubject.originalHash !== digestSRI(bundle)) return { ok: false, why: 'converted record does not match the original' };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
}
