# Architecture

<p class="lead">Five kinds of component, each its own container. Everything an agent does crosses the Lake as a signed A2A message, and nothing reaches a pod except through its own housekeeper.</p>

```
                       ┌──────────────────────────────┐
                       │   lake-ui: map + approvals    │◀─ owner taps Allow
                       └──────────────▲───────────────┘
                                      │ WebSocket events (ids, kinds, counts)
┌──────────────┐   A2A   ┌────────────┴─────────────┐   A2A   ┌──────────────────────┐
│ visitor      │────────▶│  Lake node(s)            │◀───────▶│ house × N            │
│ research     │◀────────│  registry · relay ·      │         │  housekeeper ── MCP ─┼─▶ Solid pod
│ agent + CLI  │         │  event stream · counters │         │  wallet · rules.yaml │
└──────┬───────┘         └────────────▲─────────────┘         └──────────────────────┘
       │ A2A                          │ A2A
       ▼                              │
┌─────────────────────────────────────┴───┐
│ specialists: ethics · auditor ·          │
│ payments · issuer      swarm: traders,   │
│                         attackers        │
└──────────────────────────────────────────┘
```

| Component | Package | Status |
|---|---|---|
| Shared core: cards, signing, rules, offers, events | `packages/core` | <span class="status done">runs</span> |
| House: pod, housekeeper, MCP pod door, wallet | `packages/house` | <span class="status done">runs</span> |
| Lake node: registry, events, counters, relay, intents, blueprints | `packages/lake` | <span class="status done">runs</span> |
| Visitor: `lake knock`, `dispatch`, `attack`, `swarm`, `quoters` | `packages/visitor` | <span class="status done">runs</span> |
| Specialists: ethics, auditor, payments, each pack's issuer and register, the sandbox guides | `packages/specialists` | <span class="status done">runs</span> |
| UI: live map · control panel | `packages/ui` | <span class="status done">runs</span> |
| Agent SDK + Lake MCP connector | `packages/agent` | <span class="status done">runs</span> |
| Use-case packs (health: FHIR converter, studies; mortgage: bank-data converter, lenders) | `usecases/*` | <span class="status done">runs</span> |

## Scale

Houses run in two modes that look identical on the map:

| Mode | How | Used for |
|---|---|---|
| Single | One container per house, its own pod server | Named houses, the live "spin up a house" moment |
| Multi | `lake-house --tenants 250`: many pods and housekeepers in one process | ~1,000 houses on one laptop |

Every multi-mode house is still its own WebID, pod, wallet, card and rules file. Only the process is shared.

```bash
docker compose --profile scale up -d --scale house-multi=4   # about 1,000 houses
```

### Scale, measured

On a 4-core, 16 GB laptop that was also running other work (load average around 3.5), a full paid mission (`lake dispatch --extra-fields postcode`: knock, bloc counter, re-offer, countersign, compute in place, pay, file receipts):

| Houses | Joined after | Mission | Answered and paid | Records moved |
|---|---|---|---|---|
| 250 (1 process) | 95 s warm restart | **57 s** at concurrency 64 | 200 of 200 willing | 0 |
| 1,000 (4 processes) | 279 s warm restart | **636 s** at concurrency 32 | 737 of 801 willing; 64 still busy after 3 retries | 0 |

The time goes into the pod server's file-backed storage: about 5 reads and 4 writes per house per mission, plus DPoP token checks on each. The spec's target of about 60 seconds at 1,000 houses needs dedicated cores, more pod-server processes, or a faster storage backend. [Help wanted](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).

What makes it hold up under load: signed cards and credentials are verified once per process; between full checks a house re-reads only its two data files against the digests its credentials pin; a house that can't read its pod in time answers `busy` instead of declining; agents retry busy or slow houses up to three times; payments settle in batches of 100.

## No model on the hot path

Rules decide. The Lake bundles no LLM and needs no API key. If you want an assistant to write plain-English summaries or drive the Lake, plug your own in through the MCP connector.
