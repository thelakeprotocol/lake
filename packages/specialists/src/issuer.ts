import express from 'express';
import { buildCard, digestSRI, issueCredential, signCard, type AgentCard, type Identity } from '@thelakeprotocol/core';
import { seedFrom, syntheticPatient } from '@thelakeprotocol/convert-fhir';

export interface IssuerOptions {
  id: Identity;
  /** Public URL of this issuer, e.g. http://issuer:4300 */
  url: string;
  domain: string;
  /** Fixed "today" for seeded runs. */
  asOf?: number;
}

/**
 * The Issuer plays the hospital: it holds a person's (synthetic) record and signs it as a
 * W3C Verifiable Credential when their house asks. The record goes to the house; the issuer keeps nothing.
 */
export async function createIssuer(o: IssuerOptions): Promise<{ app: express.Express; card: AgentCard; webId: string }> {
  const webId = `${o.url}/#issuer`;
  const card = await signCard(
    buildCard(
      {
        name: 'Issuer (demo hospital)',
        description: 'Signs synthetic health records as Verifiable Credentials. Synthetic data only.',
        url: `${o.url}/a2a`,
        skills: [{ id: 'issue-health-record', name: 'Issue a health record', description: 'Returns a synthetic FHIR record and a VC that pins it' }],
        profile: { role: 'specialist', webId, ownerDomain: o.domain, tags: ['issuer'] },
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
    const bundle = JSON.stringify(syntheticPatient(seedFrom(subject), o.asOf));
    const recordId = `urn:lake:record:${digestSRI(subject).slice(7, 23)}`;
    const credential = await issueCredential(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'LakeHealthRecordCredential'],
        issuer: webId,
        validFrom: new Date(o.asOf ?? Date.now()).toISOString(),
        credentialSubject: { id: subject, synthetic: true },
        relatedResource: [{ id: recordId, digestSRI: digestSRI(bundle), mediaType: 'application/fhir+json' }],
      },
      o.id,
    );
    res.json({ recordId, bundle, credential, issuer: webId });
  });

  return { app, card, webId };
}
