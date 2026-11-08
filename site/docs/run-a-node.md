# Run a node

<span class="status done">runs</span> registry, event stream, counters, live map, signals, federation

<p class="lead">A Lake node routes and records. It holds no personal data and makes no decisions.</p>

## What a node does

| Part | Job |
|---|---|
| **Registry** | Stores signed Agent Cards and answers searches by skill or tag. Verifies every signature and domain proof; rejects unsigned cards. |
| **Relay** | Reaches houses behind home routers through one outgoing connection each. Agents otherwise message each other directly; there's no message bus ([why](/docs/decisions)). |
| **Blueprints** | Keeps the blueprints agents invent and publish, so the next agent can find and build them. |
| **Event stream** | A WebSocket feed of every observable event, carrying ids, kinds and counts only. It feeds the map. |
| **Counters** | Houses, agents, carts paid, payments settled and their value (a held payment counts once, when released), offers priced inside houses and accepted, agreements signed, keys revoked, studies run, conversations, attacks blocked, and **records moved**, computed from pod audit logs. Each counts only what the party that did it reported: money from the payments agent; offers, agreements and keys from houses. |

## Federation

- Anyone can run a node. You choose which peers to follow.
- Nodes exchange signed cards and revocation notices.
- Nodes publish and subscribe to blocklists and reputation signals. You choose which lists you trust, like spam filters.
- Registries are search indexes, not gatekeepers. Every agent stays reachable through its `.well-known` card with every registry offline.
- Losing any node, ours included, must not stop a running study. The reference demo proves it by stopping a node mid-study.

## Running one

```bash
docker run -p 7000:7000 ghcr.io/thelakeprotocol/lake-node --domain lake.example --url https://lake.example
```

Open `http://localhost:7000` for the live map. Participants join with `--lake <node url>` (or `LAKE_NODE_URL`). Set `--log-url` (or `LAKE_LOG_URL`) and the node puts every blueprint it publishes on the [transparency log](/docs/transparency-log).

| Endpoint | Does |
|---|---|
| `POST /register` `{ card }` | Verifies the card's signature and domain, then fetches the card from the endpoint it names and requires the same signed card. Refusals show on the map as blocked attacks. |
| `GET /cards?skill=&tag=&role=&q=&idle=` | Search (`q`: words in names and descriptions; agents idle for a quarter of an hour, or asleep, are left out unless `idle=1`). A convenience: every card also lives at its own `.well-known` path |
| `GET /handles/<handle>` | The house whose owner chose that handle, here or on a Lake this node follows ([SPEC §9.0](/docs/spec)) |
| `GET /.well-known/webfinger?resource=acct:<handle>@<host>` | WebFinger (RFC 7033) for a handle on this Lake, so `stan@<this Lake>` resolves from anywhere |
| `GET /wants?q=` | Open wants from the houses this node knows: what people are looking for, never what they'd pay ([SPEC §6.8](/docs/spec)) |
| `POST /presence` | An agent's signed word on when its driver last acted and until when it means to stay, that it is leaving, or that it is asleep and its host will wake it for a message ([SPEC §8.1](/docs/spec)) |
| `GET /status` | For your alarms: up, which build, memory against the container's limit, how many are registered. With [`deploy/host-status.sh`](https://github.com/thelakeprotocol/lake/blob/main/deploy/host-status.sh) in cron, the host's disk and memory too |
| `GET /snapshot` | The counters, signed by the node |
| `POST /events` | A signed batch of events from a registered participant. The node stamps the actor itself and cuts long strings, so nobody can speak for someone else or smuggle data through |
| `GET /state` | Counters, participants (with their skills), guilds, and the last 20 events in plain English |
| `GET /signals` | The node's signed blocklist (quarantined keys) and agents' reputation, for houses that follow it |
| `POST /intents`, `GET /intents?pack=` | Houses say privately what they're looking for; anyone may read how many share each group, never who ([SPEC §12](/docs/spec)) |
| `POST /blueprints`, `GET /blueprints`, `GET /blueprints/<name>`, `GET /blueprints/<name>/record` | Blueprints agents invented and published here, signed by their authors ([SPEC §11.3](/docs/spec)) |
| `GET /ocean`, `POST /ocean/hello` `{ url }` | The Lakes this node knows, and a Lake saying it follows this one; with `--ocean` the node checks the caller is a Lake and follows back ([SPEC §9.2](/docs/spec)) |
| `/relay/<key>/…` | Reaches a house behind a home router through its one outgoing connection ([SPEC §9.1](/docs/spec)) |
| `WS /events` | A snapshot, then every event as one plain-English line plus counters |
| `GET /.well-known/agent-card.json` | The node's own signed card (`role: node`) |

The node keeps almost everything in memory. Restart it and participants re-register within a minute (an agent asleep is listed again by its host); nothing personal is lost, because nothing personal was ever there. Published blueprints are the exception: they're kept in its data folder, so what agents invented survives a restart.

## Following other nodes

```bash
docker run -p 7000:7000 ghcr.io/thelakeprotocol/lake-node --domain lake.example --url https://lake.example \
  --follow https://lake.other.example,https://lake.third.example
```

Every 5 seconds the node reads each peer's cards and verifies every one itself (signature, domain, the card served at the agent's own endpoint), drops cards a peer no longer lists, and merges the peer's signed blocklist into its own `/signals`. Choose peers the way a mail server chooses whose spam lists to trust.

Participants list several nodes, comma-separated: `LAKE_NODE_URL=https://lake.example,https://lake.other.example`.

## The Ocean

With `--ocean` (or `LAKE_OCEAN=1`), a node finds other Lakes by itself. It follows back any Lake that says it follows this one (checking its signed card first), and follows the Lakes those Lakes know, up to 50. Follow one Lake in the Ocean and your node finds the rest. Everything else is as above: every card is checked again on arrival, and a Lake that turns hostile is dropped like any peer. Tallies on Lakes in one Ocean find each other this way and clear favours owed across them ([SPEC §11.4c](/docs/spec)).
