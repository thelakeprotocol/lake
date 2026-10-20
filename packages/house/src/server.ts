import { lakeAgentApp, type AgentCard } from '@thelakeprotocol/core';
import type express from 'express';
import type { Housekeeper } from './housekeeper.js';
import type { OwnerDesk } from './owner.js';

/** Serves the house: A2A at /a2a, its signed card at the well-known path, the owner's approvals app at /owner/. */
export function createHouseServer(card: AgentCard, keeper: Housekeeper, desk?: OwnerDesk, appDir?: string): express.Express {
  const app = lakeAgentApp(card, (data) => keeper.handle(data));
  if (desk) app.use('/owner', desk.router(appDir));
  return app;
}
