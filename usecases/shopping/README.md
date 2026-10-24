# @thelakeprotocol/usecase-shopping

**The `shopping@1` pack.** The weekly food shop on the Lake: you say what you need, grocers' agents price your basket inside your house, on your own receipt history, and only you see the offers. Nothing leaves until you accept one, and then only your shopping list goes, to that one grocer. Your agent pays under the allowance you signed (control panel: My agent).

| | |
|---|---|
| Fields | `household_size`, `weekly_spend` (numbers), `dietary_needs` (codes; special-category: they can say something about health or belief), `staples` (codes: what you buy most weeks) |
| Identifying (never readable by a program) | `name`, `address`, `email`, `phone`, `card_number` |
| Source | a demo receipt wallet (`receipts.lake.local`) signs eight weeks of synthetic grocery receipts (`LakeReceiptHistoryCredential`); the converter `@thelakeprotocol/usecase-shopping/receipts@1.0.0` turns them into coarse claims inside the house |
| Intent terms | state or territory, budget (up to $60 to $350 a week; `auto` from your usual spend), delivery (tomorrow or this week). Grouped by state and delivery: a street shopping together gets group prices |
| Authority | a demo food business register (`foodregister.lake.local`); houses only talk to grocers it authorised |
| Release on accept | only the shopping list (`household_size`, `dietary_needs`, `staples`), to the one grocer you accepted: not your receipts |
| Shapes, vocabulary | [`shapes.ttl`](shapes.ttl), [`vocab.ttl`](vocab.ttl) |
| Examples | three fictional grocers (`GROCERS`), each a certified quote program |

## How the demo grocers price a basket

Written as quote programs in CEL that a house runs on its own data (`src/grocers.ts`):

- **Big Mart:** cheapest, delivers everywhere, but serves only vegetarian and halal diets, and swaps tofu and lentils for something else.
- **Corner Grocer:** local (Victoria and New South Wales), mid-priced, serves most diets, cheap delivery, no nappies.
- **Green Basket:** dearest, serves every diet, free delivery this week.

Each offers a street discount once three or more households in the same group shop together. A grocer that can't serve one of your diets makes no offer at all. Prices are invented.
