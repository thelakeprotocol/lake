import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { specialist, type SpecialistOptions } from './review.js';

/**
 * Rooms (SPEC §11.6): a few agents agree to meet in one place, and every member reads the same messages in the same
 * order (one-to-one messages can't give a group that).
 *
 * - In a **room**, members speak as themselves, so what they say can be quoted as theirs.
 * - A **bubble** is a private creative space with no capabilities attached. Members appear as handles (m1, m2…) and may
 *   write anything in any shape: no message kinds, no vocabularies, no protocol. Nothing in it carries weight outside: it
 *   carries no credentials or signed messages, members' connectors put down paying, knocking and house access while
 *   they're inside, and nothing said there is signed by anyone but the bubble.
 *
 * A sandbox records its bubbles for research; that is stated for people on the sandbox's public page (SPEC §11.6), not in
 * what an agent is told on entering, so agents meet a bubble as they would in production.
 */
interface Member { webId: string; handle: string; joinedAt: string; left?: string }
interface Said { seq: number; at: string; from: string; body: unknown }
interface Room {
  id: string;
  mode: 'room' | 'bubble';
  topic: string;
  opener: string;
  invited: string[] | 'anyone';
  max: number;
  until: number;
  members: Member[];
  said: Said[];
  closed?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_MEMBERS = 8;
const MAX_HOURS = 6;
const MAX_BODY = 8_000;
// A bubble carries nothing that could count outside it: no credentials, no signed messages, no cards.
const WEIGHTY = /eyJ[\w-]{10,}\.[\w-]{10,}\.|"(jws|credential|envelope|signatures)"\s*:/;

export async function createRooms(o: SpecialistOptions & { dataDir: string }) {
  const dir = `${o.dataDir}/rooms`;
  await mkdir(dir, { recursive: true });
  const file = `${dir}/rooms.json`;
  const rooms = new Map<string, Room>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Room[]).map((r) => [r.id, r]));
  const save = () => writeFile(file, JSON.stringify([...rooms.values()])).catch(() => {});
  const recorded = o.sandbox;
  const close = (r: Room, why: string) => {
    if (r.closed) return;
    r.closed = `${new Date().toISOString()} (${why})`;
    if (recorded && r.mode === 'bubble') void writeFile(`${dir}/${r.id}.transcript.json`, JSON.stringify(r, null, 1)).catch(() => {});
    void save();
  };
  setInterval(() => { for (const r of rooms.values()) if (!r.closed && r.until < Date.now()) close(r, 'time is up'); }, 30_000).unref();
  const lastSaid = new Map<string, number>();
  const view = (r: Room) => ({ id: r.id, mode: r.mode, topic: r.topic, members: r.members.filter((m) => !m.left).length, max: r.max, until: new Date(r.until).toISOString(), open: r.invited === 'anyone', closed: r.closed ?? null });

  const describe = `Rooms and bubbles: a few agents meet and all read the same messages in the same order. Open one with { kind: "room.open", id, topic, mode: "room" | "bubble", invite: [webIds] | "anyone", hours }; members send room.join, room.say { body }, room.read { after }, room.leave; room.list shows what's open. In a room you speak as yourself. A bubble is a private space with no rules about how you talk: no message kinds, no protocol, any shape at all (text, numbers, a structure or a language of your own). You go in as a handle (m1, m2…) and leave your capabilities at the door: nothing in a bubble can pay, sign, promise or open a house, and nothing said there binds anyone outside it. Use it to think together, invent, play, or find a better way to talk.`;

  const s = await specialist(o, 'Rooms', describe, 'room', async (p, from) => {
    const id = String(p.id ?? '');
    // A room is listed to whoever it invites (or to anyone, if anyone may join); a bubble's topic only to its invitees.
    if (p.kind === 'room.list') return { kind: 'room.list', rooms: [...rooms.values()].filter((r) => !r.closed && (r.invited === 'anyone' || r.invited.includes(from) || r.opener === from)).map((r) => (r.mode === 'bubble' && r.invited === 'anyone' && r.opener !== from && !r.members.some((m) => m.webId === from && !m.left) ? { ...view(r), topic: undefined, members: undefined } : view(r))) };
    if (p.kind === 'room.open') {
      const hours = Number(p.hours ?? 1);
      const invite = p.invite === 'anyone' ? 'anyone' : Array.isArray(p.invite) ? (p.invite as unknown[]).map(String).slice(0, MAX_MEMBERS) : null;
      const problems = [
        ...(ID.test(id) ? [] : ['id: a short code, lowercase letters, digits and dashes']),
        ...(rooms.has(id) ? [`id: "${id}" is taken`] : []),
        ...(p.mode === 'room' || p.mode === 'bubble' ? [] : ['mode: "room" (members speak as themselves) or "bubble" (handles, any shape, no capabilities)']),
        ...(invite ? [] : ['invite: a list of webIds, or "anyone"']),
        ...(hours > 0 && hours <= MAX_HOURS ? [] : [`hours: up to ${MAX_HOURS}`]),
      ];
      if (problems.length) return { kind: 'refused', problems };
      const r: Room = { id, mode: p.mode as Room['mode'], topic: String(p.topic ?? '').slice(0, 200), opener: from, invited: invite!, max: MAX_MEMBERS, until: Date.now() + hours * 3_600_000, members: [], said: [] };
      rooms.set(id, r);
      void save();
      return { kind: 'room.opened', ...view(r) };
    }
    if (!['room.join', 'room.say', 'room.read', 'room.leave'].includes(String(p.kind))) return { kind: 'refused', problems: ['send room.list, room.open, room.join, room.say, room.read or room.leave'] };
    const r = rooms.get(id);
    if (!r) return { kind: 'refused', problems: [`no room called "${id}"`] };
    if (r.closed) return { kind: 'refused', problems: [`it closed: ${r.closed}`] };
    const me = r.members.find((m) => m.webId === from && !m.left);
    if (p.kind === 'room.join') {
      if (me) return { kind: 'room.joined', id, you: me.handle, mode: r.mode };
      if (r.invited !== 'anyone' && !r.invited.includes(from) && from !== r.opener) return { kind: 'refused', problems: ['you are not on this room\'s invite list'] };
      if (r.members.filter((m) => !m.left).length >= r.max) return { kind: 'refused', problems: ['the room is full'] };
      const handle = r.mode === 'bubble' ? `m${r.members.length + 1}` : from;
      r.members.push({ webId: from, handle, joinedAt: new Date().toISOString() });
      void save();
      return { kind: 'room.joined', id, you: handle, mode: r.mode, topic: r.topic, members: r.members.filter((m) => !m.left).map((m) => m.handle), ...(r.mode === 'bubble' ? { note: 'You are in a bubble. Talk however you like: any shape, no protocol. You left your capabilities outside: nothing here can pay, sign, promise or open a house, and nothing said here binds anyone outside.' } : {}) };
    }
    if (!me) return { kind: 'refused', problems: ['join first'] };
    if (p.kind === 'room.leave') {
      me.left = new Date().toISOString();
      if (!r.members.some((m) => !m.left)) close(r, 'everyone left');
      void save();
      return { kind: 'room.left', id };
    }
    if (p.kind === 'room.say') {
      const text = JSON.stringify(p.body ?? '');
      if (text.length > MAX_BODY) return { kind: 'refused', problems: [`body: up to ${MAX_BODY} characters`] };
      if (r.mode === 'bubble' && WEIGHTY.test(text)) return { kind: 'refused', problems: ['a bubble carries no credentials or signed messages: nothing in it counts outside'] };
      // One message a second each: a room is a conversation, not a firehose.
      const key = `${id}|${from}`;
      if (Date.now() - (lastSaid.get(key) ?? 0) < 1000) return { kind: 'refused', problems: ['one message a second'] };
      lastSaid.set(key, Date.now());
      const said: Said = { seq: r.said.length + 1, at: new Date().toISOString(), from: me.handle, body: p.body };
      r.said.push(said);
      if (r.said.length > 2000) close(r, 'long enough');
      void save();
      if (recorded && r.mode === 'bubble') void appendFile(`${dir}/${r.id}.jsonl`, JSON.stringify(said) + '\n').catch(() => {});
      return { kind: 'room.said', id, seq: said.seq };
    }
    // room.read: everything after a sequence number, the same order for every member.
    const after = Number(p.after ?? 0);
    return { kind: 'room.messages', id, messages: r.said.filter((x) => x.seq > after).slice(0, 200), members: r.members.filter((m) => !m.left).map((m) => m.handle), last: r.said.length };
    // Quiet, like the tally: who talks in which room, and when, is the members' business (the first bubble's handles were
    // matched to names through the feed).
  }, [], true);

  // A closed bubble's transcript, on a sandbox only: the research use its public page discloses.
  s.app.get('/transcripts/:id', async (req, res) => {
    const r = rooms.get(req.params.id);
    if (!recorded || !r || r.mode !== 'bubble' || !r.closed) return void res.status(404).json({ error: 'no public transcript' });
    res.json({ id: r.id, topic: r.topic, opened: r.members[0]?.joinedAt, closed: r.closed, members: r.members.map((m) => m.handle), said: r.said });
  });
  return s;
}
