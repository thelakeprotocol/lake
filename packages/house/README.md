# @thelakeprotocol/house

**Status: milestone 1, next.** Not built yet. [Claim it](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).

A house: one container that starts a Solid pod (Community Solid Server, or any Solid server) and the housekeeper that guards it.

- Creates the owner's WebID and folders: `/health/`, `/finance/`, `/agreements/`, `/receipts/`, `/wallet/`.
- Loads one **synthetic** Synthea FHIR patient, signed by the Issuer, converted to the canonical model.
- Housekeeper: A2A endpoint, wallet, rules engine from `@thelakeprotocol/core`, reads the pod **only through MCP**.
- Publishes its signed card, registers with the Lake, emits `house.joined`.
- Multi-tenant mode (`--tenants 250`) for the 1,000-house run.

Done when: `docker run ghcr.io/thelakeprotocol/lake-house --name stan` answers an A2A offer through MCP and appears on the map within 5 seconds.
