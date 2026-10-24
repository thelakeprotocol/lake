# Decisions

<p class="lead">Where a standard left room, here is what we chose and why. Disagree? Open a <a href="https://github.com/thelakeprotocol/lake/discussions">discussion</a>.</p>

| Area | Choice | Why |
|---|---|---|
| A2A version | A2A **1.0**, official `@a2a-js/sdk`, JSON-RPC binding | Current spec; the SDK signs and verifies cards for us |
| Lake fields on cards | Inside a declared A2A **extension**, marked `required` | A2A 1.0 signatures only cover schema fields; extension params are covered. `required` makes clients say they speak Lake |
| Signatures | **Ed25519 (EdDSA)** JWS; cards per A2A §8.4 (JCS); messages over JCS of the payload | Small, fast, widely supported |
| Credentials | W3C **VC 2.0** secured with **VC-JOSE-COSE** (`typ: vc+jwt`) | Simplest standard securing that reuses the same keys |
| Pinning records | VC `relatedResource` with **`digestSRI`** | The original stays untouched in the pod; any change breaks the digest |
| Synthetic records | A seeded generator that emits **Synthea-shaped FHIR R4** | Synthea needs Java and minutes per run; the converter also reads real Synthea exports |
| Fictional drugs | "Drug X/Y/Z" under a Lake code system | The demo must never look like advice about a real medicine |
| Pod URL inside a house | `http://localhost:3000/` | Solid-OIDC allows plain HTTP only on localhost. Public houses put TLS in front |
| Sandbox Lakes | Domain proof skipped and marked `sandbox` | A local Lake has no real domains; the reply says the domain wasn't proved |
| Ethics and audit claims | Count only as signed credentials from a domain on the owner's `trust` list | An offer can't vouch for itself, and nobody appoints authorities for the Lake |
| Studies | **Declarative** (up to four yes/no questions), not code | Fully auditable and safe to run anywhere; arbitrary code needs attested execution (stretch goal) |
| What a house sends back | Its true cell as a **Prio3 report** (IETF DAP): two shares with a validity proof, for two tellers run by different parties; only their aggregate shares, added, give the table | Houses never blur their answers (an earlier version used randomised response: each answer flipped about a quarter of the time, so studies needed many more houses). Splitting keeps every answer private and every table exact; the trust moves to "the two tellers don't collude" |
| Broadcast | **Direct A2A** to every discovered house, 32 at a time; no NATS | Direct messaging is required anyway (SPEC §9); a bus is an optimisation to revisit at 1,000 houses (milestone 7) |
| Converter certificates | The auditor certifies `name@version` from an allowlist | Pinning the package digest is a follow-up |
| Grants | A `join` is the owner's standing pre-approval; keys are minted by the owner's approval flow (milestone 4) | Agents never mint keys |
| Houses at home | Relay through the nodes the house follows (`--relay`): one outgoing WebSocket each | Works behind any home router with zero setup; signed messages mean a relay can't tamper. Nodes can read relayed offers, so end-to-end encryption is next |
| Federation | Pull: a node reads its peers' `/cards` and `/signals` every 5 s, and re-verifies every card itself | Peers can point at agents but never vouch for them; no new protocol beyond what every node already serves |
| Discovery with every node down | Agents remember the houses they found; every card lives at its owner's address | Registries are search indexes, not gatekeepers |
| Record checks under load | Full chain once a minute; in between, re-read the two data files and compare with the digests the verified credentials pin | Tampering with either file is still caught; a forger can't swap credential files without the issuer's key |
| Busy, not broken | A house that can't read its pod in time answers `busy`; agents retry three times | Overload must never be mistaken for a tampered record |
| Payments at scale | Settled in batches of 100 under one Intent Mandate | The budget holds across batches; no message gets too large |
| MCP connector | Part of `@thelakeprotocol/agent`; the assistant joins the Lake as its own signed agent | The assistant is a visitor like any other: same card, same rules, same reputation |
| npm publishing | From CI on a version tag, with npm provenance | Each package is signed and linked to the exact commit and run that built it |
| Hosted cards | The card lives next to the A2A endpoint (`…/t/<name>/.well-known/agent-card.json`) | Many houses can share one host; every card still verifies on its own |
| Quarantine | By key, after 3 independent blocks; signed blocklist at `/signals` | Blocking by claimed domain would let forgers frame real organisations |
| Reputation | 0.5 + 0.05 per kept deal − 0.15 per blocked attempt, clamped to 0–1, verified identities only | Simple, explainable, and impossible to dent by impersonation |
| Injection detection | A pattern check that only labels attempts | Safety comes from rules not reading free text; a classifier would be a second line, not the first |
| Swarm | Lives in the CLI (`lake swarm`) | One image, nothing new to run |
| AP2 | Mandates implemented from the spec as W3C VCs; no AP2 SDK used | There is no stable JS SDK; the chain is what matters, and it is real |
| Settlement | Simulated; receipts are signed | Real money movement is a non-goal |
| Bloc terms | Computed by the visitor from members' signed counters, by a fixed rule anyone can check | No coordinator needed; a jointly signed bloc counter is future work |
| One card per WebID at a node | A newer card replaces the old one | Key rotation must work; stale keys must not |
| The owner's key | Ed25519, made on the phone with `@noble/curves` | Phones on a home network load the app over plain HTTP, where browsers disable WebCrypto |
| Pairing | One-time token in the printed link; sandbox may allow first-come | A stranger on the Wi-Fi can't claim your house |
| Live updates in the app | Polling once a second | Works everywhere with no push service; push notifications are a follow-up |
| LLM | **None bundled.** Rules decide; templates write reasons | People bring their own agents through MCP or A2A |
