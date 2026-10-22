import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Parser } from 'n3';
import { z } from 'zod';
import { turtleToClaims, type Claim } from '@thelakeprotocol/core';

const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

export interface PodMcpOptions {
  podRoot: string;
  /** Authenticated fetch for the pod. */
  fetch: typeof fetch;
  /** Paths (relative to the pod root) this server must never read, e.g. ["wallet/"] for outside assistants. */
  deny?: string[];
  /** Called for every pod access, for the audit trail. */
  onAccess?: (tool: string, path: string) => void;
  /** Path prefixes this door may write to (e.g. agreements/, audit/). None by default: read-only. */
  allowWrite?: string[];
  /** The converted claims documents, one per pack (e.g. health/claims.ttl), relative to the pod root. */
  claimsDocs: string[];
}

export type PodClaim = Claim;

/**
 * The only door from an agent to a pod. The housekeeper uses it in-process; any MCP-capable
 * assistant can use the same tools over stdio (see pod-mcp-stdio.ts). Read-only in v0.
 */
export function createPodMcpServer(o: PodMcpOptions): McpServer {
  const server = new McpServer({ name: 'lake-pod', version: '0.1.0' });

  const resolve = (path: string) => {
    const url = new URL(path.replace(/^\/+/, ''), o.podRoot).href;
    if (!url.startsWith(o.podRoot)) throw new Error('path is outside this pod');
    const rel = url.slice(o.podRoot.length);
    if (o.deny?.some((d) => rel.startsWith(d))) throw new Error(`${rel} is not readable through this door`);
    return { url, rel };
  };
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
  const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: (e as Error).message }], isError: true });

  server.registerTool(
    'pod_list',
    { description: 'List the resources in a pod container, e.g. "health/".', inputSchema: { path: z.string().default('') } },
    async ({ path }) => {
      try {
        const { url, rel } = resolve(path.endsWith('/') || path === '' ? path : `${path}/`);
        o.onAccess?.('pod_list', rel);
        const res = await o.fetch(url, { headers: { accept: 'text/turtle' } });
        if (!res.ok) throw new Error(`${rel}: ${res.status}`);
        const quads = new Parser({ baseIRI: url }).parse(await res.text());
        return text(JSON.stringify(quads.filter((q) => q.predicate.value === LDP_CONTAINS).map((q) => q.object.value.slice(o.podRoot.length))));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'pod_read',
    { description: 'Read one resource from the pod as text.', inputSchema: { path: z.string() } },
    async ({ path }) => {
      try {
        const { url, rel } = resolve(path);
        o.onAccess?.('pod_read', rel);
        const res = await o.fetch(url);
        if (!res.ok) throw new Error(`${rel}: ${res.status}`);
        return text(await res.text());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'pod_claims',
    {
      description: `Canonical Lake claims held in this pod (${o.claimsDocs.join(', ')}), optionally limited to some fields.`,
      inputSchema: { fields: z.array(z.string()).optional() },
    },
    async ({ fields }) => {
      try {
        const all: Claim[] = [];
        for (const doc of o.claimsDocs) {
          const { url, rel } = resolve(doc);
          o.onAccess?.('pod_claims', rel);
          const res = await o.fetch(url);
          if (res.status === 404) continue;
          if (!res.ok) throw new Error(`${rel}: ${res.status}`);
          all.push(...turtleToClaims(await res.text(), url));
        }
        return text(JSON.stringify(all.filter((c) => !fields || fields.includes(c.field))));
      } catch (e) {
        return fail(e);
      }
    },
  );

  if (o.allowWrite?.length) {
    server.registerTool(
      'pod_write',
      { description: `Write one resource under ${o.allowWrite.join(', ')}.`, inputSchema: { path: z.string(), content: z.string(), contentType: z.string().default('application/json') } },
      async ({ path, content, contentType }) => {
        try {
          const { url, rel } = resolve(path);
          if (!o.allowWrite!.some((w) => rel.startsWith(w))) throw new Error(`${rel} is not writable through this door`);
          o.onAccess?.('pod_write', rel);
          const res = await o.fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: content });
          if (!res.ok) throw new Error(`${rel}: ${res.status}`);
          return text('ok');
        } catch (e) {
          return fail(e);
        }
      },
    );
  }

  return server;
}
