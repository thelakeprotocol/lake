import { DataFactory, Parser, Writer } from 'n3';

/**
 * A pack is one use case on the Lake: health research, mortgages, energy… The core knows no field,
 * domain or company; packs declare them (SPEC §10). A pack says which coarse "safe fields" programs may
 * read, what each one means (a class in a vocabulary, ideally mapped to an existing standard), where its
 * data lives in a pod by default, how a house gets a signed record and turns it into claims, and the
 * SHACL shapes those claims must pass before anything runs on them.
 */
export interface LakePack {
  /** Short id, also the prefix of its pod folder: `health`, `mortgage`. */
  id: string;
  /** Semver. Programs name the major they were written for (`mortgage@1`). */
  version: string;
  title: string;
  /** Base IRI of the pack's vocabulary. */
  vocab: string;
  /** Default pod container for its data, e.g. `health/`. */
  folder: string;
  /** The class a pod's Type Index registers this pack's data under, so any Solid app can find where it lives. */
  recordClass: string;
  /** The fields programs may read and offers may name. */
  fields: Record<string, PackField>;
  /** Fields a pack mentions but no program may ever read: identifying ones. */
  identifying?: string[];
  /** Fields an offer may name but no program reads, and that don't identify anyone alone (a postcode): the owner's rules decide. */
  quasiIdentifying?: string[];
  /** SHACL shapes (Turtle) every converted claims document must pass. */
  shapes?: string;
  source?: PackSource;
  /**
   * Intents: what an owner may announce they want ("a mortgage, around this price, in this region"), as
   * coarse public terms. Houses with the same `groupBy` terms form a group that agents can bid for together.
   */
  intent?: {
    terms: Record<string, IntentTerm>;
    groupBy: string[];
    /** Terms an owner may leave as `auto`, worked out inside the house from their own claims (e.g. a price band they can afford). */
    auto?: (claims: Claim[]) => Record<string, string | number>;
  };
  /**
   * The authority (a register, a regulator) whose authorisation an agent must carry to ask for this pack's fields
   * or hear its intents (SPEC §5.2).
   */
  authority?: {
    name: string; description: string; domain: string; path: string; register: string[];
    /**
     * Whether a certified study may read this pack's fields without the register's authorisation (a study lets only
     * totals out). Default false: a register's fields go only to agents on it, and no auditor certifies a study that reads them.
     */
    studies?: boolean;
  };
  /** What an owner hands over when they accept an offer: the issuer-signed original, so the asker can check it with the issuer. */
  release?: ('original' | 'credential' | 'claims')[];
  /** With release 'claims': which fields' claims go, and nothing else (a shopping list, not the receipts behind it). */
  releaseFields?: string[];
  /** Something to try: what guides and examples show for this pack. */
  examples?: {
    study?: import('./study.js').Study;
    studies?: import('./study.js').Study[];
    offers?: Record<string, Omit<import('./offer.js').Offer, 'id' | 'requester'>>;
    /** Demo agents that quote for this pack's intents (lenders, insurers…), each with its certified program. */
    quoters?: QuoterExample[];
  };
}

export interface PackField {
  /** Class IRI of claims for this field. */
  class: string;
  /** How programs may compare it: a band ("60-69"), a number, a code from a code system, or a fact that's present or not. */
  kind: 'band' | 'number' | 'code' | 'flag';
  label: string;
  /** The term in an existing standard this field corresponds to (FHIR, FIBO, schema.org…), when there is one. */
  standard?: string;
  /** Unit for numbers, e.g. AUD, months. */
  unit?: string;
  /** Special-category data (health, beliefs, biometrics… in data-protection law): a house warns its owner when it's asked for to make decisions about them. */
  special?: boolean;
}

/** How a house gets its record for this pack: a trusted issuer signs the original, a certified converter turns it into claims. */
export interface PackSource {
  /** Verifiable Credential type the issuer signs the original with. */
  credentialType: string;
  /** Converter package@version: what an auditor certifies. */
  converter: string;
  mediaType: string;
  /** File name of the original inside `<folder>original/`. */
  originalName: string;
  /** The demo issuer that plays the hospital, the bank… */
  issuer: { name: string; description: string; domain: string; path: string };
  /** Original → canonical claims. Pure; runs inside the house. */
  convert(original: string, asOf?: number): Claim[];
  /** A synthetic original for a subject (seeded by it). Demo issuers only; never real data. */
  synthetic(subject: string, asOf?: number): string;
}

