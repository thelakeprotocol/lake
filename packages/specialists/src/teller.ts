import { readFile, writeFile } from 'node:fs/promises';
import { MAX_EPSILON, addNoise, aggregateReports, countTerms, newVerifyKey, prepareReport, sendLake, settleReport, signMessage, verifyLakeData, type LakeData, type Study, type TellerRef } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A teller (SPEC §11.5): one of the two aggregators of a count, as in the IETF Distributed Aggregation Protocol (DAP)
 * with Prio3. Whoever wants a total opens a count at the Leader, naming the Helper; the Leader sets it up with the
 * Helper and a verification key only the two of them hold. Each participant sends each teller one share of its answer.
 * At close, the Leader and the Helper check every answer's proof together without seeing it, drop the invalid ones,
 * and each publishes its aggregate share once, over at least a minimum batch. A count is collected once and never
 * reopened, so nobody can subtract one participant out of two totals. Quiet: who reports is nobody's business.
 *
 * A count for a study is opened with the study itself: each teller takes the size of the table, the fewest houses and
 * the noise from it, never from the opener, and takes an answer to a study only into that study's count. A house names
 * the study it answers, so what its owner agreed to (this study, with its minimum and noise) is what the count keeps.
 */
interface Report { reportId: string; publicShare: unknown; share: unknown }
interface Count {
  id: string;
  role: 'leader' | 'helper';
  /** The study this count is for (its id), when it was opened with one: its length, min and noise are the study's. */
  study?: string;
  opener: string;
  length: number;
  min: number;
  deadline: number;
  verifyKey: string;
  /** The other teller: for the Leader, its Helper; for the Helper, the Leader that set it up. */
  peer: TellerRef & { webId?: string };
  reports: Record<string, Report>;
  /** Noise this teller adds to its share before release (DAP's differential-privacy option). */
  noise?: { epsilon: number };
  /** The Helper's prepared states, between prepare and finish. */
  prepared?: Record<string, unknown>;
  aggregate?: { share: unknown; count: number; rejected: number; at: string };
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/;
const MAX_LENGTH = 64;
const MAX_HOURS = 72;

export async function createTeller(o: SpecialistOptions & { dataDir: string; name: string; floor?: number }) {
  // The smallest batch any total may come from, whatever a count asks for: small on a sandbox, larger for real.
  const floor = o.floor ?? (o.sandbox ? 3 : 20);
  const file = `${o.dataDir}/${o.name.toLowerCase().replace(/\W+/g, '-')}-counts.json`;
  const counts = new Map<string, Count>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Count[]).map((c) => [c.id, c]));
  const save = () => writeFile(file, JSON.stringify([...counts.values()])).catch(() => {});
  setInterval(() => { for (const c of counts.values()) if (c.deadline < Date.now() - 86_400_000) counts.delete(c.id); void save(); }, 3_600_000).unref();

  // Teller to teller: signed, and the answer must come from the teller named.
  const tell = async (peer: TellerRef, body: Record<string, unknown>) => {
    const envelope = await signMessage(body, o.id, { iss: s.webId });
    const raw = await sendLake(peer.url.replace(/\/?$/, '').replace(/(\/a2a)?$/, '/a2a'), { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs: 30_000 });
    const v = await verifyLakeData(raw, { sandbox: o.sandbox });
    if (!v.ok) throw new Error(`the other teller's reply did not verify: ${v.rejection.why}`);
    if (v.profile.ownerDomain !== peer.domain) {
      // It agreed under another name: take that back at once, or the id stays taken there (run 26), then say what to name.
      if ((v.payload as { kind?: string }).kind === 'count.ready') void tell({ url: peer.url, domain: v.profile.ownerDomain }, { kind: 'count.cancel', id: body.id }).catch(() => {});
      throw new Error(`the teller at ${peer.url} is ${v.profile.ownerDomain}, not ${peer.domain}: name it as helper.domain "${v.profile.ownerDomain}"`);
    }
    return { reply: v.payload as Record<string, any>, webId: v.profile.webId };
  };
  const refused = (...problems: string[]) => ({ kind: 'refused', problems });
  // Said with each share, under the teller's signature: what the count was held to.
  const heldTo = (c: Count) => ({ ...(c.study ? { study: c.study } : {}), min: Math.max(c.min, floor), ...(c.noise ? { noise: c.noise } : {}) });
  const at = (u: string) => String(u ?? '').replace(/\/+$/, '').replace(/\/a2a$/, '');
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  // What a count opened with a study must be: the study's own numbers, at the tellers it names, in the place it names them.
  // Numbers the sender also passed must be the study's: a count is never opened looser than the study says.
  const forStudy = (p: Record<string, any>, place: 0 | 1): { terms?: Extract<ReturnType<typeof countTerms>, { ok: true }>; problems: string[] } => {
    const terms = countTerms(p.study as Study);
    if (!terms.ok) return { problems: terms.problems };
    const noise = p.noise === undefined ? undefined : { epsilon: Number((p.noise as { epsilon?: number }).epsilon) };
    return { terms, problems: [
      ...(terms.tellers[place].domain.toLowerCase() === o.domain.toLowerCase() ? [] : [`study: it names ${terms.tellers[place].domain} as its ${place ? 'Helper' : 'Leader'}, and this is ${o.domain}`]),
      ...(terms.min >= floor ? [] : [`min: the study says ${terms.min}, and this teller publishes nothing from fewer than ${floor} answers`]),
      ...(p.length === undefined || Number(p.length) === terms.length ? [] : [`length: the study has ${terms.length} cells`]),
      ...(p.min === undefined || Number(p.min) === terms.min ? [] : [`min: the study says ${terms.min}`]),
      ...(noise === undefined || same(noise, terms.noise) ? [] : [`noise: the study says ${terms.noise ? `epsilon ${terms.noise.epsilon}` : 'none'}`]),
    ] };
  };

  const s: Specialist = await specialist(o, o.name, `A teller: one of two aggregators that count without looking (IETF DAP with Prio3). Open a count at the Leader with { kind: "count.open", id, length, min, deadline, helper: { url, domain } } (for a study: { kind: "count.open", id, deadline, study }, and its size, minimum, noise and Helper are the study's); participants send each teller { kind: "count.report", id, reportId, publicShare, share }; the opener sends the Leader { kind: "count.members", id } and { kind: "count.close", id, members }, then the Helper { kind: "count.collect", id }. Totals come from at least ${floor} valid answers, once.`, 'teller', async (p, from): Promise<{ kind: string; [k: string]: unknown }> => {
    const id = String(p.id ?? '');
    const c = counts.get(id);
    switch (p.kind) {
      case 'count.open': {
        // For a study, everything but the id and the deadline comes from the study (SPEC §7).
        const bound = p.study === undefined ? undefined : forStudy(p, 0);
        if (bound?.problems.length) return refused(...bound.problems);
        const terms = bound?.terms;
        const length = terms?.length ?? Number(p.length), min = terms?.min ?? Number(p.min), deadline = Date.parse(String(p.deadline ?? ''));
        const helper = terms ? terms.tellers[1] : p.helper as TellerRef | undefined;
        const noise = terms ? terms.noise : p.noise as { epsilon?: number } | undefined;
        const problems = [
          ...(terms && p.helper && String((p.helper as TellerRef).domain).toLowerCase() !== helper!.domain.toLowerCase() ? [`helper: the study names ${helper!.domain}`] : []),
          ...(ID.test(id) ? [] : ['id: a short code']),
          ...(c ? [`id: "${id}" is taken`] : []),
          ...(Number.isInteger(length) && length >= 2 && length <= MAX_LENGTH ? [] : [`length: 2 to ${MAX_LENGTH} cells`]),
          ...(Number.isInteger(min) && min >= floor ? [] : [`min: at least ${floor} answers`]),
          ...(deadline > Date.now() && deadline < Date.now() + MAX_HOURS * 3_600_000 ? [] : [`deadline: within ${MAX_HOURS} hours`]),
          ...(helper?.url && helper.domain ? [] : ['helper: { url, domain } of the second teller']),
          // The point of two tellers is two parties: a Leader can't be its own Helper (run 13 found one that could).
          ...(helper?.domain && (helper.domain.toLowerCase() === o.domain.toLowerCase() || at(helper.url) === at(s.card.supportedInterfaces[0]!.url)) ? ['helper: a different teller, run by a different party'] : []),
          ...(noise === undefined || (Number(noise.epsilon) > 0 && Number(noise.epsilon) <= MAX_EPSILON) ? [] : [`noise: { epsilon } above 0 and at most ${MAX_EPSILON}`]),
        ];
        if (problems.length) return refused(...problems);
        const verifyKey = newVerifyKey(length);
        // The Helper must agree before anyone reports: without it, no answer can be counted.
        const { reply, webId }: { reply: Record<string, any>; webId: string } = await tell(helper!, { kind: 'count.setup', id, length, min, deadline: new Date(deadline).toISOString(), verifyKey, opener: from, ...(noise ? { noise } : {}), ...(terms ? { study: p.study } : {}), leader: { url: `${s.card.supportedInterfaces[0]!.url}`, domain: o.domain } }).catch((e: Error) => ({ reply: { kind: 'refused', problems: [e.message] }, webId: '' }));
        if (reply.kind !== 'count.ready') return refused(`the Helper didn't set it up: ${(reply.problems ?? [reply.kind]).join('; ')}`);
        counts.set(id, { id, role: 'leader', ...(terms ? { study: terms.study } : {}), opener: from, length, min, deadline, verifyKey, peer: { ...helper!, webId }, reports: {}, ...(noise ? { noise: { epsilon: Number(noise.epsilon) } } : {}) });
        void save();
        return { kind: 'count.opened', id, ...(terms ? { study: terms.study } : {}), length, min, ...(noise ? { noise: { epsilon: Number(noise.epsilon) } } : {}), deadline: new Date(deadline).toISOString(), helper: helper!.domain };
      }
      case 'count.cancel': {
        // The Leader that set it up takes it back before anyone has reported.
        if (!c || c.role !== 'helper' || from !== c.peer.webId) return refused('only this count\'s Leader cancels it');
        if (Object.keys(c.reports).length) return refused('answers have come in: it can\'t be cancelled now');
        counts.delete(id);
        void save();
        return { kind: 'count.cancelled', id };
      }
      case 'count.setup': {
        const leader = p.leader as TellerRef | undefined;
        if (c) return refused(`id: "${id}" is taken`);
        if (!leader?.url || !leader.domain || typeof p.verifyKey !== 'string') return refused('setup: leader, verifyKey');
        if (from === s.webId || leader.domain.toLowerCase() === o.domain.toLowerCase()) return refused('a teller is never its own Leader');
        // The Helper reads the study itself: a Leader can't set a study's count up looser than the study says.
        const bound = p.study === undefined ? undefined : forStudy(p, 1);
        if (bound?.problems.length) return refused(...bound.problems);
        const terms = bound?.terms;
        if (terms && terms.tellers[0].domain.toLowerCase() !== leader.domain.toLowerCase()) return refused(`study: it names ${terms.tellers[0].domain} as its Leader`);
        const min = terms?.min ?? Number(p.min);
        if (!(min >= floor)) return refused(`min: at least ${floor} answers`);
        const noise = terms ? terms.noise : p.noise as { epsilon?: number } | undefined;
        counts.set(id, { id, role: 'helper', ...(terms ? { study: terms.study } : {}), opener: String(p.opener ?? ''), length: terms?.length ?? Number(p.length), min, deadline: Date.parse(String(p.deadline)), verifyKey: p.verifyKey, peer: { ...leader, webId: from }, reports: {}, ...(noise ? { noise: { epsilon: Number(noise.epsilon) } } : {}) });
        void save();
        return { kind: 'count.ready', id };
      }
    }
    if (!c) return refused(p.kind ? `no count called "${id}"` : 'send count.open, count.report, count.members, count.close or count.collect');
    switch (p.kind) {
      case 'count.report': {
        if (c.aggregate) return refused('this count has been collected');
        if (c.deadline < Date.now()) return refused('this count is past its deadline');
        if (c.reports[from]) return refused('one report each, and you have sent yours');
        if (typeof p.reportId !== 'string' || !p.publicShare || !p.share) return refused('report: reportId, publicShare, share');
        // An answer to a study goes only into that study's count, and a study's count takes nothing else: a house that
        // agreed to a study with a minimum and noise can't be counted in one opened without them.
        if (c.study && p.study === undefined) return refused(`this count is for a study: name it (study: "${c.study}")`);
        if (p.study !== undefined && p.study !== c.study) return refused(c.study ? 'this count was opened for another study' : 'this count was not opened for a study: its minimum and noise are not that study\'s');
        c.reports[from] = { reportId: p.reportId, publicShare: p.publicShare, share: p.share };
        void save();
        return { kind: 'count.received', id, ...(c.study ? { study: c.study, min: Math.max(c.min, floor), ...(c.noise ? { noise: c.noise } : {}) } : {}) };
      }
      case 'count.members':
        if (from !== c.opener) return refused('only whoever opened this count may ask');
        return { kind: 'count.members', id, members: Object.keys(c.reports), collected: !!c.aggregate };
      case 'count.prepare': {
        // Helper: the Leader asks for its view of each named answer's proof.
        if (c.role !== 'helper' || from !== c.peer.webId) return refused('only this count\'s Leader asks that');
        if (c.aggregate) return refused('this count has been collected');
        const members = (p.members as string[]) ?? [];
        const shares: Record<string, unknown> = {};
        c.prepared = {};
        for (const m of members) {
          if (!c.reports[m]) continue;
          const r = await prepareReport(c.length, c.verifyKey, 1, c.reports[m]!);
          c.prepared[m] = r.state;
          shares[m] = r.share;
        }
        return { kind: 'count.prepared', id, shares };
      }
      case 'count.finish': {
        // Helper: the settled proofs; aggregate the valid answers, once.
        if (c.role !== 'helper' || from !== c.peer.webId) return refused('only this count\'s Leader asks that');
        if (c.aggregate) return refused('this count has been collected');
        const messages = (p.messages ?? {}) as Record<string, unknown>;
        const valid = Object.keys(messages).filter((m) => messages[m] && c.prepared?.[m]);
        if (valid.length < Math.max(c.min, floor)) return refused(`too few valid answers: ${valid.length}`);
        const helperShare = aggregateReports(c.length, valid.map((m) => ({ state: c.prepared![m], message: messages[m] })));
        c.aggregate = { share: c.noise ? addNoise(c.length, helperShare, c.noise.epsilon) : helperShare, count: valid.length, rejected: Number(p.rejected ?? 0), at: new Date().toISOString() };
        c.reports = {};
        c.prepared = {};
        void save();
        return { kind: 'count.finished', id, count: valid.length };
      }
      case 'count.close': {
        if (c.role !== 'leader') return refused('close at the Leader');
        if (from !== c.opener) return refused('only whoever opened this count may close it');
        if (c.aggregate) return refused(`it was collected at ${c.aggregate.at}; a count is collected once`);
        const members = [...new Set((p.members as string[] | undefined) ?? [])].filter((m) => c.reports[m]);
        if (members.length < Math.max(c.min, floor)) return refused(`too few: ${members.length}, and a total needs at least ${Math.max(c.min, floor)}`);
        const mine: Record<string, { state: unknown; share: unknown }> = {};
        for (const m of members) mine[m] = await prepareReport(c.length, c.verifyKey, 0, c.reports[m]!);
        const { reply } = await tell(c.peer, { kind: 'count.prepare', id, members });
        if (reply.kind !== 'count.prepared') return refused(`the Helper: ${(reply.problems ?? [reply.kind]).join('; ')}`);
        const theirs = reply.shares as Record<string, unknown>;
        // An answer counts only when both tellers' views of its proof agree that it is one cell and nothing else.
        const messages: Record<string, unknown> = {};
        for (const m of members) messages[m] = theirs[m] ? await settleReport(c.length, [mine[m]!.share, theirs[m]]) : null;
        const valid = members.filter((m) => messages[m]);
        const rejected = members.length - valid.length;
        if (valid.length < Math.max(c.min, floor)) return refused(`too few valid answers: ${valid.length} (${rejected} failed their proof or never reached the Helper)`);
        const { reply: done } = await tell(c.peer, { kind: 'count.finish', id, messages, rejected });
        if (done.kind !== 'count.finished') return refused(`the Helper: ${(done.problems ?? [done.kind]).join('; ')}`);
        const leaderShare = aggregateReports(c.length, valid.map((m) => ({ state: mine[m]!.state, message: messages[m] })));
        c.aggregate = { share: c.noise ? addNoise(c.length, leaderShare, c.noise.epsilon) : leaderShare, count: valid.length, rejected, at: new Date().toISOString() };
        c.reports = {};
        void save();
        return { kind: 'count.share', id, ...heldTo(c), count: valid.length, rejected, share: c.aggregate.share };
      }
      case 'count.collect':
        // Helper: its aggregate share, to whoever opened the count, once it exists.
        if (from !== c.opener) return refused('only whoever opened this count may collect it');
        if (!c.aggregate) return refused('not closed yet');
        return { kind: 'count.share', id, ...heldTo(c), count: c.aggregate.count, rejected: c.aggregate.rejected, share: c.aggregate.share };
    }
    return refused('send count.open, count.report, count.members, count.close or count.collect');
  }, [], true);
  return s;
}
