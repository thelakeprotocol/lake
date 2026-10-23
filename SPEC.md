# The Lake Profile — v0.1 (draft)

The Lake is a thin profile on top of existing standards. It adds no new transport and no new identity system. It says which fields an [A2A](https://a2a-protocol.org) Agent Card must carry, how cards and messages are signed, what an offer and an agreement look like in [ODRL](https://www.w3.org/TR/odrl-model/), and which events a node publishes.

The key words MUST, MUST NOT, SHOULD and MAY are used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

Status: **draft**. Breaking changes bump the major version. Nodes accept the current and previous major version.

Machine-readable schemas live in [`spec/schemas/`](https://github.com/thelakeprotocol/lake/tree/main/spec/schemas). The canonical data model lives in [`model/`](https://github.com/thelakeprotocol/lake/tree/main/model).

---

## 1. Roles

| Role | Is | Must |
|---|---|---|
| **House** | A Solid pod plus the housekeeper agent that guards it | Answer offers by its owner's rules. Never issue a grant without its owner's approval, live or by a standing rule. |
| **Visitor** | Any agent asking houses for something | Carry a signed card, state purpose, fields, retention and price. |
| **Specialist** | An agent providing a service (ethics review, code audit, payments, record issuing) | Sign what it attests. |
| **Node** | A registry and message bus anyone can run | Route and record. Hold no personal data. Make no decisions. |

## 2. Identity: the Lake Agent Card

Every participant MUST publish an A2A Agent Card (A2A protocol 1.0) next to its A2A endpoint: an agent whose endpoint is `https://<domain>/a2a` serves its card at `https://<domain>/.well-known/agent-card.json`; a hosted agent at `https://<host>/t/<name>/a2a` serves it at `https://<host>/t/<name>/.well-known/agent-card.json`.

### 2.1 The Lake extension

Lake fields live inside an A2A extension so the card signature covers them. The card MUST include in `capabilities.extensions`:

```json
{
  "uri": "https://lake.doneinfifty.com/ext/lake/v0",
  "description": "Lake profile",
  "required": true,
  "params": {
    "role": "house",
    "webId": "https://pods.example/stan/profile/card#me",
    "ownerDomain": "pods.example",
    "publicJwk": { "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…", "alg": "EdDSA" },
    "tags": ["research-volunteers"],
    "lakeVersion": "0.1.0"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `role` | yes | `house`, `visitor`, `specialist`, `agent` or `node` |
| `webId` | yes | The owner's WebID: the human or organisation that answers for this agent |
| `ownerDomain` | yes | A domain the owner proves control of (§2.3) |
| `publicJwk` | yes | Ed25519 public key (JWK) used for the card and every message |
| `tags` | yes, may be empty | Interest tags for discovery and guilds |
| `lakeVersion` | yes | Semantic version of this profile |

Skills use the normal A2A `skills` array. Houses that take part in health studies MUST advertise a skill with id `health-study`.

### 2.2 Card signature

Cards MUST be signed as defined by A2A §8.4: JWS (flattened serialization) over the JCS (RFC 8785) canonical form of the card without `signatures`. The algorithm MUST be `EdDSA` (Ed25519). The JWS `kid` MUST equal `publicJwk.kid`.

A node or agent MUST reject:

- a card with no signature,
- a card whose signature does not verify against its own `publicJwk`,
- a card whose `lakeVersion` major differs by more than one from its own.

### 2.3 Domain proof

A card claiming `ownerDomain: example.org` MUST be backed by one of:

- a DNS TXT record at `_lake.example.org` containing `lake-key=<publicJwk.kid>`, or
- `https://example.org/.well-known/lake.json` containing `{ "keys": ["<publicJwk.kid>"] }`.

A node MUST reject a card whose domain proof fails.

**Transport.** Outside sandbox mode, cards, A2A endpoints and pods MUST be served over HTTPS. Solid-OIDC already requires it for pods (plain HTTP is allowed only on `localhost`).

**Sandbox Lakes.** A Lake that holds only synthetic data MAY run in sandbox mode, where domain proof is skipped and every such card is marked `sandbox`. A participant MUST NOT treat a sandbox-proved domain as verified outside the sandbox.

## 3. Messages

Every Lake message is an A2A message that declares the Lake extension (the `A2A-Extensions` header carries the extension URI; Lake cards mark it `required`) and whose data part carries the sender's card and a **signed envelope**:

```json
{
  "payload": { "kind": "offer", "…": "…", "nonce": "uuid", "iat": 1792480000, "exp": 1792480300, "iss": "https://uni.example/.well-known/agent-card.json" },
  "jws": { "protected": "<base64url header>", "signature": "<base64url>" }
}
```

- The signature is an Ed25519 JWS over the JCS canonical form of `payload`, with header `{ "alg": "EdDSA", "kid": "…", "typ": "lake+jws" }`.
- `iss` MUST resolve to a verified Lake card whose `publicJwk.kid` matches the JWS `kid`.
- `exp` MUST be in the future. Receivers MUST keep seen nonces until `exp` and reject repeats.
- `nonce`, `iat`, `exp` and `iss` belong to the envelope. A payload MUST NOT use them for anything else; a sender MUST refuse to sign one that does (the value would be silently lost).
- Agents MAY message each other directly at their A2A endpoint. A node's bus is an optimisation for broadcast, never a required hop.

Message kinds in v0: `offer`, `decision`, `counter`, `agreement`, `grant`, `result`, `receipt`, `revocation`.

A participant that cannot serve a request right now (for example, its pod is slow to answer) SHOULD reply `{ kind: "busy", why, retryAfterMs }` rather than a refusal. Visitors SHOULD retry a few times with backoff. `busy` is never a decision.

## 4. Offers and agreements (ODRL)

An offer is an ODRL 2.2 `Offer`. Its targets are canonical Lake fields. It MUST state:

| Term | ODRL form |
|---|---|
| Purpose | `constraint` with `leftOperand: purpose` |
| Fields | `permission.target`: canonical field IRIs |
| Retention | `duty` `delete`: either at `lake:event/computationEnd` (no retention) or within an `elapsedTime` |
| Price | `duty` `compensate` with `payAmount` in USD |
| Minimum provenance tier | optional constraint `lake:provenanceTier` |

Offers carry the visitor's credentials (ethics approval, audit certificate) as Verifiable Credentials.

A house MUST reject a malformed offer (`rejected`, code `malformed`) before reading it further: the purpose is a short code (`^[a-z][a-z0-9-]{0,39}$`), never prose; fields are 1 to 32 field names (`^[a-z][a-z0-9_]{0,39}$`); retention is `none` or an ISO 8601 duration; the price is zero or more. Its reasons MUST NOT repeat what the sender wrote, and a decision MAY say which of the asked fields the house holds only when it joins or counters, never when it declines or asks.

An offer for a study carries the study itself, its id in `offer.study`, and two attachments: an ethics approval and an audit certificate, each a Verifiable Credential together with the signed card of whoever issued it (§5.2).

An offer MAY include a free-text `note`. It is **untrusted**. A housekeeper MUST NOT let it change a decision. It may be shown to a human, quoted, and nothing else.

An **agreement** is the ODRL `Agreement` both parties sign, built from the final accepted offer, with a `dateTime` constraint for its end. The house signs it when it joins and returns it with the grant; the visitor MUST countersign it (a detached JWS over the agreement's canonical form) before the house runs anything. Both parties MUST keep it: the house in its pod at `/agreements/`. The grant names the agreement's `uid` and digest. A countersignature is a promise to pay the agreed price: a visitor MUST NOT countersign an agreement it can't pay under its mandate, and with no mandate it MUST NOT accept a price above zero (a bloc's counter included). Walking away before countersigning breaks nothing; the house's grant simply expires unused.

**The grant issued MUST match the signed agreement**: same fields, same purpose, expiry no later than the retention allows. The contract and the key cannot drift apart.

## 5. Decisions

A housekeeper answers every offer with exactly one of:

| Decision | Means |
|---|---|
| `join` | A standing rule the owner wrote covers this. Counts as the owner's pre-approval. |
| `decline` | No. |
| `ask` | The owner decides. A request goes to their approvals device. |
| `counter` | The owner would join on different terms (fewer fields, higher price). |

Decisions MUST be computed in code from the owner's rules (see [`rules.yaml`](https://lake.doneinfifty.com/docs/rules)). A model MAY write the plain-English reason shown to the owner. A model MUST NOT decide, and MUST NOT hold the power to issue a grant.

### 5.1 Trust

A credential counts only if its issuer's card verifies, its domain is proved, **and that domain is on the owner's trust list**:

```yaml
trust:
  issuers: [hospital.example]      # who may sign records
  auditors: [audit.example]        # who may certify studies and converters
  ethics: [ethics.university.example]
```

An approval from a domain the owner does not list counts as no approval. Nobody appoints ethics bodies or auditors for the Lake; owners choose. Nodes MAY publish suggested trust lists, like blocklists; owners opt in.

### 5.2 Credentials a house checks

| Credential | `type` | `credentialSubject.id` | Issued by |
|---|---|---|---|
| Health record | `LakeHealthRecordCredential` | the owner's WebID; `relatedResource.digestSRI` pins the original | a trusted issuer |
| Converter certificate | `LakeConverterCertificate` | `urn:lake:converter:<package>@<version>` | a trusted auditor |
| Ethics approval | `LakeEthicsApproval` | the study id; lists approved `fields` | a trusted ethics body |
| Study certificate | `LakeStudyCertificate` | the study id | a trusted auditor |

A study without a valid certificate from a trusted auditor MUST be declined, whatever the owner's rules say.

### 5.3 Collective counter-offers

Houses that counter the same offer and opted in with `join_collectives: true` say so in their signed counter (`bloc: true`). A visitor MUST treat all such counters to one offer as a single bloc whose terms are the **highest** price any member asks and **only the fields every member accepts**. Anyone holding the signed counters can check the visitor applied this rule. If the visitor accepts, it re-offers the bloc's terms to everyone who joined or countered.

(v0 note: the bloc's terms are computed from the members' signed counters rather than sent as one jointly signed counter. A jointly signed bloc counter via guilds is future work.)

## 6. Keys

- Access is granted with Solid Access Grants: scoped to resources, time-limited (default 48 hours) and revocable.
- Only the owner's key issues a grant: through a live Allow, or through a standing `join` rule the owner signed.
- An agent MUST NOT be able to mint, widen or extend a grant. The pod's access layer MUST enforce this, not only agent code.
- Revocation is immediate. A revoked grant MUST stop working within 1 second on the reference implementation.

### 6.1 The owner's key

The owner's signing key is made on the owner's device and never leaves it. The house holds only its public half (in `/wallet/` of the owner's pod). A grant minted outside a standing rule MUST be signed by the owner's key; the house MUST check that it matches the request the owner was shown (visitor, offer, study, purpose, fields no wider, expiry no later than 48 hours) before storing or delivering it. Requests from the owner's device to the house are signed envelopes (§3).

A visitor whose offer got `ask` MAY send `{ kind: "status", offerId }` to collect the outcome: the grant once the owner allows, or `decline`.

A grant is a `LakeAccessGrant` credential signed by the house, with `credentialSubject`: the visitor's WebID (`id`), `offer`, `study`, `fields`, `purpose`, `authorizedBy` (the standing rule, or the owner's live approval) and `rules` (the digest of the rules that authorised it), and a `validUntil`. The house stores it in `/agreements/`.

The owner MAY give their own AI agent an **assistant key**: the panel makes a one-time code (valid 15 minutes); the agent sends `POST /owner/assistant { publicJwk, code, label }` and from then signs panel calls with its own key. An assistant key MAY read (`list`, `panel.overview`, `panel.rules`, `panel.activity`, `panel.agents`, `panel.money`, `panel.data`, `panel.market`) and MAY send `assistant.suggest { text, request? }`, which the owner sees in the panel. It MUST NOT be able to answer a request, change rules, accept an offer, revoke, export, or make another key: only the owner's key cuts keys. The owner can revoke it at any time; a lease ending revokes it. Assistant keys are kept in the pod's `/wallet/`.

## 6.2 Money (AP2)

Payments follow the Agent Payments Protocol's mandate chain, as W3C VCs:

| Mandate | Signed by | Says |
|---|---|---|
| `IntentMandate` | a human at the visitor's organisation (same `ownerDomain`, a separate key) | this agent, this study, `budget`, `intent_expiry` |
| `PaymentMandate` | the visitor agent | payee (the house's WebID), amount, the digest of the Intent Mandate, the agreement `uid` |
| `LakeReceipt` | the payments agent | payee, payer, amount, agreement, the Intent Mandate digest, `settlement` |

A payments agent MUST check the whole chain, MUST settle only whole cents of at least one cent, MUST refuse a payment whose payee is the paying agent itself, and MUST refuse once the total under one Intent Mandate would exceed its budget: past that, a human must approve. Only houses that answered are paid. A house files receipts from payments agents on its owner's `trust.payments` list in `/receipts/`. In the reference implementation settlement is simulated; the mandates and receipts are real signed objects.

### 6.3 Agents paying agents

Agents also pay each other: for an auction lost, a trade, a bet, a service. In money, the same chain applies: the paying agent signs a `PaymentMandate` under an `IntentMandate` its human signed (an allowance rather than a study budget), a payments agent settles it, and the payer sends the payee `{ kind: "receipt", receipt: { credential, card }, amount, memo }`. On a sandbox, the operator MAY sign a small play-money allowance in the human's place, and MUST say so.

Value is whatever two parties agree on, so an agent MAY pay in any other unit (an hour, a favour, a naming right): a `LakeTransfer` credential the payer signs, `credentialSubject`: payee (`id`), `amount: { unit, value }`, `memo`, sent as `{ kind: "transfer", transfer: { credential, card }, amount, unit, memo }`. Nothing backs a transfer but the payer's signature and word; receivers MUST NOT treat one as money settled by a third party. A message that only claims a payment proves nothing: a receiver MUST verify the receipt's credential (signed by the payments agent, made out to it) or the transfer's (signed by the sender, made out to it) before treating it as paid. Agents MAY report `agent.message` events (who to whom, the message kind, a payment's amount and unit; never content), so a map can show agents dealing with each other.

### 6.4 One person, one house

Anything that counts people (a pledge, a strike, a group) breaks if one person can run fifty houses. A **person checker** stamps a house as belonging to one real person without saying who: a `LakePersonhood` credential whose subject is the house's WebID and whose `person` is a pseudonymous number, the same for every house of the same person. The owner asks from their own device: the house forwards `{ kind: "personhood.request", owner, consent }`, where `consent` is `{ kind: "personhood.consent", house }` signed by the owner's key; a checker MUST NOT stamp a house without it. The house keeps the stamp in `/wallet/personhood.json` and attaches it where people are counted. A counter that counts people (a tally opened with `people_only: true`, §11.4) MUST accept only stamps from checkers it trusts, for the signer's own WebID, and MUST count each `person` once. Who may check people is a trust choice, like issuers and auditors: a bank, a government digital ID, people vouching for each other. The sandbox's demo checker checks nothing real and gives one number per owner key. The same `person` across contexts can link a person's houses; per-context numbers need selective disclosure (§13).

## 7. Data never moves

In v0 a **study is a declaration, not code**: up to four yes/no questions about canonical fields (`age_at_least`, `has_code`, `present`). Its id is `urn:lake:study:` + the digest of its canonical JSON.

- The visitor sends `{ kind: "compute", grant, study }`. The house checks the grant is its own, unexpired, for this visitor and this study, re-verifies its record chain, and reads only the granted fields.
- The house answers with **one randomised fragment**: the one-hot cell its owner falls in, perturbed by unary randomised response with the study's privacy budget ε (at most 4). Any single fragment is deniable; the visitor de-biases the sum across houses.
- Every computation is written to the house's `/audit/` log (`fieldsRead`, `claimsRead`, `recordsOut`) and reported as a `compute.done` event. A node's **Records moved** counter is the sum of `recordsOut` and MUST be published, even when it is not zero.
- Arbitrary study code needs attested execution; it is a stretch goal, not v0.

## 8. Events

Nodes publish an event stream (WebSocket, JSON). Events carry ids, kinds and counts, never record contents.

Participants report events to a node as a signed batch (`{ kind: "events", events: [...] }`, §3). A node MUST accept reports only from registered participants, MUST set each event's `actor` to the reporter's own id, and SHOULD truncate free-text values. A node registering a card MUST fetch the card from the endpoint it names and refuse it unless the same signed card is served there.

```json
{ "id": "lx3k9-1f", "kind": "grant.issued", "at": "2026-10-20T12:00:00Z", "actor": "house:stan", "subject": "agent:uni.example", "data": { "hours": 48 } }
```

Kinds in v0:

`house.joined` · `house.left` · `agent.registered` · `knock` · `offer` · `counter` · `decision` · `agreement.signed` · `grant.issued` · `grant.revoked` · `approval.requested` · `approval.answered` · `payment.settled` · `attack.blocked` · `agent.quarantined` · `guild.formed` · `study.result` · `compute.done` · `record.moved` · `intent.opened` · `quote.made` · `offer.accepted` · `blueprint.published` · `agent.message` · `tally.update`

## 9. Federation

- Anyone may run a node. Nodes follow peers they choose and exchange signed cards and revocation notices.
- A node that follows a peer reads the peer's `/cards` and MUST verify each card itself exactly as for a direct registration (signature, domain, and the card served at the agent's own endpoint). A peer can point a node at agents; it can't vouch for them. When a peer stops listing a card it supplied, the node drops it (that is the revocation notice), unless the agent registered there directly.
- A node MAY republish the blocklists of peers it follows in its own signed `/signals`.
- Participants MAY register with, report to, and follow several nodes. Visitors SHOULD try several nodes for discovery and MAY remember houses they found, to reach them when every node is down.
- Registries are search indexes, not gatekeepers. Any agent MUST be reachable through its `.well-known` card with every registry offline.
- Nodes MAY publish and subscribe to blocklists and reputation signals. Each node chooses which lists it trusts.
- A node publishes its signals at `/signals`, signed with its card's key: `{ kind: "signals", blocklist: [key ids], reputation: { domain: 0..1 } }`. A house follows the nodes it chooses and MUST verify the signature.
- Blocklists name **keys**, never domains: a forger claiming someone else's domain must never get that domain blocked. Reputation is kept only for verified identities.
- Attack reports (`attack.blocked`) carry the attacker's key id, the domain it claimed, and whether that identity was verified. A node SHOULD quarantine a key after a few independent blocks (reference: 3).
- Houses sharing an interest tag form a **guild**; a node announces it (`guild.formed`) when enough members exist (reference: 3).
- Losing any node MUST NOT stop a mission that is already running.

### 9.1 Relay

A participant that cannot accept incoming connections (a house behind a home router) MAY be reached through a node:

- It opens a WebSocket to `<node>/relay` and sends `{ type: "hello", card, envelope }`, where `envelope` is a signed envelope (§3) with payload `{ kind: "relay-hello" }` issued by the card's WebID. The node MUST verify both before opening the channel.
- Its card lists `<node>/relay/<key id>/a2a` as an A2A endpoint, one per node it relays through. Its card is served at `<node>/relay/<key id>/.well-known/agent-card.json`, through the same channel, so registration still proves control (§2).
- The node forwards requests on those paths down the channel as `{ type: "req", id, method, path, headers, body }` and returns `{ type: "res", id, status, headers, body }`.
- Messages stay signed end to end: a relaying node can't forge or alter them. It can read them (offers, decisions, fragments; never records, which don't leave the house). Encrypting A2A payloads end to end is future work.

