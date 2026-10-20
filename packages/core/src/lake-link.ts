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
