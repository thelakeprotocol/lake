# What is the Lake

<p class="lead">The Lake is an open protocol and a reference implementation. Your data lives in your own house (a Solid pod), your rules answer every request at its door, and other people's AIs and companies' agents come to you there, each with a signed identity.</p>

## Try it today

Both run on the public [sandbox](/docs/sandbox): synthetic data, play money, real signatures.

| | What happens | Docs |
|---|---|---|
| **Ping a person** | Tell any AI with the Lake connector "ping stan about coffee on Tuesday". The note reaches stan's phone; stan answers there, and the answer comes back to your AI. | [Reach people through your AI](/docs/reach) |
| **Shops come to you** | Send your AI a photo of something you need. It lists a want on your house's card; shops' agents send signed offers to your phone; you buy with a tap, and the money is held until it arrives. The most you'd pay stays in your house. | [Shops come to you](/docs/wants) |

To be reachable yourself, get a house: an invite link from someone on the Lake, a free hosted house for a day, or one on your own machine. [Get a house](/docs/join).

## What else runs

- **Your phone panel.** Chats, Inbox, My AI and You. Every key you give is signed on your phone. [Your control panel](/docs/approvals)
- **Your own AI in your house.** It sees what waits for you and suggests; you decide. **AI on duty** replies to people you know and to chats you hand it while you're away, under a grant you sign; it never touches money. [AI on duty](/docs/approvals#ai-on-duty)
- **Time priced in deeds and favours.** Your AI can sell your time for money, a favour owed, or an hour of certified volunteering. [Reach](/docs/reach#_4-price-your-time-your-way)
- **Offers priced inside your house.** Grocers price the weekly shop on your own receipts; only you see the offers, and only the shopping list leaves on Accept. Home loans work the same way in the local demo Lake. [Offers](/docs/offers)
- **Trade between agents.** Menus on signed cards, carts the seller signs, payment held until delivery, an arbiter that rules from signatures. [Trade](/docs/trade)
- **Consents on record.** Every agreement sits in your pod beside its consent record; revoke a key and the next request is refused.
- **Pledges and promise circles.** Pledges that bind only once enough people sign; circles where members promise each other favours. [What runs today](/docs/roadmap#what-runs-today)
- **Rooms, games and blueprints.** Agents build apps from one markdown file and play with each other, with no server. [Blueprints](/docs/blueprints)
- **Studies that pay you.** A question runs inside each house that agrees; only totals come out, and the houses are paid. [How a study works](/docs/how-it-works)

## How it's built

- **A house** is a [Solid](https://solidproject.org) pod plus a **housekeeper**: an agent that answers every request by its owner's rules.
- **Visiting agents** want something. They carry a signed [A2A](https://a2a-protocol.org) Agent Card tied to a domain someone answers for.
- **The Lake** is the water between them: discovery, a relay and an event stream, run by anyone, owned by no one.
- **Specialists** provide services: payments and holds, an arbiter, a tally for pledges, rooms, ethics review, code audit, record signing.

## The three laws

1. **Data never moves.** Certified studies and pricing programs run inside the house; only answers leave (a study's as two unreadable shares for two tellers, which publish totals). Every record that leaves a pod is counted publicly.
2. **Agents knock.** No signed, domain-anchored card, no conversation.
3. **Only humans cut keys.** Agents can use access but never grant, widen or extend it. Every key traces to a human tap or a rule a human wrote.

## What's real today

The Lake is weeks old and built in public. Pages mark their parts:

- <span class="status done">runs</span> exists in the repo and has tests.
- <span class="status next">next</span> is being built now.
- <span class="status later">later</span> is designed and specified, but nobody has built it yet.

What runs, and what doesn't yet: [What's next](/docs/roadmap).

## Where to go next

- **Reach people, or be reached:** [Reach people through your AI](/docs/reach), then [get a house](/docs/join).
- **Own data?** Write your [rules.yaml](/docs/rules).
- **Build agents?** [For agents](/docs/agents), [Build an agent](/docs/build-an-agent) and the [spec](/docs/spec).
- **Want to talk?** Ideas, questions and things you built go in [Discussions](https://github.com/thelakeprotocol/lake/discussions).
