import { ed25519 } from '@noble/curves/ed25519.js';

// The owner's key lives on this device only: a non-extractable WebCrypto key where the browser offers one (HTTPS), and
// pure-JS Ed25519 where it doesn't (phones on a home network load this page over plain HTTP, where WebCrypto is off).

const enc = new TextEncoder();
const b64u = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Same canonical form as @thelakeprotocol/core: sorted keys, no whitespace. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => JSON.stringify(k) + ':' + canonicalize(x)).join(',') + '}';
}

export interface OwnerKey {
  jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA' };
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /**
   * Where it's kept: "device", a key the browser holds and won't hand out, even to this page; "storage", readable by it;
   * "none", the browser's own store didn't answer, so there's no key this time (and none is made: see loadKey).
   */
  store: 'device' | 'storage' | 'none';
}

const STORE = `lake-owner-key:${location.host}`;
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** The key as earlier versions kept it (hex in localStorage), if this browser has one. */
function storedKey(): { secret: Uint8Array; kid: string } | null {
  try { const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as { secret: string; kid: string } | null; return s ? { secret: unhex(s.secret), kid: s.kid } : null; } catch { return null; }
}
const dropStored = () => { try { localStorage.removeItem(STORE); } catch { /* nothing kept */ } };

// Over HTTPS the key is a non-extractable WebCrypto key in IndexedDB: script in this page can ask it to sign while the page
// is open, but nothing can copy it out (SPEC §6.1). The same Ed25519 signatures, so nothing changes for the house.
type Kept = { key: CryptoKey; x: string; kid: string };
// One request against the key store. It always settles: a store that's blocked, aborted or silent for five seconds is an
// error, never a wait (the panel's first line awaits this).
function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((ok, no) => {
    const late = setTimeout(() => no(new Error('the key store did not answer')), 5_000);
    const fail = (e: unknown) => { clearTimeout(late); no(e instanceof Error ? e : new Error('the key store failed')); };
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open('lake', 1); } catch (e) { return fail(e); }
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => fail(open.error);
    open.onblocked = () => fail(new Error('the key store is blocked'));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction('keys', mode);
        const r = run(tx.objectStore('keys'));
        tx.onabort = () => { db.close(); fail(tx.error ?? r.error); };
        tx.oncomplete = () => { clearTimeout(late); db.close(); ok(r.result as T); };
      } catch (e) { db.close(); fail(e); }
    };
  });
}
// An Ed25519 seed as PKCS #8 (RFC 8410), the one form WebCrypto imports a private key from.
const PKCS8_ED25519 = unhex('302e020100300506032b657004220420');
const asDevice = (k: Kept): OwnerKey => ({ jwk: { kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid, alg: 'EdDSA' }, store: 'device', sign: async (b) => new Uint8Array(await crypto.subtle.sign('Ed25519', k.key, b as BufferSource)) });
const imported = async (old: { secret: Uint8Array; kid: string }): Promise<Kept> =>
  ({ key: await crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8_ED25519, ...old.secret]), 'Ed25519', false, ['sign']), x: b64u(ed25519.getPublicKey(old.secret)), kid: old.kid });
const proven = async (k: Kept | undefined) => { if (!k) return false; const probe = random(32); return ed25519.verify(await asDevice(k).sign(probe), probe, unb64u(k.x)); };

/** Whether this browser can hold an Ed25519 key it won't hand out. An older browser can't, on every load alike. */
async function canHold(): Promise<boolean> {
  if (!isSecureContext || !crypto.subtle || typeof indexedDB === 'undefined') return false;
  try { await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']); return true; } catch { return false; }
}

/** The readable key, from where earlier versions (and plain HTTP) keep it. Made new only when `mint` says so. */
function storageKey(mint: boolean): OwnerKey | null {
  const saved = storedKey();
  if (!saved && !mint) return null;
  const secret = saved?.secret ?? ed25519.utils.randomSecretKey();
  const kid = saved?.kid ?? `owner-${hex(random(6))}`;
  if (!saved) try { localStorage.setItem(STORE, JSON.stringify({ secret: hex(secret), kid })); } catch { /* the key lives for this tab only */ }
  return { jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(ed25519.getPublicKey(secret)), kid, alg: 'EdDSA' }, store: 'storage', sign: async (b) => ed25519.sign(b, secret) };
}

