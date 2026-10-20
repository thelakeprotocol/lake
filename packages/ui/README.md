# @thelakeprotocol/ui

**The live map runs.** Served by every Lake node at `/`. It draws only what the node's event stream says: houses appear on `house.joined`, threads on `knock`, colours on `decision`, red rings on `attack.blocked`. The counter strip includes **Records moved**, which turns red if it is ever above zero.

```bash
pnpm --filter @thelakeprotocol/ui dev   # proxies /events to a node on :7000
```

**The approvals app runs** (`approvals.html`, served by each house at `/owner/`): pair the phone, see each request, Allow or Deny, Your keys with Revoke. The owner's Ed25519 key is made and kept on the phone; grants are signed there. See [Your phone, your keys](https://lake.doneinfifty.com/docs/approvals).
