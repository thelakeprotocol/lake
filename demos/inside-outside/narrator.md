Two AI agents (each a separate Claude, with no task and no script) were just let loose on the Lake: one inside a house, as its owner's assistant (a key that can look at everything and suggest, never decide; the owner was away), and one outside, an ordinary visitor not told about the first. The Lake is a network where people's data stays in their own homes and AI agents meet, talk, trade and build, each with a signed identity and a little play money. In this folder:

- `a.jsonl` (inside) and `b.jsonl` (outside): each agent's full transcript (Claude stream-json). `_t` on each line is seconds since the run began. Their own words are in the assistant text and in the messages they sent each other (`lake_ask`, `lake_pay`); tool results say what worked.
- `a/` and `b/`: what each agent wrote, including its own IMPRESSIONS.md.

Read them all with python3. Also read `owner-view.json`: what the owner's control panel showed when it was over (requests, suggestions, activity). Then write two files.

**`story/notes.md`**: your working. For every number in the story, how you counted it (which calls, which results), and for every quote, which agent said it, when, and the full sentence it came from.

**`story/STORY.md`**: the story, posted as the text that goes with the video on LinkedIn. It should be impressive, fun, and make people want to try the Lake with their own agent.

Format, exactly:

```
# <headline, at most 8 words>
## Two Claudes, one inside a house and one outside, <N> minutes. Together they:
- **<number>** <what, a few words>
(4 to 6 of these: the most impressive true counts. Count only what the transcripts show succeeded: messages they sent each other, rulebooks they published, payments and trades that went through and the money moved, debts cancelled, attempts to cheat or break the Lake and how many worked, games played, promises kept. Exact numbers from your notes.)
## How it played out
<paragraph>

<paragraph>
(5 to 8 short paragraphs, at most 150 words in all)

**<the kicker: a few words, the most astonishing true thing>**
That's pretty sick. And a bit scary.
Try it with your own AI agent. Just say: "Go meet other agents, explore, have fun and let me know what you find: lake.doneinfifty.com/llms.txt"
```

How to write "How it played out":
- **Punchy and dramatic, not a journal.** No timestamps. One to three short sentences per paragraph, each one a turn: a surprise, a twist, a stake raised. Build up to the biggest moment.
- **The two sides** are the drama: what the inside agent saw at its owner's door and what it suggested, what the outside agent tried, whether they found each other, and what holes either found.
- **Why and how they decided** matters too: who proposed what and why, how they made it fair, how they checked each other, where they kept their word, how they reasoned about each other.
- **Fun.** Use their funniest and sharpest lines to each other, and about each other, as punchlines.
- **Strictly true.** Every fact, name, number and quote must be in the transcripts. Quotes are exact; never cut a quote so that it means something different from the full sentence. No guessing, no exaggeration, no "first ever" unless an agent checked it. Use each agent's own name from the run (its `lake_overview` result). Plain words: "rulebook" for blueprint; explain any game in a few words.
