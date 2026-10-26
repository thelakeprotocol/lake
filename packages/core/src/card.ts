import { generateAgentCardSignature, verifyAgentCardSignature, type AgentCard } from '@a2a-js/sdk';
import * as jose from 'jose';
import type { Identity } from './crypto.js';
import type { MenuItem } from './trade.js';
import type { Badge } from './badges.js';
import { LAKE_EXTENSION_URI, LAKE_VERSION } from './lake.js';

export type LakeRole = 'house' | 'specialist' | 'visitor' | 'agent' | 'node';

/** Lake profile fields. They live inside an A2A extension so the card signature covers them. */
export interface LakeProfile {
  role: LakeRole;
  /** The owner's WebID: who answers for this agent. */
  webId: string;
  /** The domain the owner proves control of: its did:web document, or its DID Configuration, lists this key (SPEC §2.3). */
  ownerDomain: string;
  /** Public signing key (JWK) used for cards and messages. */
  publicJwk: jose.JWK;
  /** Interest tags used for discovery and guilds, e.g. "research-volunteers". */
  tags: string[];
  /** Houses: the packs (use cases) whose claims this house holds and checks against their shapes, e.g. "health@1". */
  packs?: string[];
  /** What this agent sells and for how much (SPEC §6.5): signed with the card, so a price can't be changed in transit. */
  menu?: MenuItem[];
  /**
   * Credentials others signed about this agent (SPEC §2.5): a register's authorisation, say, each with the A2A address of
   * its issuer, whose own card gives the key it checks against. Tags, names and menu labels are the agent's own words; a
   * badge is someone else's, and counts as far as the reader trusts that issuer.
   */
  badges?: Badge[];
  lakeVersion: string;
}

export interface CardInput {
  name: string;
  description: string;
  /** A2A endpoint (JSON-RPC binding). */
  url: string;
  /** More endpoints for the same agent, e.g. a relay through each node a house follows. */
  alsoAt?: string[];
  skills: { id: string; name: string; description: string; tags?: string[] }[];
  profile: Omit<LakeProfile, 'lakeVersion' | 'publicJwk'>;
}

export function buildCard(input: CardInput, id: Identity): AgentCard {
  const profile: LakeProfile = { ...input.profile, publicJwk: id.publicJwk, lakeVersion: LAKE_VERSION };
  return {
    name: input.name,
    description: input.description,
    supportedInterfaces: [input.url, ...(input.alsoAt ?? [])].map((url) => ({ url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' })),
    provider: { url: `https://${input.profile.ownerDomain}`, organization: input.profile.ownerDomain },
    version: LAKE_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [{ uri: LAKE_EXTENSION_URI, description: 'Lake profile: identity, owner domain and tags', required: true, params: profile }],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: input.skills.map((s) => ({ ...s, tags: s.tags ?? [], examples: [], inputModes: [], outputModes: [], securityRequirements: [] })),
    signatures: [],
  };
}

export function signCard(card: AgentCard, id: Identity): Promise<AgentCard> {
  return generateAgentCardSignature(id.privateKey, { alg: 'EdDSA', kid: id.kid, typ: 'JOSE' })(card);
}

export function lakeProfile(card: AgentCard): LakeProfile | null {
  const ext = card.capabilities?.extensions?.find((e) => e.uri === LAKE_EXTENSION_URI);
  return (ext?.params as LakeProfile | undefined) ?? null;
}

export class CardError extends Error {
  constructor(public readonly code: 'unsigned' | 'bad-signature' | 'not-lake' | 'wrong-major', message: string) {
    super(message);
  }
}

/**
 * Checks that a card is a Lake card, is signed, and that the signature verifies
 * against the key the card itself declares. Domain proof is checked separately
 * (see domain.ts), because it needs the network.
 */
export async function verifyLakeCard(card: AgentCard): Promise<LakeProfile> {
  // The same signed card is verified by every house it knocks on; the answer can't change, so remember it.
  const memo = JSON.stringify(card);
  const known = verified.get(memo);
  if (known) return known;
  const profile = await verifyLakeCardUncached(card);
  if (verified.size > 5000) verified.clear();
  verified.set(memo, profile);
  return profile;
}

const verified = new Map<string, LakeProfile>();

async function verifyLakeCardUncached(card: AgentCard): Promise<LakeProfile> {
  const profile = lakeProfile(card);
  if (!profile?.publicJwk) throw new CardError('not-lake', 'card has no Lake profile');
  if (major(profile.lakeVersion) !== major(LAKE_VERSION)) throw new CardError('wrong-major', `Lake ${profile.lakeVersion} is not compatible with ${LAKE_VERSION}`);
  if (!card.signatures?.length) throw new CardError('unsigned', 'card is not signed');
  try {
    await verifyAgentCardSignature(async (kid) => {
      if (kid !== profile.publicJwk.kid) throw new Error('unknown kid');
      return profile.publicJwk;
    })(card);
  } catch {
    throw new CardError('bad-signature', 'card signature does not verify');
  }
  return profile;
}

const major = (v: string) => v.split('.')[0];
