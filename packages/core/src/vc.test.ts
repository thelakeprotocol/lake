import { describe, expect, it } from 'vitest';
import { accessGrantDraft, digestSRI, readAccessGrant, generateIdentity, issueCredential, proveDomain, verifyCredential, type LakeProfile } from './index.js';

describe('verifiable credentials', () => {
  it('pins the original record: any change breaks verification', async () => {
    const issuer = await generateIdentity();
    const bundle = JSON.stringify({ resourceType: 'Bundle', entry: [] });
    const jws = await issueCredential(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential', 'LakeHealthRecordCredential'],
        issuer: 'https://issuer.example',
        validFrom: new Date().toISOString(),
        credentialSubject: { id: 'https://pod.example/stan/profile/card#me' },
        relatedResource: [{ id: 'urn:bundle', digestSRI: digestSRI(bundle) }],
      },
      issuer,
    );
    await expect(verifyCredential(jws, issuer.publicJwk, { id: 'urn:bundle', bytes: bundle })).resolves.toMatchObject({ issuer: 'https://issuer.example' });
    await expect(verifyCredential(jws, issuer.publicJwk, { id: 'urn:bundle', bytes: bundle.replace('[]', '[1]') })).rejects.toThrow('changed after it was signed');
    const other = await generateIdentity();
    await expect(verifyCredential(jws, other.publicJwk)).rejects.toThrow('does not verify');
  });
});

describe('domain proof', () => {
  const profile = (ownerDomain: string) => ({ ownerDomain, publicJwk: { kid: 'k1' } }) as unknown as LakeProfile;

  it('skips the check only in sandbox mode, and says so', async () => {
    expect(await proveDomain(profile('gp.example'), { sandbox: true })).toEqual({ ok: true, via: 'sandbox' });
    const nothing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect((await proveDomain(profile('nonexistent-lake-test.invalid'), { fetch: nothing })).ok).toBe(false);
  });

  it('accepts a well-known file that lists the key, rejects one that does not', async () => {
    const fake = (keys: string[]) => (async () => new Response(JSON.stringify({ keys }))) as unknown as typeof fetch;
    expect(await proveDomain(profile('nonexistent-lake-test.invalid'), { fetch: fake(['k1']) })).toEqual({ ok: true, via: 'well-known' });
    expect((await proveDomain(profile('nonexistent-lake-test.invalid'), { fetch: fake(['k2']) })).ok).toBe(false);
  });
});

describe('access grants', () => {
  const owner = 'https://pod.example/stan/profile/card#me';
  const agent = 'https://uni.example/#agent';
  const terms = { offer: 'o1', study: 's1', fields: ['age_band'], purpose: 'research', authorizedBy: 'owner, live', uses: 1 };

  it('is a Solid Access Grant a Solid tool can read: owner, grantee, data, purpose as GConsent and DPV', () => {
    const d = accessGrantDraft(owner, agent, terms);
    expect(d.type).toEqual(['VerifiableCredential', 'SolidAccessGrant']);
    expect(d.credentialSubject).toMatchObject({ id: owner, providedConsent: { isProvidedTo: agent, mode: ['http://www.w3.org/ns/auth/acl#Read'], forPurpose: ['https://w3id.org/dpv#ResearchAndDevelopment'] } });
    expect(readAccessGrant(d)).toMatchObject({ ...terms, owner, grantee: agent });
  });

  it('reads nothing from a credential that is not a given access grant', () => {
    const d = accessGrantDraft(owner, agent, terms);
    expect(readAccessGrant({ ...d, type: ['VerifiableCredential', 'LakeAccessGrant'] })).toBeNull();
    expect(readAccessGrant({ ...d, credentialSubject: { ...d.credentialSubject, providedConsent: { ...d.credentialSubject.providedConsent, hasStatus: 'https://w3id.org/GConsent#ConsentStatusRefused' } } })).toBeNull();
  });
});
