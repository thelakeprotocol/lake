# Security

The Lake is a security project. Breaking it is a contribution.

## Report privately

Use GitHub's **[private vulnerability reporting](https://github.com/thelakeprotocol/lake/security/advisories/new)**. Don't open a public issue for something that lets an attacker in.

We aim to answer within 7 days. Once it's fixed, you get credit in the release notes and in the hall of fame below, unless you'd rather not.

## What counts

Anything that breaks one of the three laws:

- **A record leaves a pod**, or the Records moved counter misses one.
- **An agent mints, widens or extends a key** without a human's approval.
- **A forged, unsigned or replayed** card or message is accepted.
- **Free text changes a decision** (prompt injection between agents).
- **Uncertified code runs** in a house, or certified code gets network or write access.

## Not in scope (yet)

This is pre-1.0 demo software running synthetic data. Production hardening of the reference containers, denial of service against a local laptop, and settlement of real money are explicit non-goals for now. Report them anyway if they're interesting; just don't expect a fix this week.

## Hall of fame

Empty. Be first.
