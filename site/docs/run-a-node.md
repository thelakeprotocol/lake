# Run a node

<span class="status done">runs</span> registry, event stream, counters, live map · <span class="status later">later</span> NATS bus (milestone 3), federation (milestone 8)

<p class="lead">A Lake node is the water, not the fish. It routes and records. It holds no personal data and makes no decisions.</p>

## What a node does

| Part | Job |
|---|---|
| **Registry** | Stores signed Agent Cards and answers searches by skill or tag. Verifies every signature and domain proof; rejects unsigned cards. |
| **Bus** | [NATS](https://nats.io) for A2A message transport and broadcast ("knock on every house"). An optimisation; agents can always message each other directly. |
| **Event stream** | A WebSocket feed of every observable event, carrying ids, kinds and counts only. It feeds the map and the approvals app. |
| **Counters** | Houses, agents, conversations, value settled, attacks blocked, and **records moved**, computed from pod audit logs. |

## Federation

- Anyone can run a node. You choose which peers to follow.
- Nodes exchange signed cards and revocation notices.
- Nodes publish and subscribe to blocklists and reputation signals. You choose which lists you trust, like spam filters.
- Registries are search indexes, not gatekeepers. Every agent stays reachable through its `.well-known` card with every registry offline.
- Losing any node, ours included, must not stop a running mission. The reference demo proves it by stopping a node mid-mission.

## Running one

```bash
docker run -p 7000:7000 ghcr.io/thelakeprotocol/lake-node --domain lake.example --url https://lake.example
```

Open `http://localhost:7000` for the live map. Participants join with `--lake <node url>` (or `LAKE_NODE_URL`).

| Endpoint | Does |
|---|---|
| `POST /register` `{ card }` | Verifies the card's signature and domain, then fetches the card from the endpoint it names and requires the same signed card. Refusals show on the map as blocked attacks. |
| `GET /cards?skill=&tag=&role=` | Search. A convenience: every card also lives at its own `.well-known` path |
| `POST /events` | A signed batch of events from a registered participant. The node stamps the actor itself and cuts long strings, so nobody can speak for someone else or smuggle data through |
| `GET /state` | Counters and participants |
| `WS /events` | A snapshot, then every event as one plain-English line plus counters |
| `GET /.well-known/agent-card.json` | The node's own signed card (`role: node`) |

The node keeps everything in memory. Restart it and participants re-register on their next start; nothing personal is lost, because nothing personal was ever there.

Following other nodes and sharing blocklists is [milestone 8](/docs/roadmap). Want to build it? [Claim it](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).
