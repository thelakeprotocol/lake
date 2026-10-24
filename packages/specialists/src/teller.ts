import { readFile, writeFile } from 'node:fs/promises';
import { addCounts, COUNT_MODULUS } from '@thelakeprotocol/core';
import { specialist, type SpecialistOptions } from './review.js';

/**
 * A teller (SPEC §11.5): adds up pieces it can't read and publishes one sum, once. Whoever opens a count names
 * how many numbers each piece has, the fewest participants a sum may come from, and a deadline. Participants send
 * one piece each. The opener closes it once, naming the participants to add up (both tellers must add up the same
 * ones); a count never publishes twice, so nobody can subtract one participant out of two sums. Quiet: who sends
 * pieces is nobody's business.
 */
interface Count {
  id: string;
  opener: string;
  length: number;
  min: number;
  deadline: number;
  pieces: Record<string, number[]>;
  closed?: { at: string; members: number };
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/;
const MAX_LENGTH = 64;
const MAX_HOURS = 72;

export async function createTeller(o: SpecialistOptions & { dataDir: string; name: string; floor?: number }) {
  // The fewest participants any sum may come from, whatever a count asks for. Small on a sandbox, larger for real.
  const floor = o.floor ?? (o.sandbox ? 3 : 20);
  const file = `${o.dataDir}/${o.name.toLowerCase().replace(/\W+/g, '-')}-counts.json`;
  const counts = new Map<string, Count>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Count[]).map((c) => [c.id, c]));
  const save = () => writeFile(file, JSON.stringify([...counts.values()])).catch(() => {});
  // Old counts go, closed or not: nothing here is worth keeping once its deadline is long past.
  setInterval(() => { for (const c of counts.values()) if (c.deadline < Date.now() - 86_400_000) counts.delete(c.id); void save(); }, 3_600_000).unref();

  const s = await specialist(o, o.name, `Counts without looking: adds up pieces it can't read and publishes one sum, once. Pair it with a second teller run by someone else. Send { kind: "count.open", id, length, min, deadline }, then participants send { kind: "count.piece", id, piece }, and the opener sends { kind: "count.members", id } and { kind: "count.close", id, members }. Sums come from at least ${floor} participants.`, 'teller', async (p, from) => {
    const id = String(p.id ?? '');
    if (p.kind === 'count.open') {
      const length = Number(p.length), min = Number(p.min), deadline = Date.parse(String(p.deadline ?? ''));
      const problems = [
        ...(ID.test(id) ? [] : ['id: a short code']),
        ...(counts.has(id) ? [`id: "${id}" is taken`] : []),
        ...(Number.isInteger(length) && length >= 1 && length <= MAX_LENGTH ? [] : [`length: 1 to ${MAX_LENGTH} numbers per piece`]),
        ...(Number.isInteger(min) && min >= floor ? [] : [`min: at least ${floor} participants`]),
        ...(deadline > Date.now() && deadline < Date.now() + MAX_HOURS * 3_600_000 ? [] : [`deadline: within ${MAX_HOURS} hours`]),
      ];
      if (problems.length) return { kind: 'refused', problems };
      counts.set(id, { id, opener: from, length, min, deadline, pieces: {} });
      void save();
      return { kind: 'count.opened', id, length, min, deadline: new Date(deadline).toISOString() };
    }
    if (!['count.piece', 'count.members', 'count.close'].includes(String(p.kind))) return { kind: 'refused', problems: ['send count.open, count.piece, count.members or count.close'] };
    const c = counts.get(id);
    if (!c) return { kind: 'refused', problems: [`no count called "${id}"`] };
    if (p.kind === 'count.piece') {
      const piece = p.piece as number[];
      if (c.closed) return { kind: 'refused', problems: ['this count has closed'] };
      if (c.deadline < Date.now()) return { kind: 'refused', problems: ['this count is past its deadline'] };
      if (c.pieces[from]) return { kind: 'refused', problems: ['one piece each, and you have sent yours'] };
      if (!Array.isArray(piece) || piece.length !== c.length || !piece.every((x) => Number.isInteger(x) && x >= 0 && x < COUNT_MODULUS)) return { kind: 'refused', problems: [`piece: ${c.length} whole numbers below ${COUNT_MODULUS}`] };
      c.pieces[from] = piece;
      void save();
      return { kind: 'count.received', id };
    }
    // Only the opener closes, once.
    if (from !== c.opener) return { kind: 'refused', problems: ['only whoever opened this count may close it'] };
    if (p.kind === 'count.members') return { kind: 'count.members', id, members: Object.keys(c.pieces), closed: !!c.closed };
    if (c.closed) return { kind: 'refused', problems: [`it closed at ${c.closed.at}, with ${c.closed.members}; a count publishes once`] };
    const members = [...new Set((p.members as string[] | undefined) ?? [])];
    const missing = members.filter((m) => !c.pieces[m]);
    if (missing.length) return { kind: 'refused', problems: [`no piece here from ${missing.length} of them`] };
    if (members.length < Math.max(c.min, floor)) return { kind: 'refused', problems: [`too few: ${members.length}, and a sum needs at least ${Math.max(c.min, floor)}`] };
    c.closed = { at: new Date().toISOString(), members: members.length };
    const sum = addCounts(...members.map((m) => c.pieces[m]!));
    c.pieces = {};
    void save();
    return { kind: 'count.sum', id, members: members.length, sum };
  }, [], true);
  return s;
}
