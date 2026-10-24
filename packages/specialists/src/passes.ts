import { readFile, writeFile } from 'node:fs/promises';
import { checkSdJwtAttachment, countContext, issuePass, newPassKey, PERSON_IN_CONTEXT_VCT, type AgentCard, type PassKey } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A pass issuer (Privacy Pass, RFC 9576/9578; SPEC §11.4): blind pledges' anonymous tokens. A tally registers each blind
 * pledge here and gets a key for it alone. Anyone who may sign asks for passes for every open pledge at once, so asking
 * says nothing about which one they'll sign; this issuer signs blinded requests and never sees the tokens, so a spent
 * token can't be traced to whoever asked for it. One pass per requester per pledge: per signed identity, or per person
 * (a person stamp for this issuer) for a pledge that counts people. Quiet: who asks for passes is nobody's business.
 */
interface Pledge { tally: string; id: string; key: PassKey; peopleOnly: boolean; deadline: number; issuedTo: string[] }

export async function createPasses(o: SpecialistOptions & { dataDir: string; personCheckers?: string[] }) {
  const file = `${o.dataDir}/passes.json`;
  const pledges = new Map<string, Pledge>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Pledge[]).map((p) => [`${p.tally}|${p.id}`, p]));
  const save = () => writeFile(file, JSON.stringify([...pledges.values()])).catch(() => {});
  setInterval(() => { for (const [k, p] of pledges) if (p.deadline < Date.now() - 86_400_000) pledges.delete(k); void save(); }, 3_600_000).unref();
  const checkers = o.personCheckers ?? ['person.lake.local'];
  const open = () => [...pledges.values()].filter((p) => p.deadline > Date.now()).map((p) => ({ tally: p.tally, id: p.id, publicKey: p.key.publicKey, peopleOnly: p.peopleOnly, deadline: new Date(p.deadline).toISOString() }));

  const s: Specialist = await specialist(o, 'Pass issuer', 'Issues anonymous one-time passes (Privacy Pass, RFC 9578) for blind pledges: a tally registers a pledge here; anyone may ask for passes for every open pledge at once ({ kind: "pass.open" } lists them; { kind: "pass.issue", requests: [{ tally, id, request }] } signs blinded requests). It never sees the passes it signs, so a spent pass can\'t be traced to who asked. One per requester (or per person, for pledges that count people) per pledge.', 'passes', async (p, from, profile) => {
    if (p.kind === 'pass.register') {
      // A tally registers a blind pledge: the key is for that tally's pledge alone.
      const id = String(p.id ?? ''), deadline = Date.parse(String(p.deadline ?? ''));
      if (!id || !(deadline > Date.now())) return { kind: 'refused', problems: ['register: id, deadline'] };
      const k = `${from}|${id}`;
      if (pledges.has(k)) return { kind: 'refused', problems: [`"${id}" is registered already`] };
      const pledge: Pledge = { tally: from, id, key: await newPassKey(), peopleOnly: p.people_only === true, deadline, issuedTo: [] };
      pledges.set(k, pledge);
      void save();
      return { kind: 'pass.registered', id, publicKey: pledge.key.publicKey, publicJwk: pledge.key.publicJwk, issuer: s.webId };
    }
    if (p.kind === 'pass.open') return { kind: 'pass.open', issuer: s.webId, pledges: open() };
    if (p.kind !== 'pass.issue') return { kind: 'refused', problems: ['send pass.open, or pass.issue { requests: [{ tally, id, request }], person? }'] };
    const requests = (Array.isArray(p.requests) ? p.requests : []).slice(0, 50) as { tally?: string; id?: string; request?: string }[];
    // For pledges that count people, one pass per person: a stamp for this issuer, bound to the asker's key.
    let person: string | undefined;
    if (requests.some((r) => pledges.get(`${r.tally}|${r.id}`)?.peopleOnly)) {
      const stamp = await checkSdJwtAttachment(p.person as { credential?: unknown; card?: AgentCard } | undefined, { trusted: checkers, vct: PERSON_IN_CONTEXT_VCT, subject: from, holder: profile.publicJwk, aud: s.webId, nonce: 'passes', sandbox: o.sandbox });
      if (!stamp.ok || stamp.claims.context !== countContext(s.webId, 'passes')) return { kind: 'refused', problems: [`a pledge that counts people needs a person stamp for "${countContext(s.webId, 'passes')}" (${stamp.ok ? 'it is for another context' : stamp.why})`] };
      person = String(stamp.claims.person);
    }
    const issued: { tally: string; id: string; response?: string; refused?: string }[] = [];
    for (const r of requests) {
      const pledge = pledges.get(`${r.tally}|${r.id}`);
      if (!pledge || pledge.deadline < Date.now()) { issued.push({ tally: String(r.tally), id: String(r.id), refused: 'no such open pledge' }); continue; }
      const who = pledge.peopleOnly ? person! : from;
      if (pledge.issuedTo.includes(who)) { issued.push({ tally: pledge.tally, id: pledge.id, refused: 'one pass each, and you have yours' }); continue; }
      try {
        issued.push({ tally: pledge.tally, id: pledge.id, response: await issuePass(s.webId, pledge.key, String(r.request ?? '')) });
        pledge.issuedTo.push(who);
      } catch (e) {
        issued.push({ tally: pledge.tally, id: pledge.id, refused: `not a pass request: ${(e as Error).message}` });
      }
    }
    void save();
    return { kind: 'pass.issued', issued };
  }, [], true);
  return s;
}
