import { parse, stringify } from 'yaml';
import type { AgentCard } from '@a2a-js/sdk';
import { canonicalize } from './canonical.js';
import { verifyLakeCard } from './card.js';
import { verifyMessage, type Signed } from './crypto.js';

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

/** The same problem on every message reads once, with how many messages it applies to: easier to fix than a wall of repeats. */
function grouped(problems: string[]): string[] {
  const out = new Map<string, number>();
  for (const p of problems) {
    const key = p.replace(/^messages\.[^.:\s]+\./, 'messages.<each>.');
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return [...out].map(([p, n]) => (n > 1 ? `${p} (${n} messages)` : p.replace('messages.<each>.', problems.find((x) => x.replace(/^messages\.[^.:\s]+\./, 'messages.<each>.') === p)!.match(/^messages\.[^.:\s]+\./)?.[0] ?? 'messages.')));
}

export function parseBlueprint(text: string): { meta: Blueprint; body: string; problems: string[] } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {} as Blueprint, body: text, problems: ['no YAML header between --- lines at the top'] };
  let meta: Blueprint;
  try {
    meta = parse(m[1]!) as Blueprint;
  } catch (e) {
    return { meta: {} as Blueprint, body: m[2]!, problems: [`header is not YAML: ${(e as Error).message}`] };
  }
  return { meta, body: m[2]!, problems: grouped(checkBlueprint(meta, m[2]!)) };
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
      if (['nonce', 'iat', 'exp', 'iss'].includes(f)) p.push(`messages.${kind}.fields.${f}: reserved for the signed envelope; call it something else`);
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

/**
 * A blueprint's header written out with correct YAML quoting: for a dry run, so an author fixes quoting in one go rather
 * than one error at a time (run 17). If the header won't parse, plain `key: value` lines whose value holds a colon or a
 * quote are quoted first; anything else is left for the author.
 */
export function blueprintHeader(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const tryParse = (y: string) => { try { return parse(y) as unknown; } catch { return null; } };
  const quoted = m[1]!.split(/\r?\n/).map((line) => {
    const kv = line.match(/^(\s*[\w.-]+):\s+(.+)$/);
    if (!kv || /^["'[{|>]/.test(kv[2]!) || !/[:#'"]/.test(kv[2]!)) return line;
    return `${kv[1]}: ${JSON.stringify(kv[2])}`;
  }).join('\n');
  const meta = tryParse(m[1]!) ?? tryParse(quoted);
  return meta && typeof meta === 'object' ? `---\n${stringify(meta).trim()}\n---` : null;
}

/**
 * What a node puts on the transparency log when a blueprint is published (SPEC §11.3): the author's signed card and the
 * author's own signed `{ kind: "blueprint", text }`, exactly as the node verified them, in canonical JSON. Logging the
 * author's signature (not the node's word, nor only a digest) lets anyone check, from the log alone, that this exact text
 * was signed by the key on that card for that domain; the log's order and checkpoints say when it went on the record.
 */
export const blueprintRecord = (card: AgentCard, envelope: Signed<{ kind: 'blueprint'; text: string }>) => canonicalize({ kind: 'lake.blueprint', card, envelope });

/**
 * Checks a logged blueprint record: the card's signature, the author's signature on the text (as of when it was signed:
 * the message's short expiry is for delivery, not for the record), and that the card's holder signed it. Returns the
 * text and who published it. The author's domain was proved to the node at publication; checking it again needs the
 * network (domain.ts). Throws why not.
 */
export async function checkBlueprintRecord(entry: string): Promise<{ name: string; version: string; text: string; author: string; webId: string; signedAt: string }> {
  const r = JSON.parse(entry) as { kind?: string; card?: AgentCard; envelope?: Signed<{ kind: string; text: string }> };
  if (r?.kind !== 'lake.blueprint' || !r.card || !r.envelope?.payload) throw new Error('not a logged blueprint');
  const profile = await verifyLakeCard(r.card);
  const iat = Number(r.envelope.payload.iat);
  const p = await verifyMessage(r.envelope, async (kid) => (kid === profile.publicJwk.kid ? profile.publicJwk : null), { now: iat * 1000 });
  if (p.iss !== profile.webId) throw new Error(`signed by ${p.iss}, but the card is ${profile.webId}'s`);
  if (p.kind !== 'blueprint' || typeof p.text !== 'string') throw new Error('not a blueprint message');
  const { meta } = parseBlueprint(p.text);
  return { name: meta.name, version: String(meta.version), text: p.text, author: profile.ownerDomain, webId: profile.webId, signedAt: new Date(iat * 1000).toISOString() };
}
