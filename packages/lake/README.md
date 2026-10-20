# @thelakeprotocol/lake

**Status: runs, end-to-end tested.** Image: `ghcr.io/thelakeprotocol/lake-node`.

A Lake node: a search index of signed Agent Cards, a signed event intake, counters, a WebSocket event stream, and the live map (from `@thelakeprotocol/ui`). Holds no personal data and makes no decisions.

```bash
docker run -p 7000:7000 ghcr.io/thelakeprotocol/lake-node --domain lake.example --url https://lake.example
```

Endpoints and rules: [Run a node](https://lake.doneinfifty.com/docs/run-a-node). Next: the NATS bus for broadcast knocks (milestone 3), then federation (milestone 8).
