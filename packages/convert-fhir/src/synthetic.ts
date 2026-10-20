/**
 * Synthetic FHIR R4 patients in the shape Synthea exports (a Bundle of Patient, Condition,
 * MedicationRequest and Encounter resources). Seeded, so the same seed always makes the same person.
 * No real data, ever. A real Synthea export can be used instead; the converter reads both.
 */

export const DEMO_DRUGS = 'https://lake.doneinfifty.com/demo/drugs';

const CONDITIONS = [
  { code: '84114007', display: 'Heart failure' },
  { code: '44054006', display: 'Type 2 diabetes mellitus' },
  { code: '13645005', display: 'Chronic obstructive lung disease' },
  { code: '38341003', display: 'Hypertension' },
];
// Fictional drugs: the demo asks about "drug X" and must never look like medical advice about a real one.
const DRUGS = [
  { code: 'drug-x', display: 'Drug X' },
  { code: 'drug-y', display: 'Drug Y' },
  { code: 'drug-z', display: 'Drug Z' },
];

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const day = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

export interface FhirBundle {
  resourceType: 'Bundle';
  type: string;
  entry: { fullUrl: string; resource: Record<string, any> }[];
}

/** One synthetic patient. `asOf` fixes "today" so seeded runs are identical. */
export function syntheticPatient(seed: number, asOf = Date.UTC(2026, 9, 1)): FhirBundle {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const pid = `urn:uuid:patient-${seed.toString(16)}`;
  const age = 30 + Math.floor(r() * 60);
  const birth = asOf - age * 365.25 * day - Math.floor(r() * 365) * day;
  const entry: FhirBundle['entry'] = [
    {
      fullUrl: pid,
      resource: { resourceType: 'Patient', id: pid.slice(9), gender: r() < 0.5 ? 'female' : 'male', birthDate: iso(birth).slice(0, 10), name: [{ given: ['Synthetic'], family: `Person-${seed % 10000}` }] },
    },
  ];
  const n = 1 + Math.floor(r() * 2);
  const conds = [...CONDITIONS].sort(() => r() - 0.5).slice(0, n);
  conds.forEach((c, i) =>
    entry.push({ fullUrl: `urn:uuid:cond-${seed}-${i}`, resource: { resourceType: 'Condition', subject: { reference: pid }, code: { coding: [{ system: 'http://snomed.info/sct', ...c }], text: c.display }, onsetDateTime: iso(asOf - (400 + Math.floor(r() * 2000)) * day) } }),
  );
  const onX = r() < 0.5;
  const meds = onX ? [DRUGS[0]!, ...(r() < 0.4 ? [pick(DRUGS.slice(1))] : [])] : [pick(DRUGS.slice(1))];
  meds.forEach((m, i) =>
    entry.push({ fullUrl: `urn:uuid:med-${seed}-${i}`, resource: { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: pid }, medicationCodeableConcept: { coding: [{ system: DEMO_DRUGS, ...m }], text: m.display }, authoredOn: iso(asOf - Math.floor(r() * 700) * day) } }),
  );
  // Older patients, and patients not on drug X, are admitted and readmitted a little more: the study has something to find.
  const risk = 0.15 + (age >= 60 ? 0.25 : 0) - (onX ? 0.12 : 0);
  let t = asOf - 700 * day;
  let k = 0;
  while (t < asOf - 40 * day && k < 6) {
    t += Math.floor(60 + r() * 300) * day;
    if (r() > 0.55) continue;
    const stay = Math.floor(2 + r() * 6) * day;
    entry.push(encounter(seed, k++, pid, t, t + stay));
    if (r() < risk) {
      const back = t + stay + Math.floor(3 + r() * 25) * day;
      entry.push(encounter(seed, k++, pid, back, back + Math.floor(2 + r() * 5) * day));
      t = back;
    }
  }
  return { resourceType: 'Bundle', type: 'collection', entry };
}

function encounter(seed: number, k: number, pid: string, start: number, end: number) {
  return {
    fullUrl: `urn:uuid:enc-${seed}-${k}`,
    resource: { resourceType: 'Encounter', status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' }, subject: { reference: pid }, period: { start: iso(start), end: iso(end) } },
  };
}
