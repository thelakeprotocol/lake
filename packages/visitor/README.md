# @thelakeprotocol/visitor

The `lake` CLI. Image: `ghcr.io/thelakeprotocol/lake`.

```bash
lake knock <house-url> [--offer research|gp|marketing|injection] [--as <domain>]
           [--purpose p --fields a,b --price 2 --retention none] [--note "..."]
           [--tamper forge-card|unsigned|replay|impersonate] [--json]
```

`knock` signs an offer with a visitor key (kept in `~/.lake/`), sends it over A2A declaring the Lake extension, and verifies the house's signed reply. `--tamper` sends the attacks a house must reject.

Coming: `lake dispatch` (milestone 3), `lake attack` (6), `lake revoke` (4), `lake reset`.
