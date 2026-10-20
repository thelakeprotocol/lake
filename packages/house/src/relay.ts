import WebSocket from 'ws';
import { signMessage, type AgentCard, type Identity } from '@thelakeprotocol/core';

/**
 * For a house behind a home router: keep one outgoing connection to a node, and answer the requests the
 * node relays down it by passing them to this house's own A2A server. Nothing to open, nothing to forward.
 * Messages are signed end to end, so the node can't forge or alter them; it can see offers and decisions,
 * never records (they don't leave the house anyway).
 */
export function connectRelay(o: { nodeUrl: string; card: AgentCard; id: Identity; webId: string; localPort: number; log?: (msg: string) => void }) {
  let ws: WebSocket | null = null;
  let delay = 500;
  let ready: () => void;
  const connected = new Promise<void>((ok) => (ready = ok));
  const url = `${o.nodeUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/relay`;

  const open = () => {
    ws = new WebSocket(url);
    ws.on('open', async () => {
      delay = 500;
      ws!.send(JSON.stringify({ type: 'hello', card: o.card, envelope: await signMessage({ kind: 'relay-hello' }, o.id, { iss: o.webId }) }));
    });
    ws.on('message', async (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; id?: string; method?: string; path?: string; headers?: Record<string, string>; body?: string };
      if (m.type === 'ready') {
        o.log?.(`reachable through the relay at ${o.nodeUrl}`);
        ready();
        return;
      }
      if (m.type !== 'req') return;
      try {
        const res = await fetch(`http://127.0.0.1:${o.localPort}${m.path}`, { method: m.method, headers: m.headers, body: m.body });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        ws!.send(JSON.stringify({ type: 'res', id: m.id, status: res.status, headers, body: await res.text() }));
      } catch (e) {
        ws!.send(JSON.stringify({ type: 'res', id: m.id, status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: (e as Error).message }) }));
      }
    });
    ws.on('close', () => setTimeout(open, (delay = Math.min(delay * 2, 15_000))));
    ws.on('error', () => {});
  };
  open();
  return { connected, close: () => { ws?.removeAllListeners('close'); ws?.close(); } };
}
