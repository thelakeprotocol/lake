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
  const verified = await verifyLakeData(await sendLake(agentUrl, data), { sandbox: true });
  if (!verified.ok) throw new Error(`the reply from ${agentUrl} did not verify: ${verified.rejection.why}`);
  return { reply: verified.payload as Record<string, any>, from: verified.profile };
}

/** Sends one signed offer to a house over A2A and returns the house's verified, signed reply. */
export async function knock(houseUrl: string, v: Visitor, terms: Omit<Offer, 'id' | 'requester'>, tamper: Tamper = 'none') {
  const offer: Offer = { id: randomUUID(), requester: tamper === 'impersonate' ? 'nhs.uk' : v.domain, ...terms };
  const { reply, from } = await ask(houseUrl, v, { kind: 'offer', offer }, tamper);
  return { offer, reply, house: from };
}
