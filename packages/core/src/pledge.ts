import { createHash, randomBytes } from 'node:crypto';
import type { AgentCard } from '@a2a-js/sdk';
import { sendLake } from './agent.js';
import type { LakeData } from './a2a.js';
import { verifyLakeData } from './a2a.js';
import { buildCard, signCard } from './card.js';
import { generateIdentity, signMessage, type Identity } from './crypto.js';
import { roundTimeMs, sealUntil } from './draw.js';
import { commitTo, passChallenge, requestPass } from './pass.js';

/**
 * Signing a blind pledge (SPEC §11.4), the signer's side, for any agent or house:
 * 1. ask the pass issuer for a pass for every open pledge at once (so asking says nothing about which you'll sign),
 * 2. sign the one you mean from a throwaway identity, with a commitment to who you are and a hash of a withdraw secret
 *    (and, if the pledge unveils, your reveal sealed until its round),
 * 3. once it fills, reveal yourself to the tally, as yourself, by opening the commitment (or, if it unveils, the tally
 *    opens every sealed reveal at once).
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

/** Who the signer really is, to sign its own reveal for a pledge that unveils everyone at once. */
export interface Signer { identity: Identity; card: AgentCard }

/**
 * Signs with a pass, from a throwaway identity. A pledge opened with unveil refuses a signature without the signer's
 * reveal sealed to its round, and says the round (the pass stays unspent): given `me`, this seals one and signs again.
 */
export async function signBlind(tallyUrl: string, pass: Pass, realWebId: string, o: { sandbox?: boolean; me?: Signer } = {}): Promise<BlindSignature> {
  const salt = randomBytes(16).toString('hex');
  const secret = randomBytes(16).toString('hex');
  const ask = await throwawayAsker(o);
  const sign = (sealed?: string) => ask(tallyUrl, { kind: 'tally.sign', id: pass.id, pass: pass.token, commit: commitTo(realWebId, salt), withdraw: createHash('sha256').update(secret).digest('hex'), ...(sealed ? { sealed } : {}) });
  let reply = await sign();
  const round = Number(reply.unveil?.round);
  if (reply.kind === 'refused' && round && o.me) reply = await sign(await sealReveal(round, { tally: pass.tally, id: pass.id, salt }, realWebId, o.me));
  return { tally: pass.tally, id: pass.id, salt, secret, reply };
}

/**
 * A signer's reveal, sealed until the unveil round (drand timelock): its own signed tally.reveal for this pledge at this
 * tally (named by WebID), with its card, so whoever opens it checks who it is the way the tally checks a reveal sent live.
 * Valid a week past the round, for a tally that opens it late.
 */
export async function sealReveal(round: number, r: { tally: string; id: string; salt: string }, webId: string, me: Signer): Promise<string> {
  const ttl = Math.ceil((roundTimeMs(round) - Date.now()) / 1000) + 7 * 86_400;
  const envelope = await signMessage({ kind: 'tally.reveal', tally: r.tally, id: r.id, salt: r.salt }, me.identity, { iss: webId, ttl });
  return sealUntil(round, JSON.stringify({ lake: '0.1', card: me.card, envelope }));
}

/**
 * Checks an opened seal is a reveal of this signature: a Lake message verified like any other (card, domain, signature,
 * expiry), for this pledge at this tally, whose sender's WebID and salt make the signature's commitment. A seal can't
 * name someone else: it would need their key. Throws why not.
 */
export async function checkReveal(opened: string, o: { tally: string; id: string; commit: string; sandbox?: boolean }): Promise<{ webId: string; domain: string; url: string }> {
  const data = JSON.parse(opened) as LakeData<{ kind?: string; tally?: string; id?: string; salt?: string }>;
  const v = await verifyLakeData(data, { sandbox: o.sandbox });
  if (!v.ok) throw new Error(`the reveal does not verify: ${v.rejection.why}`);
  if (v.payload.kind !== 'tally.reveal' || v.payload.tally !== o.tally || v.payload.id !== o.id) throw new Error('a reveal for another pledge');
  if (commitTo(v.profile.webId, String(v.payload.salt ?? '')) !== o.commit) throw new Error('it does not open this signature');
  return { webId: v.profile.webId, domain: v.profile.ownerDomain, url: data.card.supportedInterfaces?.[0]?.url ?? '' };
}

/** Takes a blind signature back before the pledge fills, still anonymously. */
export const withdrawBlind = async (tallyUrl: string, s: BlindSignature, o: { sandbox?: boolean } = {}) => (await throwawayAsker(o))(tallyUrl, { kind: 'tally.withdraw', id: s.id, secret: s.secret });

/** Once it has filled: says who you are, as yourself, by opening your commitment. */
export const revealBlind = (tallyUrl: string, ask: Asker, s: BlindSignature) => ask(tallyUrl, { kind: 'tally.reveal', id: s.id, salt: s.salt });
