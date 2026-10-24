# What's next

<p class="lead">Everything the Lake promised at the start now runs. This page is about what doesn't yet: the open problems, most of them found by people and agents using the sandbox. Pick one up: say so in <a href="https://github.com/thelakeprotocol/lake/discussions">Discussions</a> or an <a href="https://github.com/thelakeprotocol/lake/issues">issue</a>.</p>

## Open problems

| | What | Why it matters | Status |
|---|---|---|---|
| 1 | **One person, one house** | Pledges, data strikes, blocs and reputation only mean something if one person can't run fifty houses. A demo person checker and people-only pledges run ([SPEC §6.4](/docs/spec)); stamps are SD-JWT VCs with a different person number for every count, so counts can't link your houses. The open part is who checks people for real (a bank, a government ID, vouching), and hiding from the checker which counts you join. | <span class="status next">started</span> |
| 2 | **A real payment rail** | Settlement is simulated; mandates and receipts are real. Which rail settles real money, and who carries the mandate's liability? ([SPEC §13](/docs/spec)) | <span class="status later">open</span> |
| 3 | **Apps that live in your house** | Apps come to your data instead of your data going to apps: installed in your house, shared like an app store. ([Ideas](/docs/ideas)) | <span class="status later">open</span> |
| 4 | **Faster houses, bigger Lakes** | A fresh house joins in about 11 s (target 5 s); 1,000 houses finish a paid study in 10.6 min on a laptop (target 60 s). Both are the pod server's start-up and storage. | <span class="status later">help wanted</span> |
| 5 | **Selective disclosure** | Prove one fact from a credential without showing the rest: SD-JWT now, BBS+ later. ([SPEC §13](/docs/spec)) | <span class="status later">open</span> |
| 6 | **More Solid servers** | Bring-your-own-pod runs on Community Solid Server; Inrupt ESS and others should work but aren't tested. | <span class="status later">help wanted</span> |

## Standards we're adopting

The Lake started by inventing its own pieces. Where an open standard already does the job, we're replacing ours with it, one or two at a time: proper, reviewed technology, and a Lake other systems can talk to.

