# Roadmap

<p class="lead">Ten milestones, in build order. Each one ends with something you can run.</p>

| # | Milestone | Done when | Status |
|---|---|---|---|
| 0 | **Core + spec** | Signed cards, signed messages, rules engine, collective counter, ODRL offers, `SPEC.md`, schemas, model | <span class="status done">done</span> |
| 1 | **One house** | Pod, WebID, issuer-signed synthetic record, housekeeper answering an A2A request through MCP | <span class="status done">done</span> |
| 2 | **The Lake** | A federatable node: verified cards, bus, event stream, a bare map where houses appear | <span class="status done">done</span> (bus moves to M3, with broadcast) |
| 3 | **Mission, no money** | Ethics, audit, knock, decide, grant, verify signatures, compute in place, answer | <span class="status done">done</span> |
| 4 | **Approvals app** | Live Allow on a phone; revocation in under 1 second | <span class="status done">done</span> |
| 5 | **Money** | ODRL agreements, collective counter-offer, AP2 mandates, Payments agent | <span class="status done">done</span> |
| 6 | **Wild life** | Swarm, attackers, prompt-injection defence, quarantine, guilds, reputation | <span class="status done">done</span> |
| 7 | **Scale** | 1,000 houses, a full mission in about 60 seconds | <span class="status done">runs</span> 1,000 houses complete a paid mission; 10.6 min on a busy 4-core laptop, [measured](/docs/architecture#scale-measured) |
| 8 | **Federation** | Second node, `.well-known` discovery, direct messaging, shared blocklists; stop a node mid-mission and finish anyway | <span class="status done">done</span> |
| 9 | **Open door** | Agent SDK, Lake MCP connector, public sandbox Lake | <span class="status done">done</span> (sandbox live) |
| 10 | **Polish** | Map matches the reference, seeded demo mode, 90-second recording | <span class="status done">done</span> |

## Acceptance tests

The spec's acceptance criteria, as they stand. Measured on a busy 4-core laptop.

| | Criterion | Status |
|---|---|---|
| ✅ | `docker compose up` starts the Lake with no manual steps | No API key needed at all: the Lake bundles no LLM |
| ⚠️ | A new house appears on the map within 5 seconds | About 11 s for a fresh house here; the pod server's boot dominates |
| ⚠️ | A full mission at 1,000 houses in about 60 seconds | 57 s at 250 houses; 636 s at 1,000 ([measured](/docs/architecture#scale-measured)) |
| ✅ | No grant exists that a human did not approve, live or by standing rule | Live grants are signed on the owner's phone; standing-rule grants name the rule and its digest; all filed in `/agreements/` |
| ✅ | Records moved is 0, computed from pod audit logs | Summed from each house's `compute.done` audit entries |
| ✅ | Every attacker request is blocked and logged, prompt injection included | Tested end to end |
| ✅ | Revoking a house's keys cuts access within 1 second | Tested end to end |
| ✅ | A tampered record fails its check; that house is excluded and unpaid | Tested end to end |
| ✅ | Stopping one node mid-mission does not stop the mission | Tested end to end and shown in Docker |
| ✅ | An agent can be found through its `.well-known` card with every registry offline | Tested end to end; `lake card <url>` |
| ✅ | An outside agent built with the SDK joins and completes a study in the sandbox | Tested end to end (local sandbox) |
| ✅ | An assistant dispatches a study through the Lake MCP connector | Tested with an MCP client; setup documented for Claude Code and Desktop |
| ✅ | Seeded demo mode produces the same run every time | Tested end to end |
| ✅ | Every agreement and receipt can be opened in the owner's pod | `/agreements/` and `/receipts/`, tested |
