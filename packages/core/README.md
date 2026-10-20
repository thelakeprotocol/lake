# @thelakeprotocol/core

**Status: runs, tested.**

Shared building blocks every Lake component uses:

| Module | Does |
|---|---|
| `card.ts` | Builds Lake Agent Cards (A2A 1.0 + the Lake extension), signs and verifies them with the official `@a2a-js/sdk` signer |
| `crypto.ts` | Ed25519 identities; signed message envelopes with nonce, expiry and replay protection |
| `rules.ts` | Parses `rules.yaml` (fails closed on typos) and decides offers: join, decline, ask or counter; collective counter-offers |
| `offer.ts` | The offer shape and its W3C ODRL 2.2 serialisation |
| `events.ts` | Event kinds and plain-English descriptions for the map |

```bash
pnpm test
```
