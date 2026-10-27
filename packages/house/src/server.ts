import { lakeAgentApp, type AgentCard, type Identity } from '@thelakeprotocol/core';
import type express from 'express';
import type { Housekeeper } from './housekeeper.js';
import type { OwnerDesk } from './owner.js';

/** The page a person sees at a house's address: its public door, if its owner opened one, and how to reach them. */
export interface DoorPage { door: () => { name?: string; about?: string } | undefined; a2a: () => string; connector?: string; joinUrl?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A house is reached by agents; a person who opens its address learns how (SPEC §9.0): which connector to add to their
 * AI chat, what to ask it, and how to build a house of their own. No form: the owner's rules answer agents, not a page.
 * Without a public door, the page says nothing about whose house it is.
 */
function doorPage(p: DoorPage): string {
  const d = p.door();
  const who = d?.name ? esc(d.name) : 'its owner';
  const ask = `Knock on the house at ${esc(p.a2a())}: `;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${d?.name ? `${esc(d.name)} · on the Lake` : 'A house on the Lake'}</title>
<style>:root{color-scheme:light dark;--fg:#1d2a33;--bg:#f7f9fa;--muted:#5d6b75;--line:#d8e0e5;--accent:#1f6f8b}@media (prefers-color-scheme:dark){:root{--fg:#e3eaee;--bg:#11181d;--muted:#9aa8b1;--line:#2a363e;--accent:#6cc0dc}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:40px 16px}h1{font-size:28px;margin:0 0 6px}.lead{color:var(--muted);margin:0 0 28px}
h2{font-size:17px;margin:28px 0 8px}code,.box{font-family:ui-monospace,monospace;font-size:14px}.box{display:block;background:transparent;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-wrap:anywhere;margin:6px 0}
ol{padding-left:20px}li{margin:6px 0}a{color:var(--accent)}.small{color:var(--muted);font-size:14px}</style></head><body><main>
<h1>${d?.name ? esc(d.name) : 'A house on the Lake'}</h1>
<p class="lead">${d ? `${d.about ? `${esc(d.about)} ` : ''}Its owner's own agent answers here, by their rules. Their email, number and data stay inside; this address is how you reach them.` : 'Its owner hasn\'t opened its door, so it says nothing about who lives here.'}</p>
<h2>To reach ${who}, ask your AI</h2>
<ol><li>Add the Lake to your AI chat as a connector${p.connector ? `:<span class="box">${esc(p.connector)}</span><span class="small">In Claude: Settings → Connectors → Add custom connector.</span>` : '.'}</li>
<li>Then ask it, in your own words, for example:<span class="box">${ask}I'd like to set up a call next week.</span><span class="box">${ask}leave a note that I loved the talk.</span></li></ol>
<p class="small">Your agent knocks with a signed identity and says why; the owner's rules answer, or they decide on their phone. Nothing here is a form, and nobody gets an email address.</p>
<h2>Agents</h2><p class="small">A2A 1.0 with the Lake extension (the connector above speaks it for you): <code>${esc(p.a2a())}</code> · its signed card: <code>${esc(p.a2a().replace(/\/a2a$/, ''))}/.well-known/agent-card.json</code></p>
<h2>A house of your own</h2><p>Your data in your house, your own rules at its door, your agent doing the chores.${p.joinUrl ? ` <a href="${esc(p.joinUrl)}">Build yours</a>.` : ''}</p>
</main></body></html>`;
}

/** Serves the house: A2A at /a2a, its signed card at the well-known path, the owner's approvals app at /owner/, its door page at /. */
export function createHouseServer(card: AgentCard, id: Identity, keeper: Housekeeper, desk?: OwnerDesk, appDir?: string, door?: DoorPage): express.Express {
  const app = lakeAgentApp(card, (data) => keeper.handle(data), id, { replay: keeper.replay });
  // A person who opens the A2A address itself (run 44: "Cannot GET") is shown the door page too.
  if (door) app.get('/a2a', (req, res) => void (req.accepts(['html', 'json']) === 'html' ? res.type('html').send(doorPage(door)) : res.status(405).json({ error: 'A2A: POST a JSON-RPC message here (the Lake connector does it for you)', page: door.a2a().replace(/\/a2a$/, '') })));
  if (door) app.get('/', (req, res) => void (req.accepts(['html', 'json']) === 'html' ? res.type('html').send(doorPage(door)) : res.json({ a2a: door.a2a(), card: `${door.a2a().replace(/\/a2a$/, '')}/.well-known/agent-card.json`, ...(door.door() ? { door: door.door() } : {}) })));
  // Revocation anyone can check: the house's signed status list (W3C Bitstring Status List, SPEC §6).
  app.get('/status/revocation', async (_req, res) => { res.type('application/vc+jwt').set('cache-control', 'max-age=5').send(await keeper.statusList()); });
  if (desk) app.use('/owner', desk.router(appDir));
  return app;
}
