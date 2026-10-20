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

An offer for a study carries the study itself, its id in `offer.study`, and two attachments: an ethics approval and an audit certificate, each a Verifiable Credential together with the signed card of whoever issued it (§5.2).

An offer MAY include a free-text `note`. It is **untrusted**. A housekeeper MUST NOT let it change a decision. It may be shown to a human, quoted, and nothing else.

An **agreement** is the ODRL `Agreement` both parties sign, built from the final accepted offer, with a `dateTime` constraint for its end. The house signs it when it joins and returns it with the grant; the visitor MUST countersign it (a detached JWS over the agreement's canonical form) before the house runs anything. Both parties MUST keep it: the house in its pod at `/agreements/`. The grant names the agreement's `uid` and digest.

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

## 6.2 Money (AP2)

Payments follow the Agent Payments Protocol's mandate chain, as W3C VCs:

| Mandate | Signed by | Says |
|---|---|---|
| `IntentMandate` | a human at the visitor's organisation (same `ownerDomain`, a separate key) | this agent, this study, `budget`, `intent_expiry` |
| `PaymentMandate` | the visitor agent | payee (the house's WebID), amount, the digest of the Intent Mandate, the agreement `uid` |
| `LakeReceipt` | the payments agent | payee, amount, agreement, the Intent Mandate digest, `settlement` |

A payments agent MUST check the whole chain and MUST refuse once the total under one Intent Mandate would exceed its budget: past that, a human must approve. Only houses that answered are paid. A house files receipts from payments agents on its owner's `trust.payments` list in `/receipts/`. In the reference implementation settlement is simulated; the mandates and receipts are real signed objects.

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

`house.joined` · `house.left` · `agent.registered` · `knock` · `offer` · `counter` · `decision` · `agreement.signed` · `grant.issued` · `grant.revoked` · `approval.requested` · `approval.answered` · `payment.settled` · `attack.blocked` · `agent.quarantined` · `guild.formed` · `study.result` · `compute.done` · `record.moved`

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

## 10. Canonical data model

The Lake supports exactly one data model, in RDF, with SHACL shapes for validation. Other standards (FHIR, bank CSVs, wearables) are converted into it at the edge, inside the house, by signed and audited **converter** packages.

- Core classes: `Party`, `Thing`, `Claim`, `Provenance`, `Offer`, `Terms`, `Receipt`.
- Domain vocabularies (health, energy, rentals) add `Claim` subtypes inside the core.
- A converted claim carries the hash of the original signed record, the converter's name, version and certificate, and the housekeeper's signature. Study code MUST verify all three and drop any value that fails.
- Every field carries a provenance tier: `self-reported`, `device-signed` or `issuer-signed`.

See [`model/lake.ttl`](https://github.com/thelakeprotocol/lake/blob/main/model/lake.ttl) and [`model/shapes.ttl`](https://github.com/thelakeprotocol/lake/blob/main/model/shapes.ttl).

## 11. Open questions

These are real decisions still open. Argue in an issue.

- Domain proof for people without a domain: delegated subdomains from pod providers?
- Personhood: which credential prevents one person running 50 houses?
- Selective disclosure: SD-JWT now, BBS+ later?
- Payment: which rail settles real money, if any, and who carries the mandate liability?
