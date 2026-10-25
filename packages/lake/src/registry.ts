import { canonicalize, cardUrlFor, menuProblems, proveDomain, verifyLakeCard, type AgentCard, type LakeProfile } from '@thelakeprotocol/core';

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
  /** When the agent's driver last acted through it (its own signed word), if it says. */
  lastActive?: number;
  /** Until when it says it will be around. */
  hereUntil?: number;
}

export type Refusal = { code: 'not-lake' | 'forged-card' | 'domain' | 'unreachable' | 'card-mismatch' | 'reserved'; why: string };

/** A name as words, its aside dropped: "Payments (demo)" is "payments", "Arbiter, official!" is "arbiter official". */
const words = (name: string) => name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

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
    // A menu others will order from must make sense: a search shows it as it is.
    if (profile.menu !== undefined && menuProblems(profile.menu).length) return { ok: false, refusal: { code: 'not-lake', why: menuProblems(profile.menu).join('; ') } };
    const claimed = via === 'direct' ? this.claims(card, profile) : undefined;
    if (claimed) return { ok: false, refusal: { code: 'reserved', why: claimed } };
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

  /**
   * Whether a card claims a specialist's identity (SPEC §2.4): run 27's and 31's agents named themselves like the Lake's
   * specialists, or carried their skill ids as tags. A specialist registered here directly (the operator's own, which
   * register at boot) holds its name and its skill ids: no other card registered here may carry that name among its words,
   * and no card but a specialist may carry those ids as a skill or tag (Teller A and Teller B share theirs). Cards synced
   * from peers are not checked: a peer's Lake runs its own Payments and Arbiter.
   */
  private claims(card: AgentCard, profile: LakeProfile): string | undefined {
    const name = ` ${words(card.name)} `;
    const ids = new Set([...card.skills.map((s) => s.id.toLowerCase()), ...(profile.role === 'specialist' ? [] : profile.tags.map((t) => t.toLowerCase()))]);
    for (const e of this.entries.values()) {
      if (e.via !== 'direct' || e.profile.role !== 'specialist' || e.profile.webId === profile.webId) continue;
      const theirs = words(e.card.name);
      if (theirs && name.includes(` ${theirs} `)) return `"${card.name}" is taken: it names this Lake's specialist "${e.card.name}" (${e.profile.ownerDomain}); choose a name of your own`;
      const id = profile.role === 'specialist' ? undefined : e.card.skills.map((s) => s.id.toLowerCase()).find((s) => ids.has(s));
      if (id) return `"${id}" is reserved: it is the skill of this Lake's specialist "${e.card.name}" (${e.profile.ownerDomain}); use a skill id or tag of your own`;
    }
    return undefined;
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

  /**
   * Cards by role, tag, skill or free text. Forgiving where it can be (run 21's agents missed each other by a near-miss
   * tag): a tag also matches by prefix ("writer" finds "writer:poems"), and `q` matches words in a card's name,
   * description, tags and skills. Cards registered here come before those synced from peers: an agent that takes the
   * first log or arbiter it finds gets its own Lake's (run 33's sellers read a peer's log, so their sales showed 0).
   */
  search(q: { skill?: string; tag?: string; role?: string; q?: string }): Entry[] {
    const tag = q.tag?.toLowerCase();
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    return [...this.entries.values()].filter(
      (e) =>
        (!q.role || e.profile.role === q.role) &&
        (!tag || e.profile.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}:`) || t.toLowerCase().startsWith(tag))) &&
        (!q.skill || e.card.skills.some((s) => s.id === q.skill)) &&
        (!words.length || ((text) => words.every((w) => text.includes(w)))([e.card.name, e.card.description, ...e.profile.tags, ...e.card.skills.map((s) => `${s.id} ${s.name} ${s.description}`), ...(e.profile.menu ?? []).map((m) => `${m.sku} ${m.label}`)].join(' ').toLowerCase())),
    ).sort((a, b) => Number(a.via !== 'direct') - Number(b.via !== 'direct'));
  }

  all() {
    return [...this.entries.values()];
  }
}
