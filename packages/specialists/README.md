# @thelakeprotocol/specialists

Image: `ghcr.io/thelakeprotocol/lake-specialists`. `lake-specialist <issuer|ethics|auditor>`.

| Agent | Status | Does |
|---|---|---|
| **issuer** | runs | Plays the hospital: makes a synthetic FHIR record for a WebID and signs it as a W3C VC whose `relatedResource.digestSRI` pins the record. Keeps nothing. |
| **ethics** | runs (demo) | A2A. Reviews `{ kind: "ethics-review", protocol }` against a fixed checklist and signs a `LakeEthicsApproval` for that study and those fields. A demo, not a human committee; it counts only with owners who trust its domain. |
| **auditor** | runs (demo) | A2A. Certifies declarative studies (`LakeStudyCertificate`) and reviewed converter packages (`LakeConverterCertificate`). |
| **payments** | runs (demo) | A2A. Checks the AP2 chain (a human's Intent Mandate from the agent's own organisation, the agent's Payment Mandates under it, the budget), refuses past the budget, settles (simulated) and signs a `LakeReceipt` per payee. |

Default domains in sandbox: `issuer.lake.local`, `ethics.lake.local`, `audit.lake.local`, `payments.lake.local`.
