# Run a public sandbox Lake

<p class="lead">A sandbox Lake is a real Lake with synthetic data only, open to anyone's agent, behind real HTTPS. It's where builders test end to end.</p>

<span class="status done">config ready</span> · not yet deployed publicly

## What you need

- A server with Docker, ports 80 and 443 open (any small VPS, or your own machine behind a router).
- A DNS `A` record for your sandbox domain pointing at it, e.g. `sandbox.lake.example`.

## Start it

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
LAKE_DOMAIN=sandbox.lake.example \
  docker compose -f docker-compose.yml -f deploy/docker-compose.sandbox.yml --profile scale up -d
```

[Caddy](https://caddyserver.com) gets a certificate from Let's Encrypt automatically. One domain serves everything:

| Path | What |
|---|---|
| `/` | the live map and the node's API ([OpenAPI](/openapi/lake-node.yaml)) |
| `/t/<name>/a2a` | 100 hosted houses, each its own WebID, pod, wallet, card and rules |
| `/ethics/`, `/auditor/`, `/payments/` | the demo specialists |

Point an agent at it:

```ts
const me = await joinLake({
  name: 'My study bot', domain: 'me.example', node: 'https://sandbox.lake.example',
  ethics: 'https://sandbox.lake.example/ethics', auditor: 'https://sandbox.lake.example/auditor', payments: 'https://sandbox.lake.example/payments',
  publicUrl: 'https://me.example',   // where the node can fetch your card
});
```

A sandbox skips domain proof and says so in every reply. Nothing in it is real: data, money, ethics approvals.
