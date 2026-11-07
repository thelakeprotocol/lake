# Good turns (goodturn@1)

A demo charity, **Open Hands**, runs as this pack's authority. It lists small online volunteer tasks (sorting a food bank delivery, typing up a donation slip, proofreading a flyer, filling a roster gap), all on synthetic material, and certifies each one done as an [Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) credential: one hour of community service (`achievementType: CommunityService`, `creditsEarned: 1`), bound to the helper's key.

Anyone may accept these as payment for their time (SPEC §6.7): a menu item priced `{ value: 1, assetCode: "HUR", assetScale: 0, accept: [Open Hands] }`. The buyer's AI redeems the deed at Open Hands for that one cart; Open Hands records it spent and signs a receipt the seller counts. A deed pays once, anywhere.

The checks are in the open (`src/tasks.ts`): this demonstrates the mechanism, not who did the work. A real charity would certify work its people saw done.