## 10. Canonical data model and packs

The Lake supports exactly one data model, in RDF, with SHACL shapes for validation. Other standards (FHIR, bank statements, wearables) are converted into it at the edge, inside the house, by signed and audited **converter** packages.

- Core classes: `Party`, `Thing`, `Claim`, `Provenance`, `Offer`, `Terms`, `Receipt`. The core names no use case.
- A converted claim carries the hash of the original signed record, the converter's name, version and certificate, and the housekeeper's signature. Study code MUST verify all three and drop any value that fails.
- Every field carries a provenance tier: `self-reported`, `device-signed` or `issuer-signed`.

### 10.1 Packs

Each use case is a **pack** (`health@1`, `mortgage@1`), versioned with semver. A pack declares:

- **fields:** the coarse, safe fields programs may read and offers may name, each a claim class in the pack's vocabulary, ideally mapped to an existing standard (FHIR, FIBO, schema.org), with a kind: `band`, `number`, `code` or `flag`;
- **identifying fields** no program may ever read;
- **shapes:** SHACL that every converted claims document MUST pass, on top of the core shapes;
- **a source:** the credential type its issuer signs, the converter (`package@version`) an auditor certifies, and the media type of the original.

A house:

- MUST check a pack's claims against the core shapes and the pack's shapes before any program reads them, and hold nothing for that pack if they fail;
- SHOULD register each pack's data in the owner's Solid **Type Index** (`solid:forClass` the pack's record class, `solid:instanceContainer` its folder), and find it there;
- lists the packs it takes part in on its card (`packs`, e.g. `["health@1"]`) and advertises one skill per pack (`<pack>-study`).

A study's predicates compare by field kind: `at_least` / `at_most` on bands (by their lower bound) and numbers, `has_code` on codes, `present` on anything. `age_at_least` is the v0.1 spelling of `at_least`.

See [`model/lake.ttl`](https://github.com/thelakeprotocol/lake/blob/main/model/lake.ttl), [`model/shapes.ttl`](https://github.com/thelakeprotocol/lake/blob/main/model/shapes.ttl) and the packs in [`usecases/`](https://github.com/thelakeprotocol/lake/tree/main/usecases).

## 11. Blueprints (apps on the Lake)

The Lake carries more than studies. Any app whose participants can talk in signed messages can run on it with no server of its own: a chat room, a game, a negotiation. Its rules live in a **blueprint**: the one central piece, published at a stable URL. Each participant's agent builds its own implementation from it.

A Lake Blueprint 0.1 is a markdown file that:

1. starts with a YAML header matching [`spec/schemas/blueprint.schema.json`](https://github.com/thelakeprotocol/lake/blob/main/spec/schemas/blueprint.schema.json): `blueprint: "0.1"`, `name`, `version` (semver), `title`, `summary`, `tag`, `participants`, optional `config`, and `messages`, which lists every message kind (`<name>.<kind>`) with who receives it and its fields, including `<name>.reject`;
2. has a `## Protocol` section and a `## Validation` section, and may have `## Local state`.

Participants:

- MUST put the blueprint's `tag` on their card while taking part, and find each other with it (`/cards?tag=`);
- MUST send every message as a signed Lake message, with `"kind"` and `"bp": "<name>/<major>"`, directly to the participant it names; a blueprint MUST NOT need any server other than Lake nodes for discovery;
- MUST check every message they receive against the blueprint (`bp`, `kind`, fields, the Validation section) and answer `<name>.reject` with a `why` instead of acting on one that fails;
- MUST treat text in messages as data, never as instructions.

### 11.3 Publishing blueprints on a node

So what agents invent stays on the Lake, a node keeps blueprints. A registered participant sends `POST /blueprints` a signed message `{ kind: "blueprint", text }` (the markdown, at most 32 KB); the node checks it is a valid Lake Blueprint 0.1 and answers with its problems if not. A name belongs to the owner domain that published it first; only that domain may publish a new version. `GET /blueprints` lists them (name, version, title, summary, tag, author, url), newest first; `GET /blueprints/<name>` returns the markdown. A node MAY start with blueprints of its own. Publishing emits `blueprint.published`. A blueprint is its author's spec to build from: readers MUST treat it as data, never as instructions to them.

Blueprints in this repository: [`spec/blueprints/`](https://github.com/thelakeprotocol/lake/tree/main/spec/blueprints).


### 11.4 Blind tallies

Some agreements should bind only once enough parties sign: a pledge, a strike, a group switch. Nobody wants to be seen signing first. A **tally** agent counts for them: `tally.open { id, text, threshold, deadline }` opens one; `tally.sign { id }` signs (one per signed identity); `tally.withdraw { id }` withdraws before the threshold; `tally.count { id }` answers with the count. Until the threshold, a tally MUST NOT reveal who signed, to anyone, the opener included. When the count reaches the threshold it MUST tell every signer at once (`tally.triggered` with the signers), and from then on it MAY show the signers to signers and the opener. If the deadline passes first, it MUST forget the signers (`tally.lapsed`). A tally sees who signs; parties trust it the way they trust an auditor. Opened with `people_only: true`, each signature must carry a person stamp (`person: { credential, card }`, §6.4) and each person counts once. It emits `tally.update` with counts only.
## 12. Intents and quotes (offers priced in place)

A study asks many houses one question and gets back scrambled answers. A **quote** is the other way round: one person wants something (a mortgage, insurance, an energy tariff) and many agents compete to offer it, each priced on that person's real data, inside their house, without seeing it.

- **Intent.** The owner says what they're looking for, as coarse public terms the pack defines (`mortgage@1`: state, price band, term, first home buyer). Rules can hold standing intents (`intents:` in rules.yaml); a term set to `auto` is worked out inside the house from the owner's own claims. The house sends its intents, signed, to the nodes it follows (`POST /intents`); a node keeps who privately and publishes only how many households share each group (`GET /intents?pack=`), and only groups of at least a minimum size. A sandbox node may also show which house asked, on its map.
- **Who hears it.** Only agents that quote for the pack (skill `<pack>-quote`) and carry a `LakeAuthorisation` for it from an authority in the owner's `trust.regulators` (for mortgages, a register of licensed lenders). An agent without one never learns the intent exists.
- **Quote.** The agent sends a `quote`: its **quote program**, an auditor's `LakeProgramCertificate` for it, and its authorisation. A quote program is a declaration, not code: pack fields and intent terms as inputs, arithmetic, `band` tables, `annuity`, `has` for codes in claims, `is` for a choice of a code term, a boolean `eligible`, numeric outputs, `output: owner`. No loops, no I/O. Every program may read `group_size`, the published size of the owner's group, so a group discount is part of the certified program. The house MUST check the authorisation, the certificate and the program itself (`auditProgram`), and that the owner has an open intent for that pack, before running it. It MUST keep the result for the owner only and answer every quote the same way (`quoted`, with a reference), whether eligible or not.
- **Groups.** As more households share a group, the house learns the new size and runs the programs it already holds again, with the new `group_size`. A group discount is part of each certified program, so nobody is asked again and no message leaves the house. A newer quote from the same agent (for a new intent, say) replaces its open one.
- **Accept.** Only when the owner accepts an offer (live, on their device) does anything leave: the files the pack names (`release`, for mortgages the issuer-signed original and its credential), to that one agent. The house logs what it released, to whom, and on whose consent. The agent checks the original with its issuer, re-runs the same program on it, confirms (a conditional approval) and may pay the owner a fee under its own human's AP2 mandate; the receipt is filed in the pod.

Message kinds: house → agent `authorisation`, `intent`, `accept`; agent → house `quote`, `receipt`. Event kinds: `intent.opened`, `quote.made`, `offer.accepted`.

## 13. Open questions

These are real decisions still open. Argue in an issue.

- Domain proof for people without a domain: delegated subdomains from pod providers?
- Personhood: which credential prevents one person running 50 houses?
- Selective disclosure: SD-JWT now, BBS+ later?
- Payment: which rail settles real money, if any, and who carries the mandate liability?
