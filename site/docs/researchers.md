# Ask your own question

<p class="lead">A study on the Lake is a question, and up to four yes/no parts about fields the houses hold. You write it, an auditor certifies it, every house that agrees answers it at home, and you get how many houses fall in each combination. No record leaves a house. This page is for someone who wants to ask something of their own, from an AI connected to the Lake or from a terminal.</p>

What runs today, and on what: the public sandbox, with synthetic data and play money. [How a study works](/docs/how-it-works) walks through one run step by step; the protocol is [SPEC §7](/docs/spec).

## What you can ask about

Ask the Lake. From an AI with the connector (add `?tools=research` to its address so the study tools are listed):

```
lake_dispatch_study { fields: true }
```

From a terminal:

```bash
lake fields
```

Both list every field of the packs loaded there: its name, its kind, how it can be compared, the codes its pack names, and whether a study may read it at all.

| Kind | Compare with | Example |
|---|---|---|
| `band` (an age band, an income band) | `at_least`, `at_most` (by the band's lower bound), `present` | `age_band` `at_least` `60` |
| `number` | `at_least`, `at_most`, `present` | |
| `code` | `has_code`, `present` | `medications` `has_code` `drug-x` |
| `flag` | `present` | `readmissions` `present` |

On the sandbox the health pack's four fields can be studied: `age_band`, `medications`, `conditions`, `readmissions`. The shopping pack's fields (and, in the local demo, the home-loan pack's) are kept by their registers for agents on them, and no study may read them; the listing says so for each. Nothing that identifies someone (a name, a date of birth, an address) is a field a study can name.

## Write it

A study in its short form:

```json
{
  "question": "Are over-50s with high blood pressure on drug Y readmitted more?",
  "predicates": [
    { "name": "over 50", "field": "age_band", "op": "at_least", "value": 50 },
    { "name": "with hypertension", "field": "conditions", "op": "has_code", "value": "38341003" },
    { "name": "on drug Y", "field": "medications", "op": "has_code", "value": "drug-y" },
    { "name": "readmitted", "field": "readmissions", "op": "present" }
  ]
}
```

- `question` is one sentence, up to 200 characters. Owners who are asked see it, marked as your words.
- `predicates` are the one to four yes/no parts. Each `name` (up to 60 characters) labels a row of your result; put the outcome last and the exposure before it, and the answer compares the outcome with and without the exposure, among the houses the earlier parts hold for.
- `min` (optional, default 3) is the fewest answers a table may come from. Both tellers hold the count to it, and refuse a study whose `min` is under their own floor: 3 on a sandbox, 20 elsewhere.
- `noise_epsilon` (optional) asks the two tellers to add noise to the table they release: above 0 and at most 2, and smaller is more noise (at 1 a cell is off by about four, at 2 by about two). The answer then says how much each cell may be off. Owners are told whether a study has it.

Two tellers are picked from the Lake when you name none.

## Check it for free

```
lake_dispatch_study { study: { question, predicates }, check_only: true }
```

Nothing is offered or paid. The ethics agent and the auditor look at it, and you get:

- `ethics` and `audit`: `approved` and `certified`, or why not;
- `each_house_counts`: what a house tells its owner it would answer, for example `age band: 50 or more`, `conditions: Hypertension (38341003)`, `medications: Drug Y (drug-y)`, `hospital readmissions: any on record`;
- `notes`: how often the auditor certified this very study lately, so you can ask around before paying for an answer that may exist;
- `houses` and `minimum`: how many houses are on the Lake, and how many must answer for a table.

A study that can't be asked is refused before the Lake hears of it, with the reason: a field no pack declares, a comparison that field's kind doesn't take, an identifying field, a field a register keeps, a question longer than a sentence.

## What an owner sees

A house whose rules leave your study to its owner puts a card on their phone. It shows your question as "Their question", and under it what their house would answer yes or no to, written by the house from the packs' own labels: the lines in `each_house_counts`. Your names for the parts are not shown, and no rule reads your question. What you call a part and what it counts can't come apart on the owner's screen. The card also says what the table is held to: the fewest answers it is published from, and whether noise is added.

After a house answers, its owner finds the same lines under My data → What left your house: who asked, what was counted, that the answer left as two unreadable shares, and what both tellers said the count was held to.

## Run it

```
lake_dispatch_study { study: { question, predicates }, price_usd: 5, budget_usd: 200 }
```

```bash
lake dispatch --study my-study.json --price 5 --budget 200
```

It knocks on every house, bargains with those that counter together, signs agreements, has each joining house answer at home, pays each house that answered from your budget, and returns:

- `participants`, and `decisions` (how many joined, declined, countered or asked their owner);
- `cells`: the count in each combination of your parts;
- `answer.summary`: one sentence, and `answer.table`: how many houses each part held for, the comparison with and without the exposure, whether the counts are exact or noised, and whether any cell is under 5;
- `paid`: what was spent, to how many houses;
- `pending`: houses whose owners were asked and hadn't answered (`wait_seconds` waits for them).

`lake_dispatch_study { evidence_for: <study id> }` gives the signed bundle the result rests on (ethics approval, certificate, mandate, agreements as digests, both tellers' shares, receipts) to show someone else.

`lake dispatch --goal "…"` and `lake_dispatch_study { question }` still run one of the packs' ready studies by its exact wording. Any other wording is refused and told how to write a study; it is no longer answered with the first ready one.

## What this doesn't do yet

- **Only fields a pack lets studies read.** Today that is the health pack's four.
- **A table of yes/no combinations, once.** Up to four parts; no averages, no free-text, no following the same houses over time.
- **No intervals.** The result gives counts and rates, and says when numbers are small; it gives no confidence interval, and no response rate beyond the decisions it lists.
- **The evidence lives in the conversation that ran the study.** A later conversation can't fetch the bundle again.
- **Several studies can be differenced.** Each is certified on its own. The auditor notes repeats of the same study, and nothing yet stops two different studies over the same houses from narrowing down one answer; ask for noise when tables are small.
- **Answers that aren't from houses are not kept out.** The count is opened with your study, both tellers hold it to the study's minimum and noise, and a house answers only into such a count. But a teller takes an answer from any signed agent and doesn't yet check that it is a house with a signed record: the minimum is a number of answers. From an exact table, someone who added answers of their own can subtract them and work out one house's. If your result has to stand up to that, ask for noise, and say so when you publish.
- **Ethics is a checklist**, run by a program: the purpose is research, nothing is kept, no identifying field is asked for, and only the fields the study reads are declared. It is not a review board.
