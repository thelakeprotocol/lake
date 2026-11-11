import { parseArgs, type ParseArgsConfig } from 'node:util';

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * A server's command line: Node's own parser, plus `--help` (usage made from the options themselves, so it can't go
 * stale) and one plain line instead of a stack trace for an option it doesn't know.
 */
export function parseCli<O extends Options>(o: { name: string; about: string; usage: string; options: O; allowPositionals?: boolean; notes?: Record<string, string>; example?: string }) {
  const options = { ...o.options, help: { type: 'boolean' as const, short: 'h' } };
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: o.allowPositionals ?? false, strict: true });
  } catch (e) {
    // Node's first sentence only (with positionals allowed it adds advice about '--' that doesn't help here).
    const first = (e as Error).message.split('\n')[0]!.replace(/\. To specify a positional.*$/, '').replace(/\.$/, '');
    console.error(`${o.name}: ${first.replace(/^Unknown option/, 'unknown option')}. ${o.name} --help lists them.`);
    process.exit(2);
  }
  if ((parsed.values as { help?: boolean }).help) {
    const rows = Object.entries(o.options).map(([k, v]) => {
      const d = (v as { default?: unknown }).default;
      const left = `  --${k}${v.type === 'string' ? ' <value>' : ''}`;
      const right = [o.notes?.[k], d !== undefined && d !== false && d !== '' ? `(now: ${String(d)})` : ''].filter(Boolean).join(' ');
      return right ? `${left.padEnd(30)} ${right}` : left;
    });
    console.log(`${o.about}\n\nUsage: ${o.usage}\n\nOptions (most also read an environment variable; "now" shows what this run would use):\n${rows.join('\n')}${o.example ? `\n\nExample:\n  ${o.example}` : ''}`);
    process.exit(0);
  }
  return parsed as unknown as { values: { [K in keyof O]: O[K] extends { type: 'boolean' } ? boolean : string | undefined } & { help?: boolean }; positionals: string[] };
}
