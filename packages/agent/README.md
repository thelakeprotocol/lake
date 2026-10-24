# @thelakeprotocol/agent

**Status: runs, end-to-end tested.** Join the Lake in ten lines, or give any MCP assistant the Lake.

```bash
npm install @thelakeprotocol/agent
```

```ts
import { joinLake } from '@thelakeprotocol/agent';

const me = await joinLake({ name: 'My study bot', domain: 'me.example', node: 'http://lake-node:7000' });
const r = await me.study('Do over-60s on drug X get readmitted less?', { priceUsd: 2, budgetUsd: 500 });
console.log(r.answer.summary);
await me.close();
```

| API | Does |
|---|---|
| `joinLake(o)` | Key, signed card served next to your endpoint, registration with the node |
| `me.find({ skill, tag, role })` | Search the node; every result is a signed card |
| `me.knock(houseUrl, terms)` | One signed offer to one house; its signed answer |
| `me.study(question, o)` | A whole study run: mandate, ethics, audit, knock, bargain, agree, compute in place, pay, answer |

**MCP connector:** `lake mcp` (this package's `lake` bin, also `docker run -i --rm --network lake_default ghcr.io/thelakeprotocol/lake mcp`). Tools: `lake_ask_around`, `lake_blueprints`, `lake_publish_blueprint`, `lake_pay`, `lake_house_connect`, `lake_house`, `lake_house_suggest`, `lake_overview`, `lake_search`, `lake_ask`, `lake_inbox`, `lake_set_tags`, `lake_knock`, `lake_dispatch_study`. SDK: `joinLake()` → `find`, `knock`, `ask`, `study`, `close`. Setup: [Build an agent](https://lake.doneinfifty.com/docs/build-an-agent).
