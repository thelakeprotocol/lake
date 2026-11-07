import { describe, expect, it } from 'vitest';
import { generateIdentity } from './crypto.js';
import { checkDeed, deedAnswerPasses, deedDigest, issueDeed, type DeedTask } from './deed.js';
import { cartTerms, checkCart, keyThumbprint, menuProblems, signCart } from './trade.js';

const task: DeedTask = { id: 'sort', title: 'Sort a delivery', ask: 'Shelve: beans, carrots', check: { expected: { beans: 'tinned', carrots: 'fresh' } } };

describe('deeds: certified hours of help as payment (SPEC §6.7)', () => {
  it('checks an answer against the task, case and spaces aside, and with a minimum share right', () => {
    expect(deedAnswerPasses(task, { beans: ' Tinned ', carrots: 'fresh' })).toBe(true);
    expect(deedAnswerPasses(task, { beans: 'tinned', carrots: 'dry' })).toBe(false);
    expect(deedAnswerPasses({ ...task, check: { ...task.check, min: 0.5 } }, { beans: 'tinned', carrots: 'dry' })).toBe(true);
    expect(deedAnswerPasses(task, 'tinned')).toBe(false);
  });

  it('issues an Open Badges 3.0 credential for one hour of community service, bound to the helper\'s key, and checks it', async () => {
    const org = await generateIdentity(), helper = await generateIdentity();
    const jkt = await keyThumbprint(helper.publicJwk);
    const jws = await issueDeed({ issuer: org, issuerWebId: 'https://org.example/#authorise', issuerName: 'An organisation', subject: 'https://helper.example/#agent', jkt, task, achievementBase: 'https://org.example/achievements' });
    const vc = JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString());
    expect(vc['@context']).toContain('https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json');
    expect(vc).toMatchObject({ type: ['VerifiableCredential', 'OpenBadgeCredential'], credentialSubject: { type: ['AchievementSubject'], creditsEarned: 1, achievement: { achievementType: 'CommunityService' }, cnf: { jkt } } });
    expect(await checkDeed(jws, org.publicJwk)).toMatchObject({ digest: deedDigest(jws), issuer: 'https://org.example/#authorise', subject: 'https://helper.example/#agent', jkt, credits: 1 });
    await expect(checkDeed(jws, helper.publicJwk)).rejects.toThrow();
  });

  it('prices a menu item in another unit only with someone named to say it was paid, and signs a cart in it naming them', async () => {
    const seller = await generateIdentity(), org = await generateIdentity();
    const accept = [{ url: 'https://org.example/a2a', webId: 'https://org.example/#authorise', jkt: await keyThumbprint(org.publicJwk) }];
    const item = { sku: 'call', label: 'A call', price: { currency: 'AUD', value: 60 } };
    expect(menuProblems([{ ...item, prices: [{ value: 1, assetCode: 'HUR', assetScale: 0, accept }] }])).toEqual([]);
    expect(menuProblems([{ ...item, prices: [{ value: 1, assetCode: 'HUR', assetScale: 0, accept: [] }] }])).toHaveLength(1);
    expect(menuProblems([{ ...item, prices: [{ value: 1.5, assetCode: 'HUR', assetScale: 0, accept }] }])).toHaveLength(1);
    const cart = await signCart({ seller, sellerWebId: 'https://seller.example/#agent', sellerName: 'Seller', buyerWebId: 'https://buyer.example/#agent', items: [{ label: 'A call', amount: { currency: 'HUR', value: 1 } }], assets: { HUR: { accept } } });
    expect((await checkCart(cart, seller.publicJwk)).total).toEqual({ currency: 'HUR', value: 1 });
    expect(cartTerms(cart.contents).assets).toEqual({ HUR: { accept } });
  });
});
