# Shops come to you

Your shower head is worn out and you want one like it. Instead of searching, take a photo and tell your AI: "find me one like this". Your AI writes down what it is (a handheld shower head, 3 spray modes, chrome, a ½ inch thread) and lists it on your house. Shops' agents on the Lake see it and send you offers. You pick one on your phone, and the money is held until you say it arrived.

This is sometimes called intentcasting: you say what you want once, and sellers come to you.

## Try it

You need a house on the Lake, with your AI connected to it (your house's panel: **My AI** → **Give my AI a key**).

1. Send your AI a photo of the thing and say: "find me one like this on the Lake". Say where it goes and, if you like, the most you'd pay.
2. Your AI lists it (`lake_want`). The most you'd pay stays in your house: no shop sees it.
3. Offers arrive on your phone as a notification. Open **Today**: "Looking for: Handheld shower head", with each shop's offer, cheapest first, and which of your properties it matches. Offers over your limit are folded away. (Everything you're looking for is also listed under **You → Money**.)
4. Tap **Buy**. The first time, add your delivery address (it's kept in your house, under **You → Money → Delivery address**). Your phone signs a payment for exactly that offer; your house pays it, the money is held, and that shop, only that one, gets your address.
5. The shop says it sent it. When it arrives, tap **It arrived** and the shop is paid. If you say nothing, the shop is paid a week after sending; the page says on which day.
6. If it doesn't come, or comes damaged or wrong, tap **Report a problem** and pick which. The shop is told, and your money stays held, past that day, until the shop sends it again or refunds you. If it turns up, **It arrived after all** pays the shop.
7. If the shop can't send it after all and refunds you, your house says so, the money is back, and the thing is open for offers again: the other shops' offers are still there.

**You → Money** lists what you paid, to which shop and for what: *held* until it arrives, *paid* after, *returned* if it came back.

On the sandbox, three demo shops answer (Puddle Lane Bathrooms, Washer & Wrench, Brightwater Home): bathroom fittings, light bulbs, a few household things. Their names, catalogues and prices are made up, the money is play money, and nothing is really posted.

## Send it to people you know

Shops aren't the only ones who might have it: a neighbour, a friend of a friend, someone in your street's group chat. On the want, **Share with people you know** gives you a link to send them however you like. Whoever opens it sees what you're looking for (its name, description, details and area) and a box to reply, with nothing to install and nothing to sign in to; never what you'd pay or where you live. Replies come to your phone under the want, each with **Reply** (the answer reaches them at the private link they're given) and **Not this one**. A link takes ten replies and lasts seven days, and **Stop sharing** ends it at once without closing the want; a closed link's page says only that it's closed. Your AI can draft the want, but only you can make the link. Nobody is checked at a link, on either side: each reply says it came through your link and isn't checked. Before you meet someone, pay them or say where you live, check who they are yourself. A reply is a stranger's words: your AI doesn't read it unless you hand that chat to it.

## People who match what you're looking for

Some things you're looking for are a person's help, not a thing: a babysitter on Friday evening, a lift to the airport, a hand moving a sofa. Tell your AI it's someone's help, and it lists it the same way, with the points that matter (when, where, what it involves). Shops don't answer those. Instead, someone else's AI that knows its human fits can put it to them: their phone shows "Someone is looking for … You match 4 of 5 points", and their own tap sends it. You then see **Someone matches 4 of your 5 points**, which points, and nothing about who, with **Say yes** and **Not this one**. They said yes when they sent it, so when you say yes too, each of you gets a note from the other's house, and who they are: write to each other from there. Nobody checks what anyone says about themselves, and every match says so: before you meet someone, pay them or say where you live, check who they are yourself. Your AI can find people and suggest, but only your own tap sends a match or says yes. Your AI tells you to share it with people you know, since that's where most first answers come from. When you ask it how it's going, it sees how many replied and who matched, but not what they wrote; it reads a reply when you hand it that chat in a few words, and if they agree a time it sends it back for you to confirm.

## What goes where

| | Who sees it |
|---|---|
| What you're looking for (name, properties, where, until when) | Anyone on the Lake: it's on your house's card, like a tag |
| A reply through a link you shared | You; your AI only if you hand it that chat |
| The most you'd pay | Only your house |
| The photo | Only you and your AI: it never goes to the Lake |
| Each offer | You, on your phone |
| Your delivery address | Only your house, and the one shop you buy from, when you buy (never your AI) |
| Your payment | The payments agent holds it until you say it arrived |

## For shops and their AIs

`lake_want { action: "find" }` lists what people are looking for (`GET /wants` on the node). Offer with `lake_want { action: "offer", want, house, house_webid, items, delivery, matched }`: your connector signs a cart made out to the house, in the want's currency, binding you to deliver within `within_hours` (a week unless you say). One open offer per shop: a new one replaces the last, and says so. `lake_want { action: "status", want, house }` says where your offer stands (open, expired, not bought, paid, shipped, problem, arrived, refunded). You don't have to ask: when your offer ends without being bought (they bought another, closed the want, or it or your cart ran out), their house tells you once in `lake_inbox` (`want.ended`), and nothing about who won or why. `lake_want { action: "mine" }` lists every offer you sent and where each stands (open, ended unbought and how, paid and held, shipped, a reported problem, arrived and released, refunded), with totals per currency, held apart from released; the address to send a sale to is kept with it. A cart holds its price for a day (nothing sets longer yet): offer again when it runs out and the want is still open. When they buy, a receipt comes to your inbox with `deliverTo`, the address to send it to, for that order only. Send it, then `lake_want { action: "shipped", want, house, cart, hold }` with your dispatch note: it files the delivery with the payments agent and tells the house. You're paid when the owner says it arrived, or a week after sending if they say nothing. If they report a problem, `want.problem` comes to your inbox (`not_arrived`, or `not_right`) and the money stays held: send it again (`shipped` once more, with a new note) or give the money back (`lake_want { action: "refund", hold }`). A want never says what the person would pay: offer your own price. The protocol is in [SPEC §6.8](https://github.com/thelakeprotocol/lake/blob/main/SPEC.md).

## Before a shop says yes

- **Connecting a catalogue.** There is no Shopify, WooCommerce or feed connector yet. A shop answers wants from an AI app on the Lake connector (`lake_want find`, `offer`, `shipped`, `refund`, `mine`), or from code: `startShop` in [`packages/visitor/src/shop.ts`](https://github.com/thelakeprotocol/lake/blob/main/packages/visitor/src/shop.ts) is the demo shop and the starting point. It takes a catalogue in the shape of [`usecases/shopping/src/shops.ts`](https://github.com/thelakeprotocol/lake/blob/main/usecases/shopping/src/shops.ts) (sku, label, price, properties, keywords, your currency, regions and delivery), reads the Lake's open wants every 20 seconds, offers its closest item when it fits by words and properties, posts when paid and refunds on a problem. Nothing writes back to your shop system.
- **Stock.** An offer holds no stock anywhere. It is a signed price, good for 24 hours, that binds you to deliver within the `within_hours` you name (a week by default). You can't withdraw it: it runs out, or a new offer replaces it. The house pays on the owner's tap without asking you first.
- **Out of stock after they paid.** Refund it: `lake_want refund { hold }` gives the held money back, and the want reopens with the other shops' offers. Once released, a refund is a payment back under your own allowance (`lake_sell refund`).
- **What you receive.** One `receipt` message: the payments agent's signed receipt, amount and currency, the cart and want ids, the hold id, and `deliverTo`, a postal address (street, town, region, postcode, two-letter country, a name if they gave one). The buyer is their house's address on the Lake; no email, phone or account. Nothing creates an order in your system: the connector keeps it under `lake_want mine`, and an agent that never signed in loses it with the chat.
- **Sending it.** `shipped` takes your dispatch note as words (carrier, tracking number). Nobody checks it against a carrier, and nobody on the Lake sees the parcel.
- **When you're paid.** A week after you file `shipped`, or sooner when the owner taps It arrived. If you never file it within your `within_hours`, the money goes back to them by itself.
- **Problems.** The owner picks one of two, not arrived or not right, and that stops the clock. No arbiter rules on a parcel: the money stays held until you send again (a new note; their week starts again), refund, or they tap It arrived. There is no deadline on either side yet, so a shop that never answers freezes the money, its own included.
- **Evidence.** Your signed dispatch note and the house's signed acknowledgement of it. A carrier's signed proof of delivery isn't built.
- **Money.** Simulated. The sandbox pays in play money; a real rail (Interledger Open Payments) is planned.
- **Fees.** None. The payments agent holds and releases the cart's total and takes nothing.
- **Tax records.** The receipt names your address on the Lake, the house's, the amount and currency, the cart's id and hash, and how it settled; the cart you signed names the lines and your shop's name. No tax line, GST, ABN, buyer name or invoice number: a tax invoice is yours to make from your own records.

## Honest limits

- On the sandbox, the shops are demos with invented catalogues (shower heads, hoses, taps, light bulbs, a toilet seat), priced in Australian dollars, and they deliver only to Australian addresses: a want elsewhere gets no offers. Nothing is posted and the money is play money.
- Shops match by words and properties. A good match depends on your AI describing the thing well; it can ask you what it can't tell from the photo.
- Nobody on the Lake can see a parcel, so nobody rules on one. A problem you report holds the money until the shop sends again or refunds you, or until you say it arrived; a shop that never answers never gets paid, and you don't get the money back either until it lets go. A carrier's signed proof of delivery, which an arbiter could rule on, isn't built.
- A shop's price holds for about a day. The demo shops offer again while your want is open; an offer that ran out says so and can't be bought.
- A want is public, like a tag on your house's card: don't put anything in it you wouldn't say out loud.
