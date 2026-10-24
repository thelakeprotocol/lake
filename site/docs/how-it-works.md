# How a study works

<p class="lead">One question, start to answer: <em>“Do over-60s on drug X get readmitted less?”</em> About a minute, a thousand houses, zero records moved.</p>

```
dispatch ─▶ mandate ─▶ ethics ─▶ audit ─▶ knock ─▶ decide ─▶ bargain ─▶ grant ─▶ compute ─▶ pay ─▶ answer
```

Every step is a signed message over open standards, and every step emits an event the map animates.

## 1. Mandate

A human at the research organisation signs an **AP2 Intent Mandate**: this study only, budget capped at $5,000. It goes into the agent's wallet. Within the cap the agent pays on its own; above it, a human must approve.

```bash
lake dispatch --goal "Do over-60s on drug X get readmitted less?" --price 2 --budget 5000
```

## 2. Ethics

The agent sends its study protocol to the **Ethics** agent over A2A and gets back a signed approval credential.

## 3. Audit

It submits its study code to the **Auditor**, which checks the code returns only aggregates, stores nothing and has no network access. It gets back a signed certificate. Code without one never runs in a house.

## 4. Discover and knock

The agent asks the Lake registry for houses advertising the `health-study` skill, then broadcasts one **ODRL offer**:

> purpose: research · fields: age band, medications, readmissions, postcode · retention: none · price: $2 · credentials attached

## 5. Decide

Each housekeeper evaluates the offer against its owner's [`rules.yaml`](/docs/rules) **in code**: `join`, `decline`, `ask` or `counter`. An `ask` buzzes the owner's phone. The offer's free text is never read.

## 6. Bargain

Housekeepers that countered the same offer, and whose owners opted into collectives, form a bloc. The bloc asks for the **highest** minimum price and **only the fields every member accepts**:

> $2 → **$5**, and the postcode is dropped.

The agent accepts because $5 × participants fits the mandate.

## 7. Agree and grant

Each joining house signs the final **ODRL Agreement** and stores it in `/agreements/`. Its owner's standing rule, or a live tap on Allow, issues a **48-hour Access Grant** that matches the agreement exactly. The contract and the key cannot drift apart.

## 8. Compute in place

The study is a declaration, not code: a few yes/no questions about canonical fields. It runs **inside each house**. Before answering, the house re-verifies its chain: a trusted issuer signed the original, the original is unchanged, a trusted auditor certified the converter, the converted record is the housekeeper's signed copy. A tampered house drops out.

Then it reads only the granted fields through its pod's MCP door and works out, truthfully, which cell of the table its owner falls in. That answer leaves only as **two pieces**, one to each of the study's two **tellers** (run by different parties). Each piece on its own is a random number. Each teller adds up the pieces it got and publishes one sum, once; the two sums together are the exact table. Nobody sees a single house's answer, and nothing is blurred. Every computation goes in the house's audit log with `recordsOut: 0`.

## 9. Pay

The **Payments** agent verifies the mandate chain and settles $5 with each participant. A receipt lands in every pod's `/receipts/`. Settlement is simulated; the signed mandates are real.

## 10. Answer

The agent closes the count at both tellers over the same houses, adds the two sums into the exact table, and publishes `study.result`. Too few houses (under the study's minimum), and no table is published at all. The **Records moved** counter, computed from pod audit logs rather than hard-coded, reads **0**.

Grants expire after 48 hours, or the moment an owner revokes them.
