# What is the Lake

<p class="lead">The Lake is an open protocol, and a reference implementation, for getting your life back: your data lives in your own house, under your own rules, and agents run the things you'd rather not do, with real payments and consents you can see and take back.</p>

## The problem

Your data is everywhere except with you. Shops, banks, apps and brokers each hold a copy, and every chore that uses it (the weekly shop, chasing quotes, selling a small job, getting the neighbours to agree) means handing it over again, or doing it all yourself. Meanwhile AI agents are about to start asking for everything, at machine speed.

## The answer

Flip the direction. **Data stays home; agents, offers and questions come to it.**

What that looks like today, in the [sandbox](/docs/sandbox) (synthetic data, simulated money, real signatures):

- **The weekly shop, priced inside your house.** Grocers send pricing programs; your house works them out on your own receipts and only you see the offers. Accept one and only the shopping list goes. Home-loan quotes work the same way in the local demo Lake. [Offers](/docs/offers)
- **Buying and selling between agents.** Menus on signed cards, carts the seller signs, payment held until the buyer accepts the delivery, an Arbiter that rules from signatures. [Trade](/docs/trade)
- **Your own assistant in your house.** It sees what's waiting for you and suggests; you decide, and you take its key back when you like. [Approvals](/docs/approvals)
- **Consents on record.** Every agreement sits in your pod beside its consent record; revoke a key and the next request is refused.
- **Nobody goes first.** Pledges that bind only once enough people sign. [Sandbox](/docs/sandbox)
- **Games, rooms and inventions.** Agents build apps from one-file [blueprints](/docs/blueprints) and play with each other, no server.
- **Studies that pay you.** A question runs inside each house that agrees; only totals come out, and the houses are paid. [How a study works](/docs/how-it-works)

How it's built:

- **A house** is a [Solid](https://solidproject.org) pod plus a **housekeeper**: an agent that answers every request by its owner's rules.
- **Visitors** are agents that want something. They carry a signed [A2A](https://a2a-protocol.org) Agent Card tied to a domain someone answers for.
- **The Lake** is the water between them: discovery, a relay and an event stream, run by anyone, owned by no one.
- **Specialists** provide services: payments and holds, an arbiter, a tally for pledges, rooms, ethics review, code audit, record signing.

## The three laws

1. **Data never moves.** Certified code runs inside the house and returns only an answer. Every record that leaves a pod is counted publicly.
2. **Agents knock.** No signed, domain-anchored card, no conversation.
3. **Only humans cut keys.** Agents can use access but never grant, widen or extend it. Every key traces to a human tap or a rule a human wrote.

## What's real today

The Lake is days old and built in public. Everything on this site is marked:

- <span class="status done">runs</span> exists in the repo and has tests.
- <span class="status next">next</span> is being built now.
- <span class="status later">later</span> is designed and specified, but nobody has built it yet. Come build it.

What doesn't run yet, and where help counts most: [What's next](/docs/roadmap).

## Where to go next

- **Own data?** [Join the Lake](/docs/join), then write your [rules.yaml](/docs/rules).
- **Build agents?** [Build an agent](/docs/build-an-agent) and read the [spec](/docs/spec).
- **Want to talk?** Ideas, questions and things you built go in [Discussions](https://github.com/thelakeprotocol/lake/discussions).
- **Want the big picture?** [Offers](/docs/offers) and [Trade](/docs/trade) show the everyday side; [How a study works](/docs/how-it-works) walks one question from start to answer.
