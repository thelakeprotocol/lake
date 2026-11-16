# @thelakeprotocol/house

**Status: runs, end-to-end tested.** Image: `ghcr.io/thelakeprotocol/lake-house`.

One container: a Solid pod (Community Solid Server, file backend) and the housekeeper that guards it.

```bash
docker run -d -p 4000:4000 -v my-house:/data -v "$PWD/rules.yaml:/rules.yaml:ro" \
  ghcr.io/thelakeprotocol/lake-house --name you --join https://sandbox.lake.doneinfifty.com
```

`docker run --rm ghcr.io/thelakeprotocol/lake-house --help` (or `node dist/main.js --help`) lists every option with its current value. The ones most houses need:

| Flag | Env | Default | |
|---|---|---|---|
| `--name` | | `owner` from rules.yaml | The house's name; also the pod name |
| `--rules` | `LAKE_RULES` | `/rules.yaml` | The owner's rules |
| `--data` | `LAKE_DATA` | `/data` | The pod, the house's keys and state, under `<data>/<name>/`: mount a volume, back it up |
| `--join` | `LAKE_JOIN` | none | A Lake serving its specialists under `/s/` (the sandbox): sets the node, auditor, person checker and tellers, and turns the relay on |
| `--lake` | `LAKE_NODE_URL` | none | Node(s) to announce to, comma-separated (without it the house joins no Lake) |
| `--relay` | `LAKE_RELAY=1` | off | Reached through the node(s): nothing to open on a home router |
| `--handle` | `LAKE_HANDLE` | none | Open the door under this handle |
| `--owner-url` | `LAKE_OWNER_URL` | `--public-url` | Where the owner's phone opens the control panel (this machine's address on your network) |
| `--public-url` | `LAKE_PUBLIC_URL` | `http://<hostname>:4000` in Docker, `http://localhost:4000` with `--join` | Where other agents reach the house (not needed with the relay) |
| `--port`, `--pod-port` | `LAKE_PORT`, `LAKE_POD_PORT` | `4000`, `3000` | The house's and its pod's ports |
| `--packs` | `LAKE_PACKS` | `health` | The use cases it takes part in |
| `--webid`, `--client-id`, `--client-secret` | `LAKE_CLIENT_SECRET` | none | Bring your own pod (with `--pod-folder`) |
| `--duty-model`, `--connector` | `LAKE_DUTY_MODEL`, `LAKE_MCP_URL` (and `ANTHROPIC_API_KEY`) | none | Run the owner's AI on duty in the house, through the Lake's connector |
| `--production` | | off | Turns sandbox off: domains must be proved |
| | `LAKE_POD_HEAP` | `256` | The pod server's memory limit in MB |

| Module | Does |
|---|---|
| `pod.ts` | Runs the pod server, seeds the owner account, owner session via client credentials (DPoP) |
| `record.ts` | Fetches the issuer-signed record, converts it, signs the result, re-verifies the chain |
| `pod-mcp.ts` | The MCP door to the pod: `pod_list`, `pod_read`, `pod_claims`. Never leaves the pod; can shut `/wallet/` |
| `housekeeper.ts` | Verifies card, domain, signature, replay; decides by rules; answers with a signed decision |
| `server.ts` | A2A JSON-RPC at `/a2a`, signed card at `/.well-known/agent-card.json` |
| `pod-mcp-stdio.ts` | `lake-pod-mcp`: the same MCP door for your own assistant |
| `owner.ts` | The owner's desk: pairing, pending asks, live grants signed on the owner's phone, revocation |
| `admin.ts` | Operator command: `node dist/admin.js revoke-all` |
