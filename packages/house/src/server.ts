import { lakeAgentApp, type AgentCard } from '@thelakeprotocol/core';
import type express from 'express';
import type { Housekeeper } from './housekeeper.js';
import type { OwnerDesk } from './owner.js';

/** Serves the house: A2A at /a2a, its signed card at the well-known path, the owner's approvals app at /owner/. */
export function createHouseServer(card: AgentCard, keeper: Housekeeper, desk?: OwnerDesk, appDir?: string): express.Express {
  const app = lakeAgentApp(card, (data) => keeper.handle(data));
  // Revocation anyone can check: the house's signed status list (W3C Bitstring Status List, SPEC §6).
  app.get('/status/revocation', async (_req, res) => { res.type('application/vc+jwt').set('cache-control', 'max-age=5').send(await keeper.statusList()); });
  if (desk) app.use('/owner', desk.router(appDir));
  return app;
}
