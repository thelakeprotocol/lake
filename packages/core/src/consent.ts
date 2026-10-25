/**
 * Consent records (SPEC §6.6), in the shape ISO/IEC TS 27560 gives them, written with the W3C DPV terms the DPV
 * community group maps it to (w3id.org/dpv/guides/consent-27560): one record per agreement, kept in the owner's pod
 * beside it, saying whose data, for whom, for what, kept how long, decided how, and its status over time (given,
 * then withdrawn when the owner takes the key back). The agreement and the access grant stay the binding objects; the
 * record is the owner's (and a regulator's) readable account of the consent.
 */
export const CONSENT_RECORD_CONTEXT = {
  dpv: 'https://w3id.org/dpv#',
  dct: 'http://purl.org/dc/terms/',
};

/** Which profile of the 27560 schema the record follows: DPV's own, not tied to one law. */
export const CONSENT_RECORD_SCHEMA = 'https://w3id.org/dpv/schema/dpv-27560';

export interface ConsentRecordInput {
  /** The agreement's id (the offer id): the record's identifier. */
  id: string;
  /** The owner: the data subject (their WebID). */
  owner: string;
  /** The visitor: controller and recipient (WebID and domain). */
  visitor: { webId: string; domain: string };
  /** The Lake purpose code (a DPV purpose where there is one) and the fields, as the pack names them. */
  purpose: string;
  dpvPurpose?: string;
  fields: string[];
  /** "none", or an ISO 8601 duration. */
  retention: string;
  /** Until when the key works. */
  until: string;
  /** How the consent was given: by a standing rule (and which), or live on the owner's device. */
  method: { standingRule: number; rulesDigest: string } | { live: true };
  /** The agreement it belongs to, and the key's bit on the house's status list (how to withdraw it). */
  agreement: string;
  status?: string;
  given: string;
  /** The notice the owner agreed to: for a live consent, what the owner was shown (the drafted grant's digest). */
  notice?: string;
  language?: string;
}

/** A consent record for an agreement, with its first status: given. */
export function consentRecord(i: ConsentRecordInput): Record<string, unknown> {
  const via = 'live' in i.method
    // DPV has no term for either way a Lake owner consents, so the method is the Lake's own, described in words.
    ? { 'dpv:hasIndicationMethod': 'urn:lake:consent:live', 'dpv:isIndicatedBy': i.owner, 'dct:description': 'tapped Allow on the owner\'s own device, which signed the grant' }
    : { 'dpv:hasIndicationMethod': 'urn:lake:consent:standing-rule', 'dpv:isIndicatedBy': i.owner, 'dct:description': `the owner's standing rule ${i.method.standingRule} (rules ${i.method.rulesDigest}) decided it` };
  return {
    '@context': CONSENT_RECORD_CONTEXT,
    '@type': 'dpv:ConsentRecord',
    'dct:conformsTo': CONSENT_RECORD_SCHEMA,
    'dct:identifier': i.id,
    'dpv:hasDataSubject': i.owner,
    'dpv:hasNotice': { '@type': 'dpv:ConsentNotice', 'dct:identifier': i.notice ?? i.agreement, 'dct:language': i.language ?? 'en' },
    'dct:valid': `${i.given}/${i.until}`,
    'dpv:hasProcess': {
      'dpv:hasPurpose': i.dpvPurpose ?? `urn:lake:purpose:${i.purpose}`,
      'dpv:hasPersonalData': i.fields.map((f) => ({ 'dct:identifier': f })),
      'dpv:hasProcessing': i.retention === 'none' ? ['dpv:Use'] : ['dpv:Use', 'dpv:Store'],
      'dpv:hasStorageCondition': i.retention === 'none' ? 'not stored: computed in the house, records never leave' : { 'dpv:hasDuration': i.retention },
      'dpv:hasDataController': { '@id': i.visitor.webId, 'dct:title': i.visitor.domain },
      'dpv:hasRecipient': { '@id': i.visitor.webId, 'dct:title': i.visitor.domain },
      'dpv:hasLegalBasis': 'dpv:Consent',
    },
    'dpv:hasConsentControl': { '@type': 'dpv:WithdrawConsent', 'dct:description': 'the owner revokes the key in their control panel; its bit goes up on the house\'s public status list', 'dct:source': i.status },
    'dct:source': i.agreement,
    'dpv:hasConsentStatus': [{ '@type': 'dpv:ConsentGiven', 'dct:date': i.given, ...via }],
  };
}

/** The same record, its consent withdrawn at `at` (the owner took the key back). */
export function withdrawConsent(record: Record<string, unknown>, at: string): Record<string, unknown> {
  const history = (record['dpv:hasConsentStatus'] as Record<string, unknown>[] | undefined) ?? [];
  if (history.some((s) => s['@type'] === 'dpv:ConsentWithdrawn')) return record;
  return { ...record, 'dpv:hasConsentStatus': [...history, { '@type': 'dpv:ConsentWithdrawn', 'dct:date': at, 'dpv:isIndicatedBy': record['dpv:hasDataSubject'] }] };
}
