import { fieldSpec, identifyingFields, offerableFields } from './pack.js';
import { PURPOSES } from './purpose.js';
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
 * What an owner should look at twice before allowing an offer, in plain words: sensitive (special-category) data asked
 * for outside a certified study or to decide something about them, fields that identify them, fields no use case here
 * defines, and keeping the data for a year or more. Codes only; nothing the sender wrote as prose.
 */
/**
 * What the owner should look at twice, in red. `askerVerified`: the asker's domain proved its key (SPEC §2.3). A verified
 * asker wanting sensitive data for a purpose that doesn't decide about the owner (a GP for care) gets a calm note instead
 * (offerNotes): the user asked that real doctors not be made to look like a threat; an unverified one still gets the red.
 */
export function offerWarnings(o: Pick<Offer, 'fields' | 'retention'> & { purpose?: string; certifiedStudy?: boolean; askerVerified?: boolean }): string[] {
  const identifying = new Set(identifyingFields());
  const known = new Set(offerableFields());
  const ids = o.fields.filter((f) => identifying.has(f));
  const unknown = o.fields.filter((f) => !identifying.has(f) && !known.has(f));
  const years = retentionYears(o.retention);
  const special = o.fields.filter((f) => fieldSpec(f)?.special);
  const named = special.join(', ').replace(/_/g, ' ');
  const purpose = o.purpose ? PURPOSES[o.purpose] : undefined;
  // Sensitive data asked for to decide something about you: an insurer pricing you on your health (run 19). Asked for
  // outside a certified study, for anything else: run 28's made-up "carer" asked for conditions and reached the Allow
  // button at 9 of 10 houses with nothing in red. A certified study lets out only a total; this lets out the person's own.
  const sensitive = !special.length || !purpose ? ''
    : purpose.decides ? `asks for sensitive data (${named}) to make decisions about you (${purpose.label})`
    : !o.certifiedStudy && !o.askerVerified ? `asks for sensitive data (${named}) for ${purpose.label}, outside any certified study, from a sender whose identity isn't verified: allowing it lets this agent use your own ${named}, not a total`
    : '';
  return [
    sensitive,
    ids.length ? `asks for fields that identify you: ${ids.join(', ').replace(/_/g, ' ')}` : '',
    unknown.length ? `asks for fields no use case here defines: ${unknown.join(', ').replace(/_/g, ' ')}` : '',
    years >= 1 ? `wants to keep your data for ${years >= 2 ? `${Math.round(years)} years` : 'a year or more'}` : '',
  ].filter(Boolean);
}

/** A calm line for the owner, not a warning: a verified sender asking for sensitive data for a purpose that doesn't decide about them. */
export function offerNotes(o: Pick<Offer, 'fields'> & { purpose?: string; certifiedStudy?: boolean; askerVerified?: boolean }): string[] {
  const special = o.fields.filter((f) => fieldSpec(f)?.special);
  const purpose = o.purpose ? PURPOSES[o.purpose] : undefined;
  if (!special.length || !purpose || purpose.decides || o.certifiedStudy || !o.askerVerified) return [];
  return [`includes ${special.join(', ').replace(/_/g, ' ')}, for ${purpose.label}, from a verified sender: yours to share or not`];
}

/** An ISO 8601 retention ("P99Y", "P400D") in years; 0 for "none". */
export function retentionYears(retention: string): number {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?/.exec(retention);
  if (!m) return 0;
  const [, y = 0, mo = 0, w = 0, d = 0] = m.map((x) => Number(x ?? 0));
  return Number(y) + Number(mo) / 12 + (Number(w) * 7 + Number(d)) / 365;
}
