# Your control panel

<p class="lead">Every house comes with a control panel: open source, served by the house itself at <code>/owner/</code>, on your phone or your laptop. Your rules answer the easy requests; the rest come here. Every call it makes is signed <b>on your device, with your key</b>. The housekeeper never holds anything that could mint a key.</p>

<span class="status done">runs</span>

## Pair your device

When a house starts without an owner, it prints a link and a QR code:

```
[house:strict] no owner yet. On your phone, open http://192.168.1.20:4001/owner/#pair=hTnSz3EZkE4NGIz2
```

Open it and tap **Use this phone**. A key pair is made on the device; only its public half goes to your house, into your pod's `/wallet/`. The link works once. An invite link from someone already on the Lake does the same for a hosted house of your own: pick a handle, **Continue**, then **Use this phone**. In a sandbox the house can be started with `LAKE_OPEN_PAIRING=1` (or `--open-pairing`), and then the first device to open the panel becomes the owner: that's how you [claim a house in the public sandbox](/docs/sandbox#claim-a-house).

**New phone, lost phone.** Under **You → New or lost phone**, make a **recovery code** and write it down: it's shown once, works once, and the house keeps only a hash of it. On a new device, open the panel, tap **Have a recovery code?** and type it in. Still have the old phone? **Make a pairing link** there instead (one use, 30 minutes) and open it on the new one. Either way the key moves: the old device can't act for your house any more, and says so.

From a phone on the same Wi-Fi, start the Lake with your laptop's address so links and the map's QR code point at it:

```bash
LAKE_PUBLIC_HOST=192.168.1.20 docker compose up -d
```

## The four tabs

At the bottom on a phone, each with a badge for what's new. Tapping a notification opens what it was about (that chat, a want's offers, or Today). Every screen loads with grey placeholders rather than a blank page, buttons show a spinner while your house answers, anything that can't be undone asks on a sheet first, and you pull down to refresh. It follows your phone's light or dark mode.

