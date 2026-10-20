import { parse } from 'yaml';

/**
 * Lake Blueprint 0.1 (SPEC §11): the one central piece of a decentralised Lake app. A markdown file with a
 * YAML header: what the app is called, the tag its participants put on their cards, its settings, and every
 * message kind with its fields. Agents build their own implementation from it; this checks the blueprint itself.
 */
export interface BlueprintMessage { to: string; fields: Record<string, FieldType> }
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
export interface Blueprint {
  blueprint: '0.1';
  name: string;
  version: string;
  title: string;
  summary: string;
  tag: string;
  participants: { min: number; max?: number };
  config?: Record<string, unknown>;
  messages: Record<string, BlueprintMessage>;
}

const TYPES: FieldType[] = ['string', 'integer', 'number', 'boolean', 'object', 'array'];
/** Sections every blueprint's body must have, so every implementer reads the same rules. */
export const BLUEPRINT_SECTIONS = ['Protocol', 'Validation'];

export function parseBlueprint(text: string): { meta: Blueprint; body: string; problems: string[] } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {} as Blueprint, body: text, problems: ['no YAML header between --- lines at the top'] };
  let meta: Blueprint;
  try {
    meta = parse(m[1]!) as Blueprint;
  } catch (e) {
    return { meta: {} as Blueprint, body: m[2]!, problems: [`header is not YAML: ${(e as Error).message}`] };
  }
  return { meta, body: m[2]!, problems: checkBlueprint(meta, m[2]!) };
}

export function checkBlueprint(b: Blueprint, body: string): string[] {
  const p: string[] = [];
  if (b?.blueprint !== '0.1') p.push('blueprint: must be "0.1"');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(b?.name ?? '')) p.push('name: lowercase letters, digits and dashes, starting with a letter');
  if (!/^\d+\.\d+\.\d+$/.test(String(b?.version ?? ''))) p.push('version: semver, like 1.0.0');
  if (!b?.title) p.push('title: required');
  if (!b?.summary) p.push('summary: required');
  if (!/^[a-z0-9-]+:[a-z0-9._-]+$/.test(b?.tag ?? '')) p.push('tag: "<kind>:<name>", like chat:lake-lounge');
  if (!(Number.isInteger(b?.participants?.min) && b.participants.min >= 1)) p.push('participants.min: a whole number, at least 1');
  if (b?.participants?.max !== undefined && !(Number.isInteger(b.participants.max) && b.participants.max >= b.participants.min)) p.push('participants.max: a whole number, at least min');
  const kinds = Object.entries(b?.messages ?? {});
  if (!kinds.length) p.push('messages: at least one message kind');
  for (const [kind, msg] of kinds) {
    if (!kind.startsWith(`${b.name}.`)) p.push(`messages.${kind}: kinds start with "${b.name}."`);
    if (!msg?.to) p.push(`messages.${kind}.to: who receives it (e.g. "every member", "the other player")`);
    for (const [f, t] of Object.entries(msg?.fields ?? {})) {
      if (f === 'kind' || f === 'bp') p.push(`messages.${kind}.fields.${f}: "kind" and "bp" are on every message already`);
      if (!TYPES.includes(t)) p.push(`messages.${kind}.fields.${f}: one of ${TYPES.join(', ')}`);
    }
  }
  if (b?.name && !b.messages?.[`${b.name}.reject`]) p.push(`messages.${b.name}.reject: every blueprint has a reject message (with a "why")`);
  for (const s of BLUEPRINT_SECTIONS) if (!new RegExp(`^## ${s}\\b`, 'm').test(body)) p.push(`body: needs a "## ${s}" section`);
  return p;
}

/** The `bp` every message of this blueprint carries: name and major version. Different major, different app. */
export const blueprintId = (b: Pick<Blueprint, 'name' | 'version'>) => `${b.name}/${b.version.split('.')[0]}`;

/** Checks one incoming message against the blueprint's declared kinds and fields. Its own rules come on top. */
export function checkBlueprintMessage(b: Blueprint, msg: Record<string, unknown>): string[] {
  const p: string[] = [];
  if (msg.bp !== blueprintId(b)) p.push(`bp: expected "${blueprintId(b)}", got ${JSON.stringify(msg.bp)}`);
  const spec = b.messages[String(msg.kind)];
  if (!spec) return [...p, `kind: ${JSON.stringify(msg.kind)} is not in this blueprint`];
  for (const [f, t] of Object.entries(spec.fields ?? {})) {
    const v = msg[f];
    const ok = t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : typeof v === t;
    if (!ok) p.push(`${f}: expected ${t}`);
  }
  return p;
}
