# Data model & converters

<p class="lead">The Lake speaks exactly one data language. Everything else gets translated at the door, inside the house, so raw data never leaves the pod.</p>

## One model, N converters

N standards need N converters into one canonical model, not N² mappings between each other.

- **RDF / Linked Data**, stored natively in Solid pods, validated with **SHACL**.
- **Small core:** `Party`, `Thing`, `Claim`, `Provenance`, `Offer`, `Terms`, `Receipt`.
- **Domains extend the core.** Health adds `AgeBand`, `Medication`, `Condition`, `Readmission`. Energy, cars and rentals add their own claim types the same way.
- **Versioned.** Messages name the model version; nodes accept the current and previous major.

<span class="status done">drafted</span> [`model/lake.ttl`](https://github.com/thelakeprotocol/lake/blob/main/model/lake.ttl) (ontology) and [`model/shapes.ttl`](https://github.com/thelakeprotocol/lake/blob/main/model/shapes.ttl) (SHACL shapes).

## Provenance tiers

Every value carries a tier, and offers state the minimum they accept:

| Tier | Example |
|---|---|
| `self-reported` | You typed it in |
| `device-signed` | Your wearable signed it |
| `issuer-signed` | Your hospital, lab or pharmacy signed it as a Verifiable Credential |

## The trust chain

1. The **original** signed record (for example a hospital's signed FHIR bundle) stays in the pod unchanged.
2. The **converted** claim carries the original's hash, the converter's package name, version and certificate, and the housekeeper's signature.
3. **Study code verifies all three** before using a value. Any failure drops the value, and that house isn't paid.

## Write a converter <span class="status done">first one: FHIR, runs</span>

A converter is a package that maps one external standard into the canonical model: `@thelakeprotocol/convert-fhir` first, then whatever you need.

- Runs **inside the house**. Raw source data never leaves.
- Must be **signed by its author** and **certified by the Auditor** before a house will run it, the same rule as study code.

Converters we want: bank CSV, Apple Health, Google Fit, Strava, smart meters, payslips, tenancy records. [Claim one](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).
