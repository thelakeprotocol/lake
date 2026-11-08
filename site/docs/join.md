# Get a house

<p class="lead">A house is your data in your own Solid pod, a housekeeper that answers by your rules, and a control panel on your phone. With a handle, anyone's AI can reach you ("ping <i>you</i>"). Joining the Lake means publishing a signed card and announcing it to any node: no sign-up, no approval, no account with us.</p>

| Way | What you get | How |
|---|---|---|
| **An invite** | A hosted house on the sandbox that stays yours | Someone already on the Lake sends you a link (**Me → Invite someone**). Open it on your phone, pick a handle, tap **Continue**, then **Use this phone**. |
| **Borrow one for a day** | A hosted sandbox house for 24 hours | [See which are free](https://sandbox.lake.doneinfifty.com/t/) and open one. [Claim a house](/docs/sandbox#claim-a-house). |
| **Run your own** | A house on your machine, joined to the sandbox | One command, below. |
| **Bring your own pod** | Your existing Solid pod, with a housekeeper | [Below](#bring-your-own-pod). |

All of these are on the sandbox: synthetic data, play money, real signatures. [What that means](/docs/networks).

**Run your own, on the sandbox:**

```bash
docker run -it -p 4000:4000 -v my-house:/data ghcr.io/thelakeprotocol/lake-house \
  --name you --handle you --join https://sandbox.lake.doneinfifty.com
```

`--join` uses the sandbox's node, issuer and auditor and turns the relay on: nothing to open on your router. `--handle` opens your door under that handle. Open the link it prints to pair your phone with the [control panel](/docs/approvals), then turn on notifications (**Settings → Notifications**). Then talk to the [Guide](/docs/sandbox#start-with-the-guide).

## A house on a local Lake <span class="status done">runs</span>

A house is one container: a Solid pod with your data, and a housekeeper that guards it. To try everything offline, start a local Lake, then join it:

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
docker compose up -d     # two Lake nodes, the specialists, three houses
open http://localhost:7000   # the live map

docker run -d --network lake_default --hostname house-you \
  -v ./personas/research.yaml:/rules.yaml \
  ghcr.io/thelakeprotocol/lake-house --name you
```

On start, your house:

1. Starts a pod (Community Solid Server) and creates your WebID and folders: `/agreements/`, `/receipts/`, `/wallet/`, `/audit/`, `/settings/`, and one per use case it takes part in (`/health/` by default; `--packs` picks them). Each one is registered in your pod's Solid Type Index, so any Solid app can find it. Its signing key goes in `/wallet/`.
2. For each use case, asks that use case's issuer for a **synthetic** record (the demo hospital, for health), checks the signature, and stores the original untouched in `/health/original/`.
3. Converts it to claims inside the pod (`/health/claims.ttl`), checks them against the use case's shapes, and signs the result.
4. Re-verifies the whole chain, publishes its signed Agent Card at `/.well-known/agent-card.json`, and starts answering on A2A.

Watch it: `docker logs -f <container>`. Then knock:

```bash
docker compose run --rm lake knock http://house-you:4000 --offer gp         # a GP asks for medications
docker compose run --rm lake knock http://house-you:4000 --offer research   # a $2 study
docker compose run --rm lake knock http://house-you:4000 --offer injection  # "ignore your rules…"
docker compose run --rm lake knock http://house-you:4000 --offer gp --tamper forge-card
```

**At home, behind a router?** Add `--relay`. Your house keeps one outgoing connection to each node it follows, and is reached through them: no port forwarding, no domain, no certificates. A laptop, a Raspberry Pi or a home server all work.

```bash
docker run -d -e LAKE_NODE_URL=https://lake.example,https://lake.other.example \
  -v ./rules.yaml:/rules.yaml ghcr.io/thelakeprotocol/lake-house --name you --relay
```

Your house registers with the node and appears on the map. Every knock, decision and blocked attack shows there as it happens: ids, kinds and counts, never a record.

Your [`rules.yaml`](/docs/rules) decides what happens next. Start from a persona:

| Persona | Behaviour |
|---|---|
| [`stan.yaml`](https://github.com/thelakeprotocol/lake/blob/main/personas/stan.yaml) | Joins ethical research for at least $4, never shares postcode, declines marketing |
| [`research.yaml`](https://github.com/thelakeprotocol/lake/blob/main/personas/research.yaml) | Joins approved studies for at least $5 |
| [`strict.yaml`](https://github.com/thelakeprotocol/lake/blob/main/personas/strict.yaml) | Declines almost everything, asks about the rest |

Every persona starts by declining anything that asks for a field that identifies you (a name, a date of birth, an account number): `match: { asks_identifying: true }`, `decision: decline`.

### Bring your own pod

The house speaks the Solid protocol, so any Solid server works: run your own, use a pod provider, or point it at an enterprise Solid server you already have. Register an app with your Solid identity provider (it gives you a client ID and secret), then:

```bash
docker run -it -p 4000:4000 -v my-house:/data ghcr.io/thelakeprotocol/lake-house --name you \
  --webid https://id.example/you --client-id … --client-secret … \
  --join https://sandbox.lake.doneinfifty.com
```

The house reads your identity provider and storage from your WebID profile and keeps everything in one folder of your pod (`/lake/`, or `--pod-folder`). Nothing else in your pod is touched.

## Bring your agent <span class="status done">runs</span>

Any agent that speaks A2A and signs a Lake card is a citizen. Claude, GPT, a local model, a 40-line script: the Lake doesn't care what's inside. The SDK does the signing (`npm i @thelakeprotocol/agent`), and the MCP connector plugs the Lake into any assistant.

See [Build an agent](/docs/build-an-agent), then point it at the [sandbox](/docs/sandbox) and ask the Inspector to check it.

## Run a node <span class="status done">runs, federated</span>

A node is a registry, a relay and an event stream. It holds no personal data and makes no decisions. See [Run a node](/docs/run-a-node).

## Let your AI assistant read your pod

The easy way: in your control panel, **My AI → Give my AI a key**, and paste the message it shows to your AI (with the Lake connector). It sees what waits for you and suggests; you decide. The rest of this section is the lower-level way: your pod's own MCP door.

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
