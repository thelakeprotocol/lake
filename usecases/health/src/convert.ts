import { claimsToTurtle, type Claim } from '@thelakeprotocol/core';
import { health } from './pack.js';
import type { FhirBundle } from './synthetic.js';

/** What an auditor certifies: this converter, at this version. */
export const CONVERTER = '@thelakeprotocol/usecase-health/fhir@1.0.0';

export interface ConvertOptions {
  /** The owner's WebID. */
  subject: string;
  /** URL the converted document will live at; claim ids are fragments of it. */
  base: string;
  issuer: string;
  /** digestSRI of the original signed bundle. */
  originalHash: string;
  /** Auditor certificate for this converter; uncertified until an Auditor signs it. */
  converterCert?: string;
  /** "Today", for age bands. */
  asOf?: number;
}

const READMIT_DAYS = 30;

/** Reads FHIR R4 (Synthea exports included) and returns canonical claims. Pure; no network. */
export function extractClaims(bundle: FhirBundle, asOf = Date.now()): Claim[] {
  const res = bundle.entry.map((e) => e.resource);
  const claims: Claim[] = [];
  const patient = res.find((r) => r.resourceType === 'Patient');
  if (patient?.birthDate) {
    const age = Math.floor((asOf - Date.parse(patient.birthDate)) / (365.25 * 86_400_000));
    claims.push({ field: 'age_band', value: age >= 90 ? '90+' : `${Math.floor(age / 10)}0-${Math.floor(age / 10)}9` });
  }
  res.filter((r) => r.resourceType === 'MedicationRequest').forEach((m) => {
    const c = m.medicationCodeableConcept?.coding?.[0];
    if (c) claims.push({ field: 'medications', value: c.display ?? c.code, code: c.code });
  });
  res.filter((r) => r.resourceType === 'Condition').forEach((c) => {
    const k = c.code?.coding?.[0];
    if (k) claims.push({ field: 'conditions', value: k.display ?? k.code, code: k.code, observedAt: c.onsetDateTime });
  });
  const stays = res
    .filter((r) => r.resourceType === 'Encounter' && (r.class?.code ?? r.class?.[0]?.code) === 'IMP' && r.period?.start)
    .map((e) => ({ start: Date.parse(e.period.start), end: Date.parse(e.period.end ?? e.period.start) }))
    .sort((a, b) => a.start - b.start);
  stays.forEach((s, i) => {
    const prev = stays[i - 1];
    if (prev && s.start - prev.end <= READMIT_DAYS * 86_400_000) {
      claims.push({ field: 'readmissions', value: 'readmitted within 30 days', observedAt: new Date(s.start).toISOString() });
    }
  });
  return claims;
}

/** FHIR → canonical Lake model as Turtle, with the provenance the trust chain needs (SPEC §10). */
export function fhirToLake(bundle: FhirBundle, o: ConvertOptions): { claims: Claim[]; turtle: string } {
  const claims = extractClaims(bundle, o.asOf);
  const turtle = claimsToTurtle(health, claims, o.base, { subject: o.subject, issuer: o.issuer, originalHash: o.originalHash, converter: CONVERTER, converterCert: o.converterCert });
  return { claims, turtle };
}
