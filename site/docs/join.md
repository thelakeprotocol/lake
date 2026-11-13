# Get a house

<p class="lead">A house is your data in your own Solid pod, a housekeeper that answers by your rules, and a control panel on your phone. With a handle, anyone's AI can reach you ("ping <i>you</i>"). Joining the Lake means publishing a signed card and announcing it to any node: no sign-up, no approval, no account with us.</p>

| Way | What you get | How |
|---|---|---|
| **An invite** | A hosted house on the sandbox that stays yours | Someone already on the Lake sends you a link (**You → Your door → Invite someone**). Open it on your phone, pick a handle, tap **Continue**, then **Use this phone**. |
| **Borrow one for a day** | A hosted sandbox house for 24 hours | [See which are free](https://sandbox.lake.doneinfifty.com/t/) and open one. [Claim a house](/docs/sandbox#claim-a-house). |
| **Run your own** | A house on your machine, joined to the sandbox | One command, below. |
| **Bring your own pod** | Your existing Solid pod, with a housekeeper | [Below](#bring-your-own-pod). |

All of these are on the sandbox: synthetic data, play money, real signatures. [What that means](/docs/networks).

**Run your own, on the sandbox:**

```bash
docker run -it -p 4000:4000 -v my-house:/data ghcr.io/thelakeprotocol/lake-house \
  --name you --handle you --join https://sandbox.lake.doneinfifty.com
```

`--join` uses the sandbox's node, issuer and auditor and turns the relay on: nothing to open on your router. (It expects a Lake that serves its specialists under `/s/`, as the sandbox does; with a bare node, pass `--lake`, `--issuer-url` and `--auditor-url` instead.) `--handle` opens your door under that handle. It prints a link to the [control panel](/docs/approvals) for this machine (`http://localhost:4000/owner/…`). To pair your phone, on the same Wi-Fi, open the same link with this machine's address in place of `localhost`; add `--owner-url http://<that address>:4000` and the house prints that link and a code to scan (outside Docker it finds the address itself). Notifications (**You → This phone → Notifications**) need the panel on HTTPS: put your own proxy or tunnel in front of that port and give its address as `--owner-url`. Then talk to the [Guide](/docs/sandbox#start-with-the-guide).

## A house on a local Lake <span class="status done">runs</span>

A house is one container: a Solid pod with your data, and a housekeeper that guards it. To try everything offline, start a local Lake, then join it:

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
docker compose up -d     # two Lake nodes, the specialists, three houses, demo shops and lenders, a swarm of traders (--scale swarm=0 for a quiet Lake)
open http://localhost:7000   # the live map

docker run -d --network lake_default --hostname house-you \
  -v ./personas/research.yaml:/rules.yaml \
  ghcr.io/thelakeprotocol/lake-house --name you
```

On start, your house:

1. Starts a pod (Community Solid Server) and creates your WebID and folders: `/agreements/`, `/receipts/`, `/wallet/`, `/audit/`, `/settings/`, `/offers/`, `/profile/`, and one per use case it takes part in (`/health/` by default; `--packs` picks them). Each one is registered in your pod's Solid Type Index, so any Solid app can find it. Its signing key goes in `/wallet/`.
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

Outside Docker, the door needs to know where the house keeps things: `LAKE_OWNER=you LAKE_DATA=<your --data> LAKE_POD_URL=http://localhost:<pod port>/ node packages/house/dist/pod-mcp-stdio.js`.

## Run it for real

What the commands above leave out, for a house you keep.

**What it needs.** One house is two Node processes, the housekeeper and its Solid pod: about 300 MB of memory together at rest (allow 768 MB), a little CPU when something knocks, and a data folder that starts under 1 MB and grows with your records and receipts. Each process has a memory limit of its own: the pod's is `LAKE_POD_HEAP` (in MB, 256 unless you say), the house's is Node's `--max-old-space-size` in `NODE_OPTIONS`, which the pod no longer inherits. A process takes its limit plus about 80 MB, so in a container keep the two together under the container's limit; the compose file below does. A small VPS, a Raspberry Pi 4 or 5 (ARM64), or a home server is plenty. No AI model runs in the house: your AI, if you connect one, runs wherever it runs. Hosting several houses on one machine (a family): one container each, or one process with `--tenants N` (each house its own pod, keys and owner).

**Keep it running.** [`deploy/house.compose.yml`](https://github.com/thelakeprotocol/lake/blob/main/deploy/house.compose.yml) is one house as a service: restarted after a reboot or a crash, a health check on its card, a memory limit, and its folder on your disk. Edit the name, handle, time zone and `--owner-url` (this machine's address on your network: where your phone opens the control panel), put your `rules.yaml` beside it, then `docker compose -f house.compose.yml up -d`; `docker compose logs -f` to watch. `lake-house --help` lists every option.

**Back it up.** The data folder is everything: the pod (your records, agreements, receipts), the house's keys in the pod's `/wallet/`, and the house's own state (its pod login, its owner key, the pairing token). Two files there are only the house's memory of the pod and can be deleted while it's stopped: `pod-index.json` (the names of what it filed under agreements, receipts and its log, so it lists those folders once, not on every look) and `consent-index.json`; delete them if you ever change the pod's files by hand, and the house lists again. A house that runs its own pod reads that first listing from the pod's folder on disk: the pod server builds a listing in memory, and a folder of ten thousand agreements took it past its memory. A pod elsewhere (`--pod-url` with your own login) is still asked over the web. Stop the house, copy the folder, start it again: `docker compose stop && tar czf house-$(date +%F).tgz house && docker compose start`. Keep the copy somewhere else, encrypted: it holds keys. From your phone, **You → My data → Download everything** gives you the pod's contents too (wallet included) as one file.

**Move it.** Put the folder on the new machine and start the house with the same `--name`. With `--relay` (or `--join`), your house is reached at an address made from its key, so it is the same house to everyone after the move. With `--public-url`, keep that URL (point its name at the new machine).

**Upgrade.** Images are tagged `latest` and with the commit they were built from (`lake-house:<git sha>`). Pin the commit in the compose file and change it when you choose; back up first, then `docker compose pull && docker compose up -d`. The house reads its old folder; if anything's wrong, put the old tag and the backup back.

**Your AI on duty, in your house.** Set `ANTHROPIC_API_KEY` on the house (in the compose file's `environment`) and start it with `--duty-model anthropic` (or `anthropic:<model id>`): your house can then run your AI on duty itself, and **My AI → Set up AI on duty → In my house** is one tap. Without it, each owner can still add their own key from their phone. A day of duty is capped at 30 runs and 200,000 tokens.

**What the relay sees.** With `--relay`, your house keeps one outgoing WebSocket to each node it follows and answers through it, so nothing is opened on your router. Every message is signed by its sender and sealed for its recipient ([SPEC §3](https://github.com/thelakeprotocol/lake/blob/main/SPEC.md)): the node passes them on but can't read, change or forge them, or see who sent them. It does see that your house is connected, and when and how much passes. If the node goes away, your house keeps reconnecting and is unreachable meanwhile; a connection that dies without a word (a router that forgot it, a laptop that slept) is noticed within a minute and made again; following two nodes (`--lake a,b`) keeps it reachable when one is down. Your control panel is the one thing reached directly: keep that port to your own network, or put it behind your own HTTPS proxy.

## No Docker?

Run it from the repository (Node 20 or later): a node, the demo specialists (issuer, auditor and the rest, in one process), and your house. Pick a data folder of your own: `/data` is Docker's.

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
corepack enable && pnpm install && pnpm build
node packages/lake/dist/main.js --port 7000 --url http://localhost:7000 --data ./lake-node &
node packages/specialists/dist/main.js all --port 4300 --url http://localhost:4300 --lake http://localhost:7000 --data ./specialists --skip sparring,quests &
NODE_ENV=production node packages/house/dist/main.js --name you --data ./my-house --rules personas/research.yaml \
  --port 4000 --pod-port 3000 --lake http://localhost:7000 \
  --issuer-url http://localhost:4300/issuer --auditor-url http://localhost:4300/auditor
```

The house prints its pairing link in about 15 seconds, then "joined the Lake". The house and node aren't on npm; the [agent SDK and connector](/docs/build-an-agent) are. Each command has `--help`. Just want to see your rules work? The [rules playground](/#playground) runs the real rules engine in your browser.
