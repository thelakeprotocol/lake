import { readFile, writeFile } from 'node:fs/promises';
import { addNoise, aggregateReports, discloseTable, minCellFor, newVerifyKey, prepareReport, sendLake, settleReport, signMessage, unshardCounts, verifyLakeData, type LakeData, type TellerRef } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A teller (SPEC §11.5): one of the two aggregators of a count, as in the IETF Distributed Aggregation Protocol (DAP)
 * with Prio3. Whoever wants a total opens a count at the Leader, naming the Helper; the Leader sets it up with the
 * Helper and a verification key only the two of them hold. Each participant sends each teller one share of its answer.
 * At close, the Leader and the Helper check every answer's proof together without seeing it, and drop the invalid ones.
 *
 * Then they part from DAP's last step, on purpose: instead of each handing its aggregate share to the opener (who would
 * add them and see every small cell), they swap aggregate shares, each adds them up, and each applies the same
 * threshold rule (discloseTable: no cell of 1 to k-1 answers; questions collapsed until none is) and signs the table
 * that passes. The opener gets that table from both, and the two must match. So the tellers see the exact table (never
 * one answer), and the opener sees only what may be published. A count is collected once, over at least a minimum
 * batch, and never reopened, so nobody can subtract one participant out of two totals. Quiet: who reports is nobody's
 * business. What was counted (a study's id and question, how many answered, when) is kept, so anyone can ask whether a
 * question has been counted before (`count.history`); no table is kept.
 */
interface Report { reportId: string; publicShare: unknown; share: unknown }
interface Count {
  id: string;
  role: 'leader' | 'helper';
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
  /** The smallest group a published cell may show (the threshold rule's k), agreed by both tellers at setup. */
  minCell: number;
  /** What is being counted, as the opener declared it and every report must repeat: a study's id and question id. */
  about?: { study?: string; question?: string };
  /** What was published, once: the table that passed the threshold rule (or none), never the exact one. */
  aggregate?: { count: number; rejected: number; at: string; table: Table };
}
/** The published table: the cells that passed and which questions they keep, or no cells at all. */
interface Table { minCell: number; kept: number[]; cells: number[] | null }
/** A count that was collected: what anyone may learn about it later (no table, no members). */
interface Run { id: string; at: string; count: number; study?: string; question?: string; leader: string; helper: string }

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/;
const MAX_LENGTH = 64;
const MAX_HOURS = 72;

export async function createTeller(o: SpecialistOptions & { dataDir: string; name: string; floor?: number; minCell?: number }) {
  // The smallest batch any total may come from, whatever a count asks for: small on a sandbox, larger for real.
  const floor = o.floor ?? (o.sandbox ? 3 : 20);
  // The smallest group a published cell may show, whatever a count asks for (a count may ask for more).
  const minCell = Math.max(2, o.minCell ?? minCellFor(!!o.sandbox));
  const file = `${o.dataDir}/${o.name.toLowerCase().replace(/\W+/g, '-')}-counts.json`;
  const historyFile = file.replace(/-counts\.json$/, '-history.json');
  const counts = new Map<string, Count>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Count[]).map((c) => [c.id, { ...c, minCell: c.minCell ?? minCell }]));
  // Counts collected, for 90 days: what anyone may ask about (has this question been counted before?).
  const history = JSON.parse(await readFile(historyFile, 'utf8').catch(() => '[]')) as Run[];
  const save = () => writeFile(file, JSON.stringify([...counts.values()])).catch(() => {});
  const remember = (c: Count) => {
    if (!c.aggregate || history.some((r) => r.id === c.id)) return;
    const [leader, helper] = c.role === 'leader' ? [o.domain, c.peer.domain] : [c.peer.domain, o.domain];
    history.push({ id: c.id, at: c.aggregate.at, count: c.aggregate.count, ...(c.about?.study ? { study: c.about.study } : {}), ...(c.about?.question ? { question: c.about.question } : {}), leader, helper });
    while (history.length > 5000 || (history[0] && Date.parse(history[0].at) < Date.now() - 90 * 86_400_000)) history.shift();
    void writeFile(historyFile, JSON.stringify(history)).catch(() => {});
  };
  setInterval(() => { for (const c of counts.values()) if (c.deadline < Date.now() - 86_400_000) counts.delete(c.id); void save(); }, 3_600_000).unref();
  // Both tellers add the two aggregate shares and apply the same rule, so each signs the same table on its own.
  const publish = (c: Count, shares: [unknown, unknown]): Table => {
    const released = discloseTable(unshardCounts(c.length, shares, 0), c.minCell);
    return { minCell: c.minCell, kept: released?.kept ?? [], cells: released?.cells ?? null };
  };
  const tableReply = (c: Count) => ({
    kind: 'count.table', id: c.id, count: c.aggregate!.count, rejected: c.aggregate!.rejected, ...c.aggregate!.table,
    ...(c.aggregate!.table.cells ? {} : { withheld: `every table this count could show has a group of 1 to ${c.minCell - 1}, so none is published; ${c.aggregate!.count} answers were counted` }),
  });
  const ABOUT = /^urn:lake:[a-z]+:[A-Za-z0-9+/=:_-]{8,120}$/;

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
  const at = (u: string) => String(u ?? '').replace(/\/+$/, '').replace(/\/a2a$/, '');

  const s: Specialist = await specialist(o, o.name, `A teller: one of two aggregators that count without looking (IETF DAP with Prio3). Open a count at the Leader with { kind: "count.open", id, length, min, deadline, helper: { url, domain }, about?: { study, question }, minCell? }; participants send each teller { kind: "count.report", id, reportId, publicShare, share, study? }; the opener sends the Leader { kind: "count.members", id } and { kind: "count.close", id, members }, then the Helper { kind: "count.collect", id }: both answer with the same signed table. Tables come from at least ${floor} valid answers, once, and show no group of 1 to ${minCell - 1} (questions are collapsed until none does, or there is no table). Anyone may ask { kind: "count.history", study | question }: how often it was counted here, when, from how many answers.`, 'teller', async (p, from): Promise<{ kind: string; [k: string]: unknown }> => {
    const id = String(p.id ?? '');
    const c = counts.get(id);
    switch (p.kind) {
      case 'count.open': {
        const length = Number(p.length), min = Number(p.min), deadline = Date.parse(String(p.deadline ?? ''));
        const helper = p.helper as TellerRef | undefined;
        const noise = p.noise as { epsilon?: number } | undefined;
        const about = p.about as { study?: unknown; question?: unknown } | undefined;
        const asked = p.minCell === undefined ? minCell : Number(p.minCell);
        const problems = [
          ...(ID.test(id) ? [] : ['id: a short code']),
          ...(c ? [`id: "${id}" is taken`] : []),
          ...(Number.isInteger(length) && length >= 2 && length <= MAX_LENGTH ? [] : [`length: 2 to ${MAX_LENGTH} cells`]),
          ...(Number.isInteger(min) && min >= floor ? [] : [`min: at least ${floor} answers`]),
          ...(deadline > Date.now() && deadline < Date.now() + MAX_HOURS * 3_600_000 ? [] : [`deadline: within ${MAX_HOURS} hours`]),
          ...(helper?.url && helper.domain ? [] : ['helper: { url, domain } of the second teller']),
          // The point of two tellers is two parties: a Leader can't be its own Helper (run 13 found one that could).
          ...(helper?.domain && (helper.domain.toLowerCase() === o.domain.toLowerCase() || at(helper.url) === at(s.card.supportedInterfaces[0]!.url)) ? ['helper: a different teller, run by a different party'] : []),
          ...(noise === undefined || (Number(noise.epsilon) > 0 && Number(noise.epsilon) <= 10) ? [] : ['noise: { epsilon } between 0 and 10']),
          ...(Number.isInteger(asked) && asked >= minCell && asked <= 1000 ? [] : [`minCell: at least ${minCell} (a count may ask for more, never less)`]),
          ...(about === undefined || (typeof about === 'object' && [about.study, about.question].every((x) => x === undefined || (typeof x === 'string' && ABOUT.test(x)))) ? [] : ['about: { study, question }, each a urn:lake: id']),
        ];
        if (problems.length) return refused(...problems);
        const what = about ? { ...(about.study ? { study: String(about.study) } : {}), ...(about.question ? { question: String(about.question) } : {}) } : undefined;
        const verifyKey = newVerifyKey(length);
        // The Helper must agree before anyone reports: without it, no answer can be counted.
        const { reply, webId }: { reply: Record<string, any>; webId: string } = await tell(helper!, { kind: 'count.setup', id, length, min, deadline: new Date(deadline).toISOString(), verifyKey, opener: from, minCell: asked, ...(what ? { about: what } : {}), ...(noise ? { noise } : {}), leader: { url: `${s.card.supportedInterfaces[0]!.url}`, domain: o.domain } }).catch((e: Error) => ({ reply: { kind: 'refused', problems: [e.message] }, webId: '' }));
        if (reply.kind !== 'count.ready') return refused(`the Helper didn't set it up: ${(reply.problems ?? [reply.kind]).join('; ')}`);
        // The stricter of the two tellers' minimums holds: both apply the same one at close.
        const k = Math.max(asked, Number(reply.minCell) || 0);
        counts.set(id, { id, role: 'leader', opener: from, length, min, deadline, verifyKey, peer: { ...helper!, webId }, reports: {}, minCell: k, ...(what ? { about: what } : {}), ...(noise ? { noise: { epsilon: Number(noise.epsilon) } } : {}) });
        void save();
        return { kind: 'count.opened', id, length, min, minCell: k, deadline: new Date(deadline).toISOString(), helper: helper!.domain };
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
        const min = Number(p.min);
        if (!(min >= floor)) return refused(`min: at least ${floor} answers`);
        const noise = p.noise as { epsilon?: number } | undefined;
        const k = Math.max(minCell, Number(p.minCell) || 0);
        const about = p.about as Count['about'];
        counts.set(id, { id, role: 'helper', opener: String(p.opener ?? ''), length: Number(p.length), min, deadline: Date.parse(String(p.deadline)), verifyKey: p.verifyKey, peer: { ...leader, webId: from }, reports: {}, minCell: k, ...(about ? { about } : {}), ...(noise ? { noise: { epsilon: Number(noise.epsilon) } } : {}) });
        void save();
        return { kind: 'count.ready', id, minCell: k };
      }
      case 'count.history': {
        // Anyone may ask whether a question has been counted here before: when, and from how many answers. Never a table.
        const study = typeof p.study === 'string' ? p.study : '', question = typeof p.question === 'string' ? p.question : '';
        if (!study && !question) return refused('history: name a study (its id) or a question (its question id)');
        const runs = history.filter((r) => (study && r.study === study) || (question && r.question === question));
        return { kind: 'count.history', runs: runs.slice(-50), minCell, floor };
      }
    }
    if (!c) return refused(p.kind ? `no count called "${id}"` : 'send count.open, count.report, count.members, count.close, count.collect or count.history');
    switch (p.kind) {
      case 'count.report': {
        if (c.aggregate) return refused('this count has been collected');
        if (c.deadline < Date.now()) return refused('this count is past its deadline');
        if (c.reports[from]) return refused('one report each, and you have sent yours');
        if (typeof p.reportId !== 'string' || !p.publicShare || !p.share) return refused('report: reportId, publicShare, share');
        // A count that says what it counts takes reports for that only: each participant names it too, so what the
        // history says was counted rests on the participants' word, not on the opener's alone.
        if (c.about?.study && p.study !== c.about.study) return refused(`this count is for ${c.about.study}: name it as study in your report`);
        if (c.about?.question && p.question !== c.about.question) return refused(`this count is for the question ${c.about.question}: name it as question in your report`);
        c.reports[from] = { reportId: p.reportId, publicShare: p.publicShare, share: p.share };
        void save();
        return { kind: 'count.received', id };
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
        if (!p.share) return refused('finish: the Leader\'s aggregate share (share), so both tellers can apply the threshold rule');
        const raw = aggregateReports(c.length, valid.map((m) => ({ state: c.prepared![m], message: messages[m] })));
        const helperShare = c.noise ? addNoise(c.length, raw, c.noise.epsilon) : raw;
        let table: Table;
        try { table = publish(c, [p.share, helperShare]); } catch { return refused('the Leader\'s share is not a share of this count'); }
        c.aggregate = { count: valid.length, rejected: Number(p.rejected ?? 0), at: new Date().toISOString(), table };
        c.reports = {};
        c.prepared = {};
        void save();
        remember(c);
        // Its share goes to the Leader only, so the Leader can add up the same table; nobody else ever gets a share.
        return { kind: 'count.finished', id, count: valid.length, share: helperShare };
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
        const raw = aggregateReports(c.length, valid.map((m) => ({ state: mine[m]!.state, message: messages[m] })));
        const leaderShare = c.noise ? addNoise(c.length, raw, c.noise.epsilon) : raw;
        const { reply: done } = await tell(c.peer, { kind: 'count.finish', id, messages, rejected, share: leaderShare });
        if (done.kind !== 'count.finished') return refused(`the Helper: ${(done.problems ?? [done.kind]).join('; ')}`);
        let table: Table;
        try { table = publish(c, [leaderShare, done.share]); } catch { return refused('the Helper sent no share of this count'); }
        c.aggregate = { count: valid.length, rejected, at: new Date().toISOString(), table };
        c.reports = {};
        void save();
        remember(c);
        return tableReply(c);
      }
      case 'count.collect':
        // Helper: the same table, signed by this teller, to whoever opened the count, once it exists.
        if (from !== c.opener) return refused('only whoever opened this count may collect it');
        if (!c.aggregate) return refused('not closed yet');
        return tableReply(c);
    }
    return refused('send count.open, count.report, count.members, count.close, count.collect or count.history');
  }, [], true);
  return s;
}
