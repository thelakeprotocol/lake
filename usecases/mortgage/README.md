# @thelakeprotocol/usecase-mortgage

**The `mortgage@1` pack.** Australian home-loan offers on the Lake: lenders price you inside your house, on your own bank data, and only you see the offers. Nothing leaves until you accept one. How it works: [How an offer works](https://lake.doneinfifty.com/docs/offers).

| | |
|---|---|
| Fields | `income_annual`, `monthly_commitments`, `savings`, `missed_payments_12m` (numbers, AUD), `employment` (code), each mapped to a [Consumer Data Right](https://consumerdatastandardsaustralia.github.io/standards/) banking resource or schema.org |
| Identifying (never readable by a program) | `name`, `dob`, `address`, `bsb`, `account_number`, `tfn`, `email`, `phone` |
| Source | a demo bank (`bank.lake.local`) signs synthetic CDR-style bank data (`LakeBankStatementCredential`); the converter `@thelakeprotocol/usecase-mortgage/cdr@1.0.0` turns twelve months of transactions into five claims inside the house, working gross income back from net pay with the 2026–27 tax scales |
| Intent terms | state or territory, price band ($200k–$1.8M), term (25 or 30 years), first home buyer. Grouped by state, band and first home buyer. `price_band: auto` is worked out inside the house |
| Authority | a demo credit licence register (`register.lake.local`), standing in for ASIC's register of credit licensees. Houses only talk to lenders it authorised |
| Release on accept | the bank-signed original and its credential, to the one lender you accepted |
| Shapes, vocabulary | [`shapes.ttl`](shapes.ttl), [`vocab.ttl`](vocab.ttl) |
| Examples | eight fictional lenders (`LENDERS`), each a certified quote program |

## How the demo lenders decide

Simplified from how Australian lenders really do it, and written as quote programs a house runs on its own data (`src/lenders.ts`):

- **Rate by LVR.** Each lender has its own rate bands by loan-to-value ratio, about 5.5–7.1% variable.
- **Lenders mortgage insurance** above 80% LVR, added to the loan (indicative premiums of 1.2–3.6%), unless the **First Home Guarantee** applies: a first home buyer, 5% deposit, under the state's price cap (capital-city caps from October 2025).
- **Serviceability.** The repayment at the rate plus APRA's 3-point buffer must fit take-home pay, less a living-expense benchmark and other commitments.
- **Debt to income** capped at 5.5–6× gross income.
- **Missed payments.** Some lenders take none; others accept a few at a higher rate. One specialist non-bank takes the self-employed and people with a blemish.
- **Group rates.** Most lenders take a little off when three or more households share the same intent. The discount is part of the certified program.

About four in five synthetic buyers get at least one offer at the price band worked out for them. The rest genuinely can't borrow enough.

Not modelled: stamp duty (a flat 15% of savings is held back for it and fees), HELP debt, joint applications, fixed rates, credit scores, and anything a real credit assessment adds. An offer is a conditional approval in a demo, not credit advice.

Load it with `--packs health,mortgage` on houses, specialists and the CLI; `lake quoters --packs mortgage` runs the lenders. Synthetic data only.
