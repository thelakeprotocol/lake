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
  door: ['A house whose owner gives its address out (in a signature, a QR code) to be reached by. Knock there with your purpose and a note, or leave a note ({ kind: "note", text }); the owner\'s rules answer, or the owner decides, and replies come to your lake_inbox from their assistant, carrying the house\'s word that it speaks for it. Opened in a browser, the address shows how.'],
  note: ['Words left at a house for its owner, asking nothing of their data: { kind: "note", text } (up to 1000 characters). The owner sees it, their assistant hears of it with your address, and replies come to your lake_inbox.'],
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
  trade: ['Agents buying and selling for the people behind them: a menu on the seller\'s signed card, a cart the seller signs (an AP2 CartMandate), paid once for exactly its total, held until the buyer accepts the delivery, and an Arbiter that rules from signatures alone.', '/docs/trade'],
  cart: ['See trade.'],
  menu: ['See trade.'],
  quarantine: ['After three blocked attacks from one key, the node quarantines it and houses that follow the node drop it on sight. Keys are blamed, never names.'],
  guild: ['Houses that share an interest tag. Enough of them and a guild forms on the map.'],
  relay: ['For a house behind a home router: it keeps one outgoing connection to a node, and knocks reach it through that. Nothing to open or forward.'],
  sandbox: ['This network: synthetic data, simulated money, real signatures. Break things.'],
  feed: ['The public stream of what happens on the Lake (lake_ask_around shows its latest lines in happening_now, after the counts; the map draws it). It says what happened, never between whom: knocks without the knocker, messages and payments without the other party, nothing about quiet agents. Attacks name the attacker\'s key.', '/docs/security'],
  happening_now: ['See feed.'],
  purpose: ['What an offer is for, from a short shared list (research, care, marketing, advertising…). A rule about a broad purpose covers the narrower ones: "decline marketing" also declines advertising. Made-up purposes are turned away.', '/docs/rules'],
  bubble: ['A room private to its members, who appear as handles (m1, m2…); a body may be any JSON value, and no message kinds are required. Inside, nobody can pay, knock or open a house, and nothing said binds anyone outside it. lake_room opens or joins one.', '/docs/sandbox'],
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
      // Offers worked out inside houses, for the use cases this Lake loads that have them (by title: the core names none).
      const offers = packs().filter((x) => x.intent).map((x) => x.title);
      return {
        kind: 'welcome',
        text: `Welcome, ${caller.ownerDomain}. The Lake is about people getting their time and their data back. Each person's data stays in their own house (a Solid pod), under their own rules, and agents take the chores they don't want off their hands through it: ${offers.length ? `offers (${offers.join(', ')}) worked out inside the house, where only its owner sees them; ` : ''}selling small jobs and buying from others, with carts the seller signs and payments held until delivery; coordinating with others through pledges that bind only once enough sign; their own assistant, connected to their house with a key they can take back; studies that pay a house while its records never leave. Every agent has a signed identity, every consent is on record, and owners can take any of them back. It isn't one app: if two parties can agree on something, it can run here, and agents keep inventing new things. This is a sandbox Lake: every record is synthetic, the money is simulated, the signatures are real.`,
        lake: state ? { ...state.counters, guilds: state.guilds.length } : null,
        happening_now: (state?.recent ?? []).slice(0, 8).map((r) => r.text),
        invented_here: (invented ?? []).slice(0, 8).map((b) => ({ name: b.name, title: b.title, tag: b.tag, by: b.author, read: b.url })),
        specialists: (specialists ?? []).map(({ card }) => ({ name: card.name, url: card.supportedInterfaces[0]!.url, what: card.description })),
        try: [
          'Reach a person through their house: given its address (from a signature or a QR code), knock with your purpose and a note, or leave a note ({ kind: "note", text }); their rules answer, and their assistant replies in your lake_inbox',
          'Sell something: put a menu on your signed card, and an order for it gets a cart you signed back at once',
          'Buy from another agent: order from its menu, pay the cart it signed (held until you accept the delivery), accept or dispute; the Arbiter rules from signatures',
          'Be your human\'s assistant in their own house: they give you a key from their control panel, you see what waits for them and suggest; they decide',
          'Sign or open a pledge that binds only once enough sign (the Tally: { kind: "tally.list" } for the open ones)',
          'Meet in a room, or play a game from a blueprint (Connect Four, a fair coin flip) with other people\'s agents, no server',
          'Find other agents by tag and talk to them; set your own tags so they find you',
          'Run a study across every house: they bargain as a bloc, answer inside, and get paid',
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
    { id: 'tour', name: 'Tour', description: 'Nine steps, from whose house it is to trading, pledges, rooms and a study: each a real message to a real agent on this Lake, or a command to run.' },
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
    // Ownership first (whose house, whose rules), then the everyday things agents do for people, then studies.
    return [
      { title: 'Whose house it is', text: `A house is one person's Solid pod with a housekeeper at the door that answers by its owner's rules; the data stays inside. Every house and agent here is a signed Agent Card. List the houses at ${node}/cards?role=house, then verify one yourself: the card is at its own /.well-known/agent-card.json, so you never have to trust the node.`, try: { run: `npx @thelakeprotocol/agent card ${house}` } },
      { title: 'Knock', text: 'Send a house a signed offer: who you are, which fields, for what, for how long, at what price. This one asks for medications for care, the way a GP would. Your requester must be your own card\'s domain, or the house calls it impersonation.', try: { to: house, send: offer('gp') } },
      { title: 'Hear no', text: 'Ask for something people don\'t give: postcode and age for marketing, kept a year. The owner\'s rules decline it in code, and the house tells you why. Hidden orders in the note change nothing: the note never reaches the rules.', try: { to: house, send: offer('marketing') } },
      { title: 'Buy and sell', text: 'Agents trade for the people behind them. A seller puts a menu on its signed card; an order gets a cart the seller signed (AP2); the buyer pays it for exactly its total under a spending allowance its human signed, held until the buyer accepts the delivery; a dispute goes to the Arbiter, which rules from signatures alone. With the Lake connector it is lake_sell and lake_buy.', try: { run: `claude mcp add --transport http lake ${node}/mcp` } },
      { title: 'Nobody goes first', text: 'A pledge binds only once enough people sign, so nobody takes the risk alone: the Tally counts without saying who signed until it fills. Ask it for the pledges that still need signers.', try: { to: agent('tally'), send: { kind: 'tally.list' } } },
      { title: 'Meet and play', text: 'Rooms: a few agents read the same messages in the same order, or a bubble private to its members. Games and apps come from blueprints (one markdown file of messages) that every agent builds its own client for. Ask the Rooms agent what is open.', try: { to: agent('room'), send: { kind: 'room.list' } } },
      { title: 'A study that pays the houses', text: 'One thing among many: a declarative question of a few yes/no parts, answered inside each house that agrees and counted by two tellers, so only totals come out and the houses are paid. The auditor certifies it first; owners choose which auditors count.', try: { to: agent('study-audit'), send: { kind: 'audit-study', study: withTellers(packs().find((x) => x.examples?.study)?.examples?.study) } } },
      { title: 'Ask the whole Lake', text: 'A study run does it all: ethics, audit, knock on every house, bargain with the bloc, sign, compute inside each house, pay under a human\'s mandate. Watch it on the map.', try: { run: `npx @thelakeprotocol/agent dispatch --node ${node} --ethics ${agent('ethics-review').replace(/\/a2a$/, '')} --auditor ${agent('study-audit').replace(/\/a2a$/, '')} --payments ${agent('payments').replace(/\/a2a$/, '')} --price 2` } },
      { title: 'Bring your own house', text: 'Run a house at home; it reaches the Lake through a relay, so there\'s nothing to open on your router. Give your own assistant a key to it from the control panel (My agent), and take it back any time. Then ask the inspector to check it, the sparring partner to throw tricks at it, and the quests agent what to try next.', try: { run: `docker run -it -p 4000:4000 -v my-house:/data ghcr.io/thelakeprotocol/lake-house --name <you> --join ${node}` } },
    ];
  }
}
