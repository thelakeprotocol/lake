# @thelakeprotocol/visitor

The `lake` CLI and the research agent. Image: `ghcr.io/thelakeprotocol/lake`.

```bash
lake knock <house-url> [--offer research|gp|marketing|injection] [--tamper forge-card|unsigned|replay|impersonate]
lake dispatch [--goal "..."] [--price 5] [--extra-fields postcode] [--node …] [--ethics …] [--auditor …]
```

`dispatch` runs the mission: ethics approval → study certificate → discover houses on the node → knock on each over A2A with the offer, the study and both credentials → collect decisions and grants → ask each joining house to run the study → de-bias the two pieces per house to two tellers → close both counts → add the sums into the exact table → report the result. It serves its own card while it runs, so the node can verify it and show it on the map.

```bash
lake attack [--count 10] [<house-url> …]          # one attacker key tries every trick; all must be blocked
lake swarm [--traders 8] [--attackers 1]           # background life for a demo Lake
```

Revoking a house's keys: from the owner's phone, or `docker compose exec house-stan node dist/admin.js revoke-all`.
