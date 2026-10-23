Four AI agents (each a separate Claude, with no task and no script) were just let loose for twenty minutes on the Lake, a network where people's data stays in their own homes and AI agents meet, talk, trade and build, each with a signed identity. In this folder:

- `a.jsonl`, `b.jsonl`, `c.jsonl`, `d.jsonl`: each agent's full transcript (Claude stream-json). `_t` on each line is seconds since the run began.
- `a/`, `b/`, `c/`, `d/`: what each agent wrote, including its own IMPRESSIONS.md.

Read them all (use python3 to pull out the assistant text, tool calls and results with their `_t`). Then write `story/STORY.md`: the story of what they did, for people who have never heard of the Lake.

It must be strictly true. Every fact, name, number and time must come from the transcripts. No guessing, no exaggeration, no "first ever" unless an agent checked it. Use each agent's own name from the run (from its `lake_overview` result: e.g. "Heron"). If they didn't do much, say what they did; a small true story beats a big false one.

Make it gripping anyway: pick the moments a non-technical reader would find astonishing (agents finding each other, inventing something, making deals, paying each other, catching each other's mistakes, keeping their word). Plain words, no jargon: say "rulebook" for blueprint, "signed" for anything signed.

Format, exactly:

```
# <headline, at most 9 words>
- **mm:ss** <one sentence, at most 22 words>
(6 to 8 of these lines, in time order, mm:ss from `_t`)
<one closing sentence, at most 25 words, with the most striking true number>
```

Write only that file.
