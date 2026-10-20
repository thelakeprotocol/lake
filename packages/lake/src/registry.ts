import { canonicalize, cardUrlFor, proveDomain, verifyLakeCard, type AgentCard, type LakeProfile } from '@thelakeprotocol/core';

export interface Entry {
  /** Short, stable id the map and events use: role plus the start of the key id. */
  id: string;
  label: string;
  card: AgentCard;
  profile: LakeProfile;
  domainVia: string;
  registeredAt: string;
  url: string;
  /** Where we learned of it: registered here directly, or synced from a peer node we follow. */
  via: 'direct' | string;
  /** Last time the participant checked in (registration, keep-alive, or an event report). */
  lastSeen: number;
}

export type Refusal = { code: 'not-lake' | 'forged-card' | 'domain' | 'unreachable' | 'card-mismatch'; why: string };

/**
 * A search index of signed Agent Cards. Not a gatekeeper: anything here can also be found at its
 * own /.well-known/agent-card.json (SPEC §9). Rejects anything it cannot verify.
 */
export class Registry {
  private entries = new Map<string, Entry>();

  constructor(private o: { sandbox: boolean; fetch?: typeof fetch }) {}

  async register(card: AgentCard, via: Entry['via'] = 'direct'): Promise<{ ok: true; entry: Entry; replaced: Entry[] } | { ok: false; refusal: Refusal }> {
    let profile: LakeProfile;
    try {
      profile = await verifyLakeCard(card);
    } catch (e) {
      return { ok: false, refusal: { code: (e as { code?: string }).code === 'not-lake' ? 'not-lake' : 'forged-card', why: (e as Error).message } };
    }
    const proof = await proveDomain(profile, { sandbox: this.o.sandbox });
    if (!proof.ok) return { ok: false, refusal: { code: 'domain', why: proof.reason } };

    // The registrant must control the endpoint it names: that endpoint must serve this exact card.
    const url = card.supportedInterfaces[0]?.url;
    if (!url) return { ok: false, refusal: { code: 'not-lake', why: 'card names no endpoint' } };
    const wellKnown = cardUrlFor(url);
    try {
      const res = await (this.o.fetch ?? fetch)(wellKnown, { signal: AbortSignal.timeout(5000), headers: { 'A2A-Version': '1.0' } });
      const served = (await res.json()) as AgentCard;
      if (canonicalize(served.signatures) !== canonicalize(card.signatures)) {
        return { ok: false, refusal: { code: 'card-mismatch', why: `${wellKnown} serves a different card` } };
      }
    } catch (e) {
      return { ok: false, refusal: { code: 'unreachable', why: `could not fetch ${wellKnown}: ${(e as Error).message}` } };
    }

    const id = `${profile.role}:${profile.publicJwk.kid!.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`;
    // One live card per WebID: a newer card (a rotated key) replaces the old one.
    const replaced: Entry[] = [];
    for (const [old, e] of this.entries) if (e.profile.webId === profile.webId && old !== id) { this.entries.delete(old); replaced.push(e); }
    const entry: Entry = { id, label: card.name, card, profile, domainVia: proof.via, registeredAt: new Date().toISOString(), url, via, lastSeen: Date.now() };
    this.entries.set(id, entry);
    return { ok: true, entry, replaced };
  }

  remove(id: string) {
    return this.entries.delete(id);
  }

  get(id: string) {
    return this.entries.get(id);
  }

  byWebId(webId: string) {
    for (const e of this.entries.values()) if (e.profile.webId === webId) return e;
    return undefined;
  }

  search(q: { skill?: string; tag?: string; role?: string }): Entry[] {
    return [...this.entries.values()].filter(
      (e) =>
        (!q.role || e.profile.role === q.role) &&
        (!q.tag || e.profile.tags.includes(q.tag)) &&
        (!q.skill || e.card.skills.some((s) => s.id === q.skill)),
    );
  }

  all() {
    return [...this.entries.values()];
  }
}
