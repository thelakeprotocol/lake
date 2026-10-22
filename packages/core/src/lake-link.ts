import type { AgentCard } from '@a2a-js/sdk';
import { verifyLakeCard } from './card.js';
import { verifyMessage } from './crypto.js';
import { signMessage, type Identity } from './crypto.js';

/** What a node publishes for the houses that follow it (signed by the node). */
export interface Signals { blocklist: string[]; reputation: Record<string, number> }
import type { LakeEvent } from './events.js';

/**
 * A participant's line to a Lake node: register the signed card, then report events in signed batches.
 * Optional by design: a Lake works without any node (SPEC §9); losing the node only loses the map.
 */
export class LakeLink {
  private queue: LakeEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  id: string | null = null;
  private warned = false;

  constructor(private o: { nodeUrl: string; card: AgentCard; identity: Identity; webId: string; log?: (msg: string) => void }) {}

  async register(tries = 60): Promise<string | null> {
    let last = '';
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(`${this.o.nodeUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card: this.o.card }) });
        const body = (await res.json()) as { id?: string; code?: string; why?: string };
        if (res.ok && body.id) return (this.id = body.id);
        if (res.status === 400) {
          this.o.log?.(`node ${this.o.nodeUrl} refused registration: ${body.code} (${body.why})`);
          return null;
        }
        last = `${res.status}`;
      } catch (e) {
        last = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.o.log?.(`node ${this.o.nodeUrl} unreachable (${last}); carrying on without it`);
    return null;
  }

  private nodeKey: import('jose').JWK | null = null;

  /** The node's blocklist and reputation, verified against the node's own signed card. */
  /** Tells the node what this house is looking for (replacing what it said before); returns the size of each group. */
  async intents(list: { pack: string; group: string }[]): Promise<{ pack: string; group: string; members: number }[] | null> {
    try {
      const env = await signMessage({ kind: 'intents', intents: list }, this.o.identity, { iss: this.o.webId });
      const res = await fetch(`${this.o.nodeUrl}/intents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), signal: AbortSignal.timeout(5000) });
      return res.ok ? ((await res.json()) as { groups: { pack: string; group: string; members: number }[] }).groups : null;
    } catch {
      return null;
    }
  }

  async signals(): Promise<Signals | null> {
    try {
      if (!this.nodeKey) this.nodeKey = (await verifyLakeCard(await (await fetch(`${this.o.nodeUrl}/.well-known/agent-card.json`)).json())).publicJwk;
      const env = await (await fetch(`${this.o.nodeUrl}/signals`, { signal: AbortSignal.timeout(3000) })).json();
      const p = (await verifyMessage(env, async (kid) => (kid === this.nodeKey!.kid ? this.nodeKey : null))) as unknown as Signals;
      return { blocklist: p.blocklist ?? [], reputation: p.reputation ?? {} };
    } catch {
      return null;
    }
  }

  /** Nodes forget (restarts, resets). Check now and then, and register again if this one has forgotten us. */
  private alive: ReturnType<typeof setInterval> | null = null;

  keepAlive(everyMs = 15_000) {
    this.stop();
    this.alive = setInterval(async () => {
      try {
        const r = (await (await fetch(`${this.o.nodeUrl}/registered?webId=${encodeURIComponent(this.o.webId)}`, { signal: AbortSignal.timeout(3000) })).json()) as { registered: boolean };
        if (!r.registered) {
          this.id = null;
          await this.register(1);
        }
      } catch {
        // node down; try again later
      }
    }, everyMs).unref();
  }

  /** Stop checking in (a participant that's leaving, or replacing its card). */
  stop() {
    if (this.alive) clearInterval(this.alive);
    this.alive = null;
  }

  report(e: LakeEvent) {
    this.queue.push(e);
    this.timer ??= setTimeout(() => void this.flush(), 150);
  }

  async flush() {
    this.timer = null;
    const events = this.queue.splice(0);
    if (!events.length || !this.id) return;
    try {
      const env = await signMessage({ kind: 'events', events }, this.o.identity, { iss: this.o.webId });
      const res = await fetch(`${this.o.nodeUrl}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env), signal: AbortSignal.timeout(3000) });
      if (!res.ok && !this.warned) {
        this.warned = true;
        this.o.log?.(`node ${this.o.nodeUrl} refused our events: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch {
      // The node is an optimisation, not a dependency.
    }
  }
}

/**
 * Lines to several nodes at once (SPEC §9): register with each, report to each, and follow the signals
 * of all of them. Any node can vanish; the others carry on, and so does every conversation.
 */
export class LakeLinks {
  readonly links: LakeLink[];

  constructor(o: { nodeUrls: string[]; card: AgentCard; identity: Identity; webId: string; log?: (msg: string) => void }) {
    this.links = o.nodeUrls.map((u) => new LakeLink({ ...o, nodeUrl: u.replace(/\/$/, '') }));
  }

  /** Registers with every node; returns the ids each one gave (null where a node refused or was down). */
  async register(tries = 60): Promise<(string | null)[]> {
    return Promise.all(this.links.map((l) => l.register(tries)));
  }

  report(e: LakeEvent) {
    for (const l of this.links) l.report(e);
  }

  keepAlive(everyMs?: number) {
    for (const l of this.links) l.keepAlive(everyMs);
  }

  stop() {
    for (const l of this.links) l.stop();
  }

  async flush() {
    await Promise.all(this.links.map((l) => l.flush()));
  }

  /** Union of the blocklists, average of the reputations, across the nodes that answered. */
  /** Intents go to every node; the biggest count any node reports for a group is its size. */
  async intents(list: { pack: string; group: string }[]): Promise<{ pack: string; group: string; members: number }[]> {
    const answers = (await Promise.all(this.links.map((l) => l.intents(list)))).filter((a): a is NonNullable<typeof a> => !!a);
    return list.map((x) => ({ ...x, members: Math.max(1, ...answers.flat().filter((g) => g.pack === x.pack && g.group === x.group).map((g) => g.members)) }));
  }

  async signals(): Promise<Signals | null> {
    const all = (await Promise.all(this.links.map((l) => l.signals()))).filter((s): s is Signals => !!s);
    if (!all.length) return null;
    const blocklist = [...new Set(all.flatMap((s) => s.blocklist))];
    const sums = new Map<string, number[]>();
    for (const s of all) for (const [d, r] of Object.entries(s.reputation)) sums.set(d, [...(sums.get(d) ?? []), r]);
    const reputation = Object.fromEntries([...sums].map(([d, rs]) => [d, Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100]));
    return { blocklist, reputation };
  }
}
