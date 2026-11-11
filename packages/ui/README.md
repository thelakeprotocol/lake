# @thelakeprotocol/ui

**The live map runs.** Served by every Lake node at `/`. It draws only what the node's event stream says: houses appear on `house.joined`, threads on `knock`, colours on `decision`, red rings on `attack.blocked`. The counter strip includes **Records moved**, which turns red if it is ever above zero.

```bash
pnpm --filter @thelakeprotocol/ui dev   # proxies /events to a node on :7000
```

**The house app runs** (`approvals.html`, served by each house at `/owner/`): four tabs (Chats, Inbox, My AI, You), drawn by Preact with [Ionic](https://ionicframework.com/docs/components)'s web components and the Lake's own theme (`src/house/theme.css`, light and dark). Sources in `src/house/`: `api.ts` (signed calls), `ion.ts` (components), `logic.ts` (pure helpers), one file per tab, `pages.ts` (the pages under You), `pair.ts`. The owner's Ed25519 key is made and kept on the phone; grants are signed there. See [Your phone, your keys](https://lake.doneinfifty.com/docs/approvals).
