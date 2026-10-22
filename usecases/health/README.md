# @thelakeprotocol/usecase-health

**The `health@1` pack.** Health research on the Lake: what a house holds, where it comes from, and what may be asked of it.

| | |
|---|---|
| Fields | `age_band` (band), `medications` (code), `conditions` (code), `readmissions` (flag), each mapped to FHIR |
| Identifying (never readable by a program) | `name`, `dob`, `nhs_number`, `email`, `phone`, `address` |
| Source | a demo hospital signs a synthetic FHIR R4 bundle (`LakeHealthRecordCredential`); the converter `@thelakeprotocol/usecase-health/fhir@1.0.0` turns it into claims inside the house |
| Shapes | [`shapes.ttl`](shapes.ttl), on top of the core's `model/shapes.ttl` |
| Vocabulary | [`vocab.ttl`](vocab.ttl) |
| Examples | the readmission study, the sandbox sponsor's studies, offers to knock with (`gp`, `research`, `marketing`, `injection`) |

Load it with `--packs health` (the default) on a house, the specialists or the CLI. Synthetic data only.
