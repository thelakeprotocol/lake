# Decisions

<p class="lead">Where a standard left room, here is what we chose and why. Disagree? Open a <a href="https://github.com/thelakeprotocol/lake/discussions">discussion</a>.</p>

| Area | Choice | Why |
|---|---|---|
| A2A version | A2A **1.0**, official `@a2a-js/sdk`, JSON-RPC binding | Current spec; the SDK signs and verifies cards for us |
| Lake fields on cards | Inside a declared A2A **extension**, marked `required` | A2A 1.0 signatures only cover schema fields; extension params are covered. `required` makes clients say they speak Lake |
| Signatures | **Ed25519 (EdDSA)** JWS; cards per A2A §8.4 (JCS); messages over JCS of the payload | Small, fast, widely supported |
| Credentials | W3C **VC 2.0** secured with **VC-JOSE-COSE** (`typ: vc+jwt`) | Simplest standard securing that reuses the same keys |
| Pinning records | VC `relatedResource` with **`digestSRI`** | The original stays untouched in the pod; any change breaks the digest |
| Synthetic records | A seeded generator that emits **Synthea-shaped FHIR R4** | Synthea needs Java and minutes per run; the converter also reads real Synthea exports |
| Fictional drugs | "Drug X/Y/Z" under a Lake code system | The demo must never look like advice about a real medicine |
| Pod URL inside a house | `http://localhost:3000/` | Solid-OIDC allows plain HTTP only on localhost. Public houses put TLS in front |
| Sandbox Lakes | Domain proof skipped and marked `sandbox` | A local Lake has no real domains; the reply says the domain wasn't proved |
| Ethics and audit claims | Count only as signed credentials from a domain on the owner's `trust` list | An offer can't vouch for itself, and nobody appoints authorities for the Lake |
| Studies | **Declarative** (up to four yes/no questions), not code | Fully auditable and safe to run anywhere; arbitrary code needs attested execution (stretch goal) |
| What a house sends back | One cell, randomised with **unary randomised response** (local differential privacy, ε ≤ 4) | A single fragment from a one-person house would otherwise be that person's data |
| Broadcast | **Direct A2A** to every discovered house, 32 at a time; no NATS | Direct messaging is required anyway (SPEC §9); a bus is an optimisation to revisit at 1,000 houses (milestone 7) |
| Converter certificates | The auditor certifies `name@version` from an allowlist | Pinning the package digest is a follow-up |
| Grants | A `join` is the owner's standing pre-approval; keys are minted by the owner's approval flow (milestone 4) | Agents never mint keys |
| LLM | **None bundled.** Rules decide; templates write reasons | People bring their own agents through MCP or A2A |
