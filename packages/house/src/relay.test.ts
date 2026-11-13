import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { buildCard, generateIdentity } from '@thelakeprotocol/core';
import { connectRelay } from './relay.js';

/** A node's relay door that says "ready" to every hello; `autoPong` off is a connection that died without a word. */
async function node(autoPong: boolean) {
  const wss = new WebSocketServer({ port: 0, autoPong });
  await new Promise((ok) => wss.once('listening', ok));
  let hellos = 0;
  wss.on('connection', (ws) => ws.on('message', () => { hellos++; ws.send(JSON.stringify({ type: 'ready' })); }));
  return { url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, hellos: () => hellos, stop: () => { for (const c of wss.clients) c.terminate(); wss.close(); } };
}
const until = async (ok: () => boolean, ms = 3000) => { for (const t = Date.now(); !ok() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 20)); };

describe('a house behind a relay (a connection that died silently left it unreachable until a restart)', () => {
  it('connects again when the node stops answering, and stays on one connection while it answers', async () => {
    const id = await generateIdentity();
    const card = {} as ReturnType<typeof buildCard>;
    const dead = await node(false), live = await node(true);
    const a = connectRelay({ nodeUrl: dead.url, card, id, webId: 'https://house.example/profile#me', localPort: 1, beat: 60 });
    const b = connectRelay({ nodeUrl: live.url, card, id, webId: 'https://house.example/profile#me', localPort: 1, beat: 60 });
    await Promise.all([a.connected, b.connected]);
    await until(() => dead.hellos() >= 2);
    expect(dead.hellos()).toBeGreaterThanOrEqual(2);
    expect(live.hellos()).toBe(1);
    a.close(); b.close(); dead.stop(); live.stop();
  });
});
