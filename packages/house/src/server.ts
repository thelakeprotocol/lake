import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { lakeMessage, readLakeData, type AgentCard } from '@thelakeprotocol/core';
import type { Housekeeper } from './housekeeper.js';

/** Serves the house over A2A: the signed card at the well-known path, JSON-RPC at /a2a. */
export function createHouseServer(card: AgentCard, keeper: Housekeeper): express.Express {
  const executor: AgentExecutor = {
    async execute(ctx, bus) {
      const reply = await keeper.handle(readLakeData(ctx.userMessage));
      bus.publish({ kind: 'message', data: lakeMessage(reply, 'agent', ctx.contextId) });
      bus.finished();
    },
    async cancelTask() {},
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use('/a2a', express.json({ limit: '256kb' }), jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return app;
}
