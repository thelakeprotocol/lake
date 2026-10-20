# @thelakeprotocol/specialists

Image: `ghcr.io/thelakeprotocol/lake-specialists`.

| Agent | Status | Does |
|---|---|---|
| **issuer** | runs | Plays the hospital: makes a synthetic FHIR record for a WebID and signs it as a W3C VC (VC-JOSE-COSE) whose `relatedResource.digestSRI` pins the record. Keeps nothing. |
| ethics | milestone 3 | Reviews a study protocol; signs an approval credential |
| auditor | milestone 3 | Checks study code and converters; signs certificates |
| payments | milestone 5 | Verifies AP2 mandate chains; records simulated settlements |

```bash
docker run -p 4300:4300 ghcr.io/thelakeprotocol/lake-specialists issuer --url http://localhost:4300
```
