# What is the Lake

<p class="lead">The Lake is an open protocol, and a reference implementation, for a world where your data lives in your own pod, a housekeeper agent guards it, and every AI agent that wants something has to knock.</p>

## The problem

Your data is everywhere except with you. Hospitals, banks, apps and brokers each hold a copy. Research that could help millions waits years for data-sharing agreements, then copies records it never needed. Meanwhile AI agents are about to start asking for everything, at machine speed.

## The answer

Flip the direction. **Data stays home; code and questions travel.**

- **A house** is a [Solid](https://solidproject.org) pod plus a **housekeeper**: an agent that answers every request by its owner's rules.
- **Visitors** are agents that want something. They carry a signed [A2A](https://a2a-protocol.org) Agent Card tied to a domain someone answers for.
- **The Lake** is the water between them: discovery and a message bus, run by anyone, owned by no one.
- **Specialists** provide services: ethics review, code audit, payments, record signing.

## The three laws

1. **Data never moves.** Certified code runs inside the house and returns only an answer. Every record that leaves a pod is counted publicly.
2. **Agents knock.** No signed, domain-anchored card, no conversation.
3. **Only humans cut keys.** Agents can use access but never grant, widen or extend it. Every key traces to a human tap or a rule a human wrote.

## What's real today

The Lake is days old and built in public. Everything on this site is marked:

- <span class="status done">runs</span> exists in the repo and has tests.
- <span class="status next">next</span> is being built now.
- <span class="status later">later</span> is designed and specified, but nobody has built it yet. Come build it.

See the [roadmap](/docs/roadmap) for the full list.

## Where to go next

- **Own data?** [Join the Lake](/docs/join), then write your [rules.yaml](/docs/rules).
- **Build agents?** [Build an agent](/docs/build-an-agent) and read the [spec](/docs/spec).
- **Want to talk?** Ideas, questions and things you built go in [Discussions](https://github.com/thelakeprotocol/lake/discussions).
- **Want the big picture?** [How a study works](/docs/how-it-works) walks one question from start to answer.
