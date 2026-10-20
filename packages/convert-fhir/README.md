# @thelakeprotocol/convert-fhir

**Status: runs, tested against the SHACL shapes.**

FHIR R4 → canonical Lake model, inside the house. Reads Synthea exports and the built-in seeded generator.

| Export | Does |
|---|---|
| `syntheticPatient(seed, asOf?)` | One deterministic synthetic patient (Patient, Condition, MedicationRequest, inpatient Encounters) |
| `extractClaims(bundle)` | Age band, medications, conditions, readmissions (an inpatient stay within 30 days of the last discharge) |
| `fhirToLake(bundle, opts)` | Turtle in the canonical model, with provenance: issuer, original hash, converter name@version, certificate |

The certificate is `urn:lake:cert:uncertified` until the Auditor (milestone 3) signs this converter.
