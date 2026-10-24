import { identifyingFields, offerableFields } from './pack.js';
/**
 * An offer is what a visitor puts on the table: purpose, fields, retention, price.
 * On the wire it is a W3C ODRL Offer (see toOdrl); housekeepers evaluate this flat view.
 */
export interface Offer {
  id: string;
  /** Domain of the agent asking (proven at registration). */
  requester: string;
  purpose: string;
  /** Field names, as the packs in use declare them. */
  fields: string[];
  /** "none" or an ISO 8601 duration such as "P30D". */
  retention: string;
  priceUsd: number;
  credentials: { ethicsApproved: boolean; sponsorVerified: boolean; auditCertified: boolean };
  /** Id of the study this offer is for (studyId of the declarative study), when there is one. */
  study?: string;
  /** Lowest provenance tier the study accepts. */
  minTier?: 'self-reported' | 'device-signed' | 'issuer-signed';
  /**
   * Free text from the visitor. UNTRUSTED. The rules engine never reads it;
   * it may only be shown to a human, quoted.
   */
  note?: string;
}

const LAKE = 'https://lake.doneinfifty.com/model/v0#';

/** Serialise an offer as an ODRL 2.2 Offer (JSON-LD). */
export function toOdrl(o: Offer, assigner: string) {
  return {
    '@context': ['http://www.w3.org/ns/odrl.jsonld', { lake: LAKE }],
    '@type': 'Offer',
    uid: `urn:lake:offer:${o.id}`,
    assigner,
    permission: [
      {
        target: o.fields.map((f) => `lake:${f}`),
        action: 'use',
        constraint: [
          { leftOperand: 'purpose', operator: 'eq', rightOperand: `lake:purpose/${o.purpose}` },
          ...(o.minTier ? [{ leftOperand: 'lake:provenanceTier', operator: 'gteq', rightOperand: `lake:tier/${o.minTier}` }] : []),
        ],
        duty: [
          { action: 'compensate', constraint: [{ leftOperand: 'payAmount', operator: 'eq', rightOperand: { '@value': o.priceUsd.toFixed(2), '@type': 'xsd:decimal' }, unit: 'https://dbpedia.org/resource/United_States_dollar' }] },
          o.retention === 'none'
            ? { action: 'delete', constraint: [{ leftOperand: 'event', operator: 'eq', rightOperand: 'lake:event/computationEnd' }] }
            : { action: 'delete', constraint: [{ leftOperand: 'elapsedTime', operator: 'lteq', rightOperand: { '@value': o.retention, '@type': 'xsd:duration' } }] },
        ],
      },
    ],
  };
}

/**
 * What an owner should look at twice before allowing an offer, in plain words: fields that identify them, fields no
 * use case here defines, and keeping the data for a year or more. Codes only; nothing the sender wrote as prose.
 */
export function offerWarnings(o: Pick<Offer, 'fields' | 'retention'>): string[] {
  const identifying = new Set(identifyingFields());
  const known = new Set(offerableFields());
  const ids = o.fields.filter((f) => identifying.has(f));
  const unknown = o.fields.filter((f) => !identifying.has(f) && !known.has(f));
  const years = retentionYears(o.retention);
  return [
    ids.length ? `asks for fields that identify you: ${ids.join(', ').replace(/_/g, ' ')}` : '',
    unknown.length ? `asks for fields no use case here defines: ${unknown.join(', ').replace(/_/g, ' ')}` : '',
    years >= 1 ? `wants to keep your data for ${years >= 2 ? `${Math.round(years)} years` : 'a year or more'}` : '',
  ].filter(Boolean);
}

/** An ISO 8601 retention ("P99Y", "P400D") in years; 0 for "none". */
export function retentionYears(retention: string): number {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?/.exec(retention);
  if (!m) return 0;
  const [, y = 0, mo = 0, w = 0, d = 0] = m.map((x) => Number(x ?? 0));
  return Number(y) + Number(mo) / 12 + (Number(w) * 7 + Number(d)) / 365;
}
