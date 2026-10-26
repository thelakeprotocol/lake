# Your control panel

<p class="lead">Every house comes with a control panel: open source, served by the house itself at <code>/owner/</code>, on your phone or your laptop. Your rules answer the easy knocks; the rest come here. Every call it makes is signed <b>on your device, with your key</b>. The housekeeper never holds anything that could mint a key.</p>

<span class="status done">runs</span>

## Pair your device

When a house starts without an owner, it prints a link and a QR code:

```
[house:strict] no owner yet. On your phone, open http://192.168.1.20:4001/owner/#pair=hTnSz3EZkE4NGIz2
```

Open it and tap **Pair this device**. A key pair is made on the device; only its public half goes to your house, into your pod's `/wallet/`. The link works once. In a sandbox the house can be started with `LAKE_OPEN_PAIRING=1` (or `--open-pairing`), and then the first device to open the panel becomes the owner: that's how you [claim a house in the public sandbox](/docs/sandbox#claim-a-house).

From a phone on the same Wi-Fi, start the Lake with your laptop's address so links and the map's QR code point at it:

```bash
LAKE_PUBLIC_HOST=192.168.1.20 docker compose up -d
```

## What's in it

| Tab | What you do there |
|---|---|
| **Home** | Requests waiting, knocks today, live keys, money earned, attacks blocked (tap one to open its tab). Whether your record checks out (signed by a trusted issuer, unchanged, converted by a certified converter). How agents reach you: directly, or through the Lake's relay. What just happened at your door. |
| **Home: one person, one house** | Get a stamp from a person checker saying a real, single person owns your house, without saying who (your consent is signed on your device). Sign a pledge from your house; pledges that count people count you once, whatever number of houses you have. Your stamp's person number stays hidden: each pledge gets its own number for you, so pledges can't link your houses. |
| **Requests** | One card per request your rules left to you: who is asking, the question, the purpose, the exact fields, whether they keep anything, the price, how long the key lasts, and what your housekeeper recommends. **Allow** or **Deny**. The same ask from the same agent is one request ("asked 3 times"), however often it knocks. While it waits, the visitor is told roughly when you were last here (within the hour, today, this week, not this week), never the time. A visitor's note shows on the card, quoted and marked as their unchecked words, and a visitor that tries another purpose for the same data ("insurance", then "research") is flagged red. A request that asks for fields that identify you, fields no use case defines, or to keep your data for a year or more is marked red, says so in plain words, and your housekeeper recommends No. So is one that asks for sensitive data (health, diet…) to decide something about you, or for any purpose outside a certified study: whatever purpose it names, nobody checked it, and Allow lets that agent use your own data, not a total. |
| **Offers** | (Shown when your house takes part in a use case with offers.) Say what you're looking for (a home loan, say): authorised agents send their certified rules, your house works out each offer on your own data, and only you see them, cheapest first, with any group discount. **Accept** sends the agreed files to that one agent and nothing else. ([How an offer works](/docs/offers)) |
| **My agent** | Your own AI agent, inside your house. Tap **Give my AI agent a key** and paste the message it shows to your agent (it needs the Lake connector; the code works once, for a few minutes). Its key can look at everything and suggest, never Allow, change rules, accept or revoke. Its suggestions show here and on Home; one that names an offer has an **Accept the offer** button, one that names a pledge a **Sign the pledge** button, and a question has a button for each answer (your answer goes back to your agent). What it advises shows as a plain "advises: yes / no / your call", never something you have to read between the lines. Signing a pledge shows in your own activity, and nowhere public. Accepting an offer that costs more than your agent may spend asks you first: what you share goes out the moment you accept. When you decide something it would want to know (accept an offer, answer a request, give or take back an allowance), your house tells it. If it gets one wrong it can replace or withdraw its own note. Revoke it any time. **Spending money:** give a connected agent an allowance (say AUD 150 for 7 days, in the currency the shops you use quote in: nothing converts) and tap **Sign and give**: it's signed on this device with your key, and the agent spends under it with `lake_pay`. Payments refuse anything over it, after its date, or once you **take it back**. |
| **Keys** | Everyone you've said yes to, newest first, read from the consent records in your pod: who, which fields, for what purpose, how you said yes ("your rule 3 said yes", or "you tapped Allow"), whether they keep anything, and until when. Each one says where it stands: live (with the time left), taken back (and when), used (a study's key works once), or ended. **Take it back** on a live one revokes its key, and the record in your pod is marked withdrawn, with the date. **Take every key back** does them all. On a sandbox house you claimed, the list starts when you claimed it. |
| **Rules** | Your `rules.yaml`, without the YAML. A rule can match offers paying less than an amount ("decline research paying under $5"), and a switch decides whether your house's public card says what kinds of data it holds. Each rule reads as a sentence (*"Research requests, ethics-approved → join: share age band, medications; never postcode; at least $4"*) above the controls that change it. Tap a field to cycle it: not mentioned → share → never. Reorder rules, set what happens when no rule fits, turn bargaining in blocs on or off, pick your interests (for guilds), and choose whose word counts: which ethics bodies, auditors, record issuers and payment agents you trust. **Save** checks the rules the same way the housekeeper does, files them in your pod at `/settings/rules.yaml`, and the housekeeper uses them from the next knock. |
| **Visitors** | Every agent that came to your door lately, what your house told it, how many of its tricks were blocked, and its reputation across the Lake. Keys that never proved who they are and were only blocked are folded into one line. |
| **Money** | What you've earned, and every signed receipt in your pod: who paid, when, and which payments agent signed it. |
| **Data** | What your house holds, claim by claim, where it came from (issuer, converter, auditor), and what's in each folder of your pod. |
| **Move house** | Download everything in your pod, wallet included, in one file. Your house is yours: take it to another host or your own machine whenever you like. |

**Allow** signs a key on your device: a Solid Access Grant (the Solid ecosystem's own format for "this person lets that agent read this"), drafted by your house for exactly what you were shown: this visitor, this study, these fields, this purpose, 48 hours, one use for a study. The house checks it is signed by your key and matches exactly what you were shown, stores it in your pod's `/agreements/`, and hands it to the visitor. A revoked key stops working at once: the next request with it is refused, and the map shows every line into your house snap.

## From the command line

Whoever runs the machine can pull every key of a house:

```bash
docker compose exec house-stan node dist/admin.js revoke-all
```

## The API under it

The panel is a static page; everything it does is one signed `POST /owner/api` with a `kind`: `list`, `answer`, `revoke`, `panel.overview`, `panel.rules`, `panel.rules.set`, `panel.activity`, `panel.agents`, `panel.money`, `panel.consents`, `panel.data`, `panel.export`, `panel.market`, `panel.intent.open`, `panel.intent.close`, `panel.offer.accept`, `panel.assistant.invite`, `panel.assistant.revoke`, `panel.assistant.dismiss`, `panel.person.request`, `panel.pledge.sign`. Your assistant's key may only read and send `assistant.suggest`. Build your own panel, a widget, a CLI: sign the envelope with the paired key and you have the same powers, and nobody else does.

## What it can't do yet

- Push notifications. The panel checks every second and a half while it is open, and vibrates on Android when something new arrives.
- Over-asking refused below the housekeeper. Visitors never touch your pod, but the housekeeper and your pod's MCP door run in one process, so a compromised housekeeper is not yet stopped by the pod itself. [Help wanted](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).
