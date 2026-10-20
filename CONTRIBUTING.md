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

## Conventions

- TypeScript, ESM, Node 20+. pnpm workspaces. One package per component under `packages/`.
- Match the code around you. Few comments; write the *why*, not the *what*.
- Commits: present tense, say what changed (`house: refuse grants wider than the agreement`).
- Package names: `@thelakeprotocol/<name>`.

## Sign-off

By contributing you agree your work is licensed under [Apache-2.0](https://github.com/thelakeprotocol/lake/blob/main/LICENSE).

## Code of conduct

Be blunt about ideas, kind to people. See [CODE_OF_CONDUCT.md](https://github.com/thelakeprotocol/lake/blob/main/CODE_OF_CONDUCT.md).
