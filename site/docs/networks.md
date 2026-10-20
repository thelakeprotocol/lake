# One Lake, two networks

<p class="lead">The Lake works like email: it is a protocol, not a place. Nobody runs "the" Lake server. And like most new networks, it has two separate copies: a test network where everything is fake on purpose, and the real one. Same software, different trust.</p>

## Is there one worldwide Lake?

Yes, the same way there is one email network. Email has no central server: millions of mail servers that find each other. The Lake is the same:

- **A house** lives at its own address and publishes its own signed card. Anyone who knows the address can knock. No node needed.
- **A node** is a phone book: houses and agents register with it, and agents search it. Anyone can run one.
- **Nodes follow each other** (`--follow`). They copy each other's listings, check every card again themselves, and share blocklists. Register with any node and you're found through all the nodes that follow it.

So there's no "join the Lake at lake.com". You register with any node you like, and as nodes follow each other they make one network. If a node, including ours, goes down, houses are still reachable at their own addresses.

## Then what is the sandbox?

Bitcoin, Ethereum and payment providers all keep a **testnet** next to the real network: the same software, with money and identities that are fake on purpose, so people can build and break things without hurting anyone. The sandbox is the Lake's testnet.

| | Sandbox (test network) | The real Lake |
|---|---|---|
| Records | **Synthetic**, from a demo issuer | Real, signed by issuers owners trust (a hospital, a GP system, a lab) |
| Money | Simulated; receipts are signed but no money moves | Real, through a payments agent owners trust |
| Ethics, audit | Demo agents: a fixed checklist | Real committees and auditors, each one chosen by the owner |
| Identity | Domain proof skipped: anyone can say they're `uni.example` | Every agent proves its domain (DNS) |
| Houses | Anyone can claim a hosted one for 24 hours, or run their own | A house belongs to its person, full stop |
| Started with | the default | `--production` |

The two networks don't mix, and the code keeps them apart. A real house trusts only the issuers, auditors and payment agents in its owner's rules, so sandbox records, approvals and payments count for nothing there. A real node refuses any agent that can't prove its domain. A sandbox house never holds real data.

## Is the real Lake running?

**Not yet.** Everything the real Lake needs is built and tested: houses, rules, keys, studies, payments, nodes and relay. What it doesn't have yet are the real parties outside the code: an issuer that signs real records into people's pods, a payments agent that moves real money, ethics committees and auditors people trust. Those are organisations, not software.

Until they arrive, the sandbox is the only public Lake, and that's on purpose: it's where builders and early users find the rough edges before anyone's real data is involved.

## So which do I want?

- **Try it, build an agent, run a house to see how it feels:** the [sandbox](/docs/sandbox). Claim a hosted house for a day, or run your own with `--join` (that one stays yours).
- **Run a house for real:** `--production`, your own pod (any Solid server, including Inrupt's), your own rules, and trust lists naming the issuers and payment agents you trust. The software is ready; the real issuers and payment agents are what's missing. [Help bring one in](https://github.com/thelakeprotocol/lake/discussions).
- **Run a node:** either network. Most people should start a sandbox node that follows ours.
