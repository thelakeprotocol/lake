import { generateIdentity, type AgentCard } from '@thelakeprotocol/core';
import { knock, makeVisitor, PRESETS, type Tamper } from './knock.js';

export const ATTACKS: (Tamper | 'injection')[] = ['forge-card', 'unsigned', 'replay', 'impersonate', 'injection'];

/** Houses from the first node that answers (one URL, or several comma-separated). */
export async function houseUrls(nodes: string): Promise<string[]> {
  for (const node of nodes.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean)) {
    try {
      const found = (await (await fetch(`${node}/cards?role=house`, { signal: AbortSignal.timeout(5000) })).json()) as { card: AgentCard }[];
      return found.map((f) => f.card.supportedInterfaces[0]!.url);
    } catch {
      // next node
    }
  }
  return [];
}

/**
 * One attacker (one key) tries every trick in turn against the houses it can find.
 * Every attempt must be blocked; after a few, the Lake quarantines the key and houses drop it on sight.
 */
export async function attack(o: { houses: string[]; count: number; domain?: string; log?: (line: string) => void }) {
  const domain = o.domain ?? `evil-${Math.floor(Math.random() * 1e4)}.example`;
  const attacker = await makeVisitor(await generateIdentity(), domain, `Totally legit agent (${domain})`);
  const tally: Record<string, number> = {};
  for (let i = 0; i < o.count; i++) {
    const how = ATTACKS[i % ATTACKS.length]!;
    const house = o.houses[Math.floor(Math.random() * o.houses.length)]!;
    let outcome: string;
    try {
      // Requests rules decline anyway, so a replay's first, genuine copy never lands on an owner's phone.
      const { reply } = how === 'injection' ? await knock(house, attacker, PRESETS.injection!) : await knock(house, attacker, PRESETS.marketing!, how);
      outcome = reply.kind === 'rejected' ? String(reply.code) : `${reply.decision}${reply.decision === 'join' ? ' (NOT BLOCKED)' : ''}`;
    } catch (e) {
      outcome = `error: ${(e as Error).message.slice(0, 60)}`;
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    o.log?.(`${how.padEnd(12)} → ${outcome}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { domain, tally };
}

/** Background life: traders making small, ordinary requests, and an attacker every so often. */
export async function swarm(o: { node: string; traders: number; attackers: number; intervalMs: number; log?: (line: string) => void; signal?: AbortSignal }) {
  const domains = ['gp.example', 'pharmacy.example', 'ads.example', 'shop.example', 'insurer.example', 'gym.example'];
  const traders = await Promise.all(Array.from({ length: o.traders }, async (_, i) => makeVisitor(await generateIdentity(), domains[i % domains.length]!)));
  let houses = await houseUrls(o.node);
  const refresh = setInterval(async () => { houses = await houseUrls(o.node).catch(() => houses); }, 10_000);
  const jitter = () => o.intervalMs * (0.5 + Math.random());
  const loops = traders.map(async (t) => {
    while (!o.signal?.aborted) {
      await new Promise((r) => setTimeout(r, jitter()));
      if (!houses.length) continue;
      const house = houses[Math.floor(Math.random() * houses.length)]!;
      // Only the GP asks for something a rule grants; everyone else is ordinary marketing that rules decline.
      await knock(house, t, t.domain === 'gp.example' ? PRESETS.gp! : PRESETS.marketing!).catch(() => {});
    }
  });
  const attackers = Array.from({ length: o.attackers }, async () => {
    while (!o.signal?.aborted) {
      await new Promise((r) => setTimeout(r, jitter() * 4));
      if (!houses.length) continue;
      const r = await attack({ houses, count: 5 });
      o.log?.(`attacker ${r.domain}: ${Object.entries(r.tally).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    }
  });
  await Promise.race([Promise.all([...loops, ...attackers]), new Promise((r) => o.signal?.addEventListener('abort', r))]);
  clearInterval(refresh);
}
