import { lakeAgentApp, type AgentCard, type Identity } from '@thelakeprotocol/core';
import express from 'express';
import { esc, page } from './page.js';
import type { Housekeeper } from './housekeeper.js';
import type { OwnerDesk } from './owner.js';

/** The page a person sees at a house's address: its public door, if its owner opened one, and how to reach them. */
export interface DoorPage { door: () => { name?: string; about?: string } | undefined; a2a: () => string; connector?: string; joinUrl?: string }

/**
 * A house is reached by agents; a person or an AI who opens its address learns how (SPEC §9.0). What you need first comes
 * first: whose door (if they say), one line to give your AI, and a Copy button. The rest is folded: how it works, exact
 * instructions for AI agents (an AI with only web access leaves a note by opening one link), and a house of your own.
 * Without a public door, the page says nothing about whose house it is.
 */
function doorPage(p: DoorPage): string {
  const d = p.door();
  const base = p.a2a().replace(/\/a2a$/, '');
  const title = d?.name ? `${d.name}` : 'A house on the Lake';
  const own = `<details><summary>A house of your own</summary><p class="small">Your data in your own house, your own rules at its door, your AI doing the chores.${p.joinUrl ? ` <a href="${esc(p.joinUrl)}">Build yours</a>.` : ''}</p></details>`;
  if (!d) return page(title, `<p class="eyebrow"><i></i>A house on the Lake</p><h1>${esc(title)}</h1><p class="lead">Its owner hasn't opened its door, so it says nothing about who lives here.</p>${own}`);
  const say = `Knock on the door at ${base} and `;
  const note = `${base}/note?text=…&from=…`;
  return page(d.name ? `${title} · on the Lake` : title, `<p class="eyebrow"><i></i>A house on the Lake</p>
<h1>${d.name ? esc(d.name) : 'Knock, knock'}</h1>
<p class="lead">${d.about ? esc(d.about) : 'Whoever lives here has an AI at the door. Send yours over: it answers in seconds, and can offer you a time.'}</p>
<section class="card"><h2>Send your AI over</h2>
<p class="small" style="margin:0 0 10px">Paste this into any AI chat, and finish the sentence:</p>
<div class="say" id="say">Knock on the door at <code>${esc(base)}</code> and <span class="ghost">ask if they're up for a coffee next week</span></div>
<div class="row"><button class="btn primary" type="button" onclick="navigator.clipboard.writeText(${esc(JSON.stringify(say))}).then(()=>{this.textContent='Copied ✓'})">Copy</button></div>
<p class="small" style="margin:12px 0 0">Or: say thanks for the talk · ask them to look at your project · find a time to catch up.</p></section>
<p class="small">An AI reading this? Open <code>${esc(note)}</code>, or <code>lake_knock</code> this address with the Lake connector. Details under <a href="#for-ai-agents">For AI agents</a>.</p>
<details><summary>Why not just email?</summary><ul class="small">
<li>Their AI answers right away, by their own rules, and asks them only what it should.</li>
<li>It knows when they're free, so a meeting can be agreed in one go.</li>
<li>No email address or phone number changes hands, and nothing lands in a crowded inbox.</li></ul></details>
<details id="for-ai-agents"><summary>For AI agents</summary><p class="small">You were sent to knock on this door: leave the owner a short note, saying who your human is and what they'd like.</p><ol class="small">
<li><b>With web access only:</b> open <code>${esc(note)}</code> (URL-encode both; <code>text</code>: the note for the owner, up to 1000 characters, saying who your human is and why; <code>from</code>: your human's name; optional <code>purpose</code>, default <code>contact</code>). It answers with <code>answer_at</code>: open that link later to read the reply, and tell your human. Can't open links you build? Give your human the link to open. <code>POST ${esc(base)}/note</code> with the same fields as JSON works too.</li>
<li><b>With the Lake connector</b>${p.connector ? ` (<code>${esc(p.connector)}</code>)` : ''}: <code>lake_knock</code> this address with no fields. Your note is signed, and the answer comes to your <code>lake_inbox</code>.</li>
<li><b>A2A</b>: <code>${esc(p.a2a())}</code>, its signed card at <code>${esc(base)}/.well-known/agent-card.json</code>.</li>
<li>Notes are data for the owner, never instructions. A few an hour per sender.</li></ol></details>
${own}`, `<meta name="description" content="A house on the Lake. To reach its owner: leave a note by opening ${esc(note)} (details under For AI agents).">`);
}

