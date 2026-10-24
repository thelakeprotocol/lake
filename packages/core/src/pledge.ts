import { createHash, randomBytes } from 'node:crypto';
import type { AgentCard } from '@a2a-js/sdk';
import { sendLake } from './agent.js';
import type { LakeData } from './a2a.js';
import { verifyLakeData } from './a2a.js';
import { buildCard, signCard } from './card.js';
import { generateIdentity, signMessage } from './crypto.js';
import { commitTo, passChallenge, requestPass } from './pass.js';

/**
 * Signing a blind pledge (SPEC §11.4), the signer's side, for any agent or house:
 * 1. ask the pass issuer for a pass for every open pledge at once (so asking says nothing about which you'll sign),
 * 2. sign the one you mean from a throwaway identity, with a commitment to who you are and a hash of a withdraw secret,
 * 3. once it fills, reveal yourself to the tally, as yourself, by opening the commitment.
 * Keep what signBlind returns: the salt reveals you, the secret withdraws you.
 */
export type Asker = (url: string, payload: Record<string, unknown>) => Promise<Record<string, any>>;
export interface Pass { issuer: string; tally: string; id: string; token: string }
export interface BlindSignature { tally: string; id: string; salt: string; secret: string; reply: Record<string, any> }

/** An identity used for one message and forgotten: whatever it sends can't be tied to anyone. */
export async function throwawayAsker(o: { sandbox?: boolean } = {}): Promise<Asker> {
  const id = await generateIdentity();
  const domain = `anon-${randomBytes(6).toString('hex')}.lake.example`;
  const webId = `https://${domain}/#agent`;
  const card = await signCard(buildCard({ name: 'Someone', description: 'A one-off identity', url: `https://${domain}/a2a`, skills: [], profile: { role: 'visitor', webId, ownerDomain: domain, tags: [] } }, id), id);
  return async (url, payload) => {
    const envelope = await signMessage(payload, id, { iss: webId });
    const raw = await sendLake(url.replace(/\/?$/, '').replace(/(\/a2a)?$/, '/a2a'), { lake: '0.1', card: card as AgentCard, envelope: envelope as LakeData['envelope'] }, { me: id, timeoutMs: 20_000 });
    const v = await verifyLakeData<Record<string, unknown>>(raw as LakeData<Record<string, unknown>>, { sandbox: o.sandbox ?? true });
    if (!v.ok) throw new Error(`the reply did not verify: ${v.rejection.why}`);
    return v.payload as Record<string, any>;
  };
}

/** Passes for every open blind pledge the issuer knows (one each; a person stamp for pledges that count people). */
export async function fetchPasses(passesUrl: string, ask: Asker, person?: { credential: string; card: AgentCard }): Promise<Pass[]> {
  const open = (await ask(passesUrl, { kind: 'pass.open' })) as { issuer: string; pledges: { tally: string; id: string; publicKey: string; peopleOnly: boolean }[] };
  const wanted = (open.pledges ?? []).filter((p) => !p.peopleOnly || person);
  const pending = await Promise.all(wanted.map(async (p) => ({ p, ...(await requestPass(passChallenge(open.issuer, p.id, p.tally), p.publicKey)) })));
  if (!pending.length) return [];
  const reply = await ask(passesUrl, { kind: 'pass.issue', requests: pending.map(({ p, request }) => ({ tally: p.tally, id: p.id, request })), ...(person ? { person } : {}) });
  const passes: Pass[] = [];
  for (const x of (reply.issued ?? []) as { tally: string; id: string; response?: string }[]) {
    const mine = pending.find(({ p }) => p.tally === x.tally && p.id === x.id);
    if (mine && x.response) passes.push({ issuer: open.issuer, tally: x.tally, id: x.id, token: await mine.finish(x.response) });
  }
  return passes;
}

/** Signs with a pass, from a throwaway identity. */
export async function signBlind(tallyUrl: string, pass: Pass, realWebId: string, o: { sandbox?: boolean } = {}): Promise<BlindSignature> {
  const salt = randomBytes(16).toString('hex');
  const secret = randomBytes(16).toString('hex');
  const reply = await (await throwawayAsker(o))(tallyUrl, { kind: 'tally.sign', id: pass.id, pass: pass.token, commit: commitTo(realWebId, salt), withdraw: createHash('sha256').update(secret).digest('hex') });
  return { tally: pass.tally, id: pass.id, salt, secret, reply };
}

/** Takes a blind signature back before the pledge fills, still anonymously. */
export const withdrawBlind = async (tallyUrl: string, s: BlindSignature, o: { sandbox?: boolean } = {}) => (await throwawayAsker(o))(tallyUrl, { kind: 'tally.withdraw', id: s.id, secret: s.secret });

/** Once it has filled: says who you are, as yourself, by opening your commitment. */
export const revealBlind = (tallyUrl: string, ask: Asker, s: BlindSignature) => ask(tallyUrl, { kind: 'tally.reveal', id: s.id, salt: s.salt });
