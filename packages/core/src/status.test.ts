import { describe, expect, it } from 'vitest';
import { generateIdentity, readStatus, statusEntry, statusListCredential, STATUS_LIST_LENGTH } from './index.js';

describe('status list (W3C Bitstring Status List)', () => {
  it('says which keys were revoked, signed by their issuer, and nothing else', async () => {
    const house = await generateIdentity();
    const url = 'https://house.example/status/revocation';
    const list = await statusListCredential('https://house.example/#me', url, [7, 130_000], house);
    expect(await readStatus(list, house.publicJwk, 'https://house.example/#me', 7)).toBe(true);
    expect(await readStatus(list, house.publicJwk, 'https://house.example/#me', 130_000)).toBe(true);
    expect(await readStatus(list, house.publicJwk, 'https://house.example/#me', 8)).toBe(false);
    // Signed by someone else, or presented as another issuer's list: refused.
    await expect(readStatus(list, (await generateIdentity()).publicJwk, 'https://house.example/#me', 7)).rejects.toThrow();
    await expect(readStatus(list, house.publicJwk, 'https://other.example/#me', 7)).rejects.toThrow('not from the credential');
    expect(statusEntry(url, 7)).toMatchObject({ type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '7', statusListCredential: url });
    expect(STATUS_LIST_LENGTH).toBe(131_072);
  });
});
