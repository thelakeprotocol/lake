# Your phone, your keys

<p class="lead">Your rules answer the easy knocks. The rest come to your phone. You tap Allow or Deny, and the key is cut <b>on your phone, with your key</b>. The housekeeper never holds anything that could mint one.</p>

<span class="status done">runs</span>

## Pair your phone

When a house starts without an owner, it prints a link and a QR code:

```
[house:strict] no owner yet. On your phone, open http://192.168.1.20:4001/owner/#pair=hTnSz3EZkE4NGIz2
```

Open it on your phone and tap **Pair this phone**. A key pair is made on the phone; only its public half goes to your house, into your pod's `/wallet/`. The link works once. In a sandbox demo the house can be started with `LAKE_OPEN_PAIRING=1`, and then the first phone to open the app becomes the owner.

From a phone on the same Wi-Fi, start the Lake with your laptop's address so links and the map's QR code point at it:

```bash
LAKE_PUBLIC_HOST=192.168.1.20 docker compose up -d
```

## What you see

One card per request: who is asking, the question, the purpose, the exact fields, whether they keep anything, the price, how long the key lasts, and what your housekeeper recommends. Two buttons: **Allow** and **Deny**.

**Allow** signs a `LakeAccessGrant` credential on your phone: this visitor, this study, these fields, this purpose, 48 hours. The house checks it is signed by your key and matches exactly what you were shown, stores it in your pod's `/agreements/`, and hands it to the visitor.

**Your keys** lists every key to your house that is still live: who holds it, for what, how long is left, and whether a standing rule or you issued it. **Revoke** pulls one; **Revoke every key** pulls them all. A revoked key stops working at once: the next request with it is refused, and the map shows every line into your house snap.

## From the command line

Whoever runs the machine can pull every key of a house:

```bash
docker compose exec house-stan node dist/admin.js revoke-all
```

## What it can't do yet

- Push notifications. The app checks once a second while it is open, and vibrates on Android when something new arrives.
- Over-asking refused below the housekeeper. Visitors never touch your pod, but the housekeeper and your pod's MCP door run in one process, so a compromised housekeeper is not yet stopped by the pod itself. [Help wanted](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).
