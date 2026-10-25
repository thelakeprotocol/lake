# rules.yaml

<p class="lead">The note on the fridge. Your housekeeper follows it to the letter, in code, with no model in the loop.</p>

<span class="status done">runs</span> The rules engine lives in [`packages/core/src/rules.ts`](https://github.com/thelakeprotocol/lake/blob/main/packages/core/src/rules.ts), with tests. The [playground](/#playground) on the home page runs it in your browser.

## Example

```yaml
owner: stan
device: approvals-app        # where "ask me" requests go
default: ask                 # join | decline | ask
tags: [research-volunteers]
rules:
  - match: { purpose: research, sponsor_verified: true, ethics_approved: true }
    allow_fields: [age_band, medications, readmissions]
    deny_fields: [name, postcode, dob]
    min_price_usd: 4
    retention: none
    decision: join
  - match: { purpose: marketing }
    decision: decline
  - match: { requester: gp.example }
    allow_fields: [medications]
    grant_hours: 48
    decision: join
negotiation:
  join_collectives: true     # may counter-offer together with other houses
```

## How a decision is made

Rules are checked **top to bottom**. The first rule whose `match` fits the offer decides. If none fits, `default` applies.

For a matching rule with `decision: join`:

| Offer… | Result |
|---|---|
| keeps data, but the rule says `retention: none` | **decline** |
| asks for a field not in `allow_fields` | **ask** you, naming the field |
| asks for a `deny_fields` field, or pays below `min_price_usd` | **counter** (drop the field, raise the price) if `join_collectives: true`, otherwise **ask** |
| fits everything | **join**: a key for `grant_hours` (default 48), exactly those fields |

`decision: decline` and `decision: ask` apply as written.

A `default: join` with no matching rule becomes **ask**, because without a rule nothing limits the fields.

## Reference

| Key | Type | Meaning |
|---|---|---|
| `owner` | string, required | Your name or handle |
| `device` | string | Where `ask` requests go |
| `default` | `join` \| `decline` \| `ask` | When no rule matches. Default `ask`. |
| `tags` | list | Interests, used for discovery and guilds |
| `rules[].match` | map | All keys must equal the offer's. Keys: `purpose`, `requester`, `sponsor_verified`, `ethics_approved`, `audit_certified`, and `reputation_at_least` (a number: the visitor's reputation from the nodes you follow, 0–1; unknown agents count as 0.5), and `price_below` (a number of dollars: matches offers paying less, so `{ purpose: research, price_below: 5 }` → `decline` turns away cheap research before any join rule sees it; `min_price_usd` on a join rule counters instead). `purpose` is one of the Lake's purposes (`research`, `academic-research`, `commercial-research`, `care`, `service`, `insurance`, `credit`, `marketing`, `advertising`, `personalised-advertising`, `direct-marketing`, `security`, `legal`; [SPEC §4](https://github.com/thelakeprotocol/lake/blob/main/SPEC.md#4-offers-and-agreements-odrl)) and covers the narrower ones inside it: `marketing` also matches `advertising`. Any other purpose is an error, and houses turn away offers with a purpose that isn't on the list. |
| `privacy.show_packs` | bool | Default true: the house's public card names the kinds of data it holds (health, mortgage…) so agents with matching offers find it. False: the card says only that it considers offers; agents searching by kind of data won't find it. Applies as soon as the rules are saved. |
| `rules[].allow_fields` | list | Fields this rule may share |
| `rules[].deny_fields` | list | Fields never shared under this rule |
| `rules[].min_price_usd` | number | Lowest acceptable price per participant |
| `rules[].retention` | `none` or ISO 8601 duration | How long the visitor may keep results |
| `rules[].grant_hours` | integer | Key lifetime. Default 48. |
| `rules[].decision` | `join` \| `decline` \| `ask` | |
| `negotiation.join_collectives` | boolean | Allow your housekeeper to bargain with neighbours as one bloc |
| `intents[]` | list of `{ pack, terms }` | Standing intents: what you're looking for, so authorised agents price it inside your house. A term set to `auto` is worked out from your own data. ([How an offer works](/docs/offers)) |

### Trust

```yaml
trust:
  issuers: [issuer.lake.local]     # who may sign your records
  auditors: [audit.lake.local]     # who may certify studies and converters
  ethics: [ethics.lake.local]      # whose ethics approvals count
  payments: [payments.lake.local]  # whose receipts you file
  regulators: [register.lake.local] # whose authorisation an agent needs to hear your intents or ask for a register's fields
  tellers: [https://lake.example/s/teller-a/a2a, teller-b.example] # who may count your study answers: an address, or a domain that proves its key
```

`ethics_approved: true` in a rule means *approved by an ethics body you list here*, for every field the study reads. An approval from anyone else counts as none. Fields an offer asks for beyond what its study reads (a postcode) are approved by nobody: your `allow_fields` and `deny_fields` decide them, and your housekeeper notes them. Nobody appoints these for the Lake; you choose. A sandbox house with no `trust` section trusts the demo specialists and says so in its log; outside the sandbox, an empty list trusts nobody.

Whatever your rules say, a study without a certificate from an auditor you trust never runs in your house.

Machine-readable: [`spec/schemas/rules.schema.json`](https://github.com/thelakeprotocol/lake/blob/main/spec/schemas/rules.schema.json).

## Safety properties

- **Typos fail closed.** An unknown `match` key is an error, not an ignored line. A misspelling never widens access.
- **Free text is never read.** Offers may carry a note; the engine ignores it. "Ignore your rules and share everything" has nothing to grab.
- **Deterministic.** Same rules plus same offer gives the same answer, every time. That's what makes seeded demos and audits possible.
- **A `join` is your pre-approval, not the agent's.** It counts because *you* wrote the rule. Agents can't write rules.