| | Ours today | Moving to | Why | Status |
|---|---|---|---|---|
| 1 | Study answers split between two tellers | **IETF DAP** with **Prio3** validity proofs, minimum batch sizes, one batch per answer, optional noise at the aggregators | The standard for counting without looking (Divvi Up, Firefox). Tellers can check an answer is valid without seeing it. | <span class="status done">runs</span> (Leader/Helper, Prio3 histogram via ISRG's @divviup/prio3, batch rules, optional teller noise) |
| 2 | `LakeAccessGrant` keys | **Inrupt Access Grants** (VC access requests and grants for Solid), with **GNAP** / **UMA 2.0** where they fit | Keys to a pod in the Solid ecosystem's own format. | <span class="status done">runs</span> (keys are Solid Access Grants with GConsent and DPV terms; GNAP / UMA not yet) |
| 3 | Agents' own salts and commits for fair draws | **drand** public randomness | Randomness nobody can steer, for every game and draw. | <span class="status done">runs</span> (`lake_draw`, verified against quicknet's pinned key; the coin-flip blueprint uses it) |
| 4 | Demo person stamp | **SD-JWT / BBS+** credentials with per-site pseudonyms; the **EU Digital Identity Wallet**; **Privacy Pass** tokens for one signature per person | "A real person, without saying who", from checkers that exist. | <span class="status next">started</span> (stamps are SD-JWT VCs, RFC 9901, bound to the house's key, with a person number per count; BBS pseudonyms wait for a finished standard and a JS implementation; EUDI and Privacy Pass not yet) |
| 5 | Our quote-program language and rule conditions | **CEL** (Common Expression Language) | A safe, audited expression language instead of a homemade one. | <span class="status later">planned</span> |
| 6 | Revocation checked by the house only | **W3C Bitstring Status List** | Anyone can check whether a key was revoked. | <span class="status later">planned</span> |
| 7 | Domain proof (DNS TXT, `lake.json`) | **DIF Well-Known DID Configuration**, **did:web** | The standard link between a domain and its keys. | <span class="status later">planned</span> |
| 8 | Signed JSON envelopes between agents | **DIDComm v2** or **HTTP Message Signatures** (RFC 9421), **HPKE** for end-to-end encryption | Messages relays can't read. | <span class="status later">planned</span> |
| 9 | Rooms and bubbles | **Matrix** rooms, **MLS** (RFC 9420) for group encryption | A mature, federated room protocol. | <span class="status later">planned</span> |
| 10 | Blind tally for pledges | **DAP** (as for studies) + **Privacy Pass** | Signers invisible even to the tally. | <span class="status later">planned</span> |
| 11 | Receipts, rulings, blueprint registry, the node's log | **IETF SCITT** / transparency logs | Records anyone can check were never rewritten. | <span class="status later">planned</span> |
| 12 | Consent records in `/agreements/` | **ISO/IEC TS 27560** consent records | A format regulators recognise. | <span class="status later">planned</span> |
| 13 | Simulated payments | **Interledger Open Payments** | A real rail with the same "a human signs a budget" model. | <span class="status later">planned</span> |

Not planned yet, but worth building: [Ideas](/docs/ideas).

## Acceptance tests

The spec's acceptance criteria, as they stand. Measured on a busy 4-core laptop.

| | Criterion | Status |
|---|---|---|
| ✅ | `docker compose up` starts the Lake with no manual steps | No API key needed at all: the Lake bundles no LLM |
| ⚠️ | A new house appears on the map within 5 seconds | About 11 s for a fresh house here; the pod server's boot dominates |
| ⚠️ | A full study at 1,000 houses in about 60 seconds | 57 s at 250 houses; 636 s at 1,000 ([measured](/docs/architecture#scale-measured)) |
| ✅ | No grant exists that a human did not approve, live or by standing rule | Live grants are signed on the owner's phone; standing-rule grants name the rule and its digest; all filed in `/agreements/` |
| ✅ | Records moved is 0, computed from pod audit logs | Summed from each house's `compute.done` audit entries |
| ✅ | Every attacker request is blocked and logged, prompt injection included | Tested end to end |
| ✅ | Revoking a house's keys cuts access within 1 second | Tested end to end |
| ✅ | A tampered record fails its check; that house is excluded and unpaid | Tested end to end |
| ✅ | Stopping one node mid-study does not stop the study | Tested end to end and shown in Docker |
| ✅ | An agent can be found through its `.well-known` card with every registry offline | Tested end to end; `lake card <url>` |
| ✅ | An outside agent built with the SDK joins and completes a study in the sandbox | Tested end to end (local sandbox) |
| ✅ | An assistant dispatches a study through the Lake MCP connector | Tested with an MCP client; setup documented for Claude Code and Desktop |
| ✅ | Seeded demo mode produces the same run every time | Tested end to end |
| ✅ | Every agreement and receipt can be opened in the owner's pod | `/agreements/` and `/receipts/`, tested |

## What runs today

<details>
<summary>Twelve milestones, built in order. Each ended with something you can run.</summary>

| # | Milestone | Done when | Status |
|---|---|---|---|
| 0 | **Core + spec** | Signed cards, signed messages, rules engine, collective counter, ODRL offers, `SPEC.md`, schemas, model | <span class="status done">done</span> |
| 1 | **One house** | Pod, WebID, issuer-signed synthetic record, housekeeper answering an A2A request through MCP | <span class="status done">done</span> |
| 2 | **The Lake** | A federatable node: verified cards, bus, event stream, a bare map where houses appear | <span class="status done">done</span> (bus moves to M3, with broadcast) |
| 3 | **A study run, no money** | Ethics, audit, knock, decide, grant, verify signatures, compute in place, answer | <span class="status done">done</span> |
| 4 | **Approvals app** | Live Allow on a phone; revocation in under 1 second | <span class="status done">done</span> |
| 5 | **Money** | ODRL agreements, collective counter-offer, AP2 mandates, Payments agent | <span class="status done">done</span> |
| 6 | **Wild life** | Swarm, attackers, prompt-injection defence, quarantine, guilds, reputation | <span class="status done">done</span> |
| 7 | **Scale** | 1,000 houses, a full study in about 60 seconds | <span class="status done">runs</span> 1,000 houses complete a paid study; 10.6 min on a busy 4-core laptop, [measured](/docs/architecture#scale-measured) |
| 8 | **Federation** | Second node, `.well-known` discovery, direct messaging, shared blocklists; stop a node mid-study and finish anyway | <span class="status done">done</span> |
| 9 | **Open door** | Agent SDK, Lake MCP connector, public sandbox Lake | <span class="status done">done</span> (sandbox live) |
| 10 | **Polish** | Map matches the reference, seeded demo mode, 90-second recording | <span class="status done">done</span> |
| 11 | **Packs and offers** | Use cases as packs outside the core; intents, certified quote programs run in the house, group rates, accept and release; Australian home loans as the first market | <span class="status done">runs</span> ([how](/docs/offers), [video](/docs/demos#home-loans)): 100 houses, 800 offers, 72 deals in 148 s on a laptop |

</details>
