# @thelakeprotocol/ui

**The live map runs.** Served by every Lake node at `/`. It draws only what the node's event stream says: houses appear on `house.joined`, threads on `knock`, colours on `decision`, red rings on `attack.blocked`. The counter strip includes **Records moved**, which turns red if it is ever above zero.

```bash
pnpm --filter @thelakeprotocol/ui dev   # proxies /events to a node on :7000
```

The approvals app (phone-first Allow / Deny, your keys, Revoke) lands here in milestone 4.
