# Nobody goes first: 300 families find their quorum in secret

A local Lake on one laptop, 6 Nov 2026 (evening, Sydney). Real houses, real signatures; synthetic families. The "phones" are a script holding each family's key (`run.mjs`), and it calls the same control-panel API the phone does. One family is driven through its real control panel in a browser at phone size, and recorded (`feature.mjs`, `frames.mjs`).

## What ran

- **300 houses**, each its own Solid pod and keys, on one `lake-house --tenants 300` process (about 700 MB). Each was claimed by a new owner key and stamped by the demo person checker (one person, one house). Claiming and stamping all 300 took 24 seconds.
- **The organiser** is an AI with its own Lake sign-in. It opened the pledge with `lake_pledge { action: "open", quorum }`: "No smartphones before high school: the families of Hillside Primary together. Basic phones are fine." Its threshold (the smallest group it may bind) is 100, it is blind with `unveil`, and answers close after 7 minutes.
- **The question** each family answers privately: "I'm in if at least how many families are?"

| Answer | Means | Families |
|---|---|---|
| Even if nobody else does | 1 | 12 |
| If at least 25 families do | 25 | 18 |
| If at least 50 do | 50 | 30 |
| If at least 100 do | 100 | 55 |
| If at least 150 do | 150 | 50 |
| If at least 200 do | 200 | 40 |
| If at least 250 do | 250 | 25 |
| Not at all | never | 70 |

  The answers are synthetic: a few would go first, most wait for others (Granovetter's threshold model). One family on camera got the question from its AI as a note and tapped its answer.
- **Each answer** went from its house as two Prio3 shares to the tally's two tellers. The house first showed the tally a person stamp for this pledge, so each person answers once. The tally recorded who answered, never what. The AI was told only that its human had answered.

## What came out

- **When answers closed**, the tally collected the count over the 300 who answered and got back exactly the table above, as totals only. Working up from the bottom: 12 at 1, 30 at 25, 60 at 50, 115 at 100, 165 at 150, 205 at 200, and only 230 at 250. **205 families hold together**: each said they would join a group of 205 or smaller. The pledge opened to bind at 205.
- **Every family that answered was told at once** ("Enough of you would join…"). The family on camera got a new note from its AI and tapped **Sign the pledge**.
- **The families whose threshold it met signed**, plus 6 who had said 250 and joined once it opened: **211 blind signatures**. Each was an anonymous pass (Privacy Pass, one per person) carrying a reveal sealed to a drand round just after the deadline. It filled at 205.
- **At the drand round** the tally opened all 211 seals and showed them together: **revealed 211 of 211, bound**.

The pledge's public page (counts only, never names) is in `page-closed.png` and `page-revealed.png`; the family's phone is in `phone-answer.png`.

## Runs

| Run | Quorum | Signed | Revealed | Note |
|---|---|---|---|---|
| 1 | 205 | 211 | 211 | First run; the page caught the reveal partway (61, then 110, then 211 of 211) while seals were checked one by one: fixed so all show at once (7cceaa7) |
| 2 | 205 | 211 | 211 | Recording, on images with the hidden Sign button |
| 3 | 205 | 211 | 211 at once (drand round 33719943) | Final recording, on the fixed tally |

The same answers give the same quorum every time: the count is exact, with no noise.

## What it doesn't show

- The families are synthetic and their phones are a script; one family is driven through its real panel by a browser.
- Both tellers, the tally and the pass issuer are run by one operator here, so collusion between them isn't resisted.
- Answers are advisory, and someone can answer strategically. What binds is the signed pledge.
- The bands are coarse, so 205 is the largest group the bands can show.

Prior art: Secure Allegation Escrows (Arun et al., NDSS 2020) reveal reports once the largest group whose secret thresholds are all met is found. Wait Until 8th activates a pledge at 10 families per grade. Spartacus.app runs threshold pledges. Callisto, SeCritMass and Catalyst (CSCW 2014) do related things. What we haven't found elsewhere is sizing a binding pledge from privately given thresholds (an aggregate-only count), signed with anonymous one-per-person tokens, with everyone revealed together.
