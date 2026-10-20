# @thelakeprotocol/visitor

The `lake` CLI and the research agent. Image: `ghcr.io/thelakeprotocol/lake`.

```bash
lake knock <house-url> [--offer research|gp|marketing|injection] [--tamper forge-card|unsigned|replay|impersonate]
lake dispatch [--goal "..."] [--price 5] [--extra-fields postcode] [--epsilon 2] [--node …] [--ethics …] [--auditor …]
```

`dispatch` runs the mission: ethics approval → study certificate → discover houses on the node → knock on each over A2A with the offer, the study and both credentials → collect decisions and grants → ask each joining house to run the study → de-bias the randomised answers → report the result. It serves its own card while it runs, so the node can verify it and show it on the map.

Coming: `lake attack` (6), `lake revoke` (4), `lake reset`.
