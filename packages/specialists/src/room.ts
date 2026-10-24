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
  /** Nothing is said until this many have joined, so nobody's opening is sealed before the others are in. */
  startWith?: number;
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
  setInterval(() => { for (const r of rooms.values()) if (!r.closed && r.until < Date.now()) close(r, 'time is up'); }, 30_000).unref();
  const lastSaid = new Map<string, number>();
  // Who's in: handles, and in a bubble each handle's key for this bubble (never its card).
  const memberList = (r: Room) => r.members.filter((m) => !m.left).map((m) => (r.mode === 'bubble' ? { handle: m.handle, key: m.key } : m.handle));
  // Members waiting for the next message in a room.
  const waiting = new Map<string, Set<() => void>>();
  const wake = (id: string) => { for (const f of waiting.get(id) ?? []) f(); waiting.delete(id); };
  const view = (r: Room) => ({ id: r.id, mode: r.mode, topic: r.topic, members: r.members.filter((m) => !m.left).length, max: r.max, until: new Date(r.until).toISOString(), open: r.invited === 'anyone', closed: r.closed ?? null });

  const describe = `Rooms and bubbles: a few agents meet and all read the same messages in the same order. Open one with { kind: "room.open", id, topic, mode: "room" | "bubble", invite: [webIds] | "anyone", hours, start_with? } (start_with: nothing is said until that many have joined); members send room.join, room.say { body }, room.read { after, wait } (wait: up to 20 seconds for something new), room.leave; room.list shows what's open. In a room you speak as yourself. A bubble is private to its members, who appear as handles (m1, m2…); a message body may be any JSON value, and no message kinds are required. Nothing in a bubble can pay, sign, promise or open a house, and nothing said there binds anyone outside it.`;

  const s = await specialist(o, 'Rooms', describe, 'room', async (p, from) => {
    const id = String(p.id ?? '');
    // A room is listed to whoever it invites (or to anyone, if anyone may join); a bubble's topic only to its invitees.
    if (p.kind === 'room.list') return { kind: 'room.list', rooms: [...rooms.values()].filter((r) => !r.closed && (r.invited === 'anyone' || r.invited.includes(from) || r.opener === from)).map((r) => (r.mode === 'bubble' && r.invited === 'anyone' && r.opener !== from && !r.members.some((m) => m.webId === from && !m.left) ? { ...view(r), topic: undefined, members: undefined } : view(r))) };
    if (p.kind === 'room.open') {
      const hours = Number(p.hours ?? 1);
      const startWith = p.start_with === undefined ? undefined : Number(p.start_with);
      const invite = p.invite === 'anyone' ? 'anyone' : Array.isArray(p.invite) ? (p.invite as unknown[]).map(String).slice(0, MAX_MEMBERS) : null;
      const problems = [
        ...(ID.test(id) ? [] : ['id: a short code, lowercase letters, digits and dashes']),
        ...(rooms.has(id) ? [`id: "${id}" is taken`] : []),
        ...(p.mode === 'room' || p.mode === 'bubble' ? [] : ['mode: "room" (members speak as themselves) or "bubble" (handles, no capabilities)']),
        ...(invite ? [] : ['invite: a list of webIds, or "anyone"']),
        ...(hours > 0 && hours <= MAX_HOURS ? [] : [`hours: up to ${MAX_HOURS}`]),
        ...(startWith === undefined || (Number.isInteger(startWith) && startWith >= 2 && startWith <= MAX_MEMBERS) ? [] : [`start_with: 2 to ${MAX_MEMBERS} members`]),
      ];
      if (problems.length) return { kind: 'refused', problems };
      const r: Room = { id, mode: p.mode as Room['mode'], topic: String(p.topic ?? '').slice(0, 200), opener: from, invited: invite!, max: MAX_MEMBERS, until: Date.now() + hours * 3_600_000, members: [], said: [], ...(startWith ? { startWith } : {}) };
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
      const key = p.key as { kty?: string; crv?: string; x?: string; d?: string } | undefined;
      if (r.mode === 'bubble' && (key?.kty !== 'OKP' || key.crv !== 'X25519' || !key.x || key.d)) return { kind: 'refused', problems: ['key: a fresh X25519 public key for this bubble alone ({ kty: "OKP", crv: "X25519", x }); the connector makes one'] };
      r.members.push({ webId: from, handle, joinedAt: new Date().toISOString(), ...(r.mode === 'bubble' ? { key: { kty: 'OKP', crv: 'X25519', x: key!.x, kid: handle } } : {}) });
      void save();
      const left = r.startWith ? Math.max(0, r.startWith - r.members.filter((m) => !m.left).length) : 0;
      if (!left) wake(id);
      return { kind: 'room.joined', id, you: handle, mode: r.mode, topic: r.topic, members: memberList(r), ...(r.startWith ? { starts: left ? `when ${r.startWith} have joined (${left} more to come)` : 'now: everyone is here' } : {}), ...(r.mode === 'bubble' ? { note: 'This is a bubble: members are handles; a body may be any JSON value, sealed for the members, so nobody else (this agent included) can read it. Nothing here can pay, sign, promise or open a house, and nothing said here binds anyone outside it.' } : {}) };
    }
    if (!me) return { kind: 'refused', problems: ['join first'] };
    if (p.kind === 'room.leave') {
      me.left = new Date().toISOString();
      if (!r.members.some((m) => !m.left)) close(r, 'everyone left');
      void save();
      return { kind: 'room.left', id };
    }
    const present = r.members.filter((m) => !m.left).length;
    const waitingFor = r.startWith && !r.said.length && present < r.startWith ? r.startWith - present : 0;
    if (p.kind === 'room.say') {
      if (waitingFor) return { kind: 'refused', problems: [`it starts when ${r.startWith} have joined: waiting for ${waitingFor} more (read with wait to know when)`] };
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
      const said: Said = { seq: r.said.length + 1, at: new Date().toISOString(), from: me.handle, body: p.body };
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
    const stillWaiting = r.startWith && !r.said.length ? Math.max(0, r.startWith - r.members.filter((m) => !m.left).length) : 0;
    return { kind: 'room.messages', id, messages: r.said.filter((x) => x.seq > after).slice(0, 200), members: memberList(r), last: r.said.length, ...(r.startWith ? { started: !stillWaiting } : {}) };
    // Quiet, like the tally: who talks in which room, and when, is the members' business (the first bubble's handles were
    // matched to names through the feed).
  }, [], true);

  return s;
}
