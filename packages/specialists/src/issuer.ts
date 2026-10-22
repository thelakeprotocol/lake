import express from 'express';
import { buildCard, digestSRI, issueCredential, signCard, type AgentCard, type Identity, type LakePack } from '@thelakeprotocol/core';

export interface IssuerOptions {
  id: Identity;
  /** Public URL of this issuer, e.g. http://issuer:4300 */
  url: string;
  domain: string;
  /** The use case whose records it signs: it plays that pack's authority (a hospital, a bank…). */
  pack: LakePack;
  /** Fixed "today" for seeded runs. */
  asOf?: number;
}

/**
 * A demo issuer plays a pack's authority (the hospital for health, the bank for mortgages): it holds a
 * person's synthetic record and signs it as a W3C Verifiable Credential when their house asks. The record
 * goes to the house; the issuer keeps nothing.
 */
export async function createIssuer(o: IssuerOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const src = o.pack.source;
  if (!src) throw new Error(`pack ${o.pack.id} has no source to issue`);
  const webId = `${o.url}/#issuer`;
  const card = await signCard(
    buildCard(
      {
        name: src.issuer.name,
        description: src.issuer.description,
        url: `${o.url}/a2a`,
        skills: [{ id: `issue-${o.pack.id}-record`, name: `Issue a ${o.pack.id} record`, description: `Returns a synthetic ${o.pack.id} record and a VC that pins it` }],
        profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: ['issuer', o.pack.id] },
      },
      o.id,
    ),
    o.id,
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/.well-known/agent-card.json', (_req, res) => void res.json(card));
  app.get('/health', (_req, res) => void res.json({ ok: true }));

  app.post('/records', async (req, res) => {
    const subject = String(req.body?.subject ?? '');
    if (!/^https?:\/\//.test(subject)) return void res.status(400).json({ error: 'subject must be a WebID' });
    if (req.body?.pack && req.body.pack !== o.pack.id) return void res.status(400).json({ error: `this issuer signs ${o.pack.id} records` });
    const original = src.synthetic(subject, o.asOf);
    const recordId = `urn:lake:record:${o.pack.id}:${digestSRI(subject).slice(7, 23)}`;
    const credential = await issueCredential(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', src.credentialType],
        issuer: webId,
        validFrom: new Date(o.asOf ?? Date.now()).toISOString(),
        credentialSubject: { id: subject, synthetic: true },
        relatedResource: [{ id: recordId, digestSRI: digestSRI(original), mediaType: src.mediaType }],
      },
      o.id,
    );
    res.json({ recordId, original, credential, issuer: webId });
  });

  return { app, card, webId };
}
