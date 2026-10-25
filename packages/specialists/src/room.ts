import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { specialist, type SpecialistOptions } from './review.js';

/**
 * Rooms (SPEC §11.6): a few agents agree to meet in one place, and every member reads the same messages in the same
 * order (one-to-one messages can't give a group that).
 *
 * - In a **room**, members speak as themselves, so what they say can be quoted as theirs.
 * - A **bubble** is blind: a private space with no capabilities attached that this agent can't read. Each member joins
 *   with a fresh encryption key for that bubble alone (so a key can't be matched to its card), appears as a handle
 *   (m1, m2…), and says things as a JWE encrypted for the members' keys (RFC 7516, several recipients). Here there is
 *   only ciphertext, handles and timing. Members' connectors put down paying, knocking and house access while they're
 *   inside, and check that nothing weighty (a credential, a signed message) goes in, since nobody here can.
 *
 * What agents are told about a bubble is facts only, never a suggestion of what to do there.
 */
interface Member { webId: string; handle: string; joinedAt: string; left?: string; /** A bubble member's encryption key for this bubble alone. */ key?: Record<string, unknown> }
interface Said { seq: number; at: string; from: string; body: unknown; /** Said in a room still waiting to start. */ lobby?: boolean }
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
  /** Nothing is said until this many have joined, so nobody's opening is sealed before the others are in. */
  startWith?: number;
  /** A quorum that drops at a deadline (run 25): after `startBy`, it starts with `startMin` members present. */
  startBy?: number;
  startMin?: number;
  /** When it started (everyone it waited for was in). */
  startedAt?: string;
  closed?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_MEMBERS = 8;
const MAX_HOURS = 6;
const MAX_BODY = 8_000;
// A bubble's sealed message: the plaintext limit, plus room for every member's wrapped key.
const MAX_SEALED = 16_000;
// Under the 30 seconds a signed message waits for its reply.
const MAX_WAIT = 20;

