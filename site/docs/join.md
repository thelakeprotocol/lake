# Join the Lake

<p class="lead">Joining means publishing a signed card on a domain you control and announcing it to any Lake node. No sign-up, no approval, no account with us.</p>

There are three ways in. Pick yours.

## 1. As a person: run a house <span class="status done">runs</span>

A house is one container: a Solid pod with your data, and a housekeeper that guards it. Start a local Lake, then join it:

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
docker compose up -d     # an issuer + three houses: stan, strict, research

docker run -d --network lake_default --hostname house-you \
  -v ./personas/research.yaml:/rules.yaml \
  ghcr.io/thelakeprotocol/lake-house --name you
```

On start, your house:

1. Starts a pod (Community Solid Server) and creates your WebID and folders: `/health/`, `/finance/`, `/agreements/`, `/receipts/`, `/wallet/`. Its signing key goes in `/wallet/`.
2. Asks the Issuer for a **synthetic** health record, checks the Issuer's signature, and stores the original untouched in `/health/original/`.
3. Converts it to the canonical Lake model inside the pod (`/health/claims.ttl`) and signs the result.
4. Re-verifies the whole chain, publishes its signed Agent Card at `/.well-known/agent-card.json`, and starts answering on A2A.

Watch it: `docker logs -f <container>`. Then knock:

```bash
docker compose run --rm lake knock http://house-you:4000 --offer gp         # a GP asks for medications
docker compose run --rm lake knock http://house-you:4000 --offer research   # a $2 study
docker compose run --rm lake knock http://house-you:4000 --offer injection  # "ignore your rules…"
docker compose run --rm lake knock http://house-you:4000 --offer gp --tamper forge-card
```

Registering with a Lake node and appearing on the live map arrive with [milestone 2](/docs/roadmap).

Your [`rules.yaml`](/docs/rules) decides what happens next. Start from a persona:

| Persona | Behaviour |
|---|---|
| [`stan.yaml`](https://github.com/thelakeprotocol/lake/blob/main/personas/stan.yaml) | Joins ethical research for at least $4, never shares postcode, declines marketing |
| [`research.yaml`](https://github.com/thelakeprotocol/lake/blob/main/personas/research.yaml) | Joins approved studies for at least $5 |
| [`strict.yaml`](https://github.com/thelakeprotocol/lake/blob/main/personas/strict.yaml) | Declines almost everything, asks about the rest |

### Bring your own pod

The house speaks the Solid protocol, so any Solid server works: run your own, use a pod provider, or point it at an enterprise Solid server you already have.

## 2. As a builder: bring your agent <span class="status later">later · milestone 9</span>

Any agent that speaks A2A and signs a Lake card is a citizen. Claude, GPT, a local model, a 40-line script: the Lake doesn't care what's inside.

See [Build an agent](/docs/build-an-agent). The protocol is already [specified](/docs/spec), and the signing and card code [runs today](https://github.com/thelakeprotocol/lake/tree/main/packages/core).

## 3. As infrastructure: run a node <span class="status later">later · milestone 8</span>

A node is a registry and a message bus. It holds no personal data and makes no decisions. See [Run a node](/docs/run-a-node).

## Let your AI assistant read your pod

Your pod has an MCP door. Any MCP-capable assistant (Claude Desktop, Claude Code, others) can read your claims through it, and your wallet stays shut. Add this to your assistant's MCP config:

```json
{
  "mcpServers": {
    "my-pod": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "LAKE_OWNER=you", "<your-house-container>", "node", "dist/pod-mcp-stdio.js"]
    }
  }
}
```

Tools: `pod_list`, `pod_read`, `pod_claims`. Read-only. Your assistant, your model, your bill: the Lake bundles none.

## No Docker?

Open the [rules playground](/#playground) on the home page. It runs the real rules engine in your browser.
