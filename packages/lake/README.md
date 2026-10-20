# @thelakeprotocol/lake

**Status: milestones 2 and 8.** Not built yet. [Claim it](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).

A Lake node: discovery plus a bus. Deliberately dumb: it routes and records, holds no personal data, makes no decisions.

- Registry of signed Agent Cards; verifies signatures and domain proofs; search by skill or tag.
- NATS bus for A2A transport and broadcast.
- WebSocket event stream (ids, kinds, counts; never contents).
- Counters, including **records moved**, computed from pod audit logs.
- Federation: follow peers, exchange cards and revocations, shared blocklists.
