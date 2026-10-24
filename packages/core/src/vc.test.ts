import * as jose from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessGrantDraft, didWebDocument, digestSRI, readAccessGrant, generateIdentity, issueCredential, proveDomain, verifyCredential, type JWK, type LakeProfile } from './index.js';

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
  // Serves the given files for https://<host><path>; anything else is a 404.
  const serve = (files: Record<string, unknown>) => vi.stubGlobal('fetch', (async (url: string | URL) => {
    const body = files[String(url)];
    return body === undefined ? new Response('', { status: 404 }) : new Response(typeof body === 'string' ? body : JSON.stringify(body));
  }) as typeof fetch);
  afterEach(() => vi.unstubAllGlobals());
  const profile = (ownerDomain: string, publicJwk: JWK) => ({ ownerDomain, publicJwk }) as unknown as LakeProfile;

  it('skips the check only in sandbox mode, and says so', async () => {
    const me = await generateIdentity('k1');
    expect(await proveDomain(profile('gp.example', me.publicJwk), { sandbox: true })).toEqual({ ok: true, via: 'sandbox' });
    serve({});
    expect((await proveDomain(profile('gp.example', me.publicJwk))).ok).toBe(false);
  });

  it('accepts a did:web document that lists this very key, and not another key under the same name', async () => {
    const [me, impostor] = [await generateIdentity('k1'), await generateIdentity('k1')];
    serve({ 'https://gp.example/.well-known/did.json': didWebDocument('gp.example', [me.publicJwk]) });
    expect(await proveDomain(profile('gp.example', me.publicJwk))).toEqual({ ok: true, via: 'did:web' });
    expect((await proveDomain(profile('gp.example', impostor.publicJwk))).ok).toBe(false);
  });

  it('accepts a DID Configuration linking a DID that holds the key, for this origin only', async () => {
    const me = await generateIdentity('k1');
    const did = 'did:web:keys.host.example';
    const link = (origin: string) => new jose.SignJWT({ vc: { '@context': ['https://www.w3.org/2018/credentials/v1', 'https://identity.foundation/.well-known/did-configuration/v1'], type: ['VerifiableCredential', 'DomainLinkageCredential'], credentialSubject: { id: did, origin } } })
      .setProtectedHeader({ alg: 'EdDSA', kid: `${did}#k1` }).setIssuer(did).setSubject(did).setIssuedAt().setExpirationTime('1y').sign(me.privateKey);
    serve({
      'https://keys.host.example/.well-known/did.json': didWebDocument('keys.host.example', [me.publicJwk]),
      'https://gp.example/.well-known/did-configuration.json': { '@context': 'https://identity.foundation/.well-known/did-configuration/v1', linked_dids: [await link('https://gp.example')] },
      'https://ads.example/.well-known/did-configuration.json': { linked_dids: [await link('https://gp.example')] },
    });
    expect(await proveDomain(profile('gp.example', me.publicJwk))).toEqual({ ok: true, via: 'did-configuration' });
    expect((await proveDomain(profile('ads.example', me.publicJwk))).ok).toBe(false);
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
