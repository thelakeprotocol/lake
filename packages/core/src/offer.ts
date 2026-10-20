/**
 * An offer is what a visitor puts on the table: purpose, fields, retention, price.
 * On the wire it is a W3C ODRL Offer (see toOdrl); housekeepers evaluate this flat view.
 */
export interface Offer {
  id: string;
  /** Domain of the agent asking (proven at registration). */
  requester: string;
  purpose: string;
  /** Canonical Lake field names, e.g. "age_band", "medications". */
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
