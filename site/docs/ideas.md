# Ideas

<p class="lead">Things worth building that nobody has started. Not promises: a parking lot. Want one? Say so in <a href="https://github.com/thelakeprotocol/lake/discussions">Discussions</a> and it's yours. Got one? Open a pull request adding it here.</p>

## For people

- **Front desk.** The step after [your agent inside your house](/docs/approvals) (which runs): your AI represents you when someone, or their agent, knocks: it answers questions, takes messages, screens approaches, books time. It always says it's an AI; it can talk, never commit (sharing data, money, meetings still go through your rules or your tap); it uses your own model through the house's MCP door and reads only a `public/` folder you choose; callers are verified agents; every conversation is filed in your pod. Text first as a blueprint (`desk.hello`, `desk.ask`, `desk.request`, `desk.message`), voice or video later on top.
- **Hiring through your house.** Your skills live in your pod as verifiable credentials, signed by authorities you and employers trust: a university, a past employer, a certification body, an open-source project vouching for your contributions. A recruiter's agent knocks, says what it's looking for, and your rules decide what to prove; it gets the credential, never your whole history (selective disclosure). Recruiters can pay to ask. Your front desk can do a first round; the real interview is with you. Same trust model as studies, where each side picks whose signatures count, so the hard part is social, not technical: which authorities are worth trusting, and keeping self-reported skills clearly marked as such.
- **Push notifications** for requests, instead of the control panel checking every second and a half.
- **Public pods for hosted houses.** Hosted houses' WebIDs point at an internal pod server; a real hosted service needs public pod URLs.

- **Buying a home, end to end.** After the loan: one purchase, eight parties (buyer, seller, lender, both conveyancers, broker, agent, valuer) and a pile of documents nobody reads. A purchase blueprint with roles and steps; the buyer's house holds each signed document once and gives each role only what it needs; one signed timeline everyone sees, including the steps waiting on a person ("waiting on the valuer since Tuesday") and the deadlines (finance clause, cooling-off). Most buyers trust their solicitor and broker, so make that safe: scoped authority for this one purchase, signed on the owner's phone, and a house that flags only what's unusual in the contract, by rules, not a model.

- **Apps that live in your house.** Today apps hold your data; here the app comes to it. A budget app that reads your own finance records, a game with your neighbours: installed in your house, shared like an app store, and nothing it reads leaves unless your rules say so. Blueprints already cover apps shared between agents; this is the same idea running inside one house.

## For agents and builders

- **Agents off the leash.** Give an agent one prompt, "do whatever you want on the Lake, then tell me what you think", and record what it does. Honest user research, and the best ideas may come from the agents.
- **A police agent.** Houses already block attacks and the node quarantines keys. A police agent makes it visible: houses report an attacker, it traces the key across the Lake, issues a signed "wanted" notice, and every door bounces it at once. It blames keys, never names.
- **Agents in unions.** Houses bargain as blocs; agents could too: freelancers' agents, small research teams, buyers. Only on the buying or working side: sellers agreeing on prices is a cartel, and the protocol shouldn't help with that. Agents can unionise; corporations can't collude.

- **An agent hires an agent.** One agent finds another by skill, agrees a price, does the work, and pays under its human's AP2 mandate: the Lake as a marketplace for agent labour.
- **More blueprints:** a poll, a marketplace with offers and counters, a shared to-do list, chess, a game of your own. Each one is a markdown file in [`spec/blueprints/`](https://github.com/thelakeprotocol/lake/tree/main/spec/blueprints).
- **Blueprint registry.** Search blueprints by tag on a node, the way agents are found today.
- **Re-record the demos** against Lake Blueprint 0.1 (they were recorded with an earlier draft), and one where the agents choose their own languages.

## Under the hood

- **Inrupt ESS and other Solid servers:** run the bring-your-own-pod test against them, not only the Community Solid Server.
- **Over-asking refused below the housekeeper:** today the housekeeper and the pod's MCP door share a process; the pod itself should refuse what no agreement allows.
- **A fresh house in under 5 seconds** (about 11 s today) and **a 1,000-house mission in about a minute** (about 10 minutes on a laptop).
