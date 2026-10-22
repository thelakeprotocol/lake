import { Parser } from 'n3';
import rdf from '@zazuko/env';
import SHACLValidator from 'rdf-validate-shacl';
import { CORE_SHAPES, type LakePack } from '@thelakeprotocol/core';

const validators = new Map<string, SHACLValidator>();

/** Claims must pass the core shapes and their pack's own before any program reads them; a house that fails holds nothing. */
export async function checkShapes(turtle: string, p: LakePack, base: string): Promise<{ ok: true } | { ok: false; why: string }> {
  let v = validators.get(p.id);
  if (!v) {
    const shapes = rdf.dataset([...new Parser().parse(CORE_SHAPES), ...new Parser().parse(p.shapes ?? '')]);
    v = new SHACLValidator(shapes, { factory: rdf });
    validators.set(p.id, v);
  }
  const report = await v.validate(rdf.dataset(new Parser({ baseIRI: base }).parse(turtle)));
  return report.conforms ? { ok: true } : { ok: false, why: report.results.slice(0, 3).map((r) => `${r.path?.value ?? ''} ${r.message.map((m) => m.value).join(' ')}`.trim()).join('; ') };
}
