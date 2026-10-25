/**
 * Consent records (SPEC §6.6), in the shape ISO/IEC TS 27560 gives them, written with the W3C DPV terms the DPV
 * community group maps it to (w3id.org/dpv/guides/consent-27560): one record per agreement, kept in the owner's pod
 * beside it, saying whose data, for whom, for what, kept how long, decided how, and its status over time (given,
 * then withdrawn when the owner takes the key back). The agreement and the access grant stay the binding objects; the
 * record is the owner's (and a regulator's) readable account of the consent.
 */
import { PURPOSES } from './purpose.js';

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

/** A consent record as the owner reads it: who, what, why, how it was given, until when, and whether it was taken back. */
export interface ConsentSummary {
  id: string;
  visitor: { webId: string; domain: string };
  /**
   * The Lake purposes the record's purpose can be: one, unless two share a DPV term (care and a service you asked
   * for are both dpv:ServiceProvision), when the reader picks by what else it knows.
   */
  purposes: string[];
  fields: string[];
  /** "none", or an ISO 8601 duration. */
  retention: string;
  given: string;
  until: string;
  /** How it was given: by which standing rule, or live on the owner's device. */
  method: { standingRule: number | null } | { live: true } | null;
  /** When the owner withdrew it, if they have. */
  withdrawn?: string;
  agreement: string;
}

/** Reads back a record `consentRecord` wrote (and `withdrawConsent` updated); null for anything else. */
export function readConsentRecord(r: Record<string, any>): ConsentSummary | null {
  if (r?.['@type'] !== 'dpv:ConsentRecord' || typeof r['dct:identifier'] !== 'string') return null;
  const p = r['dpv:hasProcess'] ?? {};
  const purpose = String(p['dpv:hasPurpose'] ?? '');
  const purposes = purpose.startsWith('urn:lake:purpose:')
    ? [purpose.slice('urn:lake:purpose:'.length)]
    : Object.entries(PURPOSES).filter(([, x]) => x.dpv && `dpv:${x.dpv}` === purpose).map(([name]) => name);
  const history = (Array.isArray(r['dpv:hasConsentStatus']) ? r['dpv:hasConsentStatus'] : []) as Record<string, any>[];
  const given = history.find((s) => s['@type'] === 'dpv:ConsentGiven');
  const withdrawn = history.find((s) => s['@type'] === 'dpv:ConsentWithdrawn');
  // DPV has no term for a standing rule, so the record names the rule in words (consentRecord above): read its number back.
  const method = given?.['dpv:hasIndicationMethod'] === 'urn:lake:consent:live' ? { live: true as const }
    : given?.['dpv:hasIndicationMethod'] === 'urn:lake:consent:standing-rule' ? { standingRule: Number(/standing rule (\d+)/.exec(String(given['dct:description'] ?? ''))?.[1]) || null }
      : null;
  const [from = '', until = ''] = String(r['dct:valid'] ?? '').split('/');
  const storage = p['dpv:hasStorageCondition'];
  return {
    id: r['dct:identifier'],
    visitor: { webId: String(p['dpv:hasRecipient']?.['@id'] ?? ''), domain: String(p['dpv:hasRecipient']?.['dct:title'] ?? '') },
    purposes,
    fields: (Array.isArray(p['dpv:hasPersonalData']) ? p['dpv:hasPersonalData'] : []).map((d: Record<string, unknown>) => String(d['dct:identifier'])),
    retention: typeof storage === 'object' && storage?.['dpv:hasDuration'] ? String(storage['dpv:hasDuration']) : 'none',
    given: String(given?.['dct:date'] ?? from),
    until,
    method,
    ...(withdrawn ? { withdrawn: String(withdrawn['dct:date']) } : {}),
    agreement: String(r['dct:source'] ?? ''),
  };
}
