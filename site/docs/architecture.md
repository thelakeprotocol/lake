# Architecture

<p class="lead">Five kinds of component, each its own container. Everything an agent does crosses the Lake as a signed A2A message, and nothing reaches a pod except through its own housekeeper.</p>

```
                       ┌──────────────────────────────┐
                       │   lake-ui: map + approvals    │◀─ owner taps Allow
                       └──────────────▲───────────────┘
                                      │ WebSocket events (ids, kinds, counts)
┌──────────────┐   A2A   ┌────────────┴─────────────┐   A2A   ┌──────────────────────┐
│ visitor      │────────▶│  Lake node(s)            │◀───────▶│ house × N            │
│ research     │◀────────│  registry · NATS bus ·   │         │  housekeeper ── MCP ─┼─▶ Solid pod
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
| Lake node: registry, bus, events, counters | `packages/lake` | <span class="status next">next</span> |
| Visitor: `lake knock` CLI · research agent | `packages/visitor` | <span class="status done">knock runs</span> |
| Specialists: issuer · ethics, auditor, payments | `packages/specialists` | <span class="status done">issuer runs</span> |
| Swarm: background traders and attackers | `packages/swarm` | <span class="status later">later</span> |
| UI: map + approvals app | `packages/ui` | <span class="status later">later</span> |
| Agent SDK | `packages/agent` | <span class="status later">later</span> |
| Lake MCP connector | `packages/mcp` | <span class="status later">later</span> |
| FHIR converter | `packages/convert-fhir` | <span class="status done">runs</span> |

## Scale

Houses run in two modes that look identical on the map:

| Mode | How | Used for |
|---|---|---|
| Single | One container per house, its own pod server | Named houses, the live "spin up a house" moment |
| Multi | `lake-house --tenants 250`: many pods and housekeepers in one process | ~1,000 houses on one laptop |

Every multi-mode house is still its own WebID, pod, wallet, card and rules file. Only the process is shared.

## No model on the hot path

Rules decide. The Lake bundles no LLM and needs no API key. If you want an assistant to write plain-English summaries or drive the Lake, plug your own in through the MCP connector.
