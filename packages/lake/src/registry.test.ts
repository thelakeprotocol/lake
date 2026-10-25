import { describe, expect, it } from 'vitest';
import { buildCard, generateIdentity, signCard, type AgentCard, type LakeRole } from '@thelakeprotocol/core';
import { Registry } from './registry.js';

// Each card is served at its own endpoint, as registration checks; here a map stands in for the network.
const served = new Map<string, AgentCard>();
const fetchCard = (async (url: string) => ({ json: async () => served.get(String(url)) })) as unknown as typeof fetch;
let n = 0;
const card = async (name: string, role: LakeRole, skills: string[] = [], tags: string[] = []) => {
  const id = await generateIdentity();
  const base = `http://agent-${++n}.example`;
  const c = await signCard(buildCard({ name, description: 'x', url: `${base}/a2a`, skills: skills.map((s) => ({ id: s, name: s, description: 'x' })), profile: { role, webId: `${base}/#me`, ownerDomain: `agent-${n}.example`, tags } }, id), id);
  served.set(`${base}/.well-known/agent-card.json`, c);
  return c;
};

describe('registry: specialists\' names and skills are theirs (SPEC §2.4)', () => {
  it('refuses a card that names itself like a specialist registered here, or carries its skill id as a skill or tag', async () => {
    const r = new Registry({ sandbox: true, fetch: fetchCard });
    expect((await r.register(await card('Arbiter', 'specialist', ['arbiter']))).ok).toBe(true);
    expect((await r.register(await card('Payments (demo)', 'specialist', ['payments']))).ok).toBe(true);
    for (const impostor of [
      await card('Arbiter', 'visitor', ['arbiter']),
      await card('arbiter!', 'visitor'),
      await card('PAYMENTS', 'visitor'),
      await card('Payments (official)', 'visitor'),
      await card('Arbiter (real)', 'specialist', ['arbiter']),
      await card('Gale', 'visitor', ['messages'], ['arbiter']),
    ]) {
      const got = await r.register(impostor);
      expect(got.ok, impostor.name).toBe(false);
      if (!got.ok) expect(got.refusal.code).toBe('reserved');
    }
    // Names of its own, another specialist sharing a skill id (two tellers), and a peer Lake's own Arbiter all pass.
    expect((await r.register(await card('Haiku by Gale', 'visitor', ['messages'], ['writer:poems']))).ok).toBe(true);
    expect((await r.register(await card('Arbitrage bot', 'visitor'))).ok).toBe(true);
    // A name that only contains a specialist's word is a name of its own ("Haiku guide" beside a Guide).
    expect((await r.register(await card('Payments desk', 'visitor'))).ok).toBe(true);
    expect((await r.register(await card('The arbiter of taste', 'visitor'))).ok).toBe(true);
    expect((await r.register(await card('Arbiter.', 'specialist', ['arbiter']))).ok).toBe(false);
    expect((await r.register(await card('Rulings', 'specialist', ['arbiter']))).ok).toBe(true);
    expect((await r.register(await card('Arbiter', 'specialist', ['arbiter']), 'http://peer.example')).ok).toBe(true);
  });

  it('lets a specialist register again under its own WebID', async () => {
    const r = new Registry({ sandbox: true, fetch: fetchCard });
    const arbiter = await card('Arbiter', 'specialist', ['arbiter']);
    expect((await r.register(arbiter)).ok).toBe(true);
    expect((await r.register(arbiter)).ok).toBe(true);
  });
});
