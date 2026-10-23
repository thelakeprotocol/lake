# AGENTS.md

Instructions for coding agents working in this repo. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

The Lake: an open protocol and reference implementation where each person's data stays in their own Solid pod, a housekeeper agent answers every request by the owner's `rules.yaml`, and outside agents knock over A2A, sign ODRL agreements, run declarative studies inside the house, and pay under AP2 mandates. The protocol is [SPEC.md](SPEC.md). Signed example messages are in [spec/examples/](spec/examples).

## Commands

```bash
corepack enable && pnpm install
pnpm build            # tsc -b for packages, vite for the map/approvals UI
pnpm test             # unit tests (fast)
pnpm test:e2e         # boots a whole Lake from source: two nodes, every specialist (one process), houses with real Solid pods (~2.5 min)
pnpm examples         # regenerate spec/examples (then commit; the unit tests verify them)
pnpm site:dev         # website + docs (VitePress)
docker compose up -d  # the demo Lake; map at http://localhost:7000
```

Run `pnpm build` before `pnpm test:e2e`: it runs the built `dist/` files.

## Layout

| Path | What |
|---|---|
| `packages/core` | Cards (A2A 1.0 + Lake extension), signing, rules engine, ODRL, VCs, studies, AP2, A2A helpers. No I/O beyond fetch. |
| `packages/house` | A house: Community Solid Server child process, housekeeper, MCP door to the pod, owner's desk. `--tenants N` hosts many. |
| `packages/lake` | A node: registry, signed event intake, signals, WebSocket stream, serves the map. |
| `packages/specialists` | issuer, ethics, auditor, payments, and the sandbox guides: guide, inspector, sparring partner, quests (A2A agents). `all` runs them in one process. |
| `packages/visitor` | The `lake` CLI: knock, dispatch (research agent), attack, swarm. |
| `packages/ui` | The live map and the control panel every house serves at /owner/ (Vite). |
| `usecases/<name>` | One package per use case ("pack"): its fields, vocabulary, SHACL shapes, converter, synthetic data, studies, intents and example quoters. `health` and `mortgage` (Australian home loans) today. |
| `spec/`, `model/` | JSON Schemas, OpenAPI for the node, examples; RDF ontology and SHACL shapes. |
| `site/` | lake.doneinfifty.com. `site/docs/*.md` are the docs. |
| `e2e/` | End-to-end tests. |

## Rules that must never break

- **The core is generic.** Nothing in `packages/` names a use case: no field, issuer, converter or credential type of any pack. Use cases live in `usecases/<name>/` and are loaded by id (`--packs health`). `tests/core-is-generic.test.ts` fails the build when one leaks in. Before adding something for one use case, ask whether it's really a generic mechanism; if so, build it generically in the core and use it from the pack.
- **Synthetic data only.** No real personal or health data anywhere, fixtures included.
- **Agents never mint, widen or extend a key.** Live grants are signed on the owner's device; standing-rule grants name the rule and the rules digest.
- **Free text never decides.** The rules engine never reads `offer.note`. Don't add a model to the decision path.
- **Records never leave a pod.** A study returns one randomised fragment; `recordsOut` in the audit log stays 0.
- **Verify before reading.** Every incoming message: card signature, domain proof, envelope signature, expiry, replay, then the payload.
- **Blame keys, not names.** Blocklists and quarantine use key ids; reputation only for verified identities.

## Conventions

- TypeScript ESM, Node 20+, strict. Match the code around you; comments say why, not what.
- Spec and code move together: change SPEC.md (and schemas/examples) in the same commit as behaviour.
- Docs are honest: statuses in README and `site/docs/roadmap.md` (What's next) say what actually runs and what doesn't yet.
- Ports 3000 and 3100 may be taken on dev machines; tests pick free ports.
- The pod server must run with `NODE_ENV=production` (its OIDC fails under `test`).
