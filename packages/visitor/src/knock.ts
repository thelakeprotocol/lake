import { randomUUID } from 'node:crypto';
import {
  buildCard, exampleOffers, sendLake, signCard, signMessage, verifyLakeData,
  type AgentCard, type Identity, type LakeData, type Offer,
} from '@thelakeprotocol/core';

export interface Visitor {
  id: Identity;
  card: AgentCard;
  webId: string;
  domain: string;
}

export async function makeVisitor(id: Identity, domain: string, name = `Visitor from ${domain}`, url = `https://${domain}/a2a`): Promise<Visitor> {
  const webId = `https://${domain}/#agent`;
  const card = await signCard(
    buildCard(
      {
        name,
        description: `An agent acting for ${domain}.`,
        url,
        skills: [{ id: 'study', name: 'Studies', description: 'Asks houses to join studies' }],
        profile: { role: 'visitor', webId, ownerDomain: domain, tags: [] },
      },
      id,
    ),
    id,
  );
  return { id, card, webId, domain };
}

/** Ready-made offers from the loaded packs (`gp`, `research`, `marketing`, `injection`…), for the CLI, the swarm and demos. */
export const presets = (): Record<string, Omit<Offer, 'id' | 'requester'>> => exampleOffers();

export type Tamper = 'none' | 'forge-card' | 'unsigned' | 'replay' | 'impersonate';

/** Signs a payload as this visitor and sends it to an agent over A2A; returns the verified, signed reply. */
/** Network failures where the message may or may not have arrived. */
const HOUSE_KINDS = new Set(['offer', 'compute', 'status', 'withdraw', 'receipt', 'quote', 'accept']);
const DROPPED = /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|socket hang up|terminated/i;

export async function ask(agentUrl: string, v: Visitor, payload: Record<string, unknown>, tamper: Tamper = 'none') {
  const envelope = await signMessage(payload, v.id, { iss: v.webId });
  let card = v.card;
  if (tamper === 'forge-card') {
    card = structuredClone(v.card);
    card.capabilities!.extensions[0]!.params!.ownerDomain = 'trusted-hospital.example';
  }
  if (tamper === 'unsigned') card = { ...v.card, signatures: [] };
  const data: LakeData = { lake: '0.1', card, envelope: envelope as LakeData['envelope'] };
  if (tamper === 'replay') await sendLake(agentUrl, data);
  // A connection that drops mid-call leaves the sender not knowing if it arrived. Sending the same signed message again
  // is safe: the receiver refuses a nonce it has seen, and that refusal is the proof the first one got there.
  let retried = false;
  const raw = await sendLake(agentUrl, data).catch(async (e: Error & { cause?: { code?: string } }) => {
    // Not to a house: a house counts a repeat as an attack on it, and the honest sender would take the blame.
    if (!DROPPED.test(`${e.cause?.code ?? ''} ${e.message}`) || HOUSE_KINDS.has(String(payload.kind))) throw e;
    retried = true;
    return sendLake(agentUrl, data);
  });
  const verified = await verifyLakeData(raw, { sandbox: true });
  if (!verified.ok) throw new Error(`the reply from ${agentUrl} did not verify: ${verified.rejection.why}`);
  const reply = verified.payload as Record<string, any>;
  const repeat = (reply.kind === 'rejected' && reply.code === 'replayed') || (reply.kind === 'refused' && String(reply.problems?.[0] ?? '').startsWith('replayed'));
  if (retried && repeat) return { reply: { kind: 'delivered', note: 'the connection dropped, but the first try had already arrived (the retry was refused as a repeat), so it got there once' }, from: verified.profile };
  return { reply, from: verified.profile };
}

/** Sends one signed offer to a house over A2A and returns the house's verified, signed reply. */
export async function knock(houseUrl: string, v: Visitor, terms: Omit<Offer, 'id' | 'requester'>, tamper: Tamper = 'none') {
  const offer: Offer = { id: randomUUID(), requester: tamper === 'impersonate' ? 'nhs.uk' : v.domain, ...terms };
  const { reply, from } = await ask(houseUrl, v, { kind: 'offer', offer }, tamper);
  return { offer, reply, house: from };
}
