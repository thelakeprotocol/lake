import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fetchBeacon, HttpChainClient, roundAt, roundTime, type Chain, type ChainClient, type ChainInfo, type ChainOptions, type RandomnessBeacon } from 'drand-client';

/**
 * Fair draws (SPEC §11.7) from drand, the League of Entropy's public randomness: a threshold of independent operators
 * sign each round together, every 3 seconds, and nobody can know or steer a round before it is published. Parties who
 * need a draw agree, in signed messages dated before it, on a future round and a label; then anyone works out the same
 * result from that round, and anyone can check the round against the chain's public key, pinned here.
 *
 * Replaces commit-and-reveal between the players themselves, where whoever reveals last could walk away from a loss.
 */

/** drand's quicknet chain (unchained BLS on G1, RFC 9380), pinned: a beacon from anywhere else doesn't verify. */
export const QUICKNET: ChainInfo = {
  public_key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
};
/** Public HTTP relays of the same chain: any one will do, since every beacon is checked against the pinned key. */
export const DRAND_RELAYS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'];

/** A round of randomness, as parties hand it to each other: enough for anyone to check it offline. */
export interface Beacon { chain: string; round: number; randomness: string; signature: string }

const verifying: ChainOptions = { disableBeaconVerification: false, noCache: false, chainVerificationParams: { chainHash: QUICKNET.hash, publicKey: QUICKNET.public_key } };
// The chain's info is pinned, never fetched: a relay can't swap in another chain's key.
const pinned = (baseUrl: string): Chain => ({ baseUrl, info: async () => QUICKNET });

/** When a round is published (ms since 1970). */
export const roundTimeMs = (round: number) => roundTime(QUICKNET, round);
/** The first round published at least `ms` from now: what to propose, so the agreement can be signed before it exists. */
export const roundAfter = (ms: number, now = Date.now()) => roundAt(now + ms, QUICKNET) + 1;

/** A round, fetched from the first relay that answers and checked against the pinned key. */
export async function getBeacon(round: number, relays = DRAND_RELAYS): Promise<Beacon> {
  if (!Number.isInteger(round) || round < 1) throw new Error('round: a positive whole number');
  const at = roundTimeMs(round);
  if (at > Date.now()) throw new Error(`round ${round} isn't out yet: it comes at ${new Date(at).toISOString()}`);
  const problems: string[] = [];
  for (const relay of relays) {
    try {
      const b = await fetchBeacon(new HttpChainClient(pinned(`${relay.replace(/\/+$/, '')}/${QUICKNET.hash}`), verifying), round);
      return { chain: QUICKNET.hash, round: b.round, randomness: b.randomness, signature: b.signature };
    } catch (e) {
      problems.push(`${relay}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no drand relay gave a valid round ${round}: ${problems.join('; ')}`);
}

/** Checks a beacon someone handed over, offline: right chain, signed by its threshold key, randomness from the signature. */
export async function verifyBeacon(b: Beacon): Promise<boolean> {
  if (!b || b.chain !== QUICKNET.hash || !Number.isInteger(b.round)) return false;
  const given: ChainClient = { options: verifying, chain: () => pinned(''), latest: async () => given.get(b.round), get: async () => ({ round: b.round, randomness: b.randomness, signature: b.signature }) as RandomnessBeacon };
  const quiet = console.error;
  try {
    // The client logs why a beacon fails; a forged one is an answer here, not an error.
    console.error = () => {};
    await fetchBeacon(given, b.round);
    return true;
  } catch {
    return false;
  } finally {
    console.error = quiet;
  }
}

/**
 * A fair pick of one of `n`, from a round's randomness and a label the parties agreed (so one round can serve many
 * draws). Uniform: SHA-256 over randomness, label and a counter, with values past the last whole multiple of n thrown
 * away and drawn again.
 */
export function pick(randomness: string, label: string, n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error('pick among at least one');
  const space = 1n << 256n;
  const limit = space - (space % BigInt(n));
  for (let i = 0; ; i++) {
    const h = BigInt(`0x${createHash('sha256').update(`${randomness}|${label}|${i}`).digest('hex')}`);
    if (h < limit) return Number(h % BigInt(n));
  }
}

/**
 * A fair order of all the options (who picks first, second, third): drawn without replacement, the first place by
 * `pick` with the label itself (so it is the same as a single draw's result) and place k by `pick` over those left with
 * the label `<label>|order|k` (run 69: a draw named one cousin, and the other two places were made up in the room).
 */
export function order<T>(randomness: string, label: string, options: readonly T[]): T[] {
  const left = [...options];
  const out: T[] = [];
  for (let k = 0; left.length; k++) out.push(left.splice(pick(randomness, k ? `${label}|order|${k}` : label, left.length), 1)[0]!);
  return out;
}

/**
 * Timelock seals (drand's tlock, the same quicknet chain): a value encrypted to a future round, which nobody can open
 * before that round is published, and anyone can open after. For sealed bids and hidden moves with no reveal step, so
 * nobody can withhold a reveal once they've seen the others' (run 21's agents asked for it).
 */
const tlock = createRequire(import.meta.url)('tlock-js') as typeof import('tlock-js');
type TlockClient = Parameters<typeof tlock.timelockDecrypt>[1];
// The chain's info is pinned here too (so sealing needs no network); opening fetches the round, checked against its key.
const tlockClient = () => new tlock.HttpChainClient(pinned(`${DRAND_RELAYS[0]}/${QUICKNET.hash}`) as never, { ...verifying });
// A client holding one round already fetched (getBeacon tries every relay) or handed over: opening then needs no network.
const givenClient = (b: Beacon) => ({ options: verifying, chain: () => pinned(''), latest: async () => b, get: async () => b }) as unknown as TlockClient;

/** Seals text until a round: an age-armored ciphertext anyone can open once that round is out. */
export async function sealUntil(round: number, text: string): Promise<string> {
  if (roundTimeMs(round) <= Date.now()) throw new Error(`round ${round} is already out: seal to one still to come`);
  return tlock.timelockEncrypt(round, tlock.Buffer.from(text), tlockClient());
}

/** The round a seal opens at, read from its header; undefined if it isn't sealed to this chain. */
export function sealedRound(ciphertext: string): number | undefined {
  const body = String(ciphertext).replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const m = /^age-encryption\.org\/v1\n-> tlock (\d+) ([0-9a-f]{64})\n/.exec(Buffer.from(body, 'base64').toString('latin1'));
  return m && m[2] === QUICKNET.hash ? Number(m[1]) : undefined;
}

/**
 * Opens a timelock seal once its round is out; throws, saying when, before. Given the round's beacon, it opens offline: a
 * beacon that isn't the real round doesn't verify against the pinned key, and the seal stays shut.
 */
export async function openSeal(ciphertext: string, beacon?: Beacon): Promise<string> {
  const [log, error] = [console.log, console.error];
  try {
    // The library announces every beacon it fetches, and logs why a forged one fails: neither is news here.
    console.log = console.error = () => {};
    return (await tlock.timelockDecrypt(ciphertext, beacon ? givenClient(beacon) : tlockClient())).toString();
  } finally {
    [console.log, console.error] = [log, error];
  }
}
