import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { joinLake, type LakeAgent, type LakeAgentOptions } from './index.js';

/**
 * The Lake MCP connector: lets any MCP-capable assistant search the Lake, knock, and dispatch whole
 * studies, as its own signed agent. The assistant brings the model; the Lake bundles none.
 */
export function createLakeMcpServer(o: LakeAgentOptions): McpServer {
  const server = new McpServer({ name: 'lake', version: '0.1.0' });
  let me: Promise<LakeAgent> | null = null;
  const agent = () => (me ??= joinLake(o));
  const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
  const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Lake error: ${(e as Error).message}` }], isError: true });

  server.registerTool(
    'lake_overview',
    { description: 'What is happening in this Lake right now: houses, agents, conversations, value settled, attacks blocked, records moved (the target is 0), guilds.', inputSchema: {} },
    async () => {
      try {
        const s = await (await fetch(`${o.node.split(',')[0]!.trim().replace(/\/$/, '')}/state`)).json();
        const roles: Record<string, number> = {};
        for (const p of s.participants) roles[p.role] = (roles[p.role] ?? 0) + 1;
        const specialists = (await (await agent()).find({ role: 'specialist' })).map((x) => ({ name: x.name, url: x.url }));
        return json({ counters: s.counters, participants: roles, guilds: s.guilds, specialists, start: 'lake_ask the Guide with { "kind": "hello" }', explain: 'https://lake.doneinfifty.com/docs/agents' });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'lake_search',
    { description: 'Find participants by skill (e.g. "health-study"), interest tag (e.g. "research-volunteers") or role (house, specialist, visitor, agent).', inputSchema: { skill: z.string().optional(), tag: z.string().optional(), role: z.string().optional() } },
    async (q) => {
      try {
        return json(await (await agent()).find(q));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'lake_knock',
    {
      description: "Send one signed offer to one house and get its owner's rules' answer (join, decline, ask, counter). Free text never changes a decision.",
      inputSchema: {
        house_url: z.string().describe('The house A2A endpoint, from lake_search'),
        purpose: z.string().describe('e.g. research, care, marketing'),
        fields: z.array(z.string()).describe('Canonical fields, e.g. age_band, medications, readmissions'),
        price_usd: z.number().default(0),
        retention: z.string().default('none').describe('"none" or an ISO 8601 duration'),
      },
    },
    async (a) => {
      try {
        return json(await (await agent()).knock(a.house_url, { purpose: a.purpose, fields: a.fields, priceUsd: a.price_usd, retention: a.retention, credentials: { ethicsApproved: false, sponsorVerified: true, auditCertified: false } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'lake_ask',
    {
      description:
        'Send one signed message to any Lake agent and get its verified, signed reply. For the specialists listed by lake_overview: the Guide ({ "kind": "hello" }, { "kind": "tour", "step": 1 }, { "kind": "explain", "term": "bloc" }), the Inspector ({ "kind": "inspect", "url": "<agent URL>" }), the Sparring partner ({ "kind": "spar", "house": "<house URL>" }), Quests ({ "kind": "progress" }, { "kind": "leaderboard" }), the Auditor ({ "kind": "audit-study", "study": {...} }).',
      inputSchema: {
        agent_url: z.string().describe("The agent's A2A endpoint, from lake_overview or lake_search"),
        message: z.record(z.string(), z.unknown()).describe('The payload; must have a "kind"'),
      },
    },
    async (a) => {
      try {
        if (typeof a.message.kind !== 'string') throw new Error('the message needs a "kind"');
        return json(await (await agent()).ask(a.agent_url, a.message as { kind: string }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'lake_dispatch_study',
    {
      description:
        'Run a whole study across the Lake: ethics approval, audit, knock on every house, bargain, sign agreements, compute inside each house (only randomised answers leave), pay under a signed budget, and return the answer. Records moved stays 0.',
      inputSchema: {
        question: z.string().default('Do over-60s on drug X get readmitted less?'),
        price_usd: z.number().default(2),
        budget_usd: z.number().default(500).describe('The most this study may spend; 0 for unpaid'),
        extra_fields: z.array(z.string()).optional().describe('Ask for more than the study needs, to see houses push back (e.g. postcode)'),
        wait_seconds: z.number().default(0).describe('How long to wait for owners asked to tap Allow'),
      },
    },
    async (a) => {
      try {
        const steps: string[] = [];
        const r = await (await agent()).study(a.question, { priceUsd: a.price_usd, budgetUsd: a.budget_usd, extraFields: a.extra_fields, waitSeconds: a.wait_seconds, log: (s, d) => steps.push(`${s}: ${d}`) });
        const { grants: _, ...result } = r;
        return json({ ...result, steps });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
