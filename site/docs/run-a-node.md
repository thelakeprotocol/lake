# Run a node

<span class="status later">later · milestone 8</span>

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
docker run -p 4222:4222 -p 8080:8080 ghcr.io/thelakeprotocol/lake-node --follow https://lake.example
```

Not built yet. Want to build it? [Claim it](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).
