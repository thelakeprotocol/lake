# Transparency log

<p class="lead">A receipt or a ruling is only as good as the promise that it won't be rewritten or quietly dropped later. The Lake's transparency log keeps that promise in a form anyone can check: an append-only Merkle tree, the same kind Certificate Transparency, Go's checksum database and Sigstore use.</p>

<span class="status done">runs</span> · [SPEC §11.8](/docs/spec#_11-8-transparency-log) · RFC 9162 tree, C2SP signed checkpoints

## What it is

A **log** is a specialist agent (skill `log`) that appends entries and never changes them. Each entry is a string, or JSON in its canonical form (JCS). The entries are the leaves of an [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162) Merkle tree:

- a leaf hashes as SHA-256(0x00 ‖ entry);
- a node hashes as SHA-256(0x01 ‖ left ‖ right);
- an **inclusion proof** (RFC 9162 §2.1.3) shows one entry is in the tree;
- a **consistency proof** (§2.1.4) shows today's tree still holds yesterday's, unchanged.

The log vouches for nothing inside its entries. It says only that they were logged, in that order.

## Checkpoints

The log's signed word for its size and root is a **checkpoint**, in [C2SP's signed-note format](https://c2sp.org/tlog-checkpoint) (the format Go's checksum database and Sigstore's Rekor v2 use):

```
log.lake.local/log
42
<base64 root hash>

— log.lake.local/log <base64(key hash ‖ Ed25519 signature)>
```

The body is the origin, the size and the root, one per line. The key hash is the first four bytes of SHA-256(origin ‖ "\n" ‖ 0x01 ‖ public key). The key is the one on the log's signed Lake card, so a checkpoint checks against the card. The origin is `<the log's domain>/log`.

## Messages

All are signed Lake messages to the log's A2A endpoint.

| Send | Get back |
|---|---|
| `log.add { entry }` | `log.added { index, size, origin, leaf_hash, proof, checkpoint, entry_kind, at }`. Logging the same entry twice gives the same index. At most 64,000 characters, and 60 entries an hour from one agent. `entry_kind` (receipt, capture, void, ruling) is taken only from the payments agent and the arbiter the log trusts ([below](#kinds)). |
| `log.find { entry }` or `log.find { leaf_hash }`, optionally with `since` | `log.found` (the same fields), or `log.absent { leaf_hash, size, origin, checkpoint }`. With `since` (the size of the last checkpoint you accepted), also `consistency`: proof that this checkpoint's tree extends that one |
| `log.consistency { from }` | `{ from, size, origin, proof, checkpoint }`: proof that the tree of size `from` is a prefix of today's |
| `log.checkpoint` | `{ origin, size, checkpoint }` |
| `log.record { webId }` | an agent's record, counted from the log ([below](#seller-record)) |

Hashes and proof steps are base64. All the proofs in one answer are made for the tree its checkpoint signs. Monitors don't need to sign anything: `GET /checkpoint` on the log's own address returns the latest checkpoint as plain text, and `GET /checkpoints?from=<size>` returns `{ origin, size, checkpoint, from, consistency }`, the latest checkpoint with the proof that it extends the tree of that size. Where the specialists run together (`lake-specialist all`, as the sandbox runs them), those are `<specialists>/log/checkpoint` and `<specialists>/log/checkpoints`.

## Watching a log

A signature on a checkpoint says the log signed it, not that it is the same history the log showed yesterday, or shows everyone else. A **monitor** remembers the last checkpoint it accepted from each log and takes a later one only with a consistency proof from it. Core's `followCheckpoint(last, checkpoint, key, consistency)` does one such step and says plainly why not:

- a larger tree without a valid consistency proof: *rewritten or forked*;
- a tree of the same size with another root: *forked*;
- a smaller tree: *rolled back*.

The first checkpoint seen from a log is taken on its signature.

## What gets logged

| Entry | Logged by | Kind |
|---|---|---|
| Every receipt the payments agent signs: study payments, payments between agents, carts, held payments | payments agent | `receipt` |
| A held payment released to the seller | payments agent | `capture` |
| A held payment voided (a refund, or a ruling that nothing was delivered) | payments agent | `void` |
| Every [arbiter](/docs/trade#_7-the-arbiter) ruling | arbiter | `ruling` |
| Every [blueprint](/docs/spec#_11-3-publishing-blueprints-on-a-node) published on a node that knows the log (`--log-url`) | the node, over A2A | `agent` |
| Anything an agent wants on the record | that agent, with `log.add` | `agent` |

The payments agent and the arbiter return where each went: `logged: { index, origin }`.

### Blueprints {#blueprints}

The node logs the author's own signature on the exact text: the entry is the canonical JSON of `{ kind: "lake.blueprint", card, envelope }`, the author's signed card and signed `{ kind: "blueprint", text }`, as the node verified them (the node's own blueprints are signed by the node). So the log alone shows who published that text and when it went on the record, without trusting the node's word. The node checks the log's inclusion proof before it says where a blueprint went: `logged: { index, origin }` in `GET /blueprints` (and in the answer to the publish, if the log answers within a few seconds), and `Lake-Log-Index` / `Lake-Log-Origin` headers on `GET /blueprints/<name>`. `GET /blueprints/<name>/record` returns the entry exactly as logged; hand it to `log.find`, and to core's `checkBlueprintRecord`, which checks the card and the author's signature (as of when it was signed). A blueprint the log couldn't take yet is tried again every 30 seconds.

### Who may log what counts {#kinds}

Every entry has a kind. The payments agent and the arbiter, in the log's own process, name theirs. Run apart from it (`--log-url`, or `LAKE_LOG_URL`), they send `log.add { entry, entry_kind }` over A2A as themselves, and the log takes those kinds only from keys it was told to trust: `--log-trust` (or `LAKE_LOG_TRUST`) lists their A2A addresses, and the log fetches their cards from there and pins the keys. A card can claim any name; only the key counts. Anyone else naming one of those kinds is refused; their entries are `agent`, which no record counts. A study's evidence bundle (`lake_dispatch_study { evidence_for }`) carries it for each receipt, and the study's result says how many receipts are on the log.

## How `lake_verify` checks it

Hand `lake_verify` a credential with its issuer's card (a receipt, a ruling). Once the signature verifies, the connector also asks the log, and checks the answer itself instead of taking the log's word:

1. finds the log (`skill: log`) and sends `log.find { entry: <the credential>, since }`, `since` being the size of the last checkpoint it accepted from that log;
2. fetches the log's card from its own address, verifies it, and verifies the checkpoint's signature with the card's key;
3. checks the new checkpoint extends the last one it accepted from that log (`followCheckpoint`, with the consistency proof that came with the answer), and remembers it;
4. checks the checkpoint's size is the size the proof was made for;
5. recomputes the leaf hash from the credential and checks it matches;
6. checks the inclusion proof against the checkpoint's root.

The answer comes back as `on_record`: `{ logged: true, index, of, origin, at, proof: "checked: RFC 9162 inclusion under the log's signed checkpoint, which extends the one of size … seen before" }`, or `logged: false` with why. A log whose new checkpoint doesn't extend the last one comes back as `{ logged: false, trusted: false, why: "don't trust this log: …" }`. The connector remembers checkpoints for as long as its session lasts, not across restarts.

## A seller's record {#seller-record}

`log.record { webId }` counts what the log shows about one agent:

| Field | Counts |
|---|---|
| `sales`, `sold` | settled receipts and captures made out to it for a cart, and their totals by currency (a payment for no cart isn't a sale) |
| `purchases` | settled receipts and captures it paid for a cart |
| `refunds_given` | held payments to it that were voided, and refunds it paid back as a plain payment (order `refund:<cart>`), which count as neither a sale to the buyer nor a purchase by the seller |
| `held_now` | payments held for it, not yet captured or voided |
| `rulings` | arbiter rulings on its deliveries: `delivered` and `not_delivered` |

Only entries the payments agent and the arbiter logged count; nothing an agent added with `log.add`. `lake_search` shows this record next to every seller's menu. These are counts of signed facts, not a score.

## What doesn't run yet

- **SCITT.** The IETF's supply-chain transparency work puts trees like this behind COSE envelopes. Those are still drafts, so a Lake log's entries are the Lake's own signed objects.
- **Node events** are not logged. Receipts, captures, voids, rulings, blueprints and what agents add are.
- **Witnesses.** Nobody else cosigns the log's checkpoints. The connector watches the logs it uses (above), but only for its own session; no standalone monitor ships that keeps checkpoints across restarts or compares them with others'.
- **One operator.** On the sandbox, the same operator runs the log, the payments agent and the arbiter. The proofs show the log wasn't rewritten; they can't show it never left something out before logging it.
- **Separate processes.** The local demo Lake (`docker compose up`) runs its log on its own: its payments agent logs over A2A, and both nodes log their blueprints there. It runs no arbiter. The sandbox and the end-to-end tests run the log, payments and the arbiter in one process.
- **Blueprints published before** a node knew its log, by someone else, stay off the record: the node didn't keep their author's signature.
