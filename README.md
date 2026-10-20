<p align="center">
  <a href="https://lake.doneinfifty.com"><img src="site/public/og.png" alt="The Lake: green squares are homes, grey dots are agents, nobody owns the water." width="100%"></a>
</p>

<h1 align="center">THE LAKE</h1>

<p align="center"><b>Your data stays home. Agents knock. Only humans cut keys.</b></p>

<p align="center">
  <a href="https://lake.doneinfifty.com">Website</a> ·
  <a href="SPEC.md">Spec</a> ·
  <a href="https://lake.doneinfifty.com/docs/">Docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

---

Right now your health records, bank history and location trail sit in a thousand company databases. You can't see them, you can't price them, and you never said yes.

**The Lake flips that.** Your data lives in *your* pod. A housekeeper agent stands at the door. Billions of AI agents are coming to ask for things; in the Lake they have to **knock**, show who they are, say why, and offer something fair. Your rules answer. You tap Allow or you don't. The data never leaves. The answer does.

No company owns the Lake. No sign-up. No permission to join. If you can run a container, you're in.

## The three laws

1. **Data never moves.** Code goes to the data, runs inside your house, and leaves with an answer, not your records. The Lake counts every record that leaves a pod. The target is zero, and the counter is public.
2. **Agents knock.** Every agent carries a signed card tied to a domain someone answers for. No card, no conversation.
3. **Only humans cut keys.** Agents can *use* access. They can never grant it, widen it or extend it. Every key traces back to a human tap or a rule a human wrote.

## How it works, in 30 seconds

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
| Payment authority | AP2 mandates (signed; settlement simulated) |

## Join the Lake

Joining is publishing a signed card on a domain you control and announcing it to any Lake node. That's the whole protocol, and [SPEC.md](SPEC.md) defines it.

> [!WARNING]
> **Wild west.** This repo is days old and built in the open. Read the status table before you trust anything. If something below is marked *next*, it doesn't run yet: come build it.

**As a person (a house):**

```bash
# next — milestone 1
docker run ghcr.io/thelakeprotocol/lake-house --name you -v ./personas/stan.yaml:/rules.yaml
```

Your house starts a pod, creates your WebID, publishes its card, registers with the Lake and shows up on the map. Your `rules.yaml` is the note on the fridge:

```yaml
owner: you
default: ask
rules:
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

**As a builder (an agent):** bring your own agent. Any agent that speaks A2A and signs a Lake card is a citizen. Claude, GPT, a 40-line script: the Lake doesn't care what's inside. We ship an SDK and an MCP connector so it takes minutes:

```ts
// next — milestone 9: @thelakeprotocol/agent
import { joinLake } from '@thelakeprotocol/agent';

const me = await joinLake({ name: 'My research agent', domain: 'me.example', skills: ['health-study'] });
const houses = await me.find({ skill: 'health-study' });
await me.offer(houses, { purpose: 'research', fields: ['age_band', 'readmissions'], priceUsd: 2, retention: 'none' });
```

**As a node operator:** run `lake/node`, choose which peers and blocklists you trust, and you're part of the infrastructure. Lose any node, including ours, and the Lake keeps going. *(next — milestone 8)*

## Status

Honest, updated every merge.

| | Piece | Status |
|---|---|---|
| ✅ | **Core**: signed Lake cards on the official A2A signer, signed messages with replay and expiry checks, rules engine, collective counter-offers, ODRL offers, event schema | runs, tested |
| ✅ | **Spec**: `SPEC.md` + JSON Schemas + canonical model | v0.1 draft |
| ✅ | **Website + docs** | [lake.doneinfifty.com](https://lake.doneinfifty.com) |
| 🔨 | **M1 House**: pod, WebID, issuer-signed synthetic record, housekeeper over MCP | next |
| ⬜ | **M2 Lake node**: registry, bus, event stream, live map | |
| ⬜ | **M3 Mission**: ethics, audit, knock, decide, grant, compute in place | |
| ⬜ | **M4 Approvals app**: Allow from your phone, revoke in under 1 second | |
| ⬜ | **M5 Money**: ODRL agreements, collective bargaining, AP2 mandates | |
| ⬜ | **M6 Wild life**: swarm, attackers, prompt-injection defence, quarantine, guilds, reputation | |
| ⬜ | **M7 Scale**: 1,000 houses on one laptop | |
| ⬜ | **M8 Federation**: many nodes, `.well-known` discovery, shared blocklists | |
| ⬜ | **M9 Open door**: agent SDK, Lake MCP connector, public sandbox | |

## Run what exists

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
corepack enable && pnpm install
pnpm test           # core: cards, signatures, rules, the $2 → $5 counter
pnpm site:dev       # the website and docs, locally
```

Node 20+ and pnpm 9. Docker once the house lands.

## Repo map

```
packages/
  core/          signing, Lake cards, rules engine, ODRL offers, events   ✅
  house/         pod + housekeeper + MCP pod tools                        M1
  lake/          registry, bus, event stream, counters                    M2
  visitor/       research agent + `lake` CLI                              M3
  specialists/   ethics, auditor, payments, issuer                        M3–M5
  swarm/         background traders and attackers                        M6
  ui/            the map + the approvals app                              M2, M4
  agent/         SDK for outside agents                                   M9
  mcp/           Lake MCP connector: any assistant can use the Lake       M9
  convert-fhir/  FHIR → canonical Lake model                              M3
model/           canonical ontology (RDF) + SHACL shapes
spec/schemas/    JSON Schemas for cards, offers, events
personas/        example rules.yaml files
site/            lake.doneinfifty.com: landing page + docs
```

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

Read [CONTRIBUTING.md](CONTRIBUTING.md), then just open the PR.

## License

[Apache-2.0](LICENSE). Use it, sell it, build a company on it. Keep the notice.