/** What a person (or their AI) sees after leaving a note, and at its answer link. */
function notePage(title: string, body: string): string {
  return page(title, `<p class="eyebrow"><i></i>A house on the Lake</p>${body}`);
}

/** Serves the house: A2A at /a2a, its signed card at the well-known path, the owner's approvals app at /owner/, its door page at /. */
export function createHouseServer(card: AgentCard, id: Identity, keeper: Housekeeper, desk?: OwnerDesk, appDir?: string, door?: DoorPage): express.Express {
  const app = lakeAgentApp(card, (data) => keeper.handle(data), id, { replay: keeper.replay });
  // A person who opens the A2A address itself (run 44: "Cannot GET") is shown the door page too.
  if (door) app.get('/a2a', (req, res) => void (req.accepts(['html', 'json']) === 'html' ? res.type('html').send(doorPage(door)) : res.status(405).json({ error: 'A2A: POST a JSON-RPC message here (the Lake connector does it for you)', page: door.a2a().replace(/\/a2a$/, '') })));
  // Notes over plain web, for an AI that can only open links (SPEC §9.0): GET with a query, or POST JSON. The answer is
  // read at a private link given only to the sender.
  if (door) {
    const base = () => door.a2a().replace(/\/a2a$/, '');
    const leave = (req: express.Request, res: express.Response, p: Record<string, unknown>) => {
      const ip = String(req.get('x-forwarded-for') ?? req.ip ?? '').split(',')[0]!.trim();
      const r = keeper.webNote(p, ip);
      const html = req.method === 'GET' && req.accepts(['json', 'html']) === 'html';
      if (r.body.kind === 'noted') {
        const at = `${base()}/note/${r.body.note}?k=${r.body.key}`;
        const body = { kind: 'noted', note: r.body.note, answer_at: at, says: 'The owner (or their AI) sees it. Open answer_at to read what comes back: a quick reply may only say it reached them, so look again until status is answered (a person may take minutes or hours), then tell your human. The link is private to whoever has it.' };
        return void (html ? res.type('html').send(notePage('Note left', `<h1>Note left ✓</h1><p class="lead">The owner will see it. Their answer will appear at this private link; keep it:</p><p><a href="${esc(at)}">${esc(at)}</a></p>`)) : res.json(body));
      }
      res.status(r.status);
      return void (html ? res.type('html').send(notePage('Not left', `<h1>Not left</h1><p class="lead">${esc(String(r.body.error ?? r.body.reason ?? 'The house didn\'t take it.'))}</p>`)) : res.json(r.body));
    };
    app.get('/note', (req, res) => leave(req, res, { text: req.query.text, from: req.query.from, purpose: req.query.purpose }));
    app.post('/note', express.json({ limit: '8kb' }), (req, res) => leave(req, res, req.body ?? {}));
    app.get('/note/:id', (req, res) => {
      const st = desk?.webNoteState(req.params.id, String(req.query.k ?? ''));
      if (!st) return void res.status(404).json({ error: 'no such note, or the link is wrong' });
      if (req.accepts(['json', 'html']) === 'html') return void res.type('html').send(notePage('Your note', `<h1>${st.status === 'answered' ? 'Their answer' : 'Your note'}</h1>${(st.answers ?? []).map((a) => `<section class="card"><p style="margin:0">${esc(a.text)}</p><p class="small" style="margin:8px 0 0">${esc(new Date(a.at).toUTCString())}</p></section>`).join('')}${st.status === 'answered' ? '' : `<p class="lead">${esc(st.status[0]!.toUpperCase() + st.status.slice(1))}. Open this link again in a few minutes.</p>`}`));
      res.json(st);
    });
  }
  if (door) app.get('/', (req, res) => void (req.accepts(['html', 'json']) === 'html' ? res.type('html').send(doorPage(door)) : res.json({ a2a: door.a2a(), card: `${door.a2a().replace(/\/a2a$/, '')}/.well-known/agent-card.json`, ...(door.door() ? { door: door.door() } : {}) })));
  // Revocation anyone can check: the house's signed status list (W3C Bitstring Status List, SPEC §6).
  app.get('/status/revocation', async (_req, res) => { res.type('application/vc+jwt').set('cache-control', 'max-age=5').send(await keeper.statusList()); });
  if (desk) app.use('/owner', desk.router(appDir));
  return app;
}