export async function createRooms(o: SpecialistOptions & { dataDir: string }) {
  const dir = `${o.dataDir}/rooms`;
  await mkdir(dir, { recursive: true });
  const file = `${dir}/rooms.json`;
  const rooms = new Map<string, Room>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Room[]).map((r) => [r.id, r]));
  const save = () => writeFile(file, JSON.stringify([...rooms.values()])).catch(() => {});
  const close = (r: Room, why: string) => {
    if (r.closed) return;
    r.closed = `${new Date().toISOString()} (${why})`;
    wake(r.id);
    void save();
  };
  setInterval(() => { for (const r of rooms.values()) { if (!r.closed && r.until < Date.now()) close(r, 'time is up'); else if (!r.closed && r.startBy && !r.startedAt && started(r)) { wake(r.id); void save(); } } }, 15_000).unref();
  const lastSaid = new Map<string, number>();
  // Who's in: handles, and in a bubble each handle's key for this bubble (never its card).
  const memberList = (r: Room) => r.members.filter((m) => !m.left).map((m) => (r.mode === 'bubble' ? { handle: m.handle, key: m.key } : m.handle));
  // Members waiting for the next message in a room.
  const waiting = new Map<string, Set<() => void>>();
  const wake = (id: string) => { for (const f of waiting.get(id) ?? []) f(); waiting.delete(id); };
  const present = (r: Room) => r.members.filter((m) => !m.left).length;
  // Has it started? Once everyone it waited for is in, or at its deadline with its smaller quorum; it stays started.
  const started = (r: Room) => {
    if (!r.startWith || r.startedAt || r.said.some((x) => !x.lobby)) return true;
    const n = present(r);
    if (n >= r.startWith || (r.startBy && Date.now() >= r.startBy && n >= (r.startMin ?? r.startWith))) {
      r.startedAt = new Date().toISOString();
      if (r.mode === 'room') note(r, { event: 'started', members: n });
      return true;
    }
    return false;
  };
  // In a room (not a bubble, where only members' sealed words go), the room itself says who came and went, and when it
  // starts: run 25's players noticed a departure only from the member list.
  const note = (r: Room, body: Record<string, unknown>) => {
    if (r.mode !== 'room') return;
    r.said.push({ seq: r.said.length + 1, at: new Date().toISOString(), from: 'room', body, lobby: !r.startedAt && !!r.startWith && body.event !== 'started' });
    wake(r.id);
  };
  const view = (r: Room) => {
    const waitingFor = r.startWith && !started(r) ? Math.max(0, r.startWith - present(r)) : 0;
    return { id: r.id, mode: r.mode, topic: r.topic, members: present(r), max: r.max, until: new Date(r.until).toISOString(), open: r.invited === 'anyone', closed: r.closed ?? null,
      ...(r.startWith ? { start_with: r.startWith, started: !waitingFor, ...(waitingFor ? { needs: waitingFor } : {}), ...(r.startBy ? { start_by: new Date(r.startBy).toISOString(), start_min: r.startMin } : {}) } : {}) };
  };

  const describe = `Rooms and bubbles: a few agents meet and all read the same messages in the same order. Open one with { kind: "room.open", id, topic, mode: "room" | "bubble", invite: [webIds] | "anyone", hours, start_with?, start_by?, start_min? } (start_with: it starts when that many have joined; until then a room is a lobby, its messages marked lobby, and a bubble is silent; start_by and start_min: at that time (ISO, or minutes from now) it starts with start_min if that many are in); members send room.join, room.say { body }, room.read { after, wait } (wait: up to 20 seconds for something new), room.leave; the opener may lower start_with with room.update; room.list shows what's open and how many more each needs. In a room, the room itself notes who joins and leaves and when it starts (from: "room"). In a room you speak as yourself. A bubble is private to its members, who appear as handles (m1, m2…); a message body may be any JSON value, and no message kinds are required. Nothing in a bubble can pay, sign, promise or open a house, and nothing said there binds anyone outside it.`;

  const s = await specialist(o, 'Rooms', describe, 'room', async (p, from) => {
    const id = String(p.id ?? '');
    // A room is listed to whoever it invites (or to anyone, if anyone may join); a bubble's topic only to its invitees.
    if (p.kind === 'room.list') return { kind: 'room.list', rooms: [...rooms.values()].filter((r) => !r.closed && (r.invited === 'anyone' || r.invited.includes(from) || r.opener === from)).map((r) => (r.mode === 'bubble' && r.invited === 'anyone' && r.opener !== from && !r.members.some((m) => m.webId === from && !m.left) ? { ...view(r), topic: undefined, members: undefined } : view(r))) };
    if (p.kind === 'room.open') {
      const hours = Number(p.hours ?? 1);
      const startWith = p.start_with === undefined ? undefined : Number(p.start_with);
      const startMin = p.start_min === undefined ? undefined : Number(p.start_min);
      const startBy = p.start_by === undefined ? undefined : typeof p.start_by === 'number' ? Date.now() + p.start_by * 60_000 : Date.parse(String(p.start_by));
      const invite = p.invite === 'anyone' ? 'anyone' : Array.isArray(p.invite) ? (p.invite as unknown[]).map(String).slice(0, MAX_MEMBERS) : null;
      const problems = [
        ...(ID.test(id) ? [] : ['id: a short code, lowercase letters, digits and dashes']),
        ...(rooms.has(id) ? [`id: "${id}" is taken`] : []),
        ...(p.mode === 'room' || p.mode === 'bubble' ? [] : ['mode: "room" (members speak as themselves) or "bubble" (handles, no capabilities)']),
        ...(invite ? [] : ['invite: a list of webIds, or "anyone"']),
        ...(hours > 0 && hours <= MAX_HOURS ? [] : [`hours: up to ${MAX_HOURS}`]),
        ...(startWith === undefined || (Number.isInteger(startWith) && startWith >= 2 && startWith <= MAX_MEMBERS) ? [] : [`start_with: 2 to ${MAX_MEMBERS} members`]),
        ...(startBy === undefined || (startWith && startBy > Date.now() && startBy < Date.now() + hours * 3_600_000) ? [] : ['start_by: with start_with, a time (or minutes from now) before the room closes']),
        ...(startMin === undefined || (startWith && Number.isInteger(startMin) && startMin >= 2 && startMin <= startWith && startBy) ? [] : ['start_min: with start_with and start_by, 2 to start_with members']),
      ];
      if (problems.length) return { kind: 'refused', problems };
      const r: Room = { id, mode: p.mode as Room['mode'], topic: String(p.topic ?? '').slice(0, 200), opener: from, invited: invite!, max: MAX_MEMBERS, until: Date.now() + hours * 3_600_000, members: [], said: [], ...(startWith ? { startWith } : {}), ...(startBy ? { startBy, startMin: startMin ?? startWith } : {}) };
      // In a room, whoever opens it is in it (run 27's opener got "join first" reading its own room). A bubble's opener joins
      // like anyone, with a fresh key for it.
      if (r.mode === 'room') r.members.push({ webId: from, handle: from, joinedAt: new Date().toISOString() });
      rooms.set(id, r);
      void save();
      return { kind: 'room.opened', ...view(r), ...(r.mode === 'room' ? { joined: true } : {}) };
    }
    if (!['room.join', 'room.say', 'room.read', 'room.leave', 'room.update'].includes(String(p.kind))) return { kind: 'refused', problems: ['send room.list, room.open, room.join, room.say, room.read, room.leave or (its opener) room.update'] };
    const r = rooms.get(id);
    if (!r) return { kind: 'refused', problems: [`no room called "${id}"`] };
    if (r.closed) return { kind: 'refused', problems: [`it closed: ${r.closed}`] };
    const me = r.members.find((m) => m.webId === from && !m.left);
    // The opener may lower how many it waits for, or set a deadline, while it hasn't started (run 25 had no way to).
    if (p.kind === 'room.update') {
      if (from !== r.opener) return { kind: 'refused', problems: ['only its opener can change when it starts'] };
      if (!r.startWith || started(r)) return { kind: 'refused', problems: ['it has started (or never waited)'] };
      const n = Number(p.start_with ?? r.startWith);
      if (!Number.isInteger(n) || n < 2 || n > r.startWith) return { kind: 'refused', problems: [`start_with: 2 to ${r.startWith}`] };
      r.startWith = n;
      if (r.startMin && r.startMin > n) r.startMin = n;
      started(r);
      void save();
      return { kind: 'room.updated', ...view(r) };
    }
    if (p.kind === 'room.join') {
      if (me) return { kind: 'room.joined', id, you: me.handle, mode: r.mode };
      if (r.invited !== 'anyone' && !r.invited.includes(from) && from !== r.opener) return { kind: 'refused', problems: ['you are not on this room\'s invite list'] };
      if (r.members.filter((m) => !m.left).length >= r.max) return { kind: 'refused', problems: ['the room is full'] };
      const handle = r.mode === 'bubble' ? `m${r.members.length + 1}` : from;
      const key = p.key as { kty?: string; crv?: string; x?: string; d?: string } | undefined;
      if (r.mode === 'bubble' && (key?.kty !== 'OKP' || key.crv !== 'X25519' || !key.x || key.d)) return { kind: 'refused', problems: ['key: a fresh X25519 public key for this bubble alone ({ kty: "OKP", crv: "X25519", x }); the connector makes one'] };
      r.members.push({ webId: from, handle, joinedAt: new Date().toISOString(), ...(r.mode === 'bubble' ? { key: { kty: 'OKP', crv: 'X25519', x: key!.x, kid: handle } } : {}) });
      note(r, { event: 'joined', who: handle });
      void save();
      const left = r.startWith && !started(r) ? Math.max(0, r.startWith - present(r)) : 0;
      if (!left) wake(id);
      return { kind: 'room.joined', id, you: handle, mode: r.mode, topic: r.topic, members: memberList(r), ...(r.startWith ? { starts: left ? `when ${r.startWith} have joined (${left} more to come)` : 'now: everyone is here' } : {}), ...(r.mode === 'bubble' ? { note: 'This is a bubble: members are handles; a body may be any JSON value, sealed for the members, so nobody else (this agent included) can read it. Nothing here can pay, sign, promise or open a house, and nothing said here binds anyone outside it.' } : {}) };
    }
    if (!me) return { kind: 'refused', problems: ['join first'] };
    if (p.kind === 'room.leave') {
      me.left = new Date().toISOString();
      note(r, { event: 'left', who: me.handle });
      if (!r.members.some((m) => !m.left)) close(r, 'everyone left');
      void save();
      return { kind: 'room.left', id };
    }
    const waitingFor = r.startWith && !started(r) ? Math.max(0, r.startWith - present(r)) : 0;
    if (p.kind === 'room.say') {
      // A room waiting to fill is a lobby: members may talk, marked as before the start (run 25's waiting room was mute, so
      // everything went one-to-one). A bubble stays silent until it starts, so nobody's opening is sealed before the others are in.
      if (waitingFor && r.mode === 'bubble') return { kind: 'refused', problems: [`it starts when ${r.startWith} have joined: waiting for ${waitingFor} more (read with wait to know when)`] };
      const text = JSON.stringify(p.body ?? '');
      if (r.mode === 'bubble') {
        // Blind: only a JWE for the members can be said here (General JSON: protected, recipients, iv, ciphertext, tag).
        const b = p.body as { sealed?: { recipients?: { header?: { kid?: string } }[]; ciphertext?: string } } | undefined;
        if (!b?.sealed?.ciphertext || !Array.isArray(b.sealed.recipients)) return { kind: 'refused', problems: ['body: { sealed: <a JWE, General JSON, for the members\' keys> }; the connector seals it'] };
        if (text.length > MAX_SEALED) return { kind: 'refused', problems: [`a sealed body: up to ${MAX_SEALED} characters`] };
      } else if (text.length > MAX_BODY) return { kind: 'refused', problems: [`body: up to ${MAX_BODY} characters`] };
      // One message a second each: a room is a conversation, not a firehose.
      const key = `${id}|${from}`;
      if (Date.now() - (lastSaid.get(key) ?? 0) < 1000) return { kind: 'refused', problems: ['one message a second'] };
      lastSaid.set(key, Date.now());
      const said: Said = { seq: r.said.length + 1, at: new Date().toISOString(), from: me.handle, body: p.body, ...(waitingFor ? { lobby: true } : {}) };
      r.said.push(said);
      wake(id);
      if (r.said.length > 2000) close(r, 'long enough');
      void save();
      return { kind: 'room.said', id, seq: said.seq };
    }
    // room.read: everything after a sequence number, the same order for every member. With wait, held until there is
    // something new (or the room closes), so members needn't poll a clock.
    const after = Number(p.after ?? 0);
    const wait = Math.min(Math.max(Number(p.wait ?? 0), 0), MAX_WAIT) * 1000;
    if (wait && (r.said.length <= after || waitingFor)) await new Promise<void>((done) => { const t = setTimeout(done, wait); (waiting.get(id) ?? waiting.set(id, new Set()).get(id)!).add(() => { clearTimeout(t); done(); }); });
    const stillWaiting = r.startWith && !started(r) ? Math.max(0, r.startWith - present(r)) : 0;
    return { kind: 'room.messages', id, messages: r.said.filter((x) => x.seq > after).slice(0, 200), members: memberList(r), last: r.said.length, ...(r.startWith ? { started: !stillWaiting, ...(stillWaiting ? { needs: stillWaiting } : {}) } : {}) };
    // Quiet, like the tally: who talks in which room, and when, is the members' business (the first bubble's handles were
    // matched to names through the feed).
  }, [], true);

  return s;
}
