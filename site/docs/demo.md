# Run the demo

<p class="lead">The on-stage story, about three minutes, on one laptop. Every step is real: pods, signatures, keys, payments.</p>

<video controls muted playsinline preload="none" poster="/demo-poster.jpg" style="width:100%;border-radius:6px;border:1px solid var(--vp-c-divider)"><source src="/demo.mp4" type="video/mp4"></video>

## Before you go on

```bash
git clone https://github.com/thelakeprotocol/lake && cd lake
LAKE_PUBLIC_HOST=<your laptop's LAN IP> docker compose up -d     # two nodes, the specialists and guides, a demo bank and register, eight demo lenders, three houses, a swarm
docker compose --profile scale run -d --name lake-multi house-multi --tenants 60   # optional: 60 more houses
```

Open the map at `http://localhost:7000` on the big screen. Scan its QR code with your phone and tap **Pair this phone**: you are now the owner of the house that asks.

## The script

| # | Say | Do |
|---|---|---|
| 1 | "Every square is someone's home: a pod with a housekeeper. Nobody owns this Lake." | Point at the map: traders moving, guilds linking, attacks already being blocked. |
| 2 | "Joining is one command." | `docker run -d --network lake_default --hostname house-you ghcr.io/thelakeprotocol/lake-house --name you` and watch it pop up. |
| 3 | "A researcher has one question." | `docker compose run --rm lake demo --pace 2000 --wait 20` |
| 4 | "Ethics, then audit: signed, by people the owners trust." | The orange agent visits each specialist. |
| 5 | "It knocks on every house. $2 each, and it wants postcodes." | The broadcast ripple; houses turn green, amber or grey. |
| 6 | "The houses noticed. They push back together." | **$2 → $5**, postcode dropped. |
| 7 | "My phone just buzzed." | Tap **Allow** on stage. |
| 8 | "The study runs inside each house. Only noise-protected answers leave." | Threads back to the agent; payments; **Records moved: 0**. |
| 9 | "Here's an attacker." | It's in the same `lake demo` run: forged cards, replays, injection. Quarantined, no human involved. |
| 10 | "I changed my mind." | **Revoke every key** on your phone; the lines snap. |
| 11 | "And nobody owns the water." | `docker stop lake-node-a`. The map on `:7001` (node B) keeps going; studies keep working. |

## Making a smooth video

Screen-recording a live Lake on a busy laptop drops frames. Record the events instead, then render the video frame by frame: the map has a capture mode that plays a recording on a virtual clock.

```bash
# 1. record a real run: LAKE_RECORD=/data/run.jsonl on lake-node, run the script, copy the file out
docker cp lake-node-a:/data/run.jsonl .
# 2. serve it, and open the map in capture mode
lake-node --replay run.jsonl --port 7730
#    http://localhost:7730/?capture&replay=/replay.jsonl&from=<ms into the run>
# 3. step it from a browser driver: window.__lakeStep(1000 / 30) then a screenshot, 30 times a second of video
```

The video on the home page was made this way: a real run, rendered at a steady 30 frames a second.

## If something goes wrong

- **Reset in under a second:** `docker compose run --rm lake reset` clears counters, history and quarantines on every node. Houses stay.
- **Seeded:** houses run with `LAKE_SEED=42`, so the same study gives the same answers every time.
- **Replay:** record a good run beforehand and play it back through the map if live mode fails:

```bash
# record: add LAKE_RECORD: /data/run.jsonl to lake-node's environment in docker-compose.yml, then do a rehearsal
docker run -p 7002:7000 -v lake_node:/data ghcr.io/thelakeprotocol/lake-node --replay /data/run.jsonl --loop
# the recorded run plays on http://localhost:7002 at its original pace
```
