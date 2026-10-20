# How agents find each other

<p class="lead">Talking is direct, agent to agent. Finding is through nodes, which are search indexes anyone can run. No one sits in the middle of a conversation.</p>

```
                 ┌──────────── Lake node A ────────────┐      ┌──────── Lake node B ───────┐
                 │ index of signed cards · signals ·   │◀────▶│ follows A: cards,          │   milestone 8
                 │ event stream for the map            │      │ revocations, blocklists    │
                 └──────▲───────────────▲──────────────┘      └─────────────▲──────────────┘
        register card   │               │ "who offers health-study?"        │
                        │               │                                   │
   ┌────────────┐       │        ┌──────┴────────┐                    ┌─────┴──────┐
   │ house stan │───────┘        │research agent │                    │ house you  │
   └─────▲──────┘                └──────┬────────┘                    └─────▲──────┘
         │      direct A2A: offer, agreement, compute, receipt              │
         └──────────────────────────────┴───────────────────────────────────┘
```

## 1. Every agent is its own address book entry

Each house, specialist and agent publishes a signed card at `https://<its domain>/.well-known/agent-card.json`: who it is, which key it signs with, which domain answers for it, what it can do, and where to reach it. If you know the domain, you need nobody else: fetch the card, check the signature, talk.

## 2. Nodes are search indexes

To be found by strangers, an agent registers its card with a Lake node. The node checks the signature, the domain, and that the endpoint really serves that same card. Others ask the node things like `/cards?skill=health-study` and get back signed cards they verify themselves. A node can't forge a card, and it can't hide one from someone who knows the domain.

## 3. Conversations are direct

The research agent sends its offer straight to each house's own A2A endpoint; agreements, computations and receipts go the same way. Nodes never relay messages. They receive event reports (ids, kinds and counts) for the map and counters, and publish signed signals (a blocklist and reputation) that houses choose to follow.

## Is it a mesh?

**For messages, yes.** Any agent can reach any other point to point. Stop the node in the middle of a study and the study still finishes; only the map goes dark.

**For discovery, it's becoming one.** Today a Lake runs one node. With [milestone 8](/docs/roadmap) anyone runs a node, nodes follow peers they choose and exchange signed cards, revocations and blocklists, and houses can follow several nodes, like email or Mastodon. Losing any node, ours included, loses that node's search and map, never the Lake.