export interface IntentTerm {
  kind: 'band' | 'number' | 'code';
  label: string;
  /** The coarse choices an owner picks from: public, so they must not identify anyone. */
  options: (string | number)[];
  /** Unit of a band or number term, e.g. AUD: how the owner's panel shows the choices. */
  unit?: string;
  /** Plain-English names for code choices, for the owner's panel (e.g. nsw → New South Wales). */
  names?: Record<string, string>;
}

export interface QuoterExample {
  name: string;
  domain: string;
  program: import('./program.js').QuoteProgram;
  /** What it pays the owner on acceptance, in whole currency units (e.g. a procuration fee). */
  feeOnAccept?: number;
  /** ISO 4217 currency of the fee (default USD). */
  currency?: string;
  /** What an acceptance becomes, and what happens next, in the quoter's words (default: a lender's conditional approval). */
  acceptedAs?: string;
  next?: string;
  /** Single items it also sells, at fixed prices, on its signed card: ordered from it like any seller's menu (SPEC §6.5). */
  menu?: import('./trade.js').MenuItem[];
}

export interface Claim {
  field: string;
  value: string;
  code?: string;
  observedAt?: string;
}

const registry = new Map<string, LakePack>();

/**
 * Loads use cases by id: `health`, `mortgage`… Each is a package of its own (`@thelakeprotocol/usecase-<id>`,
 * or any module path) exporting a LakePack as its default. Whoever calls this knows none of them by name;
 * it passes its own `import`, so packages resolve from where they're installed (`(n) => import(n)`).
 */
export async function loadPacks(ids: string[], load: (name: string) => Promise<unknown>): Promise<LakePack[]> {
  const out: LakePack[] = [];
  for (const id of ids.map((x) => x.trim()).filter(Boolean)) {
    const name = id.includes('/') || id.startsWith('.') ? id : `@thelakeprotocol/usecase-${id}`;
    const mod = (await load(name)) as { default?: LakePack };
    if (!mod.default?.id) throw new Error(`${name} does not export a Lake pack as its default`);
    registerPack(mod.default);
    out.push(mod.default);
  }
  return out;
}

/** Packs a process uses register themselves here; everything generic looks fields up through this. */
export function registerPack(p: LakePack) {
  if (registry.get(p.id) === p) return;
  for (const f of Object.keys(p.fields)) {
    const owner = [...registry.values()].find((o) => o.id !== p.id && f in o.fields);
    if (owner) throw new Error(`field "${f}" is declared by both ${owner.id} and ${p.id}`);
  }
  registry.set(p.id, p);
}

export const packs = (): LakePack[] => [...registry.values()];
export const pack = (id: string): LakePack | undefined => registry.get(id.split('@')[0]!);
export const packId = (p: LakePack) => `${p.id}@${p.version.split('.')[0]}`;
export const fieldSpec = (field: string): (PackField & { pack: LakePack }) | undefined => {
  for (const p of registry.values()) if (p.fields[field]) return { ...p.fields[field]!, pack: p };
  return undefined;
};
/**
 * The fields a register guards (SPEC §5.2), by pack: those of `fields` whose pack names an authority, less any a
 * certified study reads (`readByStudy`) where that pack lets studies read its fields. An agent needs the register's
 * authorisation to ask for what's left.
 */
export function guardedFields(fields: string[], readByStudy: string[] = []): { pack: LakePack; fields: string[] }[] {
  const out = new Map<LakePack, string[]>();
  for (const f of new Set(fields)) {
    const spec = fieldSpec(f);
    if (!spec?.pack.authority || (spec.pack.authority.studies && readByStudy.includes(f))) continue;
    out.set(spec.pack, [...(out.get(spec.pack) ?? []), f]);
  }
  return [...out].map(([pack, fields]) => ({ pack, fields }));
}
/** Ready-made offers the loaded packs provide, by name (`gp`, `marketing`…), for CLIs, demos and tests. */
export const exampleOffers = () => Object.assign({}, ...packs().map((p) => p.examples?.offers ?? {})) as Record<string, Omit<import('./offer.js').Offer, 'id' | 'requester'>>;
/** Studies the loaded packs offer as examples (what sandbox sponsors and assistants may run). */
export const exampleStudies = () => packs().flatMap((p) => p.examples?.studies ?? (p.examples?.study ? [p.examples.study] : []));
export const allFields = () => packs().flatMap((p) => Object.keys(p.fields));
export const identifyingFields = () => packs().flatMap((p) => p.identifying ?? []);
/** Every field name an offer may use: what programs read, plus the identifying and quasi-identifying ones packs name. */
export const offerableFields = () => [...new Set(packs().flatMap((p) => [...Object.keys(p.fields), ...(p.identifying ?? []), ...(p.quasiIdentifying ?? [])]))];