const NO_KEY: OwnerKey = { jwk: { kty: 'OKP', crv: 'Ed25519', x: '', kid: '', alg: 'EdDSA' }, store: 'none', sign: async () => { throw new Error('This browser didn\'t open its key store'); } };

/**
 * The owner's key on this device. Two rules keep it one key (round 16: a store that failed once had left two):
 * - where the browser can hold a key, a readable one is never made. If the store doesn't answer this time, the key kept
 *   the old way is used if there is one, and otherwise there is no key (store "none") and the panel says so; a key made in
 *   its place would be paired, then lose to the stored one on the next load;
 * - a key is added, never overwritten: of two tabs opening at once, both end with the one that got there first.
 */
export async function loadKey(): Promise<OwnerKey> {
  if (!(await canHold())) return storageKey(true)!;
  try {
    const kept = await idb<Kept | undefined>('readonly', (s) => s.get(STORE));
    const old = storedKey();
    if (kept) {
      // The same key kept both ways: the readable copy goes. A different one stays until the house says which it knows
      // (settleSpare), since only the house can tell.
      if (old?.kid === kept.kid) dropStored();
      return asDevice(kept);
    }
    // A key kept the old way moves in, same key and kid (no pairing again); otherwise a new one is made here.
    const made = old ? await imported(old)
      : await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']).then(async (p) => { const pair = p as CryptoKeyPair; return { key: pair.privateKey, x: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), kid: `owner-${hex(random(6))}` }; });
    await idb('readwrite', (s) => s.add(made, STORE)).catch(() => { /* another tab got there first: its key is read back */ });
    // Read back and proven with a signature before the readable copy goes: a failed move must never lose the key.
    const back = await idb<Kept | undefined>('readonly', (s) => s.get(STORE));
    if (!(await proven(back))) throw new Error('the kept key did not sign');
    if (old?.kid === back!.kid) dropStored();
    return asDevice(back!);
  } catch { return storageKey(false) ?? NO_KEY; }
}

/** A readable key left beside the device's own, by a version that made one when the store failed (round 16). */
export const spareKey = (k: OwnerKey) => { const old = k.store === 'device' ? storedKey() : null; return old && old.kid !== k.jwk.kid ? old : null; };

/**
 * Which of two keys is the house's, once the house has said. It knows the device's: the readable spare goes. It doesn't,
 * and there's a spare: the spare moves into the browser's keeping (proven first) and the caller loads the page again.
 */
export async function settleSpare(k: OwnerKey, houseKnowsIt: boolean): Promise<boolean> {
  const spare = spareKey(k);
  if (!spare) return false;
  if (houseKnowsIt) { dropStored(); return false; }
  try {
    const made = await imported(spare);
    if (!(await proven(made))) return false;
    await idb('readwrite', (s) => s.put(made, STORE));
    if (!(await proven(await idb<Kept | undefined>('readonly', (s) => s.get(STORE))))) return false;
    dropStored();
    return true;
  } catch { return false; }
}

/** Signing out on this device: the key goes, wherever it was kept. */
export async function forgetKey() {
  dropStored();
  if (typeof indexedDB !== 'undefined') await idb('readwrite', (s) => s.delete(STORE)).catch(() => {});
}

const sign = async (input: string, k: OwnerKey) => b64u(await k.sign(enc.encode(input)));

/** A signed Lake envelope, byte-compatible with core's signMessage. */
export async function signEnvelope(payload: Record<string, unknown>, k: OwnerKey, iss: string) {
  const iat = Math.floor(Date.now() / 1000);
  const full = { ...payload, nonce: hex(random(16)), iat, exp: iat + 60, iss };
  const protectedHeader = b64u(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: k.jwk.kid, typ: 'lake+jws' })));
  return { payload: full, jws: { protected: protectedHeader, signature: await sign(`${protectedHeader}.${b64u(enc.encode(canonicalize(full)))}`, k) } };
}

/** A W3C VC secured as VC-JOSE (compact JWS), signed on this device. */
export async function signCredential(vc: Record<string, unknown>, k: OwnerKey): Promise<string> {
  const h = b64u(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: k.jwk.kid, typ: 'vc+jwt', cty: 'vc' })));
  const p = b64u(enc.encode(JSON.stringify(vc)));
  return `${h}.${p}.${await sign(`${h}.${p}`, k)}`;
}
