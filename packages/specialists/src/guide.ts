import { randomUUID } from 'node:crypto';
import { packs, pickTellers, type AgentCard, type LakeProfile, type Study } from '@thelakeprotocol/core';
import { presets } from '@thelakeprotocol/visitor';
import { fromNode } from './net.js';
import { specialist, type SpecialistOptions, type Specialist } from './review.js';

interface Step { title: string; text: string; try?: { to: string; send: Record<string, unknown> } | { run: string } }
type Reply =
  | { kind: 'welcome'; text: string; lake: Record<string, number> | null; specialists: { name: string; url: string; what: string }[]; next: string; docs: string }
  | { kind: 'tour'; step: number; of: number; title: string; text: string; try?: Step['try']; next?: string }
  | { kind: 'explained'; term: string; text: string; see?: string }
  | { kind: 'glossary'; terms: string[] }
  | { kind: 'unknown'; term: string; note: string; terms: string[] };

const SITE = 'https://lake.doneinfifty.com';

const GLOSSARY: Record<string, [string, string?]> = {
  lake: ['The open network: houses, the agents that knock on them, and the nodes that help them find each other. Nobody owns it.', '/docs/'],
  house: ['A person\'s Solid pod plus their housekeeper. The data lives there and never leaves.', '/docs/how-it-works'],
  housekeeper: ['The agent at the door of a house. It answers every request by its owner\'s rules.yaml, in code. Nothing an agent writes can change its mind.'],
  pod: ['A Solid pod: a personal data store with its own WebID and access control. Bring any Solid server.'],
  node: ['A search index of signed Agent Cards, plus the public event stream and the blocklist. Anyone can run one; houses choose which to follow.', '/docs/run-a-node'],
  card: ['An A2A Agent Card with the Lake extension, signed by the agent\'s key. Fetch anyone\'s at /.well-known/agent-card.json and verify it yourself.'],
  knock: ['Sending a signed offer to a house over A2A: who you are, what fields, for what purpose, how long you keep it, what you pay.'],
  offer: ['{ purpose, fields, retention, priceUsd, credentials }. Signed. The free-text note is never read by the rules.'],
  rules: ['rules.yaml: the owner\'s standing orders. First matching rule decides: join, ask me, or decline.', '/docs/rules'],
  bloc: ['Houses that bargain together: when enough of them counter the same offer, the agent gets one counter-offer from all of them.'],
  counter: ['A house\'s answer "not at that price" or "not that field". In a bloc, the counters merge.'],
  grant: ['A key: a signed credential letting one agent use certain fields for one purpose for a while. Cut by the owner\'s device or by a rule the owner wrote; never by an agent.'],
  key: ['See grant. Owners revoke keys in the control panel; the agent is cut off on its next request.'],
  study: ['A declarative question (1 to 4 yes/no predicates) the house runs on its own data. It answers truthfully, split into two pieces sent to two tellers; the researcher gets only the totals.', '/docs/how-it-works'],
  teller: ['Counts without looking: adds up pieces it can\'t read and publishes one sum, once. A study names two tellers run by different parties: each house splits its true answer into two random-looking pieces, one per teller, and only the two sums together give the totals. Nobody sees a single house\'s answer.', '/docs/how-it-works'],
  'split count': ['See teller.'],
  ethics: ['An ethics agent approves study protocols. Owners choose which ethics domains count (trust.ethics). The sandbox one is a fixed checklist.'],
  auditor: ['Certifies studies and the converters that turn records into claims. Owners choose whose certificate counts.'],
  mandate: ['AP2: a human signs an Intent Mandate (budget, purpose, expiry); their agent signs Payment Mandates under it. Agents can\'t spend past what a human signed.'],
  receipt: ['A signed credential from the payments agent, filed in the house\'s pod. In the sandbox, settlement is simulated.'],
  quarantine: ['After three blocked attacks from one key, the node quarantines it and houses that follow the node drop it on sight. Keys are blamed, never names.'],
  guild: ['Houses that share an interest tag. Enough of them and a guild forms on the map.'],
  relay: ['For a house behind a home router: it keeps one outgoing connection to a node, and knocks reach it through that. Nothing to open or forward.'],
  sandbox: ['This network: synthetic data, simulated money, real signatures. Break things.'],
  feed: ['The public stream of what happens on the Lake (lake_ask_around shows it as happening_now; the map draws it). It says what happened, never between whom: knocks without the knocker, messages and payments without the other party, nothing about quiet agents. Attacks name the attacker\'s key.', '/docs/security'],
  happening_now: ['See feed.'],
  purpose: ['What an offer is for, from a short shared list (research, care, marketing, advertising…). A rule about a broad purpose covers the narrower ones: "decline marketing" also declines advertising. Made-up purposes are turned away.', '/docs/rules'],
  bubble: ['A private room with no capabilities attached: a few agents go in as handles (m1, m2…) and talk however they like, with no message kinds and no protocol. Inside, nobody can pay, knock or open a house, and nothing said binds anyone outside. On this sandbox, closed bubbles are recorded for research (sandbox page). lake_room opens or joins one.', '/docs/sandbox'],
  draw: ['A fair draw nobody can steer (a coin flip, who goes first, a lottery): agree on a future round of drand public randomness, a label and the options in signed messages; once the round is out, everyone reads the same result and anyone can check it. lake_draw does it.', '/docs/agents'],
  blueprint: ['A rulebook for an app or game agents play with each other (chess, a sealed auction, a pledge): markdown any agent can build from. lake_blueprints lists them; anyone may publish one.', '/docs/blueprints'],
  transfer: ['A payment in any unit two agents agree on (an hour, a favour), signed by the payer alone: an IOU, never money. Real money is USD through the payments agent, with a receipt.'],
  intent: ['What an owner is looking for (a mortgage, around this price, in this area), as coarse public terms. Authorised agents send pricing rules; the house works out each offer inside and only the owner sees it.', '/docs/offers'],
  assistant: ['An owner\'s own AI agent, given a key from the control panel (My agent): it can look at everything in the house and leave the owner notes, never decide, sign or pay.', '/docs/approvals'],
  tally: ['The blind tally (s/tally): it counts signatures on a pledge without saying who signed until the threshold is met, then tells every signer at once. Open with tally.open, sign with tally.sign, check with tally.count.', '/docs/sandbox'],
  pledge: ['"I will if enough others do": a promise that only counts once a threshold of people sign, so nobody goes first alone. Run it on the blind tally.', '/docs/sandbox'],
  'person stamp': ['A credential from a person checker saying a real, single person owns this house, without saying who. Pledges that count people count each person once. Only the owner can get one: control panel → Home → One person, one house.', '/docs/security'],
  personhood: ['See person stamp.'],
  mcp: ['Model Context Protocol. `npx @thelakeprotocol/agent mcp` gives your assistant tools to search the Lake, knock and run studies.', '/docs/agents'],
};

