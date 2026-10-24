import { fieldSpec } from './pack.js';
import { PURPOSES } from './purpose.js';

/**
 * A key to a house is a Solid Access Grant (Inrupt's Access Grant format, built on the GConsent vocabulary): a
 * credential whose subject is the data owner, with `providedConsent` saying who may read what, for which purpose. The
 * Lake's own terms (which offer, which study, how many uses, which rule allowed it) ride alongside in `lake`, so a Solid
 * tool reads the grant as any access grant and a house reads the rest (SPEC §6).
 */
export const ACCESS_GRANT_CONTEXT = ['https://www.w3.org/ns/credentials/v2', 'https://schema.inrupt.com/credentials/v2.jsonld'];
export const ACCESS_GRANT_TYPE = ['VerifiableCredential', 'SolidAccessGrant'];
export const CONSENT_GIVEN = 'https://w3id.org/GConsent#ConsentStatusExplicitlyGiven';
/** What a draft says until the owner's device signs it: asked for, not yet given (run 19 read a draft as consent). */
export const CONSENT_REQUESTED = 'https://w3id.org/GConsent#ConsentStatusRequested';
const GIVEN = CONSENT_GIVEN;
const READ = 'http://www.w3.org/ns/auth/acl#Read';

/** What a house grants, in the Lake's terms. */
export interface GrantTerms {
  offer: string;
  study: string | null;
  fields: string[];
  purpose: string;
  /** "standing rule 2", or "owner, live". */
  authorizedBy: string;
  /** A study's key works once (SPEC §7). */
  uses?: number;
  /** The digest of the rules that allowed it (standing-rule grants). */
  rules?: string;
  agreement?: string;
  agreementDigest?: string;
}

/** A field as personal data a grant names: the class its pack gives it, or a Lake URN. */
export const fieldIri = (f: string) => fieldSpec(f)?.class ?? `urn:lake:field:${f}`;
/** A purpose as a grant names it: its W3C DPV term where it has one. */
export const purposeIri = (p: string) => (PURPOSES[p]?.dpv ? `https://w3id.org/dpv#${PURPOSES[p]!.dpv}` : `urn:lake:purpose:${p}`);

/** The credential subject of a grant from `owner` to `grantee`. */
export function accessGrantSubject(owner: string, grantee: string, t: GrantTerms, status = GIVEN) {
  return {
    id: owner,
    providedConsent: { mode: [READ], hasStatus: status, forPersonalData: t.fields.map(fieldIri), forPurpose: [purposeIri(t.purpose)], isProvidedTo: grantee },
    lake: Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)),
  };
}

/** A grant's unsigned body, for a device to date and sign. */
export const accessGrantDraft = (owner: string, grantee: string, t: GrantTerms, status = GIVEN) => ({ '@context': ACCESS_GRANT_CONTEXT, type: ACCESS_GRANT_TYPE, credentialSubject: accessGrantSubject(owner, grantee, t, status) });

/** Who granted what to whom, read from a verified credential; null when it isn't a given Solid Access Grant with Lake terms. */
export function readAccessGrant(vc: { type: string[]; credentialSubject: unknown }): (GrantTerms & { owner: string; grantee: string }) | null {
  const s = vc.credentialSubject as { id?: string; providedConsent?: { hasStatus?: string; isProvidedTo?: string }; lake?: GrantTerms };
  if (!vc.type.includes('SolidAccessGrant') || s?.providedConsent?.hasStatus !== GIVEN || !s.providedConsent.isProvidedTo || !s.lake || !s.id) return null;
  return { ...s.lake, owner: s.id, grantee: s.providedConsent.isProvidedTo };
}
