# @thelakeprotocol/house

**Status: runs, end-to-end tested.** Image: `ghcr.io/thelakeprotocol/lake-house`.

One container: a Solid pod (Community Solid Server, file backend) and the housekeeper that guards it.

```bash
docker run --network lake_default --hostname house-you -v ./rules.yaml:/rules.yaml \
  ghcr.io/thelakeprotocol/lake-house --name you
```

| Flag | Env | Default | |
|---|---|---|---|
| `--name` | | `owner` from rules.yaml | Owner handle; also the pod name |
| `--rules` | `LAKE_RULES` | `/rules.yaml` | The owner's rules |
| `--data` | `LAKE_DATA` | `/data` | Pod files + local secrets (mount a volume) |
| `--port` | `LAKE_PORT` | `4000` | A2A + signed card |
| `--pod-port` | `LAKE_POD_PORT` | `3000` | Pod server |
| `--public-url` | `LAKE_PUBLIC_URL` | `http://<hostname>:4000` in Docker | Where other agents reach this house |
| `--pod-url` | `LAKE_POD_URL` | `http://localhost:3000/` | HTTPS, or HTTP on localhost only (Solid-OIDC) |
| `--issuer-url` | `LAKE_ISSUER_URL` | `http://issuer:4300` | Who signs the synthetic record |
| `--production` | | off | Turns sandbox off: domains must be proved |
| `--json` | | off | Events as JSON lines |
| `--owner-url` | `LAKE_OWNER_URL` | `--public-url` | Base URL the owner's phone uses for `/owner/` |
| `--open-pairing` | `LAKE_OPEN_PAIRING=1` | off | Sandbox only: the first device to open the app becomes the owner |
| `--auditor-url` | `LAKE_AUDITOR_URL` | `http://auditor:4400` | Who certifies this house's converter |
| `--seed` | `LAKE_SEED` | none | Same seed, same synthetic records and answers |

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
