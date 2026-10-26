# How an offer works

<p class="lead">A study asks many houses one question. An offer runs the other way: <em>one</em> person wants something, and many agents compete to offer it, each priced on that person's real data, inside their house, without seeing it. The first use case: home loans in Australia. Eight lenders, a few seconds, and no lender sees your bank data until you say yes.</p>

```
intent ─▶ authorised lenders hear ─▶ certified program ─▶ runs in your house ─▶ offers only you see ─▶ group rate ─▶ accept ─▶ two files, one lender
```

<video controls muted playsinline preload="none" poster="/demos/home-loans-inside-homes.jpg" style="width:100%;border:1px solid var(--vp-c-divider);border-radius:6px"><source src="/demos/home-loans-inside-homes.mp4" type="video/mp4"></video>

Everything here runs, on synthetic data, in the local demo Lake (`docker compose up`) and in the end-to-end tests. It isn't on the public sandbox. The video is a real run of [`demos/offers`](https://github.com/thelakeprotocol/lake/tree/main/demos#offers-no-claude-in-this-one): a hundred houses, eight lenders, 72 deals in 148 seconds. The protocol is [SPEC §12](/docs/spec).

## 1. Your data, signed

Your bank signs your transactions as a Verifiable Credential (in the demo, a bank that makes up a synthetic person in the shape of a [Consumer Data Right](https://consumerdatastandardsaustralia.github.io/standards/) export). Inside your house, a converter an auditor certified turns twelve months of transactions into five plain facts: yearly income, monthly loan and card repayments, savings, missed payments, employed or self-employed. Account numbers and your name are never readable by any program.

## 2. Say what you're looking for

In your [control panel](/docs/approvals), **Offers**: a state, a price band, a term, first home buyer or not. Or leave the price as **What I can afford**, and your house works it out from your own numbers, without telling anyone how. You can also keep a standing intent in [`rules.yaml`](/docs/rules):

```yaml
intents:
  - pack: mortgage
    terms: { region: qld, price_band: auto, term_years: 30, first_time_buyer: "yes" }
```

These terms are coarse on purpose: "a first home buyer in Queensland, $450–600k" fits thousands of people.

## 3. Only authorised lenders hear

Your house sends the intent to the lenders listed on the Lake, but only to those carrying a signed authorisation from a register you trust (in the demo, a stand-in for ASIC's register of credit licensees). A lender without one never learns you're looking.

The node learns something too, privately: which group you're in. It publishes only how many households share each group, never who, and only once a group is big enough.

## 4. The lender sends rules, not questions

Each lender answers with a **quote program**: its lending rules as a declaration, not code, written in [CEL](https://cel.dev) (Google's Common Expression Language, which can't loop or reach out, and is type-checked before it runs). Rate bands by loan-to-value, lenders mortgage insurance above 80%, the First Home Guarantee under your state's cap, repayments tested at APRA's 3-point buffer against take-home pay after living costs, a debt-to-income cap. An auditor certified the program; your house checks the certificate, checks the program again itself, and checks the lender's authorisation, before running it on your data.

Then it keeps the result. The lender gets the same reply whether you qualify or not: *quoted*. It learns nothing about you.

## 5. Offers only you see

Your panel fills up, cheapest first: *Wattle Mutual, 6.04%, $2,254 a month, First Home Guarantee, no LMI.* Lenders that wouldn't lend say so, to you alone.

No offers yet? Your panel says why, in plain facts, and so does `lake_house { view: "offers" }` for your assistant: how many authorised lenders your house told, and which ones it turned away or couldn't reach, with the reason and the time. If your own record can't price anything (it's missing, or it stopped checking out), your house still opens the intent but warns you at once: no lender's program can run until the record is fixed. A lender whose quote is turned away is told so too, and doesn't take the refusal for a delivered quote.

## 6. Ask together, pay less

As more households join your group, your house learns the new size and runs the lenders' programs again itself: most of them take a little off when three or more of you ask together. The discount is written into each certified program, the same for everyone in the group, so nobody has to be asked again and nothing leaves your house. A household that has accepted an offer still counts in the group for a day, so a neighbour who decides later isn't priced for a smaller group.

## 7. Accept, and only then share

Tap **Accept** on one offer. Now, and only now, your house sends two files to that one lender: the bank-signed original and its credential. It logs what went where, on whose say-so.

The lender checks the bank's signature, runs the same program on the original, and confirms: a **conditional approval**. It pays you the fee it would have paid a broker (in AUD, under its own human's spending mandate), and the receipt lands in your pod.

## What it isn't

The Lake prices, consents and pays; it doesn't deliver. Once you accept a grocer's offer and pay, the shopping itself (picking, packing, the van at your door) is the grocer's, outside the Lake, and nothing here shows it arrived. Money is simulated too, everywhere on the Lake.

A demo of the protocol, not a lender. The lenders, the bank, the register and every person are synthetic. The rules are simplified from real Australian lending ([the full list](https://github.com/thelakeprotocol/lake/tree/main/usecases/mortgage#how-the-demo-lenders-decide)), and an offer is not credit advice. Buying a home involves far more than a loan: valuers, conveyancers, agents, settlement. That's a bigger story, and a later one ([Ideas](/docs/ideas)).

## Run it

```bash
docker compose up -d     # the local Lake runs the bank, the register and eight lenders
```

Or in code: [`usecases/mortgage`](https://github.com/thelakeprotocol/lake/tree/main/usecases/mortgage) holds the pack and the lenders; `lake quoters --packs mortgage` runs them; a house joins with `--packs health,mortgage`. Any other market works the same way: write a pack with intent terms, and quoters with programs.

## A second market: the weekly shop

People already shop with AI by hand: ask it what to buy, photograph the shelf, ask again. On the Lake the shops come to your agent instead, and your details never leave home. [`usecases/shopping`](https://github.com/thelakeprotocol/lake/tree/main/usecases/shopping) is the `shopping@1` pack:

- **Your data:** a receipt wallet signs your grocery receipts; inside your house they become a few facts: how many people, dietary needs (sensitive: they can say something about health or belief), the staples you buy most weeks, your usual spend.
- **Your intent:** "this week's shop, up to $180, delivered this week", in your state. Households on the same street wanting the same get a group price.
- **The offers:** three demo grocers price your basket *inside your house*: a cheap supermarket that can't serve every diet (and makes no offer if it can't serve yours), a local grocer, an organic shop that serves every diet. Only you see the totals, delivery fees, substitutions and whether it's within budget.
- **Accept:** only your shopping list goes, to that one grocer, not your receipts. It confirms the order; your house tells your agent, and it pays under the [spending allowance](/docs/approvals) you signed (in AUD, the shops' currency), naming the order on the receipt. An offer that isn't for you says why ("we can't cater for: nut allergy"), and one that swaps a staple says which, worked out in your house for you only.

`lake quoters --packs shopping` runs the grocers; a house joins with `--packs health,shopping`.
