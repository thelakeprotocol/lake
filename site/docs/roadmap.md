# Roadmap

<p class="lead">Ten milestones, in build order. Each one ends with something you can run.</p>

| # | Milestone | Done when | Status |
|---|---|---|---|
| 0 | **Core + spec** | Signed cards, signed messages, rules engine, collective counter, ODRL offers, `SPEC.md`, schemas, model | <span class="status done">done</span> |
| 1 | **One house** | Pod, WebID, issuer-signed synthetic record, housekeeper answering an A2A request through MCP | <span class="status next">next</span> |
| 2 | **The Lake** | A federatable node: verified cards, bus, event stream, a bare map where houses appear | <span class="status later">later</span> |
| 3 | **Mission, no money** | Ethics, audit, knock, decide, grant, verify signatures, compute in place, answer | <span class="status later">later</span> |
| 4 | **Approvals app** | Live Allow on a phone; revocation in under 1 second | <span class="status later">later</span> |
| 5 | **Money** | ODRL agreements, collective counter-offer, AP2 mandates, Payments agent | <span class="status later">later</span> |
| 6 | **Wild life** | Swarm, attackers, prompt-injection defence, quarantine, guilds, reputation | <span class="status later">later</span> |
| 7 | **Scale** | 1,000 houses, a full mission in about 60 seconds | <span class="status later">later</span> |
| 8 | **Federation** | Second node, `.well-known` discovery, direct messaging, shared blocklists; stop a node mid-mission and finish anyway | <span class="status later">later</span> |
| 9 | **Open door** | Agent SDK, Lake MCP connector, public sandbox Lake | <span class="status later">later</span> |
| 10 | **Polish** | Map matches the reference, seeded demo mode, 90-second recording | <span class="status later">later</span> |

## Acceptance tests

The Lake is done when all of these pass:

- `docker compose up` on a clean laptop starts the Lake with no manual steps.
- A new house appears on the map within 5 seconds.
- A full mission completes at 1,000 houses in about 60 seconds.
- No grant exists that a human didn't approve, live or by standing rule, and the audit log proves it.
- Records moved is 0 after a full mission, computed from pod audit logs, not hard-coded.
- Every attacker request is blocked and logged, prompt injection included.
- Revoking a house's keys cuts its access within 1 second.
- A tampered record fails its signature check; that house is excluded and unpaid.
- Stopping one Lake node mid-mission doesn't stop the mission.
- An agent is findable through its `.well-known` card with every registry offline.
- An outside agent built with the SDK joins and completes a study in the sandbox.
- An AI assistant dispatches a study through the Lake MCP connector.
- Seeded demo mode produces the same run every time.
- Every agreement and receipt can be opened in the owner's pod afterwards.
