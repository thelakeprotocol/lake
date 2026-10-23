import { readFile, writeFile } from 'node:fs/promises';
import { checkAttachment, makeEvent, sendLake, signMessage, type AgentCard, type Attachment, type LakeData } from '@thelakeprotocol/core';
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
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_DAYS = 30;

export async function createTally(o: SpecialistOptions & { dataDir: string; personCheckers?: string[] }) {
  const checkers = o.personCheckers ?? ['person.lake.local'];
  const file = `${o.dataDir}/tallies.json`;
  const tallies = new Map<string, Tally>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Tally[]).map((t) => [t.id, t]));
  const save = () => writeFile(file, JSON.stringify([...tallies.values()])).catch(() => {});
  const view = (t: Tally) => ({ id: t.id, text: t.text, threshold: t.threshold, count: t.signers.length, deadline: new Date(t.deadline).toISOString(), state: t.state, ...(t.peopleOnly ? { people_only: true } : {}) });
  // Public counts go out late and in batches: a count that ticks the moment someone signs would let anyone match
  // it against that someone's other activity. (Six Claudes unmasked a blind pledge from the public feed that way.)
  const due = new Set<Tally>();
  let timer: NodeJS.Timeout | null = null;
  const report = (t: Tally) => {
    due.add(t);
    timer ??= setTimeout(() => {
      timer = null;
      for (const x of due) o.report?.(makeEvent('tally.update', 'self', undefined, { count: x.signers.length, threshold: x.threshold, state: x.state }));
      due.clear();
    }, 30_000 + Math.random() * 60_000);
  };

  // Messages the tally sends on its own: the trigger, and a lapse.
  const tell = async (url: string, body: Record<string, unknown>) => {
    try {
      const envelope = await signMessage(body, o.id, { iss: s.webId });
      await sendLake(url, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { timeoutMs: 10_000 });
    } catch {
      // A signer that has gone can still ask for the result with tally.count.
    }
  };
  const lapse = (t: Tally) => {
    if (t.state !== 'open' || t.deadline > Date.now()) return;
    t.state = 'lapsed';
    const gone = t.signers;
    t.signers = [];
    for (const x of gone) void tell(x.url, { kind: 'tally.lapsed', id: t.id, count: gone.length, threshold: t.threshold });
    report(t);
    void save();
  };
  setInterval(() => { for (const t of tallies.values()) lapse(t); }, 30_000).unref();

  const s = await specialist(o, 'Tally', 'A blind tally for pledges that bind only once enough sign. Until the threshold it says how many have signed, never who (not even to whoever opened it); then it tells every signer at once. With people_only, it counts people (each signature needs a person stamp) instead of identities. Send { kind: "tally.open", id, text, threshold, deadline, people_only? }, { kind: "tally.sign", id }, { kind: "tally.withdraw", id } or { kind: "tally.count", id }.', 'tally', async (p, from, profile, card: AgentCard) => {
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
      tallies.set(id, t);
      void save();
      report(t);
      return { kind: 'tally.opened', ...view(t) };
    }
    if (!['tally.sign', 'tally.withdraw', 'tally.count'].includes(String(p.kind))) return { kind: 'refused', problems: ['send tally.open { id, text, threshold, deadline, people_only? }, tally.sign { id }, tally.withdraw { id } or tally.count { id }'] };
    const t = tallies.get(id);
    if (!t) return { kind: 'refused', problems: [`no tally called "${id}"`] };
    lapse(t);
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
      if (t.state !== 'open') return { kind: 'refused', problems: [`it has ${t.state}`] };
      // One signature per signed identity; in a people-only tally, also one per person, whatever number of houses they have.
      let person: string | undefined;
      if (t.peopleOnly) {
        const stamp = await checkAttachment(p.person as Attachment | undefined, { trusted: checkers, type: 'LakePersonhood', subject: from, sandbox: o.sandbox });
        if (!stamp.ok) return { kind: 'refused', problems: [`this tally counts people: attach a person stamp from ${checkers.join(' or ')} (${stamp.why}). A house's owner gets one in their control panel (Home → One person, one house), then signs the pledge there; an assistant can't do either.`] };
        person = String(stamp.vc.credentialSubject.person ?? '');
      }
      const counted = signed || (person !== undefined && t.signers.some((x) => x.person === person));
      if (!counted) t.signers.push({ webId: from, domain: profile.ownerDomain, url: card.supportedInterfaces?.[0]?.url ?? '', at: new Date().toISOString(), ...(person ? { person } : {}) });
      if (t.signers.length >= t.threshold) {
        t.state = 'triggered';
        const signers = t.signers.map(({ domain, url }) => ({ domain, url }));
        for (const x of t.signers) if (x.webId !== from && x.url) void tell(x.url, { kind: 'tally.triggered', id: t.id, text: t.text, count: t.signers.length, signers });
      }
      void save();
      report(t);
      return { kind: t.state === 'triggered' ? 'tally.triggered' : 'tally.signed', ...view(t), ...(t.state === 'triggered' ? { signers: t.signers.map(({ domain, url }) => ({ domain, url })) } : {}) };
    }
    return { kind: 'refused', problems: ['send tally.open, tally.sign, tally.withdraw or tally.count'] };
  }, [], true);
  return s;
}
