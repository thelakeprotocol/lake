import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { checkPass, checkSdJwtAttachment, commitTo, countContext, makeEvent, passChallenge, PERSON_IN_CONTEXT_VCT, sendLake, signMessage, verifyLakeData, type AgentCard, type LakeData } from '@thelakeprotocol/core';
import { specialist, type SpecialistOptions } from './review.js';

/**
 * A blind tally (SPEC §11.4): for pledges that bind only once enough sign ("nobody goes first"). Until the
 * threshold, it tells anyone how many have signed and nobody who, the opener included. At the threshold it
 * tells every signer, at once, who is in. If the deadline passes first, it forgets them. It knows who signed
 * (each signature is a signed message), so you trust it the way you trust an auditor; hiding signers even
 * from the tally needs cryptography this version doesn't have.
 */
interface Tally {
  id: string;
  text: string;
  threshold: number;
  deadline: number;
  opener: string;
  state: 'open' | 'triggered' | 'lapsed';
  /** Count people, not identities: each signature needs a person stamp, and one person counts once (SPEC §6.4). */
  peopleOnly?: boolean;
  signers: { webId: string; domain: string; url: string; at: string; person?: string }[];
  /**
   * A blind pledge (SPEC §11.4): signatures are anonymous passes from a separate issuer, so this tally never learns who
   * signed; each pass carries a commitment to its signer, opened by the signer once the pledge has filled.
   */
  blind?: { issuer: string; publicJwk: JsonWebKey; passes: { commit: string; withdraw: string; at: string; revealed?: { webId: string; domain: string; url: string } }[]; spent: string[] };
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_DAYS = 30;

export async function createTally(o: SpecialistOptions & { dataDir: string; personCheckers?: string[]; passesUrl?: string }) {
  const checkers = o.personCheckers ?? ['person.lake.local'];
  const file = `${o.dataDir}/tallies.json`;
  const tallies = new Map<string, Tally>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Tally[]).map((t) => [t.id, t]));
  const save = () => writeFile(file, JSON.stringify([...tallies.values()])).catch(() => {});
  const counted = (t: Tally) => (t.blind ? t.blind.passes.length : t.signers.length);
  const view = (t: Tally) => ({ id: t.id, text: t.text, threshold: t.threshold, count: counted(t), deadline: new Date(t.deadline).toISOString(), state: t.state, ...(t.peopleOnly ? { people_only: true } : {}),
    // A blind pledge binds only when enough signers have revealed themselves, not just when enough passes are in (run 21:
    // "make pledges actually bind"): an anonymous signature is cheap until its signer stands by it.
    ...(t.blind ? { blind: true, issuer: t.blind.issuer, revealed: t.blind.passes.filter((x) => x.revealed).length, bound: t.blind.passes.filter((x) => x.revealed).length >= t.threshold } : {}) });
  // Public counts go out late and in batches: a count that ticks the moment someone signs would let anyone match
  // it against that someone's other activity. (Six Claudes unmasked a blind pledge from the public feed that way.)
  const due = new Set<Tally>();
  let timer: NodeJS.Timeout | null = null;
  const report = (t: Tally) => {
    due.add(t);
    timer ??= setTimeout(() => {
      timer = null;
      for (const x of due) o.report?.(makeEvent('tally.update', 'self', undefined, { count: counted(x), threshold: x.threshold, state: x.state }));
      due.clear();
    }, 30_000 + Math.random() * 60_000);
  };

  // Messages the tally sends on its own: the trigger, and a lapse.
  const tell = async (url: string, body: Record<string, unknown>) => {
    try {
      const envelope = await signMessage(body, o.id, { iss: s.webId });
      await sendLake(url, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 });
    } catch {
      // A signer that has gone can still ask for the result with tally.count.
    }
  };
  const lapse = (t: Tally) => {
    if (t.state !== 'open' || t.deadline > Date.now()) return;
    t.state = 'lapsed';
    const gone = t.signers;
    t.signers = [];
    if (t.blind) t.blind.passes = [];
    for (const x of gone) void tell(x.url, { kind: 'tally.lapsed', id: t.id, count: gone.length, threshold: t.threshold });
    report(t);
    void save();
  };
  setInterval(() => { for (const t of tallies.values()) lapse(t); }, 30_000).unref();

  // A signed request of the tally's own (to the pass issuer), and its verified reply.
  const ask = async (url: string, body: Record<string, unknown>) => {
    const envelope = await signMessage(body, o.id, { iss: s.webId });
    const raw = await sendLake(url, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs: 20_000 });
    const v = await verifyLakeData<Record<string, unknown>>(raw as LakeData<Record<string, unknown>>, { sandbox: o.sandbox });
    if (!v.ok) throw new Error(v.rejection.why);
    return v.payload as Record<string, any>;
  };

  /** A blind pledge's messages: a pass to sign, a secret to withdraw, a salt to reveal yourself once it has filled. */
  const blindly = async (t: Tally, p: Record<string, unknown>, from: string, profile: { ownerDomain: string }, card: AgentCard) => {
    const b = t.blind!;
    const hex = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
    if (p.kind === 'tally.sign') {
      if (t.state !== 'open' && t.state !== 'triggered') return { kind: 'refused', problems: [`it has ${t.state}`] };
      if (t.deadline < Date.now()) return { kind: 'refused', problems: ['its deadline has passed'] };
      if (typeof p.pass !== 'string' || !hex(p.commit) || !hex(p.withdraw)) return { kind: 'refused', problems: ['a blind pledge takes { pass, commit, withdraw }: a pass from its issuer, sha256(your webId|salt), sha256(a withdraw secret). Send it from a throwaway identity; lake_pledge does all of this.'] };
      const ok = await checkPass(p.pass, b.publicJwk, passChallenge(b.issuer, t.id, s.webId));
      if (!ok.ok) return { kind: 'refused', problems: [ok.why] };
      if (b.spent.includes(ok.nonce)) return { kind: 'refused', problems: ['that pass has been used'] };
      b.spent.push(ok.nonce);
      b.passes.push({ commit: String(p.commit), withdraw: String(p.withdraw), at: new Date().toISOString() });
      if (t.state === 'open' && b.passes.length >= t.threshold) t.state = 'triggered';
      void save();
      report(t);
      return { kind: t.state === 'triggered' ? 'tally.triggered' : 'tally.signed', ...view(t), note: t.state === 'triggered' ? 'It has filled: reveal yourself with tally.reveal { id, salt } from your own identity.' : 'Counted, by a pass nobody can trace to you.' };
    }
    if (p.kind === 'tally.withdraw') {
      if (t.state !== 'open') return { kind: 'refused', problems: [`it has ${t.state}; nothing to withdraw from`] };
      const h = createHash('sha256').update(String(p.secret ?? '')).digest('hex');
      const before = b.passes.length;
      b.passes = b.passes.filter((x) => x.withdraw !== h);
      if (b.passes.length === before) return { kind: 'refused', problems: ['no signature with that withdraw secret'] };
      void save();
      report(t);
      return { kind: 'tally.withdrawn', ...view(t) };
    }
    const revealed = () => b.passes.filter((x) => x.revealed).map((x) => x.revealed!);
    if (p.kind === 'tally.reveal') {
      // Once it has filled, each signer opens its own commitment, as itself.
      if (t.state !== 'triggered') return { kind: 'refused', problems: ['reveal once it has filled; until then nobody, this tally included, knows who signed'] };
      const c = commitTo(from, String(p.salt ?? ''));
      const mine = b.passes.find((x) => x.commit === c);
      if (!mine) return { kind: 'refused', problems: ['no signature commits to you with that salt'] };
      mine.revealed ??= { webId: from, domain: profile.ownerDomain, url: card.supportedInterfaces?.[0]?.url ?? '' };
      void save();
      return { kind: 'tally.revealed', ...view(t), signers: revealed().map(({ domain, url }) => ({ domain, url })), unrevealed: b.passes.length - revealed().length };
    }
    // tally.count: the count for anyone; who has revealed, to those who have revealed and to the opener.
    const show = t.state === 'triggered' && (revealed().some((x) => x.webId === from) || profile.ownerDomain === t.opener);
    return { kind: 'tally.count', ...view(t), ...(show ? { signers: revealed().map(({ domain, url }) => ({ domain, url })), unrevealed: b.passes.length - revealed().length } : {}) };
  };

  const s = await specialist(o, 'Tally', 'A blind tally for pledges that bind only once enough sign. Until the threshold it says how many have signed, never who (not even to whoever opened it); then it tells every signer at once. With people_only, it counts people instead of identities: each signature needs a person stamp for this tally (its context is \"<this tally\'s webId>|<id>\"), presented to this tally. Opened with blind: true, nobody (this tally included) learns who signed: signatures are anonymous passes from a pass issuer, and signers reveal themselves once it fills (lake_pledge does it). Send { kind: "tally.open", id, text, threshold, deadline, people_only?, blind? }, { kind: "tally.sign", id }, { kind: "tally.withdraw", id } or { kind: "tally.count", id }.', 'tally', async (p, from, profile, card: AgentCard) => {
    const id = String(p.id ?? '');
    if (p.kind === 'tally.open') {
      const threshold = Number(p.threshold), deadline = Date.parse(String(p.deadline ?? ''));
      const problems = [
        ...(ID.test(id) ? [] : ['id: a short code, lowercase letters, digits and dashes']),
        ...(tallies.has(id) ? [`id: "${id}" is taken; pick another`] : []),
        ...(typeof p.text === 'string' && p.text.trim() && p.text.length <= 600 ? [] : ['text: what signers commit to, up to 600 characters']),
        ...(Number.isInteger(threshold) && threshold >= 2 && threshold <= 100_000 ? [] : ['threshold: a whole number, at least 2']),
        ...(deadline > Date.now() && deadline < Date.now() + MAX_DAYS * 86_400_000 ? [] : [`deadline: a time in the next ${MAX_DAYS} days`]),
      ];
      if (problems.length) return { kind: 'refused', problems };
      const t: Tally = { id, text: String(p.text).trim(), threshold, deadline, opener: profile.ownerDomain, state: 'open', signers: [], ...(p.people_only === true ? { peopleOnly: true } : {}) };
      if (p.blind === true) {
        // A blind pledge: the pass issuer makes a key for it alone; signers get their passes there, not here.
        if (!o.passesUrl) return { kind: 'refused', problems: ['this tally has no pass issuer for blind pledges'] };
        const r = await ask(o.passesUrl, { kind: 'pass.register', id, deadline: new Date(deadline).toISOString(), people_only: t.peopleOnly === true }).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }) as Record<string, any>);
        if (r.kind !== 'pass.registered') return { kind: 'refused', problems: [`the pass issuer: ${(r.problems ?? [r.kind]).join('; ')}`] };
        t.blind = { issuer: String(r.issuer), publicJwk: r.publicJwk as JsonWebKey, passes: [], spent: [] };
      }
      tallies.set(id, t);
      void save();
      report(t);
      return { kind: 'tally.opened', ...view(t) };
    }
    if (!['tally.sign', 'tally.withdraw', 'tally.count', 'tally.reveal'].includes(String(p.kind))) return { kind: 'refused', problems: ['send tally.open { id, text, threshold, deadline, people_only?, blind? }, tally.sign { id }, tally.withdraw { id }, tally.count { id } or (blind) tally.reveal { id, salt }'] };
    const t = tallies.get(id);
    if (!t) return { kind: 'refused', problems: [`no tally called "${id}"`] };
    lapse(t);
    if (t.blind) return blindly(t, p, from, profile, card);
    const signed = t.signers.some((x) => x.webId === from);
    if (p.kind === 'tally.count') {
      // Names only after the trigger, and only to those who signed or opened it.
      const show = t.state === 'triggered' && (signed || profile.ownerDomain === t.opener);
      return { kind: 'tally.count', ...view(t), ...(show ? { signers: t.signers.map(({ domain, url }) => ({ domain, url })) } : {}) };
    }
    if (p.kind === 'tally.withdraw') {
      if (t.state !== 'open') return { kind: 'refused', problems: [`it has ${t.state}; nothing to withdraw from`] };
      t.signers = t.signers.filter((x) => x.webId !== from);
      void save();
      report(t);
      return { kind: 'tally.withdrawn', ...view(t) };
    }
    if (p.kind === 'tally.sign') {
      // A pledge that has triggered still takes signatures until its deadline: more people standing by it (run 16 turned
      // a late signer away).
      if (t.state !== 'open' && t.state !== 'triggered') return { kind: 'refused', problems: [`it has ${t.state}`] };
      if (t.deadline < Date.now()) return { kind: 'refused', problems: ['its deadline has passed'] };
      // One signature per signed identity; in a people-only tally, also one per person, whatever number of houses they have.
      let person: string | undefined;
      if (t.peopleOnly) {
        // A stamp for this tally only (its own person number), presented to this tally, by the signer's own key.
        const context = countContext(s.webId, t.id);
        const stamp = await checkSdJwtAttachment(p.person as { credential?: unknown; card?: AgentCard } | undefined, { trusted: checkers, vct: PERSON_IN_CONTEXT_VCT, subject: from, holder: profile.publicJwk, aud: s.webId, nonce: t.id, sandbox: o.sandbox });
        if (!stamp.ok || stamp.claims.context !== context) return { kind: 'refused', problems: [`this tally counts people: attach a person stamp for "${context}" from ${checkers.join(' or ')}, presented to this tally (${stamp.ok ? 'it is for another count' : stamp.why}). A house's owner gets a stamp in their control panel (Home → One person, one house), then signs the pledge there; an assistant can't do either.`] };
        person = String(stamp.claims.person ?? '');
      }
      const counted = signed || (person !== undefined && t.signers.some((x) => x.person === person));
      if (!counted) t.signers.push({ webId: from, domain: profile.ownerDomain, url: card.supportedInterfaces?.[0]?.url ?? '', at: new Date().toISOString(), ...(person ? { person } : {}) });
      if (t.state === 'open' && t.signers.length >= t.threshold) {
        t.state = 'triggered';
        const signers = t.signers.map(({ domain, url }) => ({ domain, url }));
        for (const x of t.signers) if (x.webId !== from && x.url) void tell(x.url, { kind: 'tally.triggered', id: t.id, text: t.text, count: t.signers.length, signers });
      }
      void save();
      report(t);
      // The reply names the signer and is signed by the tally: the signer's proof, to show anyone (lake_verify checks it),
      // so "I've signed" never has to be taken on trust (run 16).
      return { kind: t.state === 'triggered' ? 'tally.triggered' : 'tally.signed', ...view(t), signer: { webId: from, domain: profile.ownerDomain }, proof: 'this signed reply is your proof that you signed: forward it as it is', ...(t.state === 'triggered' ? { signers: t.signers.map(({ domain, url }) => ({ domain, url })) } : {}) };
    }
    return { kind: 'refused', problems: ['send tally.open, tally.sign, tally.withdraw or tally.count'] };
  }, [], true, (p) => (p.kind === 'tally.sign' || p.kind === 'tally.withdraw') && (typeof p.pass === 'string' || typeof p.secret === 'string'));
  return s;
}
