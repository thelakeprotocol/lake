import { lakeAgentApp, type AgentCard } from '@thelakeprotocol/core';
import type express from 'express';
import type { Housekeeper } from './housekeeper.js';

/** Serves the house over A2A: the signed card at the well-known path, JSON-RPC at /a2a. */
export function createHouseServer(card: AgentCard, keeper: Housekeeper): express.Express {
  return lakeAgentApp(card, (data) => keeper.handle(data));
}
