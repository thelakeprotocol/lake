# Contributing to the Lake

The Lake is built in the open, by whoever shows up. You don't need permission. Open the PR.

## The fast path

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
corepack enable && pnpm install
pnpm test
```

1. Pick something: an issue labelled [`good first issue`](https://github.com/thelakeprotocol/lake/labels/good%20first%20issue), a milestone in the [status table](https://github.com/thelakeprotocol/lake/blob/main/README.md#status), or your own idea.
2. Ideas, questions, half-baked plans: post them in [Discussions](https://github.com/thelakeprotocol/lake/discussions). No idea is too early.
3. If it's big, open an issue first and say what you're building, so two people don't build the same thing.
4. Open a PR. Small and working beats big and perfect.

## What we merge

- **It runs.** Tests for logic, a command that shows it working for everything else.
- **It follows the spec.** If you change behaviour the spec defines, change [`SPEC.md`](https://github.com/thelakeprotocol/lake/blob/main/SPEC.md) in the same PR and say why.
- **Real standards.** A2A, MCP, Solid, ODRL, Verifiable Credentials. No homemade look-alikes. If a spec is unclear, follow it and write the choice down.
- **No real data.** Synthetic only, everywhere, fixtures included.

## What we don't merge

- Anything that lets an agent mint, widen or extend a key.
- Anything that lets free text from another agent change a decision.
- Anything that moves records out of a pod. The Records moved counter is sacred.
- A central server that the Lake depends on.

## Good things to build

| You like… | Build… |
|---|---|
| Data plumbing | A converter into the canonical model: bank CSV, Apple Health, Strava, smart meters |
| Agents | A visitor agent with a real question, or a guild that negotiates for its members |
| Security | Attacks. Forged cards, replays, prompt injection, over-asking. Then the defence. |
| Design | The map, the approvals app, the landing page |
| Writing | Docs that get a stranger from zero to a running house in 10 minutes |
| Policy | Personas: opinionated `rules.yaml` files for carers, renters, gig workers |

## Two local Lakes for staging

Two sandbox-shaped Lakes on your laptop, built from your checkout (unmerged changes included), each following the other's node, so you can try cross-Lake things before they reach the public sandbox. Each runs a node, the specialists, 4 hosted houses (`sb-0`…`sb-3`, open pairing), the grocers and the MCP connector, behind Caddy, with the public sandbox's paths (`/`, `/s/*`, `/t/*`, `/pods/*`, `/mcp`; plus `/g/*` for the grocers). About 1.2 GB of RAM for both.

```bash
scripts/local-lakes.sh build    # the four images, from this checkout (lake-local/*:dev); again after each change
scripts/local-lakes.sh up       # Lake A at http://lake-a.localhost:8081, Lake B at http://lake-b.localhost:8082
scripts/local-lakes.sh status   # both green: node, houses joined, specialists, MCP initialize, what each sees of the other
scripts/local-lakes.sh check    # an agent on A finds a seller on B, they message, it orders, pays (held), B delivers, A accepts, the money is released to B; a dispute goes to B's arbiter; it knocks on a house of B
scripts/local-lakes.sh logs a houses
scripts/local-lakes.sh down     # stop (data kept); reset wipes both Lakes' volumes
```

`*.localhost` resolves to your own machine, and inside each Lake's network to that Lake's Caddy, so every address an agent advertises works from the laptop and from the containers alike. Ports: `LAKE_A_PORT`, `LAKE_B_PORT`; `LAKE_PROFILES=sponsor,lively` adds the sponsor and the swarm. A second pair beside the first (from another checkout or worktree) takes other names, ports and image tags: `LAKE_A_ID=c LAKE_B_ID=d LAKE_A_PORT=8083 LAKE_B_PORT=8084 LAKE_TAG=mine scripts/local-lakes.sh build|up|check|down`.

Each Lake's specialists are named under its own demo domain (`payments.lake-a.localhost`, `payments.lake-b.localhost`), houses trust both Lakes' demo specialists, sellers' carts name the peer Lake's payments agent too, and both connectors accept both arbiters: what two operators would agree to federate trade (SPEC §6.5).

The simulation kit takes any Lake's base URL (build the host side first: `pnpm build`):

```bash
LAKE_SANDBOX=http://lake-a.localhost:8081 demos/explore/go.sh <scenario>
LAKE_SANDBOX=http://lake-b.localhost:8082 node demos/explore/claim.mjs <run-folder>
```

What crosses between the two today (`check` shows it): search finds the other Lake's houses, specialists and agents (each node re-verifies their cards from the agents' own addresses); signed messages, menus, carts and knocks go both ways; an agent on one Lake can be a house's assistant on the other. Money doesn't: a receipt from Lake A's payments agent reads on Lake B as "not by the payments agent", so B's seller sees the cart unpaid. And the demo grocers have the same WebID on every Lake, so each node keeps its own and drops the peer's.

## Conventions

- TypeScript, ESM, Node 20+. pnpm workspaces. One package per component under `packages/`.
- Match the code around you. Few comments; write the *why*, not the *what*.
- Commits: present tense, say what changed (`house: refuse grants wider than the agreement`).
- Package names: `@thelakeprotocol/<name>`.

## Sign-off

By contributing you agree your work is licensed under [Apache-2.0](https://github.com/thelakeprotocol/lake/blob/main/LICENSE).

## Code of conduct

Be blunt about ideas, kind to people. See [CODE_OF_CONDUCT.md](https://github.com/thelakeprotocol/lake/blob/main/CODE_OF_CONDUCT.md).
