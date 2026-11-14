import { join } from 'node:path';
import { loadOrCreateIdentity } from '@thelakeprotocol/core';
import { ask, makeVisitor, type Visitor } from '@thelakeprotocol/visitor';

/**
 * Tells whoever runs this Lake, at their own house, when something they asked to hear about happens (an AI app's first
 * real sign-in here): a signed note, as any agent leaves one, from a key this connector keeps. Nothing is sent unless
 * an operator house is named; ten a day at most. (14 Nov: "how do we know when a real second human uses the Lake?")
 */
export function operatorNotes(o: { house?: string; dataDir?: string; publicUrl: string; log?: (m: string) => void }) {
  let me: Promise<Visitor> | null = null;
  let told = { day: '', n: 0 };
  return (text: string) => {
    if (!o.house || !o.dataDir) return;
    const day = new Date().toISOString().slice(0, 10);
    if (told.day !== day) told = { day, n: 0 };
    if (++told.n > 10) return;
    me ??= loadOrCreateIdentity(join(o.dataDir, 'operator-key.json')).then((id) => makeVisitor(id, new URL(o.publicUrl).host, "This Lake's connector", `${o.publicUrl.replace(/\/$/, '')}/operator/a2a`));
    void me.then((v) => ask(`${o.house!.replace(/\/$/, '')}/a2a`, v, { kind: 'note', text, purpose: 'contact' }))
      .then((r) => { const kind = String((r.reply as { kind?: string; decision?: string } | null)?.kind ?? ''); o.log?.(kind === 'noted' ? `told the operator (noted): ${text}` : `the operator's house didn't take it (${kind || 'no answer'}): ${text}`); }, (e: Error) => o.log?.(`couldn't tell the operator: ${e.message}`));
  };
}