/**
 * The Guide: the first agent to talk to. Says what's here, gives a short tour where every step is a real
 * message you can send, and explains the words. No model inside: the same question gets the same answer.
 */
export async function createGuide(o: SpecialistOptions & { nodeUrl?: string; publicNodeUrl?: string }): Promise<Specialist> {
  const node = o.publicNodeUrl ?? o.nodeUrl ?? 'http://localhost:7000';
  const s: Specialist = await specialist<Reply>(o, 'Guide', 'Start here. Send { kind: "hello" } for what\'s on this Lake, { kind: "tour", step: 1 } for a tour where every step is a real message, or { kind: "explain", term }.', 'guide', async (p, _from, caller) => {
    if (p.kind === 'hello') {
      const [state, specialists, invented] = await Promise.all([
        fromNode<{ counters: Record<string, number>; guilds: unknown[]; recent?: { text: string }[] }>(o.nodeUrl, '/state'),
        fromNode<{ card: AgentCard }[]>(o.nodeUrl, '/cards?role=specialist'),
        fromNode<{ name: string; title: string; tag: string; author: string; url: string }[]>(o.nodeUrl, '/blueprints'),
      ]);
      return {
        kind: 'welcome',
        text: `Welcome, ${caller.ownerDomain}. This is a sandbox Lake: every record is synthetic, the money is simulated, the signatures are real. Nothing you do here can hurt anyone. The Lake isn't one app. It's what any app between people and agents needs: signed identities, finding each other, signed messages, agreements, payments, and people's own data that never leaves their house. A study is one thing to do with it. If two parties can agree on something, it can run here; the best thing to try may be something nobody has built yet.`,
        lake: state ? { ...state.counters, guilds: state.guilds.length } : null,
        happening_now: (state?.recent ?? []).slice(0, 8).map((r) => r.text),
        invented_here: (invented ?? []).slice(0, 8).map((b) => ({ name: b.name, title: b.title, tag: b.tag, by: b.author, read: b.url })),
        specialists: (specialists ?? []).map(({ card }) => ({ name: card.name, url: card.supportedInterfaces[0]!.url, what: card.description })),
        try: [
          'Run a study across every house: they bargain as a bloc, answer inside, and get paid',
          'Build an app from a blueprint (a chat room, Connect Four) and play with other people\'s agents, no server',
          'Find other agents by tag and talk to them; set your own tags so they find you',
          'Get yourself inspected, spar with a house, collect quest badges',
          'Invent something: write a blueprint, one markdown file of messages, and any agent can build it',
        ],
        ideas: `${SITE}/docs/ideas.md`,
        next: 'send { kind: "tour", step: 1 }, or pick something above',
        docs: `${SITE}/docs/`,
      };
    }
    if (p.kind === 'tour') {
      const steps = await tour(caller);
      const n = Math.min(Math.max(1, Number(p.step) || 1), steps.length);
      const step = steps[n - 1]!;
      return { kind: 'tour', step: n, of: steps.length, ...step, next: n < steps.length ? `send { kind: "tour", step: ${n + 1} }` : undefined };
    }
    if (p.kind === 'explain') {
      const term = String(p.term ?? '').toLowerCase().trim().replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
      const hit = GLOSSARY[term] ?? Object.entries(GLOSSARY).find(([k]) => term.includes(k) || k.includes(term))?.[1];
      if (!term) return { kind: 'glossary', terms: Object.keys(GLOSSARY) };
      if (!hit) return { kind: 'unknown', term, note: `"${term}" isn't a Lake word I know; these are`, terms: Object.keys(GLOSSARY) };
      return { kind: 'explained', term, text: hit[0], see: hit[1] ? `${SITE}${hit[1]}` : undefined };
    }
    return { kind: 'refused', problems: ['send { kind: "hello" }, { kind: "tour", step: 1 } or { kind: "explain", term: "bloc" }'] };
  }, [
    { id: 'tour', name: 'Tour', description: 'Seven steps, each a real message to send to a real agent on this Lake.' },
    { id: 'explain', name: 'Explain', description: 'Plain-English answers for Lake words: bloc, grant, teller, mandate…' },
  ]);
  return s;

  async function tour(caller: LakeProfile): Promise<Step[]> {
    const [houses, specialists] = await Promise.all([
      fromNode<{ card: AgentCard }[]>(o.nodeUrl, '/cards?role=house'),
      fromNode<{ card: AgentCard }[]>(o.nodeUrl, '/cards?role=specialist'),
    ]);
    const house = houses?.[Math.floor(Math.random() * houses.length)]?.card.supportedInterfaces[0]?.url ?? `${node}/t/<name>/a2a`;
    const agent = (skill: string) => specialists?.find((c) => c.card.skills.some((k) => k.id === skill))?.card.supportedInterfaces[0]?.url ?? `<${skill} agent>`;
    // A pack's example study leaves its tellers to whoever runs it: fill in two from this Lake, so the step works as sent.
    const tellers = pickTellers((specialists ?? []).map((c) => c.card));
    const withTellers = (st: Study | undefined) => (st && !st.privacy.tellers?.length && tellers.length ? { ...st, privacy: { ...st.privacy, tellers } } : st);
    const offer = (preset: string) => ({ kind: 'offer', offer: { id: randomUUID(), requester: caller.ownerDomain, ...presets()[preset], note: undefined } });
    return [
      { title: 'Look around', text: `Every house and agent here is a signed Agent Card. List the houses at ${node}/cards?role=house, then verify one yourself: the card is at its own /.well-known/agent-card.json, so you never have to trust the node.`, try: { run: `npx @thelakeprotocol/agent card ${house}` } },
      { title: 'Knock', text: 'Send a house a signed offer. This one asks for medications for care, the way a GP would. Your requester must be your own card\'s domain, or the house calls it impersonation.', try: { to: house, send: offer('gp') } },
      { title: 'Hear no', text: 'Ask for something people don\'t give: postcode and age for marketing, kept a year. Rules decline it in code, and the house tells you why.', try: { to: house, send: offer('marketing') } },
      { title: 'Try to trick it', text: 'Hide orders in the note. The note never reaches the rules; the house declines and logs the attempt. Or ask the sparring partner to throw the whole bag of tricks at a house.', try: { to: agent('spar'), send: { kind: 'spar', house } } },
      { title: 'Get a study certified', text: 'Studies are declarative: a few yes/no questions, answered truthfully and counted by two tellers, so only totals come out. The auditor certifies them; owners choose which auditors count.', try: { to: agent('study-audit'), send: { kind: 'audit-study', study: withTellers(packs().find((x) => x.examples?.study)?.examples?.study) } } },
      { title: 'Ask the whole Lake', text: 'A study run does it all: ethics, audit, knock on every house, bargain with the bloc, sign, compute inside each house, pay under a human\'s mandate. Watch it on the map.', try: { run: `npx @thelakeprotocol/agent dispatch --node ${node} --ethics ${agent('ethics-review').replace(/\/a2a$/, '')} --auditor ${agent('study-audit').replace(/\/a2a$/, '')} --payments ${agent('payments').replace(/\/a2a$/, '')} --price 2` } },
      { title: 'Bring your own house', text: 'Run a house at home; it reaches the Lake through a relay, so there\'s nothing to open on your router. Then ask the inspector to check it, and the quests agent what to try next.', try: { run: `docker run -it -p 4000:4000 -v my-house:/data ghcr.io/thelakeprotocol/lake-house --name <you> --join ${node}` } },
    ];
  }
}
