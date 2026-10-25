import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';

/**
 * Replies already given, by the exact message they answered (SPEC §3). A sender whose connection dropped before the
 * reply came back sends the very same signed message again: it gets the very same signed reply, and nothing is done
 * twice. Kept until the message itself expires (after that a copy is refused as expired anyway), and bounded: past
 * `maxEntries` or `maxBytes` the oldest go first, and a copy that finds nothing here falls back to being refused as a
 * replay, which is what every receiver did before.
 */
export class ReplyCache<R> {
  private entries = new Map<string, { exp: number; reply: Promise<R>; bytes: number }>();
  private bytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;

  constructor(o: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = o.maxEntries ?? 2000;
    this.maxBytes = o.maxBytes ?? 16 * 1024 * 1024;
  }

  get size(): number { return this.entries.size; }

  /** A key for a message as it arrived (for a Lake message: the sender's card and its signed envelope). */
  static keyOf(message: unknown): string {
    return createHash('sha256').update(canonicalize(message)).digest('base64url');
  }

  /**
   * Answers the message `key`, which expires at `exp` (seconds): with the reply already given to it, or else with
   * `work`'s, remembered only if `keep()` says the message was verified and acted on. An unverified message did
   * nothing, so a copy of it is simply checked again. A copy that arrives while the first is still being answered
   * waits for that same answer.
   */
  answer(key: string, exp: number, work: () => Promise<R>, keep: () => boolean, now = Date.now()): Promise<R> {
    const sec = Math.floor(now / 1000);
    const had = this.entries.get(key);
    if (had && had.exp >= sec && exp >= sec) return had.reply;
    if (had) this.drop(key);
    const reply = work();
    // An expired message is refused by whoever verifies it; there is nothing to remember.
    if (!(exp >= sec)) return reply;
    const entry = { exp, reply, bytes: 0 };
    this.entries.set(key, entry);
    reply.then(
      (r) => {
        if (this.entries.get(key) !== entry) return;
        if (!keep()) return void this.drop(key);
        entry.bytes = JSON.stringify(r ?? null).length;
        this.bytes += entry.bytes;
        this.trim(sec);
      },
      () => { if (this.entries.get(key) === entry) this.drop(key); },
    );
    this.trim(sec);
    return reply;
  }

  private drop(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.bytes -= e.bytes;
    this.entries.delete(key);
  }

  private trim(sec: number) {
    if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) return;
    for (const [k, e] of this.entries) if (e.exp < sec) this.drop(k);
    // Oldest first: a retry comes within seconds of its first try, so the newest are the ones still worth keeping.
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.drop(k);
    }
  }
}
