import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCard, checkBadges, generateIdentity, issueCredential, keyThumbprint, ownWordClaims, signCard, verifyLakeCard, type Badge } from './index.js';

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** A register that serves its own signed card, and signs authorisations for an agent's key. */
async function register() {
  const app = express();
  const server = app.listen(0);
  servers.push(server);
  await new Promise((ok) => server.once('listening', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`;
  const id = await generateIdentity();
  const webId = 'https://register.example/#authorise';
  const card = await signCard(buildCard({ name: 'Register', description: 'x', url, skills: [], profile: { role: 'specialist', webId, ownerDomain: 'register.example', tags: [] } }, id), id);
  app.get('/.well-known/agent-card.json', (_req, res) => void res.json(card));
  const vouch = async (subject: Record<string, unknown>, validUntil?: string) => issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeAuthorisation'], issuer: webId, validFrom: new Date().toISOString(), ...(validUntil ? { validUntil } : {}), credentialSubject: subject } as never, id);
  return { url, vouch };
}

const agentWith = async (badges: (jkt: string, webId: string) => Promise<Badge[]>, name = 'Corner Grocer') => {
  const id = await generateIdentity();
  const webId = 'https://grocer.example/#agent';
  const card = await signCard(buildCard({ name, description: 'x', url: 'https://grocer.example/a2a', skills: [], profile: { role: 'agent', webId, ownerDomain: 'grocer.example', tags: ['grocer'], badges: await badges(await keyThumbprint(id.publicJwk), webId) } }, id), id);
  return verifyLakeCard(card);
};

describe('badges: what someone else signed about an agent, on its card (SPEC §2.5)', () => {
  it('checks each against its issuer\'s own card: signature, subject, key, expiry', async () => {
    const r = await register();
    const good = await agentWith(async (jkt, webId) => [{ credential: await r.vouch({ id: webId, pack: 'shopping@1', scope: 'quote', cnf: { jkt } }), issuer: r.url }]);
    expect(await checkBadges(good, { sandbox: true })).toEqual([expect.objectContaining({ by: 'register.example', type: 'LakeAuthorisation', says: 'authorised to quote for shopping@1' })]);
    // Another agent of the same owner (same WebID, another key) can't wear it: the badge pins the key.
    const borrowed = await agentWith(async (_jkt, webId) => [{ credential: await r.vouch({ id: webId, pack: 'shopping@1', scope: 'quote', cnf: { jkt: 'someone-else' } }), issuer: r.url }]);
    expect(await checkBadges(borrowed, { sandbox: true })).toEqual([]);
    // About someone else, expired, or naming an issuer whose card doesn't sign it: none count.
    const strangers = await agentWith(async () => [
      { credential: await r.vouch({ id: 'https://other.example/#agent', pack: 'x', scope: 'quote' }), issuer: r.url },
      { credential: await r.vouch({ id: 'https://grocer.example/#agent', pack: 'x', scope: 'quote' }, new Date(Date.now() - 1000).toISOString()), issuer: r.url },
    ]);
    expect(await checkBadges(strangers, { sandbox: true })).toEqual([]);
    const forged = await agentWith(async (jkt, webId) => [{ credential: await issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeAuthorisation'], issuer: 'https://register.example/#authorise', validFrom: new Date().toISOString(), credentialSubject: { id: webId, cnf: { jkt } } } as never, await generateIdentity()), issuer: r.url }]);
    expect(await checkBadges(forged, { sandbox: true })).toEqual([]);
  });

  it('points out an agent\'s own words that sound like someone else\'s approval, or name another agent', () => {
    expect(ownWordClaims({ name: 'Gale', menu: [{ label: 'Haiku by Rook (official Rook outlet)' }, { label: 'Certified contract review' }] }, ['Rook', 'Moss'])).toEqual([
      'menu "Haiku by Rook (official Rook outlet)" says "official"',
      'menu "Haiku by Rook (official Rook outlet)" names another agent, Rook',
      'menu "Certified contract review" says "certified"',
    ]);
    expect(ownWordClaims({ name: 'Moss', description: 'Plain copy, fast.' }, ['Rook'])).toEqual([]);
  });
});
