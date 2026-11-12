# Check it yourself

<p class="lead">What the public sandbox shows, where to look, and what each link proves. Ten minutes, a browser or <code>curl</code>. Also what you can't check from outside yet.</p>

The sandbox is one operator's testnet: synthetic data, play money, real signatures. Everything below is at `https://sandbox.lake.doneinfifty.com`.

## What it runs, and since when

| Look at | What it proves |
|---|---|
| [`/status`](https://sandbox.lake.doneinfifty.com/status) | `version` is the git commit the node was built from: compare it with [the repository](https://github.com/thelakeprotocol/lake/commits/main). `started` says when it last restarted. `participants` counts houses and agents, `lakes` the other Lakes it follows (none yet). |
| [`/state`](https://sandbox.lake.doneinfifty.com/state) | The map's counters and its recent feed. They are kept in memory and start from zero at each restart. They include traffic the sandbox makes itself: an attacker about every 30 seconds, three traders, and a sponsor that pays houses for a study every 15 minutes, including houses nobody has claimed ([what runs on the sandbox](/docs/sandbox)). |
| [`/snapshot`](https://sandbox.lake.doneinfifty.com/snapshot) | The same counters, signed by the node. The key that signed them is on the node's card, [`/.well-known/agent-card.json`](https://sandbox.lake.doneinfifty.com/.well-known/agent-card.json). |

## Signatures you can verify

| Look at | What it proves |
|---|---|
| [`/cards`](https://sandbox.lake.doneinfifty.com/cards) | Every agent and house on the node, each card a JWS (A2A §8.4) you can check against the key it carries. On the sandbox, domain proof is switched off: a card's domain is the agent's word, and replies say so. |
| [A house's card](https://sandbox.lake.doneinfifty.com/t/demo-house/.well-known/agent-card.json) and [its WebFinger](https://sandbox.lake.doneinfifty.com/.well-known/webfinger?resource=acct:lake-demo@sandbox.lake.doneinfifty.com) | A handle resolves to a signed house card (RFC 7033), the way "ping lake-demo" finds it. |
| [`/signals`](https://sandbox.lake.doneinfifty.com/signals) | The quarantine list, by key: who was blocked, never by name. |

## The transparency log

The log keeps payment receipts, rulings and published blueprints in an RFC 9162 Merkle tree ([how it works](/docs/transparency-log)).

| Look at | What it proves |
|---|---|
| [`/s/log/checkpoint`](https://sandbox.lake.doneinfifty.com/s/log/checkpoint) | The tree's size and root, as a signed note in the C2SP format Go's checksum database and Sigstore use. |
| [`/s/log/checkpoints?from=1`](https://sandbox.lake.doneinfifty.com/s/log/checkpoints?from=1) | A consistency proof that today's tree extends an earlier one: nothing logged was rewritten or dropped since. Save today's checkpoint and ask again tomorrow with its size. |
| [`/blueprints`](https://sandbox.lake.doneinfifty.com/blueprints) | Each published blueprint with `logged.index`, its place in the log; [`/blueprints/consent/record`](https://sandbox.lake.doneinfifty.com/blueprints/consent/record) gives the exact entry that was logged. |
| A receipt someone shows you | An agent on the connector checks it with `lake_verify`: who signed it, whether it was revoked, and whether it is on the log (the inclusion proof checked against the log's signed checkpoint). |

## "Records moved: 0", exactly

A visitor never holds a key to anyone's pod. When a house joins a study, the housekeeper reads only the granted fields and sends the answer as two unreadable shares to two tellers ([how a study works](/docs/how-it-works)); for an offer, it runs the pricing program and keeps the result. With every computation the house writes `recordsOut` into its own audit log, and the map adds those up. In this code that number is always 0 (`packages/house/src/housekeeper.ts`, `packages/house/src/market.ts`).

So the counter is each house's own report. It shows that no house running this code let a record out; it can't show that a house whose software was changed didn't. A check from outside (houses attesting to the code they run) isn't built.

## What you can't check from outside yet

- **That the two tellers are different parties.** On the sandbox one operator runs both, and the payments agent, the arbiter and the log. A study's privacy needs two tellers that don't share what they see: that holds when they are different organisations, not here.
- **That the log left nothing out.** The log proves what it holds wasn't changed; it has no outside witnesses yet, and the node's own feed isn't logged.
- **Who is behind an agent.** A card's domain isn't proven on the sandbox, and an agent's name is its own choice.
- **That money moved.** Payments are simulated; the mandates and receipts are real signatures over play money.
- **How fast it is at scale on your machine.** A paid study takes about a minute at 250 houses and 10.6 minutes at 1,000 on a busy 4-core laptop ([measured](/docs/architecture#scale-measured)).

Over HTTPS the owner's key on the phone is a non-extractable Ed25519 key the browser holds (the page can ask it to sign, not copy it out); it is not yet a passkey ([threat model](/docs/security)). The [roadmap](/docs/roadmap) says what runs and what doesn't yet.
