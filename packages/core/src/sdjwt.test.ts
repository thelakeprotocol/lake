import { describe, expect, it } from 'vitest';
import { generateIdentity, issueSdJwtVc, presentSdJwtVc, readSdJwtVc, verifySdJwtVc } from './index.js';

describe('SD-JWT VCs', () => {
  it('shows only what the holder reveals, to whom it was presented, bound to the holder\'s key', async () => {
    const [issuer, holder, thief] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const vc = await issueSdJwtVc({ iss: 'https://checker.example/#agent', sub: 'https://house.example/#me', vct: 'urn:test:stamp', holder: holder.publicJwk, days: 1, person: 'p-123', note: 'visible' }, ['person'], issuer);
    expect(await readSdJwtVc(vc)).toMatchObject({ person: 'p-123' });

    const hiding = await presentSdJwtVc(vc, [], holder, { aud: 'https://tally.example/#agent', nonce: 'pledge-1' });
    const seen = await verifySdJwtVc(hiding, issuer.publicJwk, { vct: 'urn:test:stamp', aud: 'https://tally.example/#agent', nonce: 'pledge-1', holder: holder.publicJwk });
    expect(seen.note).toBe('visible');
    expect(seen.person).toBeUndefined();

    const showing = await presentSdJwtVc(vc, ['person'], holder, { aud: 'https://checker.example/#agent', nonce: 'ctx' });
    expect((await verifySdJwtVc(showing, issuer.publicJwk, { vct: 'urn:test:stamp', aud: 'https://checker.example/#agent', nonce: 'ctx' })).person).toBe('p-123');

    // Replayed to someone else, or for another nonce, or by another key, or from another issuer: refused.
    await expect(verifySdJwtVc(hiding, issuer.publicJwk, { vct: 'urn:test:stamp', aud: 'https://other.example/#agent', nonce: 'pledge-1' })).rejects.toThrow();
    await expect(verifySdJwtVc(hiding, issuer.publicJwk, { vct: 'urn:test:stamp', aud: 'https://tally.example/#agent', nonce: 'pledge-2' })).rejects.toThrow();
    const stolen = await presentSdJwtVc(vc, [], thief, { aud: 'https://tally.example/#agent', nonce: 'pledge-1' });
    await expect(verifySdJwtVc(stolen, issuer.publicJwk, { vct: 'urn:test:stamp', aud: 'https://tally.example/#agent', nonce: 'pledge-1' })).rejects.toThrow();
    await expect(verifySdJwtVc(hiding, thief.publicJwk, { vct: 'urn:test:stamp', aud: 'https://tally.example/#agent', nonce: 'pledge-1' })).rejects.toThrow();
    await expect(verifySdJwtVc(hiding, issuer.publicJwk, { vct: 'urn:test:stamp', aud: 'https://tally.example/#agent', nonce: 'pledge-1', holder: thief.publicJwk })).rejects.toThrow('bound to another key');
  });
});
