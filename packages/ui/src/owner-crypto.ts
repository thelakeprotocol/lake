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
  /** Where it's kept: "device", a key the browser holds and won't hand out, even to this page; "storage", readable by it. */
  store: 'device' | 'storage';
}

const STORE = `lake-owner-key:${location.host}`;
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** The key as earlier versions kept it (hex in localStorage), if this browser has one. */
function storedKey(): { secret: Uint8Array; kid: string } | null {
  try { const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as { secret: string; kid: string } | null; return s ? { secret: unhex(s.secret), kid: s.kid } : null; } catch { return null; }
}

// Over HTTPS the key is a non-extractable WebCrypto key in IndexedDB: script in this page can ask it to sign while the page
// is open, but nothing can copy it out (SPEC §6.1). The same Ed25519 signatures, so nothing changes for the house.
type Kept = { key: CryptoKey; x: string; kid: string };
function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((ok, no) => {
    const open = indexedDB.open('lake', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => no(open.error);
    open.onsuccess = () => { const r = run(open.result.transaction('keys', mode).objectStore('keys')); r.onsuccess = () => ok(r.result as T); r.onerror = () => no(r.error); };
  });
}
// An Ed25519 seed as PKCS #8 (RFC 8410), the one form WebCrypto imports a private key from.
const PKCS8_ED25519 = unhex('302e020100300506032b657004220420');
const asDevice = (k: Kept): OwnerKey => ({ jwk: { kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid, alg: 'EdDSA' }, store: 'device', sign: async (b) => new Uint8Array(await crypto.subtle.sign('Ed25519', k.key, b as BufferSource)) });

async function deviceKey(): Promise<OwnerKey | null> {
  if (!isSecureContext || !crypto.subtle || typeof indexedDB === 'undefined') return null;
  try {
    const kept = await idb<Kept | undefined>('readonly', (s) => s.get(STORE));
    const old = storedKey();
    if (kept) { if (old?.kid === kept.kid) localStorage.removeItem(STORE); return asDevice(kept); }
    // A key kept the old way moves in, same key and kid (no pairing again); otherwise a new one is made here.
    const made = old
      ? { key: await crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8_ED25519, ...old.secret]), 'Ed25519', false, ['sign']), x: b64u(ed25519.getPublicKey(old.secret)), kid: old.kid }
      : await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']).then(async (p) => { const pair = p as CryptoKeyPair; return { key: pair.privateKey, x: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), kid: `owner-${hex(random(6))}` }; });
    await idb('readwrite', (s) => s.put(made, STORE));
    // Read back and proven with a signature before the readable copy goes: a failed move must never lose the key.
    const back = await idb<Kept | undefined>('readonly', (s) => s.get(STORE));
    const probe = random(32);
    if (!back || !ed25519.verify(await asDevice(back).sign(probe), probe, unb64u(back.x))) { await idb('readwrite', (s) => s.delete(STORE)).catch(() => {}); return null; }
    if (old) localStorage.removeItem(STORE);
    return asDevice(back);
  } catch { return null; }
}

/** Pure-JS, where WebCrypto isn't there (a page loaded over plain HTTP on a home network, an older browser). */
function storageKey(): OwnerKey {
  const saved = storedKey();
  const secret = saved?.secret ?? ed25519.utils.randomSecretKey();
  const kid = saved?.kid ?? `owner-${hex(random(6))}`;
  if (!saved) try { localStorage.setItem(STORE, JSON.stringify({ secret: hex(secret), kid })); } catch { /* the key lives for this tab only */ }
  return { jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(ed25519.getPublicKey(secret)), kid, alg: 'EdDSA' }, store: 'storage', sign: async (b) => ed25519.sign(b, secret) };
}

export async function loadKey(): Promise<OwnerKey> {
  return (await deviceKey()) ?? storageKey();
}

/** Signing out on this device: the key goes, wherever it was kept. */
export async function forgetKey() {
  try { localStorage.removeItem(STORE); } catch { /* nothing kept */ }
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
