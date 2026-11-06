# @thelakeprotocol/usecase-mortgage

**The `mortgage@1` pack.** Australian home-loan offers on the Lake: lenders price you inside your house, on your own bank data, and only you see the offers. Nothing leaves until you accept one. How it works: [How an offer works](https://lake.doneinfifty.com/docs/offers).

| | |
|---|---|
| Fields | `income_annual`, `monthly_commitments`, `savings`, `missed_payments_12m` (numbers, AUD), `employment` (code), each mapped to a [Consumer Data Right](https://consumerdatastandardsaustralia.github.io/standards/) banking resource or schema.org |
| Identifying (never readable by a program) | `name`, `dob`, `address`, `bsb`, `account_number`, `tfn`, `email`, `phone` |
| Source | a demo bank (`bank.lake.local`) signs synthetic CDR-style bank data (`LakeBankStatementCredential`); the converter `@thelakeprotocol/usecase-mortgage/cdr@1.1.0` turns twelve months of transactions into five claims inside the house, working gross income back from net pay with the 2026–27 tax scales |
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

## Existing loans, the loyalty tax, and refinancing

About three in five synthetic people have a home loan with one of four fictional big banks (Harbour, Granite, Lyrebird, Magpie). Like the banks in the ACCC's home loan price inquiry, these charge borrowers who stay more than they offer new customers, and the gap grows with the loan's age. From the bank data, the converter works out, inside the house:

- **The loan:** who it's with, what's owed, its rate, the bank's estimate of the home's value, and how long ago it started.
- **The gap:** how far its rate sits above what the same bank offers a new customer at the same loan-to-value, and what that costs a year (`loyalty_gap`, `overpay_yearly`).
- **One combined answer for a secret count:** the bank and a band of that yearly cost (`lender_overpay`, for example `harbour:3k-6k`; 16 answers in all).

An intent with `purpose: refinance` asks lenders to price a refinance of exactly that loan. Their programs read its balance, the home's value and the current rate, apply the same serviceability rules as for a purchase (refinancing means passing the stress test again, and some can't), and show the owner what the switch saves in the first year after switching costs. The group discount applies to a refinance group too: households with the same intent in the same state.