/** Where a pack's files live in a pod, relative to the pod root (or to the folder the Type Index names). */
export function packPaths(p: LakePack, folder = p.folder) {
  const original = p.source?.originalName ?? 'record.json';
  const stem = original.replace(/\.[^.]+$/, '');
  return {
    folder,
    original: `${folder}original/${original}`,
    credential: `${folder}original/${stem}.vc.jwt`,
    issuer: `${folder}original/issuer.json`,
    claims: `${folder}claims.ttl`,
    claimsCredential: `${folder}claims.vc.jwt`,
    converterCert: `${folder}converter.cert.json`,
  };
}

/** The core model every pack's claims sit inside (model/lake.ttl). */
export const LAKE_MODEL = 'https://lake.doneinfifty.com/model/v0#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface Provenance { subject: string; issuer: string; originalHash: string; converter: string; converterCert?: string }

/** Claims → Turtle in the canonical model, with the provenance the trust chain needs (SPEC §10). */
export function claimsToTurtle(p: LakePack, claims: Claim[], base: string, prov: Provenance): string {
  const { namedNode: nn, literal: lit, quad } = DataFactory;
  const L = (n: string) => nn(LAKE_MODEL + n);
  const me = (frag: string) => nn(`${base}#${frag}`);
  const person = me('person');
  const pv = me('provenance');
  const q = [
    quad(person, nn(RDF_TYPE), L('Person')), quad(person, L('subject'), nn(prov.subject)),
    quad(pv, nn(RDF_TYPE), L('Provenance')), quad(pv, L('tier'), L('IssuerSigned')), quad(pv, L('issuer'), nn(prov.issuer)),
    quad(pv, L('originalHash'), lit(prov.originalHash)), quad(pv, L('converter'), lit(prov.converter)),
    quad(pv, L('converterCert'), nn(prov.converterCert ?? 'urn:lake:cert:uncertified')), quad(pv, L('signedBy'), nn(prov.subject)),
  ];
  claims.forEach((c, i) => {
    const spec = p.fields[c.field];
    if (!spec) throw new Error(`${p.id} has no field "${c.field}"`);
    const s = me(`${c.field}-${i}`);
    q.push(quad(s, nn(RDF_TYPE), nn(spec.class)), quad(s, L('about'), person), quad(s, L('provenance'), pv), quad(s, L('value'), lit(c.value)));
    if (c.code) q.push(quad(s, L('code'), lit(c.code)));
    if (c.observedAt) q.push(quad(s, L('observedAt'), lit(c.observedAt, nn(XSD + 'dateTime'))));
  });
  const writer = new Writer({ prefixes: { lake: LAKE_MODEL, xsd: XSD, [p.id]: p.vocab } });
  writer.addQuads(q);
  let turtle = '';
  writer.end((err, out) => { if (err) throw err; turtle = out; });
  return turtle;
}

/** Turtle → claims, for every field of a registered pack whose class appears in it. */
export function turtleToClaims(turtle: string, base: string): Claim[] {
  const byClass = new Map<string, string>();
  for (const p of registry.values()) for (const [f, spec] of Object.entries(p.fields)) byClass.set(spec.class, f);
  const subjects = new Map<string, Record<string, string>>();
  for (const q of new Parser({ baseIRI: base }).parse(turtle)) {
    const s = subjects.get(q.subject.value) ?? {};
    if (q.predicate.value === RDF_TYPE) s.type = q.object.value;
    else if (q.predicate.value.startsWith(LAKE_MODEL)) s[q.predicate.value.slice(LAKE_MODEL.length)] = q.object.value;
    subjects.set(q.subject.value, s);
  }
  return [...subjects.values()]
    .filter((s) => s.type && byClass.has(s.type))
    .map((s) => ({ field: byClass.get(s.type!)!, value: s.value ?? '', ...(s.code ? { code: s.code } : {}), ...(s.observedAt ? { observedAt: s.observedAt } : {}) }));
}

/** Seeded randomness, for synthetic data and reproducible demo runs. */
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
