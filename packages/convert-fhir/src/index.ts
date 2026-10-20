import { DataFactory, Writer } from 'n3';
import type { FhirBundle } from './synthetic.js';

export * from './synthetic.js';

export const CONVERTER = '@thelakeprotocol/convert-fhir@0.1.0';
const LAKE = 'https://lake.doneinfifty.com/model/v0#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Canonical field name → claim class. These are the names offers use. */
export const FIELD_CLASS = { age_band: 'AgeBand', medications: 'Medication', conditions: 'Condition', readmissions: 'Readmission' } as const;
export type Field = keyof typeof FIELD_CLASS;

export interface Claim {
  id: string;
  field: Field;
  value: string;
  code?: string;
  observedAt?: string;
}

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
    claims.push({ id: 'age', field: 'age_band', value: age >= 90 ? '90+' : `${Math.floor(age / 10)}0-${Math.floor(age / 10)}9` });
  }
  res.filter((r) => r.resourceType === 'MedicationRequest').forEach((m, i) => {
    const c = m.medicationCodeableConcept?.coding?.[0];
    if (c) claims.push({ id: `med-${i}`, field: 'medications', value: c.display ?? c.code, code: c.code });
  });
  res.filter((r) => r.resourceType === 'Condition').forEach((c, i) => {
    const k = c.code?.coding?.[0];
    if (k) claims.push({ id: `cond-${i}`, field: 'conditions', value: k.display ?? k.code, code: k.code, observedAt: c.onsetDateTime });
  });
  const stays = res
    .filter((r) => r.resourceType === 'Encounter' && (r.class?.code ?? r.class?.[0]?.code) === 'IMP' && r.period?.start)
    .map((e) => ({ start: Date.parse(e.period.start), end: Date.parse(e.period.end ?? e.period.start) }))
    .sort((a, b) => a.start - b.start);
  stays.forEach((s, i) => {
    const prev = stays[i - 1];
    if (prev && s.start - prev.end <= READMIT_DAYS * 86_400_000) {
      claims.push({ id: `readm-${claims.length}`, field: 'readmissions', value: 'readmitted within 30 days', observedAt: new Date(s.start).toISOString() });
    }
  });
  return claims;
}

/** FHIR → canonical Lake model as Turtle, with the provenance the trust chain needs (SPEC §10). */
export function fhirToLake(bundle: FhirBundle, o: ConvertOptions): { claims: Claim[]; turtle: string } {
  const claims = extractClaims(bundle, o.asOf);
  const { namedNode: nn, literal: lit, quad } = DataFactory;
  const L = (n: string) => nn(LAKE + n);
  const me = (frag: string) => nn(`${o.base}#${frag}`);
  const q = [];
  const person = me('person');
  const prov = me('provenance');
  q.push(quad(person, nn(RDF_TYPE), L('Person')), quad(person, L('subject'), nn(o.subject)));
  q.push(
    quad(prov, nn(RDF_TYPE), L('Provenance')),
    quad(prov, L('tier'), L('IssuerSigned')),
    quad(prov, L('issuer'), nn(o.issuer)),
    quad(prov, L('originalHash'), lit(o.originalHash)),
    quad(prov, L('converter'), lit(CONVERTER)),
    quad(prov, L('converterCert'), nn(o.converterCert ?? 'urn:lake:cert:uncertified')),
    quad(prov, L('signedBy'), nn(o.subject)),
  );
  for (const c of claims) {
    const s = me(c.id);
    q.push(quad(s, nn(RDF_TYPE), L(FIELD_CLASS[c.field])), quad(s, L('about'), person), quad(s, L('provenance'), prov), quad(s, L('value'), lit(c.value)));
    if (c.code) q.push(quad(s, L('code'), lit(c.code)));
    if (c.observedAt) q.push(quad(s, L('observedAt'), lit(c.observedAt, nn(XSD + 'dateTime'))));
  }
  const writer = new Writer({ prefixes: { lake: LAKE, xsd: XSD } });
  writer.addQuads(q);
  let turtle = '';
  writer.end((err, out) => { if (err) throw err; turtle = out; });
  return { claims, turtle };
}