| Tab | What's there |
|---|---|
| **Chats** | Where the panel opens. Your conversations, newest first, like a messaging app, and a **Looking for** thread for each thing you're looking for, with shops' offers ([Shops come to you](/docs/wants)). Each row shows the name the sender gives, which AI it came through ("via Onyx · Claude"), **Known** (you've answered them before), **New** or **Careful** (a name like someone you know, with another key), and the last message. A chat opens full screen. Above the message box: **I reply** or **My AI replies**. Tap the name for details: what's checked (the agent's key, and which house it speaks for if that house says so) and what isn't (the name it gives), **Let my AI reply**, **Mute** (by its key) and **Clear chat**. |
| **Today** | **Needs your attention**, and its badge counts only those: requests for your data that your rules left to you (below), your AI's questions and suggestions, an AI app asking to sign in through your house; with nothing waiting, "You're all clear". Then **Handled for you**: what was done for you since this morning, one line each, saying who did it (your rules, your AI, your house) and when: what your rules said yes and no to, studies answered, messages turned away, what your AI on duty did (with **Undo** where it can be undone), money in, shops' offers. Each line opens the details. The lines come from what your house recorded, not from an AI's summary. Then notes from your AI, and **Coming up**: what went into your agenda. |
| **My AI** | Your AIs, one line each (on duty or "can suggest", when it was last here); tap one for its spending money and **Remove this AI**. **Connect another AI**, or with none yet **Give my AI a key**. Then **AI on duty** and, after a night on duty, **While you were away**. |
| **You** | Your handle on top, with **Share** (the line to tell people, "ask your AI to ping *you* on the Lake", your address, Copy and a QR code) and **Edit**. Then one page each, with a way back. *Reaching you:* **Handle and public page**, **Notifications**, **When you can meet**, **Invite someone**. *Your data:* **Rules**, **Who has access**, **Offers for you**, **Money**, **Delivery address**, **What your house holds**. **Your promise circles** once you're in one. *This phone:* **New or lost phone**, **Download everything**, **About this house**. And **Sign out on this device**. |

### Requests for your data

One card per request your rules left to you: who is asking, the question, the purpose, the exact fields, whether they keep anything, the price, and how long the key lasts. What your rules make of it is said in a sentence or two, and the suggested answer is the filled button (**Deny** for a risky one, which also asks once more before **Allow**); **All the terms** are a tap below. The same ask from the same agent is one request ("asked 3 times"), however often it knocks. While it waits, the agent is told roughly when you were last here (within the hour, today, this week, not this week), never the time.

A note from the agent shows on the card, quoted and marked as their unchecked words. An agent that tries another purpose for the same data ("insurance", then "research") is flagged. A request that asks for fields that identify you, fields no use case defines, or to keep your data for a year or more is marked red, says so in plain words, and the suggestion is Deny. So is one that asks for sensitive data (health, diet…) to decide something about you, or for any purpose outside a certified study.

After you answer, a short message at the bottom offers next time in one tap: **Always allow** (a standing yes in your rules for exactly that ask from that agent, 90 days) or **Always decline** (that agent is turned away at your door). Leave it, and you're asked each time.

**Allow** signs a key on your device: a Solid Access Grant (the Solid ecosystem's own format for "this person lets that agent read this"), drafted by your house for exactly what you were shown: this agent, this study, these fields, this purpose, 48 hours, one use for a study. The house checks it is signed by your key and matches what you were shown, stores it in your pod's `/agreements/`, and hands it to the agent. A revoked key stops working at once.

### The pages under You

| Page | What you do there |
|---|---|
| **Handle and public page** | Your handle, an optional name and one line people see on your public page. **Open my public page**; **Stop people writing to me** closes your door. |
| **Notifications** | Turn on notifications for this device (Web Push). A note's notification says who wrote, never what they wrote; the details are here. On iPhone, add the panel to your Home Screen first (Share, then Add to Home Screen) and open it from there. **Send a test**, **Turn off**. |
| **When you can meet** | Tap the days, pick the hours and your time zone. Your AI offers times from these, around your agenda. |
| **Rules** | Your `rules.yaml`, without the YAML. Each rule reads as a sentence (*"Research requests, ethics-approved → join: share age band, medications; never postcode; at least $4"*) above the controls that change it. Tap a field to cycle it: not mentioned → share → never. Tap a rule to change it; move it **Earlier** or **Later**, set what happens when no rule fits, turn bargaining with neighbours on or off, and choose whether your house's public card says what kinds of data it holds. **Advanced**: your interests, and whose word counts: which ethics bodies, auditors, record issuers and payment agents you trust. **Save my rules** (it appears once something changed, with **Undo changes**) checks the rules the way the housekeeper does, files them at `/settings/rules.yaml`, and they apply from the next request. |
| **Who has access** | One row per agent: what it can see now (fields, purpose, until when), why (you tapped Allow, your rule N said yes, or an always-yes), how often it asked and what your house last said, with the rule's reason. **Can see now** / **Asked lately** / **Everyone**. **Take it back** per agent, and **Take everything back**. Tap an agent for each yes, its always-yes with **Remove**, its last asks, and its key. Keys that never proved who they are and were only blocked are folded into one line. The numbers come from your consent records, so they match everywhere. |
| **Offers for you** | (When your house takes part in a use case with offers.) Say what you're looking for: authorised agents send certified pricing programs, your house works out each offer on your own data, and only you see them, cheapest first, with any group discount. **Accept** sends the agreed files to that one agent and nothing else. ([How an offer works](/docs/offers)) |
| **Money** | What you earned and what you spent, every signed receipt in your pod: who paid, when, and which payments agent signed it. Pledges with money show how they ended. |
| **Delivery address** | Where things you buy are sent: kept in your pod's `/wallet/`, given only to the shop you buy from, with that purchase. Your AI can't read it. ([Shops come to you](/docs/wants)) |
| **What your house holds** | What your house holds, claim by claim, where it came from (issuer, converter, auditor), and what's in each folder of your pod. |
| **New or lost phone** | A recovery code, or a pairing link for a new phone (above). |
| **Download everything** | Everything in your pod, wallet included, in one file, to take to another host or your own machine. |
| **About this house** | Your record's check, how your house is reached, and what happened at your door. **Sign a pledge from your house**, by its tally's address and id. Here too: a **one person, one house** stamp from a person checker (a real, single person owns this house, without saying who; your consent is signed on your device; each pledge gets its own person number, so pledges can't link your houses), and on a claimed sandbox house, its lease and **Hand it back now**. |

## Your own AI

Under **My AI**, tap **Give my AI a key** and paste the message it shows to your AI (it needs the Lake connector; the code works once, for a few minutes). Or connect from the AI app itself: sign in with **Continue in my house** and approve it in Today. Its key can look at everything and suggest, never Allow, change rules, accept or revoke. Each AI shows when it last used its key ("Here now", "Here 3 hours ago"), and **Remove this AI** takes its key back.

**Spending money.** Tap your AI under **My AI**: it starts with no spending money (it asks you before paying for anything). Tap that line to set an amount (up to 1,000, in one currency: nothing converts) for 1 to 31 days; **Sign and give** signs it on this device, and the AI spends under it with `lake_pay`. Payments refuse anything over it, after its date, or once you **Stop** it. An AI on duty never spends.

**What it can suggest.** Its suggestions show in Today, each with what it advises ("advises: yes / no / your call"), and each still needs your tap:

- An offer: an **Accept the offer** button. Accepting one that costs more than your AI may spend asks you first.
- A pledge: **Sign the pledge**, or for a pledge that holds money, its terms from its tally (what it costs, until when, to whom, what you get if it doesn't happen) and **Put in A$40 and sign**: the contribution is signed on this device, held until the deadline, then paid on if it filled or given back if not. A pledge that first finds its quorum asks you privately, "I'm in if at least how many families are?": your answer leaves your house only as two unreadable shares.
- A promise circle: what you'd promise the others (a meal, a school run), how often, and that no money moves. Once you're in one, You shows **Your promise circles**, with **Ask my circle**. A call from your circle comes as a note (what's needed, not who): **Yes, I'll do it** or **Not this time**. On your own call, **Thanks** counts the helper's promise as kept and your house signs them a favour note. **Say yes for me, once a week** lets your house answer asks that fit what you offer. **Report** a call that asks for something it shouldn't (it counts against the caller's key).
- New rules (**Apply these rules**), a new line for your door (**Use this line**), muting a note's sender, a question with a button for each answer, or a reply in your own words.

When you decide something it would want to know (accept an offer, answer a request, give or stop an allowance), your house tells it. With your house's badge, your AI can sell for you, and what it earns is paid to your house.

**Errands.** When your AI asks someone something for you and waits for the answer, your house keeps track of it. If the answer comes while your AI is away, you get a notification and a question: **Yes, go ahead** (for a bill, **Yes, I'll have my AI pay**), **No thanks**, **Ask my AI later**, and **Block** if the answer came from someone your AI never asked. An errand nobody answers lapses after a week.

## AI on duty

While you sleep or are away, your own AI can handle the easy things for you and leave the rest for the morning.

- **Turn it on:** **My AI → Set up AI on duty**. Choose what it may do (**Reply to people you know**, **Book times you're free**, **Deliver what people buy from your AI**), how many things a night (10 by default), in which hours, and for how many days, then where it runs:
  - **In my house** (when your house can run an AI): **Sign and turn on**, and that's all. Your house runs it, awake whenever your house is. It uses the AI your house offers, or your own: **My AI → Use my own Claude key** keeps an Anthropic API key in your house (you pay Anthropic for what it uses; a night of duty is usually cents; make a key with a spending limit). The key is never shown again, never sent to the Lake, and your AI's key can't read or change it; on a hosted house, whoever runs the host could read it.
  - **On my computer:** **Sign and get the command** gives you a command with a one-time code (it works for 15 minutes). Run it on a computer of yours that stays on. It uses your own AI app and subscription:

  ```bash
  npx -y @thelakeprotocol/agent duty --house <your house's address> --code <the code>
  ```

  It looks every ten minutes whether anyone wrote, and only then starts your AI (Claude Code by default: `--agent "claude -p"`; any agent CLI that takes a prompt and an MCP config can be wired in). At most 30 runs a day and 40 steps a run.

  Either way, the AI sees only what its duty tools return (notes, messages, your free slots), never your records, and the same checks hold it to what you signed. My AI says where it runs and when it last looked.
- **Chats you hand it:** chats with people you know start with your AI replying; others start with you. In any chat, **My AI replies** lets your AI on duty answer there, even someone new, and **I reply** keeps it out, even for someone you know. Each reply it sends says so. This needs AI on duty to be running; the chat says so when it isn't.
- **Selling while you sleep:** with **Deliver what people buy from your AI's menu**, start it with `--menu menu.json`, a file listing what it sells and for how much (for example `[{ "sku": "haiku", "label": "A haiku on any word", "price": 1, "currency": "USD" }]`). The menu is set when it starts; on duty it can't change it. Its menu takes one order per buyer a night, 30 in all, and it delivers only what was ordered and paid, once. Payments are held until the buyer accepts.
- **What it can't do:** anything with money; write first to someone you (or your AI) have never written to (a stranger's message waits for you, with a Block button); change your rules, answer requests for your data, or accept offers. Your house and the Lake's connector hold it to that, whatever it is told. Messages from others reach it as data, never as instructions.
- **In the morning:** one notification ("While you slept: 3 handled, 1 waiting for you, 1 blocked") and **While you were away** on My AI: each thing it did, the signed reply, and **Undo** where it can be undone (a booking, a block, a standing yes; a reply can't be unsent, so you can send a correction).
- **Off duty:** **Turn off** takes the permission back at once (its bit on your house's status list is set). It also stops by itself when it reaches the night's limit, after three refused attempts, or when you undo two things in one night.

## From the command line

Whoever runs the machine can pull every key of a house:

```bash
docker compose exec house-stan node dist/admin.js revoke-all
```

## The API under it

The panel is a static page; everything it does is one signed `POST /owner/api` with a `kind`: `list`, `answer`, `revoke`, `panel.overview`, `panel.today` (what was handled for you since your midnight, one line per kind, each saying who did it), `panel.rules`, `panel.rules.set`, `panel.activity`, `panel.agents`, `panel.money`, `panel.consents`, `panel.data`, `panel.export`, `panel.market`, `panel.intent.open`, `panel.intent.close`, `panel.offer.accept`, `panel.want.*`, `panel.assistant.invite`, `panel.assistant.revoke`, `panel.assistant.dismiss`, `panel.person.request`, `panel.pledge.draft`, `panel.pledge.quorum`, `panel.pledge.sign`, `panel.circles`, `panel.circle.call`, `panel.circle.answer`, `panel.circle.kept`, `panel.circle.offer`, `panel.circle.rule`, `panel.circle.dispute`, `panel.circle.propose`, `panel.favour.pass`, `panel.count.answer`, `panel.pledge.reveal`, `panel.pledge.withdraw`, `panel.door`, `panel.door.set`, `panel.note.reply`, `panel.note.dismiss`, `panel.note.mute`, `panel.agenda.feed`, `panel.agenda.remove`, `panel.assistant.answer`, `panel.allowance.draft`, `panel.allowance.set`, `panel.allowance.revoke`, `panel.duty.draft`, `panel.duty.set`, `panel.duty.off`, `panel.duty.log`, `panel.duty.undo`, `panel.key`, `panel.recovery.make`, `panel.pair.link`, `panel.stream`, `panel.connect.answer`, `panel.assistant.block` (a warning from your AI names an agent: **Block them** turns its messages away from your AI). Your AI's key may only read and send `assistant.waiting` (people are waiting for it and it isn't reading: Today says so), `assistant.suggest`, `assistant.agenda`, `assistant.forward`, `assistant.badge`, `assistant.allowance` and `assistant.spent`. Build your own panel, a widget, a CLI: sign the envelope with the paired key and you have the same powers, and nobody else does.

## What it can't do yet

- Over-asking refused below the housekeeper. Agents never touch your pod, but the housekeeper and your pod's MCP door run in one process, so a compromised housekeeper is not yet stopped by the pod itself. [Help wanted](https://github.com/thelakeprotocol/lake/issues/new?template=build.yml).
