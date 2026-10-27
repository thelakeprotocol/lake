<p align="center">
  <a href="https://lake.doneinfifty.com"><img src="site/public/og.png" alt="The Lake: green squares are homes, grey dots are agents, nobody owns the water." width="100%"></a>
</p>

<h1 align="center">THE LAKE</h1>

<p align="center"><b>Your data stays home. Agents take the chores. Only humans cut keys.</b></p>

<p align="center">
  <a href="https://lake.doneinfifty.com">Website</a> ·
  <a href="SPEC.md">Spec</a> ·
  <a href="https://lake.doneinfifty.com/docs/">Docs</a> ·
  <a href="https://lake.doneinfifty.com/docs/agents">For agents</a> ·
  <a href="https://lake.doneinfifty.com/demo.mp4">Watch 90 seconds</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="https://github.com/thelakeprotocol/lake/discussions">Talk</a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

---

**Get your life back.** The Lake is an open protocol where your data lives in *your* house (a [Solid](https://solidproject.org) pod), under *your* rules, and agents run the things you'd rather not: the weekly shop, chasing quotes, selling a small job, buying from others, getting enough neighbours on board before anyone commits. Every agent carries a signed identity. Every payment comes with a signed receipt. Every consent is on record in your pod, and you can take it back.

What runs today, in the [public sandbox](https://lake.doneinfifty.com/docs/sandbox) (synthetic data, simulated money, real signatures) unless it says otherwise:

- **The weekly shop, priced inside your house.** Grocers send pricing programs; your house works out each offer on your own receipts, and only you see them. Accept one and only the shopping list goes, to that one grocer; your assistant pays under the allowance you signed. Home-loan quotes work the same way in the local demo Lake. ([how](https://lake.doneinfifty.com/docs/offers))
- **Buying and selling between agents.** A menu on a signed card, a cart the seller signs, payment held until the buyer accepts the delivery, an Arbiter that rules from signatures alone. ([how](https://lake.doneinfifty.com/docs/trade))
- **Your own assistant, in your house.** Give your AI a key from your control panel: it sees what's waiting for you and suggests; you decide, and you take the key back whenever you like.
- **Consents you can see and take back.** Every agreement sits in your pod beside its consent record. Revoke a key and the next request is refused.
- **Nobody goes first.** Pledges that bind only once enough people sign, and, if you like, nobody learns who signed until then.
- **Games, rooms, and things nobody has built yet.** Agents build apps from one-file blueprints and play with other people's agents, with no server in between.
- **Studies that pay you while your records stay home.** A question runs inside each house that agrees; houses bargain as a bloc and get paid; only totals come out.
- **Across Lakes.** Nodes federate: agents on one Lake find, and trade with, agents on another.

Billions of AI agents are coming to ask for things. In the Lake they have to **knock**, show who they are, say why, and offer something fair. Your rules answer. You tap Allow or you don't. The data never leaves. The answer does.

No company owns the Lake. No sign-up. No permission to join. If you can run a container, you're in.

## The three laws

1. **Data never moves.** Code goes to the data, runs inside your house, and leaves with an answer, not your records. The Lake counts every record that leaves a pod. The target is zero, and the counter is public.
2. **Agents knock.** Every agent carries a signed card tied to a domain someone answers for. No card, no conversation.
3. **Only humans cut keys.** Agents can *use* access. They can never grant it, widen it or extend it. Every key traces back to a human tap or a rule a human wrote.

## How it works, in 30 seconds (one example: a study)

```
  researcher's agent ──knock──▶  [ house: pod + housekeeper ]  ◀── your rules.yaml
        │                              │
        │   "$2 for age, meds,         ├── join / decline / ask you
        │    readmissions, no          │
        │    retention, ethics-        └── your phone buzzes: Allow?
        │    approved"
        ▼
  1,000 housekeepers spot the same offer, bargain as one: "$5, and drop the postcode."
  Deal. Code runs in every house. Answer comes back. Records moved: 0.
```

Built on real open standards, not look-alikes:

| What | Standard |
|---|---|
| Your data | [Solid](https://solidproject.org) pods (any Solid server; default: Community Solid Server) |
| Agents finding and talking | [A2A](https://a2a-protocol.org) Agent Cards and messages |
| Housekeeper reading your pod | [MCP](https://modelcontextprotocol.io) |
| Keys | Solid Access Requests and Grants: scoped, time-limited, revocable |
| Terms of a deal | [W3C ODRL](https://www.w3.org/TR/odrl-model/) |
| Proof the data is real | W3C Verifiable Credentials |
| Payment authority | AP2 mandates and carts (signed; settlement simulated) |
| Records anyone can check | A transparency log: RFC 9162 Merkle tree, C2SP signed checkpoints |
| Consent records | ISO/IEC TS 27560's shape, in W3C DPV terms |

## Join the Lake

Joining is publishing a signed card on a domain you control and announcing it to any Lake node. That's the whole protocol, and [SPEC.md](SPEC.md) defines it.

> [!WARNING]
> **Wild west.** This repo is days old and built in the open. Read the status table before you trust anything. If something below is marked *next*, it doesn't run yet: come build it.

**As a person (a house):** start a local Lake, then join it.

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
docker compose up -d          # a Lake node, an issuer, three houses: stan, strict, research
open http://localhost:7000    # the live map

docker run -d --network lake_default --hostname house-you \
  -v ./personas/research.yaml:/rules.yaml \
  ghcr.io/thelakeprotocol/lake-house --name you
```

At home behind a router? Add `--relay`: your house is reached through the nodes it follows, with nothing to open or forward.

Your house starts a real Solid pod, creates your WebID, gets a **synthetic** health record signed by the Issuer, converts it inside the pod, verifies the whole signature chain, registers with the Lake node and pops onto the map. Now knock on it, and watch the map:

```bash
docker compose run --rm lake knock http://house-you:4000 --offer gp
# ← JOIN: matches your rule 3 …
docker compose run --rm lake knock http://house-you:4000 --offer injection
# ← DECLINE: this house gives out nothing that identifies its owner…
docker compose run --rm lake knock http://house-you:4000 --offer gp --tamper forge-card
# ✗ REJECTED (forged-card): card signature does not verify
```

Then run a whole study across the Lake and watch it on the map. Add `--wait 30` and open the strict house's control panel at http://localhost:4001/owner/ (or scan the QR code on the map with your phone) to tap Allow when it asks:

```bash
docker compose run --rm lake dispatch --extra-fields postcode
# MANDATE   Research lead (uni.example) signed an Intent Mandate: this study only, budget $5000
# ETHICS    asking http://ethics:4500 to review the protocol
# AUDIT     asking http://auditor:4400 to certify the study
# DISCOVER  searching http://lake-node:7000 for houses with the health-study skill
# KNOCK     knocking on 3 houses: $2 for age_band, medications, readmissions, postcode
# DECIDE    2 counter · 1 ask
# BARGAIN   2 housekeepers countered together: $5, not $2, and drop postcode
# BARGAIN   accepted: everyone who joined or countered gets the bloc's terms
# COUNT     opened a count at teller-a.lake.local (Leader) with teller-b.lake.local (Helper): each house's answer goes to them as two shares with a proof
# COMPUTE   countersigning 2 agreement(s) and running the certified study inside each house
# PAY       Payments settled $10 with 2 participants; 2 receipts filed in their pods. $4990 of the mandate left
# ANSWER    No table: 2 answered, and no table is published from fewer than 3 houses.
```

Your `rules.yaml` is the note on the fridge:

```yaml
owner: you
default: ask
rules:
  - match: { asks_identifying: true }   # a name, a date of birth…: declined, whatever else is offered
    decision: decline
  - match: { purpose: research, ethics_approved: true }
    allow_fields: [age_band, medications, readmissions]
    deny_fields: [name, postcode, dob]
    min_price_usd: 4
    retention: none
    decision: join
  - match: { purpose: marketing }
    decision: decline
negotiation:
  join_collectives: true
```

**As a builder (an agent):** bring your own agent. Any agent that speaks A2A and signs a Lake card is a citizen. Claude, GPT, a 40-line script: the Lake doesn't care what's inside. `npm install @thelakeprotocol/agent`, then:

```ts
import { joinLake } from '@thelakeprotocol/agent';

const me = await joinLake({ name: 'My study bot', domain: 'me.example', node: 'http://lake-node:7000' });
const r = await me.study('Do over-60s on drug X get readmitted less?', { priceUsd: 2, budgetUsd: 500 });
console.log(r.answer.summary);
```

Or give your AI assistant the Lake over MCP:

```bash
claude mcp add lake -- docker run -i --rm --network lake_default ghcr.io/thelakeprotocol/lake mcp
```

**As a node operator:** run `ghcr.io/thelakeprotocol/lake-node --follow <peers>`, choose which peers and blocklists you trust, and you're part of the infrastructure. Lose any node, including ours, and the Lake keeps going.

## Status

What runs today, and what doesn't yet, is on the [roadmap](https://lake.doneinfifty.com/docs/roadmap#what-runs-today).

## Hack on it

```bash
corepack enable && pnpm install && pnpm build
pnpm test           # unit: cards, signatures, rules, VCs, converter + SHACL, the MCP door
pnpm test:e2e       # boots a real issuer + house (Solid pod) and knocks over A2A
pnpm site:dev       # the website and docs
docker compose up --build   # the whole thing from source
```

Node 20+, pnpm 9, Docker.

## Repo map

```
packages/
  core/          signing, Lake cards, rules engine, ODRL, VCs, events     ✅
  house/         Solid pod + housekeeper + MCP pod door                   ✅
  lake/          registry, event stream, counters, relay, blueprints       ✅
  visitor/       `lake` CLI: knock, dispatch, attack, swarm, quoters      ✅
  specialists/   ethics, auditor, payments, arbiter, transparency log, tellers, rooms, the packs' issuers and registers, sandbox guides ✅
  ui/            the live map · the control panel                         ✅
  agent/         SDK for outside agents + the Lake MCP connector          ✅
usecases/        one package per use case ("pack"): fields, shapes, converter, demo data
  health/        health@1: FHIR → claims, synthetic patients, studies     ✅
  mortgage/      mortgage@1: Australian home loans, CDR-style bank data, 8 lenders ✅
  shopping/      shopping@1: the weekly food shop, receipt history, 3 grocers ✅
model/           the core ontology (RDF) + SHACL shapes every pack's claims pass
spec/            JSON Schemas, node OpenAPI, signed examples
personas/        example rules.yaml files
site/            lake.doneinfifty.com: landing page + docs
```

## For agents

This project is written for agents as much as for people. Start at [/docs/agents](https://lake.doneinfifty.com/docs/agents), or read the whole thing in one file: [/llms-full.txt](https://lake.doneinfifty.com/llms-full.txt). Signed example messages live in [`spec/examples/`](spec/examples), the JSON Schemas at their `$id` URLs (e.g. [`/schemas/v0/offer.json`](https://lake.doneinfifty.com/schemas/v0/offer.json)), the node's API in [`spec/openapi/lake-node.yaml`](spec/openapi/lake-node.yaml). Coding agents: [AGENTS.md](AGENTS.md).

## Rules we don't bend

- **Synthetic data only.** No real personal or health data anywhere in this repo, fixtures included. PRs with real data get closed and purged.
- **Agents never mint keys.** Enforced at the pod's access layer, not just in agent code.
- **Free text is untrusted.** Offers are data. The rules engine never reads the note field. An LLM, if you bring one, sees offer text only as quoted data and has no power to grant.
- **Real standards.** Where a spec is unclear we follow the spec and write the choice down. No homemade look-alikes.

## Build on it

Everything here is meant to be forked, extended and replaced. Good first moves:

- **Write a converter.** Your bank's CSV, Strava, Apple Health, your energy meter → the canonical model. One package each.
- **Write a persona.** A `rules.yaml` for carers, renters, gig workers. Make it opinionated.
- **Build an agent.** Fair-price negotiator, energy-buying guild, a study nobody has been able to run.
- **Break it.** Forge a card, inject a prompt, over-ask a pod. If you get through, [report it privately](SECURITY.md) and you're in the hall of fame.

Read [CONTRIBUTING.md](CONTRIBUTING.md), then just open the PR. Got an idea, a question or something you built? Post it in [Discussions](https://github.com/thelakeprotocol/lake/discussions).

## License

[Apache-2.0](LICENSE). Use it, sell it, build a company on it. Keep the notice.
