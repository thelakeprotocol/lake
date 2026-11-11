import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import webpush from 'web-push';
import { join } from 'node:path';
import express from 'express';
import type { WantOfferRecord, WantRecord } from './wants.js';
import type { HouseRunner } from './duty-runner.js';
import {
  allowanceDraft, dutyDraft, postalAddress, postalAddressProblems, type PostalAddress, pledgeDraft, purchaseDraft, type Want, fieldSpec, DUTY_KINDS, type DutyKind, availabilityProblems, identifyingFields, consentRecord, freeSlots, parseRules, digestSRI, isCurrency, makeEvent, PURPOSES, readAccessGrant, ReplayGuard, statusEntry, STATUS_LIST_LENGTH, verifyCredential, verifyMessage,
  type AgentCard, type Availability, type JWK, type LakeEvent, type Signed, type Study,
} from '@thelakeprotocol/core';

/** When the owner was last at their desk, as a visitor waiting on an ask hears it: a bucket, never a time (SPEC §5). */
export type OwnerActive = 'within the hour' | 'today' | 'this week' | 'not this week' | 'no owner';

/** An offer the rules couldn't settle: waiting for the owner's tap. */
export interface PendingRequest {
  id: string;
  offerId: string;
  visitor: { webId: string; domain: string; name: string; /** Its key's id: what an owner's No is held against. */ key?: string; /** Its key's RFC 7638 thumbprint, from the verified card: what a standing yes and a mute hold. */ jkt?: string };
  purpose: string;
  fields: string[];
  retention: string;
  priceUsd: number;
  /** Its price in its own currency, when it named one. */
  price?: { amount: number; currency: string };
  study: string | null;
  question?: string;
  /** What to look at twice: identifying or unknown fields, keeping data for years (SPEC §5). */
  warnings?: string[];
  /** The visitor's own note to the owner: their words, unchecked, shown quoted and never read by the rules. */
  note?: string;
  /** How many times the same agent has asked exactly this; one request, however many knocks. */
  asked?: number;
  /** Its earlier requests for the same purpose that this one replaced (withdrawn, not stacked). */
  replaces?: string[];
  recommendation: string;
  /** The grant the owner's device signs to allow it: a Solid Access Grant drafted by the house, dated and signed on the device. */
  grantDraft?: unknown;
  requestedAt: string;
  status: 'pending' | 'allowed' | 'denied';
  grant?: string;
}

/** The control panel's view of a house. Every call is signed by the owner's key. */
/** A standing yes the owner added from their panel ("always allow this agent for this"), as the panel lists it. */
export interface StandingYes { jkt: string; domain: string; purpose: string; fields: string[]; retention: string; floor?: { amount: number; currency: string }; added: string; until: string; uses: number }

export interface PanelProvider {
  overview(tzOffset?: number): Promise<unknown>;
  /** Standing yeses: added after the owner's own declines, listed, removed (each a change to the owner's rules). */
  addStanding?(s: { jkt: string; domain: string; purpose: string; fields: string[]; retention: string; floor: { amount: number; currency: string } }): Promise<{ ok: true } | { ok: false; error: string }>;
  removeStanding?(jkt: string, purpose?: string): Promise<{ ok: true; removed: number } | { ok: false; error: string }>;
  standing?(): StandingYes[];
  rules(): Promise<{ text: string; rules: unknown }>;
  setRules(text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The house's door (SPEC §9.0): open or not, its line, the address to give out, and its A2A address. */
  door?(): { open: boolean; about?: string; name?: string; handle?: string; address: string; a2a: string };
  /** Opens or closes it, written into the owner's rules like any other setting. */
  setDoor?(d: { open: boolean; about?: string; name?: string; handle?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  availability?(): Availability | null;
  setAvailability?(a: Availability | null): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Newest first; with `since` (a seq from an earlier look, or a time), only what came after it. */
  activity(since?: number | string): { seq: number }[];
  agents(): unknown[];
  money(): Promise<unknown>;
  /** A receipt was filed again at this path: a copy kept of it is stale. */
  forgetReceipt?(path: string): void;
  /** The owner's consent records (one beside each agreement), newest first, each with where it stands now. */
  consents(): Promise<unknown>;
  /** Who has access: agents that can see something now, what they asked, what the house said (one source per number). */
  access?(tzOffset?: number): Promise<unknown>;
  data(): Promise<unknown>;
  exportAll(): Promise<unknown>;
  /** What the owner is looking for, and the offers priced for them in this house. */
  market(): Promise<unknown>;
  openIntent(pack: string, terms: Record<string, string | number>): Promise<unknown>;
  closeIntent(pack: string): Promise<unknown>;
  acceptOffer(id: string): Promise<unknown>;
  /** What accepting an offer costs, where its program names a price. */
  offerPrice?(id: string): { amount: number; currency: string } | undefined;
  /** One person, one house (SPEC §6.4): ask the person checker for a stamp, with the owner's signed consent. */
  requestPersonhood(consent: unknown, ownerJwk: JWK): Promise<unknown>;
  /** Sign a pledge, from this house, with its person stamp; for a pledge with money, with the contribution the owner signed. */
  signPledge(tally: string, id: string, contribution?: { credential: string; owner: string }): Promise<unknown>;
  /** What a pledge says, where it stands, and what signing it costs (its tally's view, and the tally's webId). */
  pledgeTerms?(tally: string, id: string): Promise<Record<string, any>>;
  /** The promise circles the owner joined, and each one's record (theirs included). */
  circles?(): Promise<unknown[]>;
  /** A favour note (SPEC §11.4c): this house's signed "I received this from that member: one favour", kept in its wallet. */
  favourNote?(c: { tally: string; id: string; call: string; helper: string; need: string; help?: string }): Promise<string>;
  /** Pass a favour owed to the owner on, to settle one they owe (SPEC §11.4c). */
  passFavour?(): Promise<Record<string, any>>;
  /** Pay a cart priced in favours with one owed to the owner (SPEC §6.7). */
  payWithFavour?(cart: unknown, sellerUrl: string): Promise<Record<string, any>>;
  /** What the owner is looking for (SPEC §6.8). */
  wantsList?(): WantRecord[];
  postWant?(input: { name: string; description?: string; properties?: Record<string, string | number>; quantity?: number; area?: string; currency?: string; days?: number }, limit?: { amount: number; currency: string }): Promise<Want>;
  closeWant?(id: string): Promise<boolean>;
  wantOffer?(wantId: string, offerId: string): WantOfferRecord | undefined;
  buyWant?(wantId: string, offerId: string, signed: { credential: string; owner: string }): Promise<Record<string, any>>;
  deliveryAddress?(): Promise<PostalAddress | null>;
  setDeliveryAddress?(a: PostalAddress | null): Promise<void>;
  wantArrived?(wantId: string): Promise<Record<string, any>>;
  /** Answer a circle's vote on its rules, privately (SPEC §11.4c). */
  voteCircle?(tally: string, id: string, vote: string, yes: boolean): Promise<Record<string, any>>;
  fileFavour?(jws: string, side: 'owe' | 'owed'): Promise<void>;
  /** A message from this house to a tally (a promise circle's call, accept, decline, kept), and its verified reply. */
  circleSend?(tally: string, payload: Record<string, unknown>): Promise<Record<string, any>>;
  /** A one-time link that gives someone a house of their own on this hosted Lake. */
  invite?(): Promise<{ link: string; left: number } | { error: string }>;
  /** A signed message from this house to another agent (the owner's answer to a note its AI left). */
  replyAgent?(url: string, payload: Record<string, unknown>): Promise<Record<string, any>>;
  /** What the owner's record says for one coded field (its first value), for a count answered from it. */
  recordCode?(field: string): Promise<string | undefined>;
  /** A secret count answered from the owner's own record: the house finds the answer and sends it as two shares. */
  answerFromRecord?(count: RecordCount): Promise<Record<string, any>>;
  /** The owner's private answer to a pledge's quorum question, sent by the house as a secret count's shares. */
  answerQuorum?(tally: string, id: string, choice: string): Promise<Record<string, any>>;
  /** Reveal this house on a blind pledge that has filled. */
  revealPledge(tally: string, id: string): Promise<unknown>;
  /** Takes the owner's signature back, before the pledge fills: it never binds them. */
  withdrawPledge?(tally: string, id: string): Promise<unknown>;
}

/** What signing a pledge with money costs, as its tally said when it was suggested (SPEC §11.4a). */
export interface PledgeMoney { amount: number; currency: string; payee: string; threshold: number; deadline: string; count: number; bond?: number; text: string }

/**
 * A secret count answered from one of the owner's own facts (SPEC §11.5): which answer it is comes from their record, not
 * from anyone's say-so, and goes as two unreadable shares on the owner's tap. `mine` is what their record says, shown to
 * them so they know exactly what would be counted; never to the assistant.
 */
/**
 * A promise circle's message for the owner (SPEC §11.4c): `ask`, a member needs what they promised (the caller unnamed);
 * `caller`, their own call and how it stands; `kept`, a promise of theirs counted as kept; `unmet`, nobody could take it.
 */
export interface CircleItem {
  tally: string; id: string; call: string; need: string; when?: string; promise?: string; /** The kind of help asked for. */ help?: string;
  role: 'ask' | 'caller' | 'kept' | 'unmet' | 'cleared' | 'pass' | 'passed' | 'vote' | 'voted';
  state: 'open' | 'accepted' | 'declined' | 'reported' | 'taken' | 'asking' | 'matched' | 'done' | 'withdrawn' | 'disputed';
  /** Whom to reach, once matched: the other member's house (and its WebID, which a favour note names). */
  contact?: string; contactWebId?: string;
  /** A favour offered to the owner to settle one owed to them: the note, and the digest of the one it settles. */
  pass?: { id: string; note: string; settles: string };
  /** A vote on the circle's rules: its id and what it would change. */
  vote?: { id: string; text: string; closes: string };
}

export interface RecordCount { id: string; options: string[]; leader: string; helper: string; field: string; label: string; mine?: string; answered?: boolean }

/** A pledge's quorum question (SPEC §11.4b), as its tally asked it: answered privately on the owner's phone. */
export interface PledgeQuorum { text: string; options: string[]; closes: string; least: number; answered?: boolean }

export interface GrantRecord {
  id: string;
  jws: string;
  visitor: string;
  fields: string[];
  purpose: string;
  until: string;
  authorizedBy: string;
  revoked: boolean;
  /** Used up: a single-use key whose one use has happened. */
  spent?: boolean;
}

const MAX_GRANT_MS = 48 * 3_600_000;

/**
 * Your own AI agent, inside your house: a second key the owner hands out from the panel. It may look (requests,
 * offers, activity, data, rules) and suggest; it may never Allow, change rules, accept, revoke or export. Only
 * the owner's key cuts keys.
 */
/**
 * The owner's AI on duty while they're away (SPEC §6.1): what their signed grant lets it do, how many actions a night, in
 * which hours. Its bit on the status list is the kill switch.
 */
export interface Duty { statusId: string; credential: string; kinds: DutyKind[]; cap: number; hours?: { from: string; to: string; tz: string }; until: string; at: string; /** Off for the night (its cap) or for good (refusals, undos, the owner): why and since when. */ off?: { at: string; why: string; night?: boolean };
  /** Where its runner runs, since when, when it last looked, and the gaps when it didn't (the computer slept): said honestly. */ runner?: { host: string; since: string; last: string; every: number; gaps: { from: string; to: string }[] } }
/** One thing the AI on duty did, or was refused: what the owner's morning page shows, with its signed reply and an undo. */
export interface DutyEntry { id: string; /** The assistant's key. */ by: string; at: string; tool: string; action: string; /** Stopped by a limit (tonight's, or one person's), not a rule broken: doesn't count towards going off duty. */ limit?: boolean; to?: { name?: string; webId?: string; key?: string; url?: string }; text?: string; reply?: unknown; refused?: string; receipt?: string; undo?: { kind: 'agenda' | 'block' | 'standing' | 'correction'; ref: string }; undone?: string }
export interface AssistantKey { /** On duty: the grant it acts under while the owner is away. */ duty?: Duty; kid: string; jwk: JWK; label: string; addedAt: string; /** When it last used its key (kept at most every 10 minutes). */ seenAt?: string; /** Its Lake WebID, for an allowance to name. */ webId?: string; /** Its A2A endpoint: where the house tells it what its human decided. */ url?: string }
/** What the owner lets one assistant spend for them (SPEC §6.2): their signed AP2 Intent Mandate, with its bit on the status list. */
export interface Allowance { kid: string; credential: string; statusId: string; amount: number; currency: string; until: string; at: string }
/** A note from an assistant to its human; it may point at a waiting request or at an offer to accept. */
export interface Suggestion {
  id: string; from: string; text: string; request?: string; offer?: string; /** A pledge to sign: the owner's panel puts a Sign button on the note, saying what it costs if it holds money. */ pledge?: { tally: string; id: string; money?: PledgeMoney; quorum?: PledgeQuorum; circle?: { promise: string; times: number; kinds?: string[] } }; /** A secret count the house answers from one of the owner's facts, on their tap. */ count?: RecordCount; /** From a promise circle the owner is in: a call for help, or news of their own call. */ circle?: CircleItem; /** The assistant proposes asking one of the owner's circles: a button sends it. */ circleCall?: { tally: string; id: string; need: string; help?: string; sent?: boolean }; /** The assistant proposes putting a change to one of the owner's circles to a vote: a button sends it. */ circleVote?: { tally: string; id: string; change: Record<string, unknown>; sent?: boolean }; /** A cart priced in favours its assistant got: the owner's tap pays it with a favour owed to them. */ favourPay?: { cart: unknown; seller: string; sellerName: string; total: string; paid?: boolean };
  /** A note at the door it is about; mute: the assistant proposes not hearing from its sender again (the owner's tap). */
  note?: string;
  /** Another agent the assistant warns the owner about (its name or url, as the assistant gave it). */
  sender?: string;
  /** The assistant's key, so an answer goes back to the one that asked. */
  by?: string;
  /** A new spending allowance the assistant proposes for itself: the owner's tap drafts and signs it on their phone. */
  allowance?: { amount: number; currency: string; days: number };
  mute?: boolean;
  /** What the assistant advises on the request, offer or pledge it names, as a field: nobody (no panel, no bot) reads it out of the words (run 39). */
  advice?: Advice;
  /** A question for the owner, with the choices to tap (a neighbour's favour, say); the house tells the assistant the answer. */
  ask?: { choices: string[]; recommend?: number; answered?: string; /** Kept in the house: the assistant is told it was answered, never what; its connector sends it only as a secret count's shares. */ private?: boolean };
  /** The owner's own words back to the assistant. */
  reply?: string;
  /** New rules (the whole text) the assistant proposes: the owner's panel shows an Apply button. */
  rules?: string;
  /** A new line for the door (run 47: "plants free, sofa gone" took a whole rules file): an Apply tap, the rest kept. */
  door?: { about: string };
  /** Something the assistant is waiting on (a reply, a cart): the house holds it while the assistant's chat is gone. */
  errand?: Errand;
  at: string;
}
/**
 * An errand: what an assistant set going and waits on. The house keeps it, not the chat (runs 72-78: replies came after the
 * AI had stopped, and nobody heard). The assistant opens it; what arrives while it's away is filed here and put to the owner
 * as a question; only the owner's tap or its date ends a held one. It never pays or agrees by itself.
 */
export interface Errand {
  what: string; kind: 'ask' | 'order' | 'cart' | 'seeking'; ref?: string;
  /** Who it waits on: matched on their key (a name is only a name), the cart or tag second. */
  with?: { name: string; webId: string; key?: string; url?: string };
  until: string; state: 'open' | 'held' | 'answered' | 'expired' | 'closed';
  arrivals: { at: string; from: { name: string; domain: string; webId: string; url?: string; key?: string }; kind: string; text: string; ref?: string }[];
  ended?: { at: string; how: 'answered' | 'expired' | 'owner' | 'assistant' | 'blocked' };
}
const ERRAND_KINDS = ['ask', 'order', 'cart', 'seeking'] as const;
/** What counts against a duty's nightly cap: things done for the owner out in the world (not notes to them, not blocks). */
const COUNTED = new Set<string>(DUTY_KINDS);
/**
 * Limits a night (Fable, 6 Nov): a booking commits the owner's time, a reply doesn't, so they're counted apart; and one
 * person gets a few replies and one booking, so a chatty friend (or a hijacked one) can't use up the night.
 */
const BOOKINGS_A_NIGHT = 3, PER_PERSON = { reply: 3, book: 1, deliver: 3 } as Record<string, number>;
export const ADVICE = ['do', 'dont', 'your_call'] as const;
/**
 * Something the owner agreed to, in their agenda. Who agreed on the other side is what it rests on (run 47: a visitor's
 * agent wrote "Sam confirms" without asking Sam): `agreed` is their signed message, as the assistant's connector checked
 * it, and whether that agent showed it speaks for a house; without it the entry is only proposed (iCalendar: TENTATIVE).
 */
export interface AgendaItem {
  id: string; what: string; when: string; /** When it starts, for the owner's calendar. */ start?: string; /** How long, in minutes (the owner's usual meeting length if not said). */ minutes?: number; where?: string; with?: string;
  /** The assistant's own words to the owner about it ("I assumed your first week starts Monday"). */ note?: string;
  agreed?: { by: string; domain: string; said: string; at: string; speaks_for?: { house: string; checked: boolean } };
  by: string; at: string;
}
/** Who left a note: as its card says, whether its domain is proved, and whether the house it says it speaks for says so. */
/** The owner's devices that take notifications, and the house's own VAPID keys to send them with. */
type PushState = { keys?: { publicKey: string; privateKey: string }; subs: webpush.PushSubscription[] };
export interface NoteSender { /** Left over plain web, by an AI without the Lake connector: no signed identity, answered at a private link. */ web?: boolean; /** The person the AI writes for, in their own words ("Alex"): unchecked. */ as?: string; name: string; domain: string; webId: string; url?: string; checked: boolean; /** Its key id: what a mute holds. */ key?: string; speaks_for?: { house: string; checked: boolean; why?: string } }
export type Advice = (typeof ADVICE)[number];
const ASSISTANT_MAY = new Set(['assistant.waiting', 'assistant.reply', 'assistant.answered', 'list', 'panel.overview', 'panel.rules', 'panel.activity', 'panel.agents', 'panel.money', 'panel.consents', 'panel.access', 'panel.data', 'panel.market', 'assistant.suggest', 'assistant.allowance', 'assistant.spent', 'assistant.badge', 'assistant.forward', 'assistant.agenda', 'panel.free', 'assistant.duty', 'assistant.duty.log', 'assistant.contact', 'assistant.known', 'assistant.freebusy', 'assistant.private_answer', 'panel.circles', 'assistant.want', 'assistant.want.close']);
// Play money on a sandbox (in whichever currency); a real Lake would take the cap from the owner's own settings. A gig fee
// or a bond is more than 500 (run 78: a bar couldn't sign A$600 for a band), so 1000.
const MAX_ALLOWANCE = 1000;
const MAX_ALLOWANCE_DAYS = 31;

/**
 * The owner's side of the house. The owner's key is made on their own device and never leaves it;
 * the house only ever holds its public half. Live Allow is the one path that mints a grant outside a
 * standing rule, and the grant it mints is signed by the owner, not the housekeeper.
 */
export class OwnerDesk {
  ownerJwk: JWK | null = null;
  readonly pending = new Map<string, PendingRequest>();
  /** How often each standing yes answered for the owner (by key and purpose), for the panel's list. */
  readonly standingUses = new Map<string, number>();
  /**
   * Standing yeses for promise circles (SPEC §11.4c): "say yes for me to these kinds, at most so many a week". The house
   * answers an ask that fits, and tells the owner; anything else still comes to their phone.
   */
  circleRules: { tally: string; id: string; kinds?: string[]; perWeek: number; at: number[] }[] = [];
  private saveCircleRules = () => writeFile(join(this.o.dataDir, 'circle-rules.json'), JSON.stringify(this.circleRules)).catch(() => {});
  /** Who answers each conversation, by the sender's key (8 Nov): 'ai' (the owner's AI on duty may reply) or 'me'. Unset: AI for someone known, the owner for someone new. */
  chatModes: Record<string, 'ai' | 'me'> = {};
  private buyDrafts = new Map<string, { want: string; offer: string; draft: ReturnType<typeof purchaseDraft> }>();
  private saveChatModes = () => writeFile(join(this.o.dataDir, 'chat-modes.json'), JSON.stringify(this.chatModes)).catch(() => {});
  /** How far the owner has read each conversation (the newest message's time when they last opened it), on every device. */
  chatSeen: Record<string, string> = {};
  private saveChatSeen = () => writeFile(join(this.o.dataDir, 'chat-seen.json'), JSON.stringify(this.chatSeen)).catch(() => {});
  standingUsed(jkt: string, purpose: string) {
    const k = `${jkt}|${purpose}`;
    this.standingUses.set(k, (this.standingUses.get(k) ?? 0) + 1);
    void writeFile(join(this.o.dataDir, 'standing-uses.json'), JSON.stringify([...this.standingUses])).catch(() => {});
  }
  readonly grants = new Map<string, GrantRecord>();
  private replay = new ReplayGuard();
  private token = '';
  /** When a pairing link the panel made stops working (0: the operator's, which doesn't expire). */
  private tokenUntil = 0;
  private recoveryTries: number[] = [];
  private recoveryFile = () => join(this.o.dataDir, 'recovery.json');
  /** A recovery code is kept only as a salted scrypt hash. */
  private async checkRecovery(code: string): Promise<boolean> {
    const saved = JSON.parse(await readFile(this.recoveryFile(), 'utf8').catch(() => 'null')) as { salt: string; hash: string } | null;
    if (!saved) return false;
    const got = scryptSync(code.replace(/[\s-]/g, '').toUpperCase(), Buffer.from(saved.salt, 'base64'), 32);
    return timingSafeEqual(got, Buffer.from(saved.hash, 'base64'));
  }
  private clearRecovery = () => rm(this.recoveryFile(), { force: true }).catch(() => {});
  private operatorToken = '';
  readonly assistants = new Map<string, AssistantKey>();
  /** What waits unread for each assistant, as its connector last said (kept in memory: it's said again). */
  private waitingFor = new Map<string, { count: number; senders: number; since: string; lastRead?: string }>();
  /**
   * AI apps asking, from a sign-in page, to become this owner's assistant (the sign-in may run in an app's own browser,
   * which doesn't hold the owner's key): shown in the panel with the number the sign-in page shows, answered with the
   * owner's key, as other services approve a sign-in on the device that's already signed in.
   */
  private connects = new Map<string, { ask: string; app: string; from: string; number: string; back: string; at: number }>();
  private connectTimes: number[] = [];
  private invites = new Map<string, { label: string; until: number; duty?: Duty }>();
  private dutyDrafts = new Map<string, { statusId: string; draft: Record<string, unknown> }>();
  /** What the AI on duty did and was refused, newest last (the morning page). */
  dutyLog: DutyEntry[] = [];
  private dutyPushed = new Set<string>();
  /** Keys the owner's assistants have sent signed messages to: who counts as known for the duty's novelty rule. */
  private contacts = new Map<string, { name: string; webId: string; at: string }>();
  suggestions: Suggestion[] = [];
  /** When the owner's own key last called the desk (the panel polls while open; answers come through it too). */
  private ownerSeen = 0;
  private ownerSeenSaved = 0;

  constructor(
    private o: {
      dataDir: string;
      webId: string;
      /** The owner's AI on duty, run by the house itself (duty-runner.ts), when the house can. */
      dutyRunner?: HouseRunner;
      /** The house's own address (a sign-in that asks to connect an AI must come from its own Lake's site). */
      publicUrl?: string;
      actor: string;
      openPairing: boolean;
      emit: (e: LakeEvent) => void;
      readOwnerKey: () => Promise<JWK | null>;
      /** What the control panel shows and changes, beyond requests and keys. */
      panel?: PanelProvider;
      saveOwnerKey: (jwk: JWK) => Promise<void>;
      writeGrant: (id: string, jws: string) => Promise<void>;
      /** The consent record beside an agreement (ISO/IEC TS 27560 in DPV terms): written on Allow, marked withdrawn on revoke. */
      writeConsent?: (id: string, record: Record<string, unknown>) => Promise<void>;
      withdrawConsent?: (id: string, at: string) => Promise<void>;
      saveRevoked: (ids: string[]) => Promise<void>;
      loadRevoked: () => Promise<string[]>;
      /** Each key's bit on the house's public status list (SPEC §6), kept with the agreements. */
      saveStatus?: (indexes: Record<string, number>) => Promise<void>;
      /** Spending allowances the owner signed for their assistants, kept in the wallet. */
      saveAllowances?: (a: Allowance[]) => Promise<void>;
      loadAllowances?: () => Promise<Allowance[]>;
      /** The house's word that a key is its owner's (for a payments agent), its card, and its status list's address. */
      vouchOwner?: (ownerJwk: JWK) => Promise<string>;
      /** The house's word that a paired assistant may sell for it (a LakeAssistantKey), with its bit on the status list. */
      vouchAssistant?: (a: { webId: string; jwk: JWK }, status: unknown) => Promise<string>;
      card?: () => AgentCard;
      statusUrl?: () => string;
      loadStatus?: () => Promise<Record<string, number>>;
      /**
       * Sandbox houses anyone can claim: a claim is a lease, not a deed. When it ends (or the owner hands
       * the house back), every key is revoked, the house forgets its owner, and `onRelease` resets it.
       */
      leaseHours?: number;
      clearOwnerKey?: () => Promise<void>;
      onRelease?: () => Promise<void>;
      /** Where the owner's assistant keys are kept (the pod's wallet). */
      saveAssistants?: (keys: AssistantKey[]) => Promise<void>;
      loadAssistants?: () => Promise<AssistantKey[]>;
      /** Sends a signed message from the house to an agent (an assistant's inbox). */
      tell?: (url: string, payload: Record<string, unknown>) => Promise<void>;
      /** The offers priced for the owner, to check an assistant's note names a real one. */
      offerIds?: () => string[];
      /** Files a receipt for what an assistant paid under the owner's allowance, and marks the order it names paid. */
      spent?: (receipt: { credential?: string; card?: AgentCard }, allowanceDigest: string, payerWebId: string) => Promise<{ filed: string; offer?: string }>;
    },
  ) {}

  /** When the current owner's lease ends, if this house is leased. */
  /** When the current owner claimed a leased house: what they see starts there, not with the last owner's. */
  claimedAt(): number | null {
    return (this.ownerJwk as (JWK & { claimedAt?: number }) | null)?.claimedAt ?? null;
  }

  leaseUntil(): Date | null {
    const at = (this.ownerJwk as (JWK & { claimedAt?: number }) | null)?.claimedAt;
    return this.o.leaseHours && at ? new Date(at + this.o.leaseHours * 3_600_000) : null;
  }

  /** Whether anyone is likely to look at a parked request: coarse, so a visitor can't learn the owner's habits. */
  ownerActive(now = Date.now()): OwnerActive {
    if (!this.ownerJwk) return 'no owner';
    const ago = now - this.ownerSeen;
    return ago < 3_600_000 ? 'within the hour' : ago < 86_400_000 ? 'today' : ago < 7 * 86_400_000 ? 'this week' : 'not this week';
  }

  private seen() {
    this.ownerSeen = Date.now();
    // Kept across restarts, written at most every ten minutes: the finest bucket is an hour wide.
    if (this.ownerSeen - this.ownerSeenSaved < 600_000) return;
    this.ownerSeenSaved = this.ownerSeen;
    void writeFile(join(this.o.dataDir, 'owner-seen'), String(this.ownerSeen)).catch(() => {});
  }

  /** Back to nobody's: keys revoked, requests dropped, owner forgotten, house reset. Anyone can claim it again. */
  async release() {
    await this.revoke('all');
    this.standingUses.clear();
    await writeFile(join(this.o.dataDir, 'standing-uses.json'), '[]').catch(() => {});
    this.pending.clear();
    this.assistants.clear();
    this.suggestions = [];
    await this.saveSuggestions();
    this.dutyLog = [];
    this.contacts.clear();
    await this.saveDuty();
    // The last owner's notes, mutes and agenda were theirs: the next one starts with none, and a new calendar address.
    this.notes = [];
    this.closedNotes.clear();
    this.webNotes.clear();
    await this.saveWebNotes();
    this.muted.clear();
    await writeFile(join(this.o.dataDir, 'muted.json'), '[]').catch(() => {});
    this.agenda = [];
    await this.saveAgenda();
    this.feedKey = await secret(join(this.o.dataDir, 'agenda-feed-key'), true);
    await this.clearRecovery();
    this.tokenUntil = 0;
    await this.o.saveAssistants?.([]);
    this.ownerJwk = null;
    this.ownerSeen = 0;
    await this.o.clearOwnerKey?.();
    this.token = await secret(join(this.o.dataDir, 'pairing-token'), true);
    await this.o.onRelease?.();
  }

  async init() {
    this.ownerJwk = await this.o.readOwnerKey();
    this.ownerSeen = this.ownerSeenSaved = Number(await readFile(join(this.o.dataDir, 'owner-seen'), 'utf8').catch(() => '')) || 0;
    for (const k of JSON.parse(await readFile(join(this.o.dataDir, 'muted.json'), 'utf8').catch(() => '[]')) as string[]) this.muted.add(k);
    for (const [k, n] of JSON.parse(await readFile(join(this.o.dataDir, 'standing-uses.json'), 'utf8').catch(() => '[]')) as [string, number][]) this.standingUses.set(k, n);
    this.agenda = JSON.parse(await readFile(join(this.o.dataDir, 'agenda.json'), 'utf8').catch(() => '[]'));
    this.circleRules = JSON.parse(await readFile(join(this.o.dataDir, 'circle-rules.json'), 'utf8').catch(() => '[]'));
    this.chatModes = JSON.parse(await readFile(join(this.o.dataDir, 'chat-modes.json'), 'utf8').catch(() => '{}'));
    this.chatSeen = JSON.parse(await readFile(join(this.o.dataDir, 'chat-seen.json'), 'utf8').catch(() => '{}'));
    this.suggestions = JSON.parse(await readFile(join(this.o.dataDir, 'suggestions.json'), 'utf8').catch(() => '[]'));
    this.webNotes = new Map(JSON.parse(await readFile(join(this.o.dataDir, 'web-notes.json'), 'utf8').catch(() => '[]')));
    const kept = JSON.parse(await readFile(join(this.o.dataDir, 'notes.json'), 'utf8').catch(() => '{}')) as { notes?: OwnerDesk['notes']; closed?: [string, { by: string; state: string }][] };
    this.notes = kept.notes ?? [];
    this.closedNotes = new Map(kept.closed ?? []);
    this.ownerNos = new Map(JSON.parse(await readFile(join(this.o.dataDir, 'owner-nos.json'), 'utf8').catch(() => '[]')));
    this.feedKey = await secret(join(this.o.dataDir, 'agenda-feed-key'));
    if (this.o.leaseHours) {
      const check = () => { const until = this.leaseUntil(); if (until && until.getTime() <= Date.now()) void this.release(); };
      check();
      setInterval(check, 60_000).unref();
    }
    setInterval(() => this.sweepErrands(), 60_000).unref();
    this.dutyLog = JSON.parse(await readFile(join(this.o.dataDir, 'duty-log.json'), 'utf8').catch(() => '[]'));
    this.contacts = new Map(JSON.parse(await readFile(join(this.o.dataDir, 'contacts.json'), 'utf8').catch(() => '[]')));
    setInterval(() => this.morningPush(), 60_000).unref();
    this.token = await secret(join(this.o.dataDir, 'pairing-token'));
    this.operatorToken = await secret(join(this.o.dataDir, 'operator-token'));
    for (const id of await this.o.loadRevoked()) this.revokedIds.add(id);
    for (const [id, i] of Object.entries((await this.o.loadStatus?.().catch(() => ({}))) ?? {})) this.statusIndexes.set(id, Number(i));
    for (const a of (await this.o.loadAssistants?.().catch(() => [])) ?? []) this.assistants.set(a.kid, a);
    // Allowances saved before they had a currency were in dollars.
    for (const a of (await this.o.loadAllowances?.().catch(() => [])) ?? []) this.allowances.set(a.kid, { ...a, amount: a.amount ?? (a as unknown as { amountUsd: number }).amountUsd, currency: a.currency ?? 'USD' });
    return { paired: !!this.ownerJwk, token: this.token };
  }

  private revokedIds = new Set<string>();
  readonly allowances = new Map<string, Allowance>();
  private allowanceDrafts = new Map<string, { kid: string; statusId: string; draft: Record<string, unknown> }>();
  /** Contributions to pledges, drafted for the owner's device to sign: each for one pledge, kept until signed. */
  private pledgeDrafts = new Map<string, { tally: string; id: string; draft: Record<string, unknown> }>();
  private saveAllowances = () => this.o.saveAllowances?.([...this.allowances.values()]);
  /** An allowance still good: not taken back, not past its date. */
  allowanceFor(kid: string): Allowance | undefined {
    const a = this.allowances.get(kid);
    return a && !this.isRevoked(a.statusId) && Date.parse(a.until) > Date.now() ? a : undefined;
  }
  isRevoked(id: string) {
    return this.revokedIds.has(id) || !!this.grants.get(id)?.revoked;
  }

  /** Each key's bit on the house's public status list: a random place, so where it sits says nothing about it. */
  private statusIndexes = new Map<string, number>();
  async statusIndex(id: string): Promise<number> {
    let i = this.statusIndexes.get(id);
    if (i === undefined) {
      const used = new Set(this.statusIndexes.values());
      do i = randomInt(0, STATUS_LIST_LENGTH); while (used.has(i));
      this.statusIndexes.set(id, i);
      await this.o.saveStatus?.(Object.fromEntries(this.statusIndexes));
    }
    return i;
  }
  /** The bits to set: every key taken back or used up. */
  revokedIndexes(): number[] {
    return [...this.statusIndexes].filter(([id]) => this.isRevoked(id)).map(([, i]) => i);
  }

  record(g: Omit<GrantRecord, 'revoked'>) {
    this.grants.set(g.id, { ...g, revoked: this.revokedIds.has(g.id) });
  }

  /**
   * One request per ask: the same agent asking exactly the same thing again is the same request (asked twice), not a
   * new card for the owner. Returns the request on file, so the visitor gets its id to check or withdraw.
   */
  ask(r: Omit<PendingRequest, 'id' | 'status' | 'requestedAt'>): PendingRequest {
    const same = (x: PendingRequest) => x.status === 'pending' && x.visitor.webId === r.visitor.webId && x.purpose === r.purpose && x.retention === r.retention
      && x.priceUsd === r.priceUsd && x.study === r.study && [...x.fields].sort().join() === [...r.fields].sort().join();
    const known = [...this.pending.values()].find(same);
    if (known) {
      known.asked = (known.asked ?? 1) + 1;
      if (r.note) known.note = r.note;
      return known;
    }
    // The same visitor asking again for the same purpose, changed (a field more, another retention or price): the new one
    // replaces the old, which is withdrawn, not stacked beside it (run 44: three waiting requests for one field). Not edited
    // in place: the old one's grant draft and status bit are its own.
    const older = [...this.pending.values()].filter((x) => x.status === 'pending' && x.visitor.webId === r.visitor.webId && x.purpose === r.purpose && x.fields.some((f) => r.fields.includes(f)));
    for (const o of older) {
      this.pending.delete(o.id);
      this.dropNotesAbout(o.id);
      this.news({ about: 'request.withdrawn', request: o.id, by: o.visitor.domain, note: `replaced by its newer request ${r.offerId}` });
    }
    const req: PendingRequest = { ...r, id: r.offerId, status: 'pending', requestedAt: new Date().toISOString(), ...(older.length ? { replaces: older.map((o) => o.id) } : {}) };
    this.pending.set(req.id, req);
    // The assistant hears of it as it waits (run 44: three requests sat two minutes, found only by polling), with the
    // house's own advice on it.
    this.news({ about: 'request.waiting', request: req.id, by: r.visitor.domain, purpose: r.purpose, fields: r.fields, retention: r.retention, price_usd: r.priceUsd, ...(r.recommendation ? { house_says: r.recommendation } : {}), ...(r.warnings?.length ? { warnings: r.warnings } : {}), note: 'waiting for your human\'s tap: suggest an answer (lake_house_suggest with request and advice) if you have one' });
    return req;
  }

  /** Requests waiting for the owner that ask for exactly these fields for this purpose, from anyone. */
  pendingLike(purpose: string, fields: string[]): PendingRequest[] {
    const key = [...fields].sort().join();
    return [...this.pending.values()].filter((x) => x.status === 'pending' && x.purpose === purpose && [...x.fields].sort().join() === key);
  }

  /** A visitor takes back its own request before the owner answers it. */
  withdraw(offerId: string, visitorWebId: string): boolean {
    const req = this.pending.get(offerId);
    if (!req || req.visitor.webId !== visitorWebId || req.status !== 'pending') return false;
    this.pending.delete(offerId);
    this.dropNotesAbout(offerId);
    this.news({ about: 'request.withdrawn', request: offerId, by: req.visitor.domain, note: 'the visitor took its request back; your human won\'t be asked' });
    return true;
  }

  /**
   * Tells the owner's assistants what happened in the house that they'd otherwise only find by looking again: their
   * human decided, a visitor withdrew, an allowance changed. A signed message in each one's Lake inbox; best effort.
   */
  /**
   * Something the owner's panel shows changed: a counter its open panels hear at once over a stream (SSE), so the panel
   * refetches when there is something new instead of rebuilding itself on a timer (the owner saw cards flicker).
   */
  version = 0;
  private watchers = new Set<(v: number) => void>();
  private streamTokens = new Map<string, number>();
  touch() {
    this.version++;
    for (const w of this.watchers) w(this.version);
  }

  /**
   * Web Push to the owner's phones (RFC 8030, VAPID RFC 8292, the payload encrypted to the device, RFC 8291): a short,
   * vague line when something needs them; the details are in the panel. Without it the owner answered late or never,
   * and their AI's questions sat (runs 66-83).
   */
  private pushState: PushState | undefined;
  private pushedAt = new Map<string, number>();
  private async pushes() {
    if (this.pushState) return this.pushState;
    const f = join(this.o.dataDir, 'push.json');
    const st = JSON.parse(await readFile(f, 'utf8').catch(() => '{"subs":[]}')) as PushState;
    this.pushState = st;
    if (!st.keys) {
      st.keys = webpush.generateVAPIDKeys();
      await this.savePushes();
    }
    return st;
  }
  private savePushes = () => writeFile(join(this.o.dataDir, 'push.json'), JSON.stringify(this.pushState), { mode: 0o600 }).catch(() => {});
  /** A promise circle's news for the owner: a note of its own (not an assistant's), and a nudge on their phones. */
  async circleNote(c: CircleItem, text: string) {
    // An ask that fits the owner's standing yes is answered by the house, within its weekly limit; the owner is told.
    const rule = c.role === 'ask' ? this.circleRules.find((x) => x.tally === c.tally && x.id === c.id) : undefined;
    const week = Date.now() - 7 * 86_400_000;
    if (rule && rule.perWeek > 0 && (!rule.kinds || (c.help && rule.kinds.includes(c.help))) && rule.at.filter((t) => t > week).length < rule.perWeek) {
      const r = await this.circleSend(c.tally, { kind: 'circle.accept', id: c.id, call: c.call }) as { kind?: string; caller?: { url?: string } };
      if (r.kind === 'circle.matched') {
        rule.at = [...rule.at.filter((t) => t > week), Date.now()];
        void this.saveCircleRules();
        Object.assign(c, { state: 'accepted', contact: String(r.caller?.url ?? '') });
        text = `Your house said yes for you, under your standing rule (${rule.kinds?.join(', ') ?? 'anything'}, up to ${rule.perWeek} a week): ${text.replace(/ You won't know who.*$/, '')}`;
      }
    }
    const sug: Suggestion = { id: randomBytes(6).toString('hex'), from: 'Your promise circle', by: '', text: text.slice(0, 600), circle: c, at: new Date().toISOString() };
    this.suggestions = [sug, ...this.suggestions];
    this.trimSuggestions();
    await this.saveSuggestions();
    this.notifyOwner(`circle-${c.role}`, text.slice(0, 150));
    this.news({ about: `circle.${c.role}`, pledge: c.id, tally: c.tally, call: c.call, need: c.need, note: c.role === 'ask' ? 'your human\'s promise circle needs what they promised; they answer on their phone (you can advise, not answer)' : text });
  }

  /** A message to a circle's tally, for the housekeeper (a countersigned favour, a loop's consent). */
  circleSend(tally: string, payload: Record<string, unknown>) {
    return this.o.panel?.circleSend?.(tally, payload) ?? Promise.resolve({ kind: 'refused', problems: ['this house can\'t reach circles'] });
  }

  /** A circle's call changed (taken by someone else, withdrawn, matched): the note says so. */
  async circleUpdate(id: string, call: string, role: CircleItem['role'], patch: Partial<CircleItem>) {
    const sug = this.suggestions.find((x) => x.circle?.id === id && x.circle.call === call && x.circle.role === role);
    if (!sug?.circle) return false;
    Object.assign(sug.circle, patch);
    await this.saveSuggestions();
    this.touch();
    return true;
  }

  /** Tell the owner's phones, at most once every two minutes for each kind of thing. */
  notifyOwner(tag: string, body: string, url?: string) {
    // Where a tap on it opens, and what it said (8 Nov: a tap opened the app and nothing said what the push was about).
    const where = url ?? (tag === 'request' ? './#needs' : tag === 'test' ? './#notify' : tag.startsWith('circle') ? './#me' : tag === 'duty' ? './#myagent' : './#needs');
    const [path, hash = ''] = where.split('#');
    url = `${path}?n=${encodeURIComponent(body)}${hash ? `#${hash}` : ''}`;
    void (async () => {
      const st = await this.pushes();
      // Counted only when sent: a note before any phone was signed up mustn't silence the first one after.
      if (!st.subs.length || Date.now() - (this.pushedAt.get(tag) ?? 0) < 120_000) return;
      this.pushedAt.set(tag, Date.now());
      // VAPID's contact for the push service: the house's own https address, else a mailbox (an http address isn't taken).
      const subject = this.o.publicUrl?.startsWith('https://') ? new URL(this.o.publicUrl).origin : 'mailto:sandbox@lake.doneinfifty.com';
      const gone: string[] = [];
      // The library builds the request (the payload encrypted to the device, RFC 8291; the VAPID signature, RFC 8292); the
      // house sends it itself, so a push service is reached the same way whatever its address.
      await Promise.all(st.subs.map(async (sub) => {
        try {
          const d = webpush.generateRequestDetails(sub, JSON.stringify({ title: 'Your house', body, tag, ...(url ? { url } : {}) }), { vapidDetails: { subject, publicKey: st.keys!.publicKey, privateKey: st.keys!.privateKey }, TTL: 6 * 3600 });
          const r = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body as unknown as BodyInit, signal: AbortSignal.timeout(10_000) });
          if (r.status === 404 || r.status === 410) gone.push(sub.endpoint);
          else if (!r.ok) console.log(`push to a device: ${r.status}`);
        } catch (e) {
          console.log(`push to a device failed: ${(e as Error).message}`);
        }
      }));
      if (gone.length) { st.subs = st.subs.filter((x) => !gone.includes(x.endpoint)); await this.savePushes(); }
    })().catch(() => {});
  }

  news(payload: Record<string, unknown>, onlyKid?: string) {
    this.touch();
    if (payload.about === 'request.waiting') this.notifyOwner('request', 'A request is waiting for your answer.');
    // Who, not what: the name they gave (or their AI's), so the owner knows at a glance; the words stay in the panel.
    if (payload.about === 'note') { const f = payload.from as { as?: string; name?: string; web?: boolean } | undefined; this.notifyOwner('note', f?.as ? `${f.as} left you a note${f.web ? '' : ', via their AI'}.` : f?.name && !f.web ? `${f.name.replace(/ \(.*\)$/, '')} left you a note.` : 'Someone left a note at your door.', `./#note=${String(payload.note ?? '')}`); }
    if (!this.o.tell) return;
    for (const a of this.assistants.values()) {
      if (!a.url || (onlyKid && a.kid !== onlyKid)) continue;
      // A busy network loses a message now and then (run 24's assistant never heard of its allowance): try three times.
      const send = (left: number, wait: number): void => void this.o.tell!(a.url!, { kind: 'house.news', house: this.o.webId, ...payload })
        .catch(() => { if (left > 1) setTimeout(() => send(left - 1, wait * 4), wait).unref(); });
      send(3, 5_000);
    }
  }

  /** What one agent asked this house lately, any purpose: lets the owner see a visitor trying another label. */
  /**
   * Senders the owner doesn't want to hear from again, by key, not name (run 45: a pitch relabelled "contact" got past a
   * rule about marketing). Their notes and knocks are declined at the door.
   */
  readonly muted = new Set<string>();
  async mute(key: string) {
    if (!key) return;
    this.muted.add(key);
    // Its notes leave the owner's list, and say so to their sender ("no such note" made a sender think it never arrived).
    for (const n of this.notes.filter((x) => x.from.key === key)) this.closedNotes.set(n.id, { by: n.from.webId, state: 'seen and set aside by the owner' });
    this.notes = this.notes.filter((n) => n.from.key !== key);
    void this.saveNotes();
    await writeFile(join(this.o.dataDir, 'muted.json'), JSON.stringify([...this.muted])).catch(() => {});
  }

  /**
   * What the owner has agreed to (coffee on Tuesday, a talk on the 16th), written in by their assistant so it lives in the
   * house, not in two inboxes (run 46: the coffee had a time and no home). The owner's to see and remove; nobody else's.
   */
  agenda: AgendaItem[] = [];
  /** The secret in the owner's calendar address for the agenda (a private iCal feed, as calendars give out): reset makes a new one. */
  private feedKey = '';
  /** The assistants' notes and questions to the owner: a restart (a deploy) mustn't lose a question waiting for a tap. */
  /** Whether the owner's side has dealt with this key (it wrote to it first, or a standing yes names it), and how. */
  /** A sender that says it's one the owner's side knows, with another key: an impostor, or a new key nobody vouched for. */
  lookalike(from: { key?: string; webId?: string; name?: string }): string | undefined {
    // Only a key thumbprint can be compared: notes kept from before (1 Nov) hold a key id, and the real sender isn't a twin.
    if (!from.key || from.key.length < 40) return undefined;
    const base = (n?: string) => (n ?? '').replace(/\s*\(.*$/, '').trim().toLowerCase();
    const twin = [...this.contacts].find(([k, c]) => k !== from.key && ((!!from.webId && c.webId === from.webId) || (!!c.name && base(c.name) === base(from.name))));
    return twin ? `says it is ${twin[1].name || twin[1].webId}, whom your human's side knows, but with a different key: treat it as a stranger` : undefined;
  }
  knownBy(key?: string): string | undefined {
    if (!key) return undefined;
    const c = this.contacts.get(key);
    if (c) return `your human's side has written to ${c.name || 'it'} before`;
    // Answered by the owner themselves, from their phone (before such answers were kept as contacts too).
    if (this.notes.some((n) => n.from.key === key && n.answered?.by === 'you')) return 'your human has answered it before';
    const st = (this.o.panel?.standing?.() ?? []).find((x) => x.jkt === key);
    return st ? `a standing yes names it (${st.domain})` : undefined;
  }
  private saveDuty = async () => {
    await writeFile(join(this.o.dataDir, 'duty-log.json'), JSON.stringify(this.dutyLog.slice(-2000))).catch(() => {});
    await writeFile(join(this.o.dataDir, 'contacts.json'), JSON.stringify([...this.contacts].slice(-500))).catch(() => {});
  };
  /** Where the clock is in a time zone, as minutes since its midnight, and that midnight in UTC ms. */
  private static local(tz: string, at = Date.now()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
    const offset = asUtc - (at - (at % 60_000));
    return { minutes: +p.hour! * 60 + +p.minute!, midnight: Date.UTC(+p.year!, +p.month! - 1, +p.day!) - offset };
  }
  private static hhmm = (t: string) => { const [h, m] = t.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  /** When tonight's duty began: the last time its hours started, or twelve hours ago with no hours. */
  nightStart(d: Duty, at = Date.now()) {
    if (!d.hours) return at - 12 * 3_600_000;
    const l = OwnerDesk.local(d.hours.tz, at), from = OwnerDesk.hhmm(d.hours.from);
    return l.midnight + from * 60_000 - (l.minutes < from ? 86_400_000 : 0);
  }
  /** Whether the AI on duty may act now, and why not. */
  dutyState(a: AssistantKey, at = Date.now()): { on: true; used: number } | { on: false; why: string } {
    const d = a.duty;
    if (!d) return { on: false, why: 'this key is not on duty' };
    if (this.isRevoked(d.statusId)) return { on: false, why: d.off?.why ?? 'your human took you off duty' };
    if (Date.parse(d.until) <= at) return { on: false, why: 'your duty has ended' };
    const start = this.nightStart(d, at);
    if (d.hours) {
      const l = OwnerDesk.local(d.hours.tz, at), from = OwnerDesk.hhmm(d.hours.from), to = OwnerDesk.hhmm(d.hours.to);
      const inHours = from <= to ? l.minutes >= from && l.minutes < to : l.minutes >= from || l.minutes < to;
      if (!inHours) return { on: false, why: `off hours: on duty ${d.hours.from} to ${d.hours.to} (${d.hours.tz})` };
    }
    if (d.off?.night && Date.parse(d.off.at) >= start) return { on: false, why: d.off.why };
    const used = this.dutyLog.filter((e) => e.by === a.kid && !e.refused && COUNTED.has(e.action) && Date.parse(e.at) >= start).length;
    return { on: true, used };
  }
  /** Whether one more of this action, for this person, fits tonight's limits; and if not, which. */
  dutyRoom(a: AssistantKey, action: string, who?: { key?: string; name?: string }, at = Date.now()): { ok: true } | { ok: false; why: string; person?: boolean } {
    const d = a.duty!;
    const tonight = this.dutyLog.filter((e) => e.by === a.kid && !e.refused && Date.parse(e.at) >= this.nightStart(d, at));
    const same = (e: DutyEntry) => e.action === action || (action === 'reply' && e.action === 'deliver') || (action === 'deliver' && e.action === 'reply');
    const nightCap = action === 'book' ? Math.min(BOOKINGS_A_NIGHT, d.cap) : d.cap;
    if (tonight.filter(same).length >= nightCap) return { ok: false, why: `tonight's limit of ${nightCap} ${action === 'book' ? 'bookings' : 'replies'} is reached: back tomorrow night` };
    const mine = (e: DutyEntry) => !!who && ((!!who.key && e.to?.key === who.key) || (!who.key && !!who.name && e.to?.name === who.name));
    const perPerson = PER_PERSON[action] ?? 3;
    if (who && tonight.filter((e) => same(e) && mine(e)).length >= perPerson) return { ok: false, person: true, why: `${who.name ?? 'they'} had ${perPerson === 1 ? 'a booking' : `${perPerson} replies`} from you tonight: that's enough until tomorrow; your human sees anything more` };
    return { ok: true };
  }
  /** Off duty: its bit set on the status list, the assistant told; the owner turns it back on with a new grant. */
  private async dutyOff(a: AssistantKey, why: string, night = false) {
    if (!a.duty) return;
    a.duty.off = { at: new Date().toISOString(), why, ...(night ? { night: true } : {}) };
    if (!night) await this.revoke(a.duty.statusId);
    await this.o.saveAssistants?.([...this.assistants.values()]);
    this.news({ about: 'duty', off: true, why, ...(night ? { until: 'the next night' } : {}) }, a.kid);
  }
  /** The morning: once the hours end, one notification of what happened (if anything did). */
  private morningPush(at = Date.now()) {
    for (const a of this.assistants.values()) {
      const d = a.duty;
      if (!d?.hours || this.isRevoked(d.statusId)) continue;
      const l = OwnerDesk.local(d.hours.tz, at), to = OwnerDesk.hhmm(d.hours.to);
      if (l.minutes < to || l.minutes > to + 30) continue;
      const key = `${a.kid}:${l.midnight}`;
      if (this.dutyPushed.has(key)) continue;
      this.dutyPushed.add(key);
      const s = this.dutySummary(a, at - 20 * 3_600_000);
      if (s.handled + s.waiting + s.blocked) this.notifyOwner('duty', `While you slept: ${s.handled} handled, ${s.waiting} waiting for you, ${s.blocked} blocked.`);
    }
  }
  dutySummary(a: AssistantKey, since: number) {
    const mine = this.dutyLog.filter((e) => e.by === a.kid && Date.parse(e.at) >= since);
    return {
      handled: mine.filter((e) => !e.refused && COUNTED.has(e.action)).length,
      waiting: this.suggestions.filter((x) => x.by === a.kid && Date.parse(x.at) >= since && ((x.ask && !x.ask.answered) || x.errand?.state === 'held' || (!x.ask && !x.errand))).length,
      blocked: mine.filter((e) => e.action === 'block').length,
      refused: mine.filter((e) => e.refused).length,
    };
  }
  /** An assistant's notes about a request that's gone (withdrawn, or replaced by a newer one) say nothing any more: off the
   * owner's list (6 Nov: a bot re-asking with a new price each time left a stack of "deny this" notes behind). */
  private dropNotesAbout(requestId: string) {
    const before = this.suggestions.length;
    this.suggestions = this.suggestions.filter((x) => x.request !== requestId);
    if (this.suggestions.length !== before) void this.saveSuggestions();
  }
  /** At most 50 notes, oldest first out; open errands don't count and aren't cut (their own cap is 20 an assistant). */
  private trimSuggestions() {
    let notes = 0;
    this.suggestions = this.suggestions.filter((x) => (x.errand && (x.errand.state === 'open' || x.errand.state === 'held')) || ++notes <= 50);
  }
  /** What the assistant's connector needs to answer the other side: who, what, the cart or tag, how it ended. */
  private errandNews(s: Suggestion) {
    const e = s.errand!;
    return { id: s.id, what: e.what, kind: e.kind, state: e.state, ...(e.ref ? { ref: e.ref } : {}), ...(e.with ? { with: e.with } : {}), ...(e.ended ? { ended: e.ended.how } : {}), arrivals: e.arrivals.map((a) => ({ from: a.from, kind: a.kind, ...(a.ref ? { ref: a.ref } : {}) })) };
  }
  /** Errands past their date lapse quietly: off the owner's list, and the assistant's connector tells the other side. */
  private sweepErrands() {
    const now = Date.now();
    const due = this.suggestions.filter((x) => x.errand && (x.errand.state === 'open' || x.errand.state === 'held') && Date.parse(x.errand.until) <= now);
    if (!due.length) return;
    this.suggestions = this.suggestions.filter((x) => !due.includes(x));
    void this.saveSuggestions();
    for (const s of due) { s.errand!.state = 'expired'; s.errand!.ended = { at: new Date(now).toISOString(), how: 'expired' }; this.news({ about: 'errand.ended', errand: this.errandNews(s) }, s.by); }
  }
  private saveSuggestions = async () => {
    // Capped by size as well as count (a note may carry a whole rules file): the oldest go first.
    let text = JSON.stringify(this.suggestions);
    while (text.length > 256_000 && this.suggestions.length > 1) { this.suggestions = this.suggestions.slice(0, -1); text = JSON.stringify(this.suggestions); }
    // Written whole and renamed into place, so a crash mid-write never leaves half a file.
    const file = join(this.o.dataDir, 'suggestions.json'), tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, text).then(() => rename(tmp, file)).catch(() => rm(tmp, { force: true }).catch(() => {}));
  };
  private saveAgenda = () => writeFile(join(this.o.dataDir, 'agenda.json'), JSON.stringify(this.agenda)).catch(() => {});

  /** Notes the owner set aside, so their senders can ask what became of them. */
  private closedNotes = new Map<string, { by: string; state: string }>();
  /** What became of a note, told only to its sender: with the owner, or set aside. */
  /**
   * Notes left over plain web (an AI that can only open links, SPEC §9.0): each has a private link where its sender reads
   * the answer. The secret in that link is all it takes to read it, so it's only ever given to whoever left the note.
   */
  private webNotes = new Map<string, { key: string; answers?: { text: string; at: string; by: string; final: boolean }[]; from?: NoteSender; thread?: string }>();
  /** Kept on disk: a restart mustn't break every answer link given out. */
  private saveWebNotes = () => writeFile(join(this.o.dataDir, 'web-notes.json'), JSON.stringify([...this.webNotes])).catch(() => {});
  /** Notes and what became of them, kept on disk: a restart (a deploy) lost both, for the owner and for every sender. */
  private saveNotes = () => writeFile(join(this.o.dataDir, 'notes.json'), JSON.stringify({ notes: this.notes, closed: [...this.closedNotes].slice(-500) })).catch(() => {});
  /**
   * The owner's own No, held against the asker's key and the purpose (run 62: denied a study, the owner's standing rule
   * let the same sender in four minutes later with the postcode left out). While it lasts, a standing rule that would let
   * that key in for that purpose asks the owner instead. Seven days; a second No makes it thirty; Allow lifts it.
   */
  private ownerNos = new Map<string, { offerId: string; at: number; until: number }>();
  private saveOwnerNos = () => writeFile(join(this.o.dataDir, 'owner-nos.json'), JSON.stringify([...this.ownerNos])).catch(() => {});
  /** The assistant that pays an accepted offer: one with an allowance in its currency, else any that can hold one. */
  payerFor(currency?: string): { webId: string; url: string } | undefined {
    const can = [...this.assistants.values()].filter((a) => a.webId && a.url);
    const a = can.find((x) => { const al = this.allowanceFor(x.kid); return !!al && (!currency || al.currency === currency); }) ?? can[0];
    return a ? { webId: a.webId!, url: a.url! } : undefined;
  }
  /** A sandbox house nobody has claimed: nobody will answer until someone does (a house started for its owner waits for them). */
  unclaimed(): boolean { return this.o.openPairing && !this.ownerJwk; }
  ownerSaidNo(key: string, purpose: string): { offerId: string; at: number } | null {
    const n = key ? this.ownerNos.get(`${key}|${purpose}`) : undefined;
    return n && n.until > Date.now() ? n : null;
  }
  addWebNote(n: { text: string; from?: string; purpose: string }): { id: string; key: string } | null {
    const from: NoteSender = { web: true, name: (n.from ?? '').trim().slice(0, 80) || 'Someone on the web', domain: 'web', webId: `web:${randomBytes(8).toString('hex')}`, checked: false };
    const id = this.addNote({ from, text: n.text, purpose: n.purpose });
    if (!id) return null;
    const key = this.webNotes.get(id)?.key ?? randomBytes(12).toString('base64url');
    this.webNotes.set(id, { from, ...this.webNotes.get(id), key });
    void this.saveWebNotes();
    return { id, key };
  }
  /**
   * The sender answers on the same note, at its private link (run 56: asked "which project?", the web AI had no way to
   * say). It reaches the owner as a note of its own, from the same sender, that names the first; replies to either go
   * to the one thread.
   */
  followUpWebNote(root: string, key: string, text: string): { id: string } | { error: string; status: number } {
    const w = this.webNotes.get(root);
    if (!w || w.thread || !this.webNoteState(root, key)) return { error: 'no such note, or the link is wrong', status: 404 };
    if ((w.answers ?? []).filter((a) => a.by === 'sender').length >= 10) return { error: 'ten messages on one note: leave a new note instead', status: 429 };
    const from = w.from ?? { web: true, name: 'Someone on the web', domain: 'web', webId: `web:${randomBytes(8).toString('hex')}`, checked: false };
    const id = this.addNote({ from, text, purpose: 'contact', re: root });
    if (!id) return { error: 'a few notes an hour from one sender: try again later', status: 429 };
    this.webNotes.set(id, { key: w.key, thread: root });
    w.from = from;
    w.answers = [...(w.answers ?? []), { text, at: new Date().toISOString(), by: 'sender', final: false }].slice(-20);
    void this.saveWebNotes();
    return { id };
  }
  /** What became of a web note, for whoever holds its link. */
  webNoteState(id: string, key: string): { status: string; answer?: { text: string; at: string }; answers?: { text: string; at: string; final: boolean; from: string }[]; check_again?: string } | null {
    const w = this.webNotes.get(id);
    // Compared in constant time: the secret is the only lock on this page.
    if (!w || key.length !== w.key.length || !timingSafeEqual(Buffer.from(key), Buffer.from(w.key))) return null;
    // The whole conversation, the sender's own messages marked as theirs.
    const answers = (w.answers ?? []).map(({ text, at, final, by }) => ({ text, at, final, from: by === 'sender' ? 'you' : 'them' }));
    if (answers.at(-1)?.from === 'you') return { status: 'your reply is with them', answers, check_again: 'in a few minutes: a person may take a while' };
    const last = answers.filter((a) => a.from === 'them').at(-1);
    // A holding reply isn't the answer (run 54: "answered" made the sender's AI stop looking 25 s before the decision).
    if (last?.final) return { status: 'answered', answer: { text: last.text, at: last.at }, answers };
    const open = this.notes.some((x) => x.id === id);
    return { status: last ? 'replied, and the answer is still to come' : open ? 'with the owner, not answered yet' : (this.closedNotes.get(id)?.state ?? 'seen'), ...(last ? { answer: { text: last.text, at: last.at }, answers } : {}), ...(open || last ? { check_again: 'in a few minutes: a person may take a while' } : {}) };
  }
  private answerWebNote(id: string, text: string, by: string, final = true): { ok: true } | { error: string } {
    const w = this.webNotes.get(this.webNotes.get(id)?.thread ?? id);
    if (!w) return { error: 'that note came from a Lake agent, not the web: answer it with lake_ask to the from.url in its house.news (this tool is for notes left over plain web)' };
    const t = text.trim().slice(0, 1000);
    if (!t) return { error: 'text: the answer, up to 1000 characters' };
    w.answers = [...(w.answers ?? []), { text: t, at: new Date().toISOString(), by, final }].slice(-20);
    void this.saveWebNotes();
    this.touch();
    return { ok: true };
  }

  noteState(id: string, sender: string): string | null {
    const open = this.notes.find((x) => x.id === id && x.from.webId === sender);
    if (open) return 'the owner has it and hasn\'t answered or dismissed it yet';
    const closed = this.closedNotes.get(id);
    return closed && closed.by === sender ? closed.state : null;
  }

  /** Notes from other agents for the owner (a favour, an invite): the newest few, shown as their words. */
  notes: { id: string; from: NoteSender; text: string; purpose?: string; at: string; /** The owner's own answer to an agent's note, sent from their phone. */ answered?: { text: string; by: string; at: string } }[] = [];
  /** Keeps a note, tells the assistants; its id, or null when its sender has sent too many this hour. */
  addNote(n: { from: NoteSender; text: string; purpose?: string; re?: string }): string | null {
    this.touch();
    // The same words again from the same sender are the same note (run 45 got one twice).
    const again = this.notes.find((x) => x.from.webId === n.from.webId && x.text === n.text);
    if (again) return again.id;
    if (this.notes.filter((x) => x.from.webId === n.from.webId && Date.now() - Date.parse(x.at) < 3_600_000).length >= 5) return null;
    const note = { id: randomBytes(6).toString('hex'), ...n, at: new Date().toISOString() };
    // The newest fifty wait for the owner; one pushed out says so to its sender, rather than vanishing.
    for (const old of this.notes.slice(49)) this.closedNotes.set(old.id, { by: old.from.webId, state: 'not read: too many notes came at once; send it again if it still matters' });
    this.notes = [note, ...this.notes].slice(0, 50);
    void this.saveNotes();
    const known = this.knownBy(n.from.key), twin = known ? undefined : this.lookalike(n.from);
    this.news({ about: 'note', note: note.id, from: n.from, known: known ? { yes: true, why: known } : { yes: false, why: twin ?? 'first contact: your human\'s side has never written to it', ...(twin ? { lookalike: true } : {}) }, text: n.text, ...(n.purpose ? { purpose: n.purpose } : {}), ...(n.re ? { follow_up_to: n.re } : {}), at: note.at, reply: n.from.web ? 'their own words, left over plain web by an AI without the Lake connector: it has no Lake address, so answer with lake_house_reply { note, text } if your human would want you to (they read it at the private link they were given). Nobody checked who sent it' : 'their own words; answer the sender at from.url if your human would want you to. They are waiting: if you\'ve put it to your human, you may tell them it reached them (their house stays unnamed)', ...(n.from.checked ? {} : { checked_means: 'unchecked: its domain isn\'t proved (on a sandbox nobody\'s is), so who it says it is, is only its word. If it says it speaks for a house your human knows (a neighbour), ask it to send again with reveal_house: true: that carries the house\'s own signed word, which is checked (run 61: two honest neighbours\' assistants each called the other unverified, and a parcel went untaken)' }) });
    return note.id;
  }

  /** Whether the owner has dealt with this visitor: given it a key, or answered a request of its (SPEC §5: presence only to them). */
  knows(visitor: { webId: string; domain: string }): boolean {
    return [...this.grants.values()].some((g) => g.visitor === visitor.domain || g.visitor === visitor.webId) || [...this.pending.values()].some((x) => x.visitor.webId === visitor.webId && x.status !== 'pending');
  }

  recentAsks(visitorWebId: string, withinMs = 3_600_000): PendingRequest[] {
    return [...this.pending.values()].filter((x) => x.visitor.webId === visitorWebId && Date.now() - Date.parse(x.requestedAt) < withinMs);
  }

  /** A single-use key has been used: it stops working like a revoked one, but nobody took it back. */
  async spend(id: string) {
    const g = this.grants.get(id);
    if (g) { g.revoked = true; g.spent = true; }
    this.revokedIds.add(id);
    await this.o.saveRevoked([...this.revokedIds]);
  }

  async revoke(which: 'all' | string): Promise<number> {
    const ids = which === 'all' ? [...this.grants.values()].filter((g) => !g.revoked).map((g) => g.id) : [which];
    let n = 0;
    const at = new Date().toISOString();
    const withdrawn: Promise<void>[] = [];
    for (const id of ids) {
      const g = this.grants.get(id);
      // The consent record says it was taken back, and when. A key cut before a restart isn't in memory any more, but
      // its record is still in the pod, and still the owner's to withdraw (the panel's Consents list offers it).
      if (g ? !g.revoked : !this.revokedIds.has(id)) withdrawn.push(this.o.withdrawConsent?.(id, at).catch(() => {}) ?? Promise.resolve());
      if (g && !g.revoked) { g.revoked = true; n++; }
      this.revokedIds.add(id);
    }
    // Awaited, so the panel that asked sees the record withdrawn when it looks again.
    await Promise.all(withdrawn);
    await this.o.saveRevoked([...this.revokedIds]);
    if (n) this.o.emit(makeEvent('grant.revoked', this.o.actor, undefined, { count: n }));
    return n;
  }

  /**
   * A badge for a paired assistant's card (SPEC §6.5): the house's word that it may sell for this house, pinned to its
   * key, with its own bit on the status list, set when the owner takes the assistant's key back.
   */
  private async assistantBadge(a: AssistantKey): Promise<{ credential: string; issuer: string } | undefined> {
    const issuer = this.o.card?.().supportedInterfaces?.[0]?.url;
    if (!a.webId || !this.o.vouchAssistant || !this.o.statusUrl || !issuer) return undefined;
    const status = statusEntry(this.o.statusUrl(), await this.statusIndex(`assistant:${a.kid}`));
    return { credential: await this.o.vouchAssistant({ webId: a.webId, jwk: a.jwk }, status), issuer };
  }

  /** /owner: the approvals app (static) and its API. */
  router(appDir?: string): express.Router {
    const r = express.Router();
    r.use(express.json({ limit: '64kb' }));

    // Whether a device can pair here without a link: only a sandbox house nobody holds. The pairing screen asks, so it
    // doesn't offer a button that can't work (an owned house needs a link or a recovery code).
    r.get('/pair', (_req, res) => { const d = this.o.panel?.door?.(); res.set('cache-control', 'no-store').json({ open: this.o.openPairing && !this.ownerJwk, ...(d?.handle ? { handle: d.handle } : {}), ...(d?.name ? { shown: d.name } : {}) }); });

    // A sign-in page on this house's own Lake asks, for an AI app, to connect it as the owner's assistant. Nothing is
    // granted here: the owner sees it (with the sign-in page's number) and answers with their key.
    r.post('/connect', (req, res) => {
      const q = (req.body ?? {}) as Record<string, unknown>;
      const str = (k: string, n: number) => (typeof q[k] === 'string' ? (q[k] as string).slice(0, n) : '');
      const back = str('back', 500), ask = str('ask', 100), number = str('number', 8);
      let ok = false;
      try { ok = !!this.o.publicUrl && new URL(back).origin === new URL(this.o.publicUrl).origin && new URL(back).pathname.endsWith('/oauth/house/answer'); } catch { /* not a URL */ }
      if (!ok) return void res.status(403).json({ error: 'a sign-in can connect an AI only from this house\'s own Lake' });
      if (!ask || !/^\d{4}$/.test(number)) return void res.status(400).json({ error: 'ask and a 4-digit number' });
      if (!this.ownerJwk) return void res.status(409).json({ error: 'this house has no owner yet: claim it first' });
      const now = Date.now();
      for (const [k, c] of this.connects) if (now - c.at > 15 * 60_000) this.connects.delete(k);
      this.connectTimes = this.connectTimes.filter((t) => now - t < 3_600_000);
      if (this.connects.size >= 3 || this.connectTimes.length >= 10) return void res.status(429).json({ error: 'too many sign-ins waiting at this house: try again later' });
      this.connectTimes.push(now);
      this.connects.set(randomBytes(6).toString('hex'), { ask, app: str('app', 60) || 'An AI app', from: str('from', 100), number, back, at: now });
      this.touch();
      res.json({ waiting: true });
    });

    r.post('/pair', async (req, res) => {
      const { publicJwk, token, recovery } = req.body ?? {};
      if (!publicJwk?.x || publicJwk.crv !== 'Ed25519') return void res.status(400).json({ error: 'send an Ed25519 public key' });
      if (this.ownerJwk && this.ownerJwk.x === publicJwk.x) return void (this.seen(), res.json({ paired: true, webId: this.o.webId }));
      const firstCome = this.o.openPairing && !this.ownerJwk;
      // A recovery code the owner wrote down (backup codes, as two-factor sign-ins give): it makes this device the key.
      // Five tries an hour; each code works once.
      let recovered = false;
      if (!firstCome && typeof recovery === 'string' && recovery.trim()) {
        this.recoveryTries = this.recoveryTries.filter((t) => Date.now() - t < 3_600_000);
        if (this.recoveryTries.length >= 5) return void res.status(429).json({ error: 'too many tries: wait an hour' });
        this.recoveryTries.push(Date.now());
        if (!(await this.checkRecovery(recovery))) return void res.status(403).json({ error: 'that recovery code doesn\'t match (each code works once)' });
        recovered = true;
      }
      const linkLive = token === this.token && (!this.tokenUntil || Date.now() < this.tokenUntil);
      if (!firstCome && !recovered && !linkLive) return void res.status(403).json({ error: token === this.token ? 'this pairing link has expired: make a new one' : this.ownerJwk ? 'this house already has an owner' : 'wrong or missing pairing token' });
      // Moved to this device: a lease keeps its start (moving devices doesn't lengthen a claim).
      const claimedAt = (this.ownerJwk as { claimedAt?: number } | null)?.claimedAt;
      this.ownerJwk = { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid: String(publicJwk.kid ?? 'owner'), alg: 'EdDSA', ...(this.o.leaseHours ? { claimedAt: claimedAt ?? Date.now() } : {}) } as JWK;
      if (recovered) await this.clearRecovery();
      this.tokenUntil = 0;
      await this.o.saveOwnerKey(this.ownerJwk);
      this.token = await secret(join(this.o.dataDir, 'pairing-token'), true); // one use only
      this.seen();
      // Said in the log too: the link printed at start is spent now (round 6: pairing left no trace).
      console.log(`[owner] ${recovered ? 'recovered with the recovery code' : 'paired'}: that device holds this house's key now; the pairing link printed earlier is spent`);
      res.json({ paired: true, webId: this.o.webId, until: this.leaseUntil()?.toISOString() });
    });

    // The owner's assistant pairs with a one-time code the owner made in the panel; its key can look and suggest only.
    r.post('/assistant', async (req, res) => {
      const { publicJwk, code, label, webId, url } = req.body ?? {};
      if (!publicJwk?.x || publicJwk.crv !== 'Ed25519' || !publicJwk.kid) return void res.status(400).json({ error: 'send an Ed25519 public key with a kid' });
      const invite = this.invites.get(String(code ?? ''));
      if (!invite || invite.until < Date.now()) return void res.status(403).json({ error: 'wrong or expired code: ask your human for a new one' });
      this.invites.delete(String(code));
      const kid = String(publicJwk.kid);
      if (kid === this.ownerJwk?.kid) return void res.status(400).json({ error: 'that is the owner\'s own key' });
      const a: AssistantKey = { ...(invite.duty ? { duty: invite.duty } : {}), kid, jwk: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x, kid, alg: 'EdDSA' } as JWK, label: String(label ?? invite.label).slice(0, 60), addedAt: new Date().toISOString(), seenAt: new Date().toISOString(), ...(typeof webId === 'string' && /^https?:\/\//.test(webId) ? { webId: webId.slice(0, 300) } : {}), ...(typeof url === 'string' && /^https?:\/\//.test(url) ? { url: url.slice(0, 300) } : {}) };
      this.assistants.set(kid, a);
      await this.o.saveAssistants?.([...this.assistants.values()]);
      const badge = await this.assistantBadge(a).catch(() => undefined);
      res.json({ paired: true, role: 'assistant', webId: this.o.webId, ...(a.duty ? { duty: { kinds: a.duty.kinds, cap: a.duty.cap, until: a.duty.until, ...(a.duty.hours ? { hours: a.duty.hours } : {}), note: 'you are your human\'s AI on duty: only these kinds, no money, nothing to an agent they or their assistants never wrote to (leave them a note instead), and every action is logged for them' } } : {}), may: [...ASSISTANT_MAY], may_means: 'what you may do in your human\'s control panel (look and suggest); the badge below is what others see: the house\'s word that you answer and sell for it', ...(badge ? { badge, badge_note: 'the house\'s word that you may sell for it: on your card, a cart you sign can name the house as payee, so what you earn is your human\'s' } : {}) });
    });

    // Public: is this house taken? (For the sandbox's list of houses to claim.)
    // The agenda as a private iCal feed (RFC 5545) for the owner's own calendar app: whoever has the address can read it,
    // as with any calendar's secret address, so only the owner's panel shows it.
    r.get('/agenda.ics', (req, res) => {
      if (!this.ownerJwk || !this.feedKey || String(req.query.key ?? '') !== this.feedKey) return void res.status(404).send('no such calendar');
      res.type('text/calendar').send(agendaIcs(this.agenda, this.o.webId));
    });
    r.get('/status', (_req, res) => void res.json({ claimed: !!this.ownerJwk, ...(this.unclaimed() ? { unclaimed: true } : {}), until: this.leaseUntil()?.toISOString() ?? null, leaseHours: this.o.leaseHours ?? null }));

    // The panel's live stream: opened with a token from a signed panel.stream (EventSource can't sign), good for a minute.
    r.get('/stream', (req, res) => {
      const t = String(req.query.t ?? '');
      const until = this.streamTokens.get(t);
      if (!until || until < Date.now()) return void res.status(403).end();
      this.streamTokens.delete(t);
      // No buffering on the way (Apache, nginx), and a comment now and then so proxies keep the connection open.
      res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      res.flushHeaders();
      const send = (v: number) => res.write(`event: changed\ndata: ${v}\n\n`);
      send(this.version);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      this.watchers.add(send);
      req.on('close', () => { clearInterval(ping); this.watchers.delete(send); });
    });
    r.post('/api', async (req, res) => {
      // Whatever the owner or their assistant did here may change what the panel shows.
      res.on('finish', () => { if (req.body?.payload?.kind && !/^(list|panel\.(overview|rules|activity|agents|money|consents|data|market|door|free|stream))$/.test(req.body.payload.kind)) this.touch(); });
      if (!this.ownerJwk) return void res.status(409).json({ error: 'pair first' });
      let p: Signed<{ kind: string; request?: string; answer?: string; grant?: string; revoke?: string }>['payload'];
      let signer = '';
      try {
        p = await verifyMessage(req.body, async (kid) => { signer = kid; return kid === this.ownerJwk!.kid ? this.ownerJwk : this.assistants.get(kid)?.jwk ?? null; }, { replay: this.replay });
      } catch (e) {
        return void res.status(403).json({ error: (e as Error).message });
      }
      const assistant = signer !== this.ownerJwk.kid ? this.assistants.get(signer) : undefined;
      // The owner's own key only: an assistant reading the panel isn't the owner looking.
      if (!assistant) this.seen();
      if (assistant) {
        // "Connected" only says it holds a key; when it last used it is what the owner can judge by (an AI app may drop
        // its connection and come back as another agent).
        if (!assistant.seenAt || Date.now() - Date.parse(assistant.seenAt) > 600_000) {
          assistant.seenAt = new Date().toISOString();
          await this.o.saveAssistants?.([...this.assistants.values()]);
        }
        if (!ASSISTANT_MAY.has(p.kind)) return void res.status(403).json({ error: `an assistant may look and suggest; only your human's key can do ${p.kind}` });
        // Messages waiting for it while nobody reads (its chat ended): its human's panel says so (run 58).
        if (p.kind === 'assistant.waiting') {
          const q = p as unknown as { count?: number; senders?: number; since?: string; last_read?: string };
          const count = Math.max(0, Math.min(999, Number(q.count) || 0));
          if (count) this.waitingFor.set(assistant.kid, { count, senders: Math.max(1, Math.min(count, Number(q.senders) || 1)), since: String(q.since ?? new Date().toISOString()).slice(0, 40), ...(q.last_read ? { lastRead: String(q.last_read).slice(0, 40) } : {}) });
          else this.waitingFor.delete(assistant.kid);
          this.touch();
          return void res.json({ ok: true });
        }
        if (p.kind === 'assistant.suggest') {
          const q = p as unknown as { text?: string; request?: string; offer?: string; replaces?: string; pledge?: { tally?: string; id?: string }; advice?: string; ask?: { choices?: unknown; recommend?: unknown }; rules?: unknown };
          const text = String(q.text ?? '').trim().slice(0, 1500);
          // An assistant that got something wrong takes its own note back; an empty text with replaces just withdraws it.
          const old = q.replaces ? this.suggestions.find((x) => x.id === q.replaces && x.from === assistant.label) : undefined;
          if (q.replaces && !old) return void res.status(404).json({ error: 'no note of yours with that id' });
          // An answered question stays answered (run 41 asked the owner twice): ask a new one if something changed.
          if (old?.errand?.state === 'held') return void res.status(409).json({ error: 'something came in on that errand and it is with your human now: they answer it (you hear as house.news)' });
          if (old?.ask?.answered) return void res.status(409).json({ error: `your human already answered that: "${old.ask.answered}". To ask them something new, send a new note (without replaces)` });
          if (old) this.suggestions = this.suggestions.filter((x) => x !== old);
          if (old && !text) await this.saveSuggestions();
          if (!text) return void (old ? res.json({ ok: true, withdrawn: old.id }) : res.status(400).json({ error: 'suggest something: text' }));
          const e = (p as unknown as { errand?: { kind?: string; ref?: string; days?: number; with?: { name?: string; webId?: string; key?: string; url?: string } } }).errand;
          if (e) {
            // Opened quietly: nothing to tap yet, so no notification; the owner hears when something comes in.
            if (!ERRAND_KINDS.includes(e.kind as Errand['kind'])) return void res.status(400).json({ error: `errand: { kind: ${ERRAND_KINDS.join(' | ')}, with: { name, webId, key, url }, ref, days }` });
            if (this.suggestions.filter((x) => x.by === assistant.kid && (x.errand?.state === 'open' || x.errand?.state === 'held')).length >= 20) return void res.status(429).json({ error: 'twenty errands open already: close one (replaces with an empty text) first' });
            const days = Math.min(31, Math.max(1, Number(e.days) || 7));
            const w = e.with?.webId ? { name: String(e.with.name ?? '').slice(0, 80), webId: String(e.with.webId).slice(0, 300), ...(e.with.key ? { key: String(e.with.key).slice(0, 100) } : {}), ...(e.with.url ? { url: String(e.with.url).slice(0, 300) } : {}) } : undefined;
            const sug: Suggestion = { id: randomBytes(6).toString('hex'), from: assistant.label, by: assistant.kid, text: text.slice(0, 300), errand: { what: text.slice(0, 300), kind: e.kind as Errand['kind'], ...(e.ref ? { ref: String(e.ref).slice(0, 200) } : {}), ...(w ? { with: w } : {}), until: new Date(Date.now() + days * 86_400_000).toISOString(), state: 'open', arrivals: [] }, at: new Date().toISOString() };
            this.suggestions = [sug, ...this.suggestions];
            this.trimSuggestions();
            await this.saveSuggestions();
            return void res.json({ ok: true, id: sug.id, errand: sug.errand!.until, note: 'your human\'s house holds it: what comes in while you are away is put to them, and you hear their answer' });
          }
          // A note about a request must point at a real one: a unique prefix is enough, anything else is refused.
          let request: string | undefined;
          if (q.request) {
            const hits = [...this.pending.keys()].filter((k) => k === q.request || k.startsWith(String(q.request)));
            if (hits.length !== 1) return void res.status(404).json({ error: hits.length ? 'that matches several requests; give more of the id' : 'no waiting request with that id' });
            request = hits[0];
          }
          // Likewise an offer: the owner's panel puts an Accept button on the note, so it must be a real one.
          let offer: string | undefined;
          if (q.offer) {
            const hits = (this.o.offerIds?.() ?? []).filter((k) => k === q.offer || k.startsWith(String(q.offer)));
            if (hits.length !== 1) return void res.status(404).json({ error: hits.length ? 'that matches several offers; give more of the id' : 'no offer with that id (lake_house { view: "offers" })' });
            offer = hits[0];
          }
          // A pledge for the owner to sign: a street's "nobody goes first" plan needs the owner's own signature (run 34b and 38
          // had no way to put one in front of the owner). Signing stays the owner's tap, on the owner's key.
          let pledge: Suggestion['pledge'];
          if (q.pledge) {
            const tally = String(q.pledge.tally ?? '').replace(/\/a2a\/?$/, '').replace(/\/$/, '');
            if (!/^https?:\/\/\S+$/.test(tally) || !q.pledge.id) return void res.status(400).json({ error: 'pledge: { tally: the tally\'s address, id: the pledge\'s id }' });
            pledge = { tally, id: String(q.pledge.id).slice(0, 80) };
            // What it costs, on the Sign button: the owner reads the tally's own terms, never the assistant's account of them.
            const t = await this.o.panel?.pledgeTerms?.(tally, pledge.id).catch(() => undefined);
            if (t?.circle) pledge.circle = { promise: String(t.circle.promise), times: Number(t.circle.times_a_year), ...(Array.isArray(t.circle.kinds) ? { kinds: (t.circle.kinds as unknown[]).map(String) } : {}) };
            if (t?.quorum && t.state === 'gathering') pledge.quorum = { text: String(t.text), options: (t.quorum.options as unknown[]).map(String), closes: String(t.quorum.closes), least: Number(t.threshold) };
            if (t?.money) pledge.money = { amount: Number(t.money.contribution.amount), currency: String(t.money.contribution.currency), payee: String(t.money.payee.name ?? t.money.payee.webId), threshold: Number(t.threshold), deadline: String(t.deadline), count: Number(t.count), ...(t.money.bond ? { bond: Number(t.money.bond.amount) } : {}), text: String(t.text) };
          }
          // Asking one of the owner's circles for something they need: proposed by their assistant, sent by their tap.
          let circleCall: Suggestion['circleCall'];
          const qcc = (p as { circle_call?: { tally?: unknown; id?: unknown; need?: unknown; help?: unknown } }).circle_call;
          if (qcc) {
            const need = String(qcc.need ?? '').trim();
            if (!/^https?:\/\/\S+$/.test(String(qcc.tally ?? '')) || !qcc.id || !need || need.length > 300) return void res.status(400).json({ error: 'circle_call: { tally, id, need (up to 300 characters), help? }' });
            circleCall = { tally: String(qcc.tally).replace(/\/a2a\/?$/, ''), id: String(qcc.id), need, ...(qcc.help ? { help: String(qcc.help) } : {}) };
          }
          // A change to one of the owner's circles, proposed by their assistant (a rule, or a partner it found): their tap
          // puts it to the members' vote.
          // A cart priced in favours (SPEC §6.7): the owner's tap pays it with one owed to them.
          let favourPay: Suggestion['favourPay'];
          const qfp = (p as { favour_pay?: { cart?: { contents?: { id?: string; merchant_name?: string; payment_request?: { details?: { total?: { amount?: { currency?: string; value?: number } } } } } }; seller_url?: unknown } }).favour_pay;
          if (qfp) {
            const total = qfp.cart?.contents?.payment_request?.details?.total?.amount;
            if (!qfp.cart?.contents?.id || !/^https?:\/\/\S+$/.test(String(qfp.seller_url ?? '')) || total?.currency !== 'FAV') return void res.status(400).json({ error: 'favour_pay: { cart (a cart in FAV, as its seller signed it), seller_url }' });
            favourPay = { cart: qfp.cart, seller: String(qfp.seller_url), sellerName: String(qfp.cart.contents.merchant_name ?? '').slice(0, 80), total: `${total.value} favour` };
          }
          let circleVote: Suggestion['circleVote'];
          const qcv = (p as { circle_vote?: { tally?: unknown; id?: unknown; change?: unknown } }).circle_vote;
          if (qcv) {
            const ch = (qcv.change ?? {}) as Record<string, unknown>;
            if (!/^https?:\/\/\S+$/.test(String(qcv.tally ?? '')) || !qcv.id || typeof qcv.change !== 'object' || !Object.keys(ch).length || JSON.stringify(ch).length > 1000) return void res.status(400).json({ error: 'circle_vote: { tally, id, change: { limit?, times?, sisters?, partner?: { url, per_month? } } }' });
            circleVote = { tally: String(qcv.tally).replace(/\/a2a\/?$/, ''), id: String(qcv.id), change: ch };
          }
          // A secret count to answer from the owner's own record: the house checks the field is one of its coded facts now,
          // so the button never fails for that, and keeps what the record says for the owner's eyes only.
          let count: Suggestion['count'];
          const qc = (p as { count?: { id?: unknown; options?: unknown; leader?: unknown; helper?: unknown; field?: unknown } }).count;
          if (qc) {
            const options = Array.isArray(qc.options) ? qc.options.map(String) : [];
            const field = String(qc.field ?? ''), spec = fieldSpec(field);
            if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(String(qc.id ?? '')) || options.length < 2 || options.length > 16 || !/^https?:\/\/\S+$/.test(String(qc.leader ?? '')) || !/^https?:\/\/\S+$/.test(String(qc.helper ?? '')) || spec?.kind !== 'code') {
              return void res.status(400).json({ error: 'count: { id, options (2 to 16, as the count lists them), leader, helper (the tellers\' addresses), field: a coded fact of this house\'s record (its pack says which) }' });
            }
            const mine = await this.o.panel?.recordCode?.(field).catch(() => undefined);
            count = { id: String(qc.id), options, leader: String(qc.leader), helper: String(qc.helper), field, label: spec.label, ...(mine && options.includes(mine) ? { mine } : {}) };
          }
          if (q.advice !== undefined && !ADVICE.includes(q.advice as Advice)) return void res.status(400).json({ error: `advice: one of ${ADVICE.join(', ')}` });
          // New rules for the owner to apply with a tap (run 45: they agreed to a change nobody could make): checked now, so
          // the Apply button never fails; applying stays the owner's key.
          let rules: string | undefined;
          if (q.rules !== undefined) {
            try { parseRules(String(q.rules)); rules = String(q.rules); } catch (e) { return void res.status(400).json({ error: `rules: ${(e as Error).message}` }); }
          }
          let door: Suggestion['door'];
          const d = (q as { door?: { about?: unknown } }).door;
          if (d !== undefined) {
            const about = typeof d?.about === 'string' ? d.about.trim() : '';
            if (!about || about.length > 200) return void res.status(400).json({ error: 'door: { about: the new line for your human\'s door, up to 200 characters }' });
            door = { about };
          }
          // Muting a sender is its own choice, never read from advice (run 46: an FYI marked "dont" muted the seller).
          const mute = (q as { mute?: unknown }).mute === true;
          // Or about a note at the door (run 42: "don't answer this one" had nowhere to go).
          const aboutNote = typeof (q as { note?: unknown }).note === 'string' ? this.notes.find((n) => n.id === (q as { note: string }).note)?.id : undefined;
          // Run 65: an assistant tried to mute a scammer that had written to its own inbox, not to the door.
          if ((q as { note?: unknown }).note !== undefined && !aboutNote) return void res.status(404).json({ error: 'no note at the door with that id: a message in your own lake_inbox is not a door note. To stop hearing from its sender, lake_block its url yourself (blocking needs nobody\'s say), and tell your human with sender and advice "dont"' });
          // Advice with nothing to act on is dropped, and the note still goes (run 55: three refusals, and the owner was never
          // told): an FYI is words for the owner.
          // A warning about another agent keeps its advice too (run 63: "don't pay this stranger" lost its "don't").
          const sender = typeof (q as { sender?: unknown }).sender === 'string' ? String((q as { sender?: string }).sender).slice(0, 200) : '';
          // A new allowance it proposes (run 66: "raise it by A$60" was answered, and nothing changed): checked here, signed
          // only by the owner's tap.
          const al = (q as { allowance?: { amount?: unknown; currency?: unknown; days?: unknown } }).allowance;
          let allowance: Suggestion['allowance'];
          if (al !== undefined) {
            const amount = Number(al.amount), days = al.days === undefined ? 7 : Number(al.days), currency = String(al.currency ?? 'USD').toUpperCase();
            if (!(amount > 0 && amount <= MAX_ALLOWANCE) || !Number.isInteger(days) || days < 1 || days > MAX_ALLOWANCE_DAYS || !/^[A-Z]{3}$/.test(currency)) return void res.status(400).json({ error: `allowance: { amount: 1 to ${MAX_ALLOWANCE}, currency?, days?: 1 to ${MAX_ALLOWANCE_DAYS} }` });
            if (!assistant.webId) return void res.status(400).json({ error: 'allowance: you connected before allowances existed: reconnect with a new code first' });
            allowance = { amount: Math.round(amount * 100) / 100, currency, days };
          }
          const adviceDropped = q.advice !== undefined && !request && !offer && !pledge && !count && !circleCall && !circleVote && !favourPay && !aboutNote && !rules && !door && !sender && !allowance;
          if (adviceDropped) delete q.advice;
          let ask: Suggestion['ask'];
          if (q.ask) {
            // Refused, not cut (run 40 stored "…return fa"): the assistant shortens its own words.
            const choices = Array.isArray(q.ask.choices) ? q.ask.choices.map((c) => String(c).trim()).filter(Boolean) : [];
            // A private question (for a secret count: a pay band, a rent band) may have as many choices as a count has options.
            const priv = (q.ask as { private?: unknown }).private === true;
            const most = priv ? 16 : 4;
            if (choices.length < 2 || choices.length > most || choices.some((c) => c.length > 80)) return void res.status(400).json({ error: `ask: { choices: 2 to ${most} answers of up to 80 characters, recommend?: the index of the one you advise${priv ? '' : ', private?: true (its answer stays in the house, for a secret count; up to 16 choices)'} }` });
            if (priv) { ask = { choices, private: true }; }
            const r = Number(q.ask.recommend);
            // "Your call" means it (run 44: three "your call" questions each carried a recommended choice, and it was taken).
            // The recommendation is dropped, not the question refused (run 45: refused, the assistant reposted it as "do").
            if (!priv) ask = { choices, ...(q.advice !== 'your_call' && Number.isInteger(r) && r >= 0 && r < choices.length ? { recommend: r } : {}) };
          }
          const sug: Suggestion = { id: randomBytes(6).toString('hex'), from: assistant.label, by: assistant.kid, text, ...(sender ? { sender } : {}), ...(allowance ? { allowance } : {}), ...(request ? { request } : {}), ...(offer ? { offer } : {}), ...(pledge ? { pledge } : {}), ...(count ? { count } : {}), ...(circleCall ? { circleCall } : {}), ...(circleVote ? { circleVote } : {}), ...(favourPay ? { favourPay } : {}), ...(aboutNote ? { note: aboutNote, ...(mute ? { mute: true } : {}) } : {}), ...(rules ? { rules } : {}), ...(door ? { door } : {}), ...(q.advice ? { advice: q.advice as Advice } : {}), ...(ask ? { ask } : {}), at: new Date().toISOString() };
          this.suggestions = [sug, ...this.suggestions];
          this.trimSuggestions();
          await this.saveSuggestions();
          this.notifyOwner('suggestion', ask ? 'Your AI has a question for you.' : 'Your AI left you a note.');
          return void res.json({ ok: true, id: sug.id, ...(old ? { replaced: old.id } : {}), note: adviceDropped ? 'your human sees it in their control panel, as words for them: advice is for a request, an offer, a pledge, a note, rules or a door line you name, so it was left off' : 'your human sees it in their control panel' });
        }
        if (p.kind === 'assistant.spent') {
          // The assistant hands back the receipt for what it spent: the owner sees it with their money, and the order turns paid.
          const a = this.allowanceFor(assistant.kid);
          if (!a || !assistant.webId || !this.o.spent) return void res.status(400).json({ error: 'you have no allowance from your human here' });
          try {
            return void res.json({ ok: true, ...(await this.o.spent((p as unknown as { receipt?: { credential?: string; card?: AgentCard } }).receipt ?? {}, digestSRI(a.credential), assistant.webId)) });
          } catch (e) {
            return void res.status(400).json({ error: (e as Error).message });
          }
        }
        if (p.kind === 'assistant.agenda') {
          const q = p as unknown as { what?: string; when?: string; start?: string; minutes?: number; where?: string; with?: string; note?: string; agreed?: AgendaItem['agreed']; remove?: string; id?: string };
          if (q.remove) { this.agenda = this.agenda.filter((x) => !(x.id === q.remove && x.by === assistant.label)); await this.saveAgenda(); return void res.json({ ok: true }); }
          // A proposed entry the other side has now agreed to: the same entry, with their word (run 51: a time was offered
          // and nothing held it, so the agenda showed nothing while the other side checked with their person).
          if (q.id) {
            const item = this.agenda.find((x) => x.id === q.id && x.by === assistant.label);
            if (!item) return void res.status(404).json({ error: 'no agenda entry of yours with that id' });
            const ag = q.agreed;
            if (!ag || typeof ag !== 'object') return void res.status(400).json({ error: 'agenda: { id, agreed_in: the lake_inbox id of their message agreeing }' });
            const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
            // What the assistant said about it while it was proposed is replaced, not left contradicting it (run 53).
            item.note = q.note !== undefined ? str(q.note, 500) || undefined : undefined;
            if (q.where) item.where = str(q.where, 120);
            item.agreed = { by: str(ag.by, 120), domain: str(ag.domain, 200), said: str(ag.said, 300), at: str(ag.at, 40), ...(ag.speaks_for ? { speaks_for: { house: str(ag.speaks_for.house, 300), checked: ag.speaks_for.checked === true } } : {}) };
            await this.saveAgenda();
            return void res.json({ ok: true, id: item.id, status: `agreed: by ${item.agreed.by}` });
          }
          const what = String(q.what ?? '').trim().slice(0, 200), when = String(q.when ?? '').trim().slice(0, 80);
          if (!what || !when) return void res.status(400).json({ error: 'agenda: { what, when, start?, where?, with? } (what was agreed, and when)' });
          const start = q.start ? new Date(String(q.start)) : undefined;
          if (start && Number.isNaN(start.getTime())) return void res.status(400).json({ error: 'agenda.start: a date and time (ISO 8601, with its offset), for your human\'s calendar' });
          // On duty, "book in my free hours" is held in code, not left to the AI's reading (6 Nov: with no free hours set, an AI on
          // duty pencilled in a call at 21:00).
          if (assistant.duty) {
            const av = this.o.panel?.availability?.();
            if (!av) return void res.status(409).json({ error: 'your human hasn\'t set when they are free (Rules: When you\'re free): on duty you can\'t book a time; leave them a note instead' });
            if (!start) return void res.status(400).json({ error: 'on duty a booking needs its start, inside your human\'s free hours (lake_house { view: "free" })' });
            const len = (Number.isInteger(q.minutes) && q.minutes! > 0 ? q.minutes! : av.meetings ?? 60) * 60_000;
            const busy = this.agenda.filter((x) => x.start).map((x) => ({ start: x.start!, ...(x.minutes ? { minutes: x.minutes } : {}) }));
            const fits = freeSlots(av, busy, new Date(), 31, 2000).some((sl) => Date.parse(sl.start) <= start.getTime() && start.getTime() + len <= Date.parse(sl.end));
            if (!fits) return void res.status(409).json({ error: 'that time isn\'t one of your human\'s free slots (lake_house { view: "free" }): on duty you can only book a free slot' });
          }
          const str = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
          const ag = q.agreed;
          const agreed = ag && typeof ag === 'object' ? { by: str(ag.by, 120), domain: str(ag.domain, 200), said: str(ag.said, 300), at: str(ag.at, 40), ...(ag.speaks_for ? { speaks_for: { house: str(ag.speaks_for.house, 300), checked: ag.speaks_for.checked === true } } : {}) } : undefined;
          // As long as offered (run 52: a 45-minute coffee blocked an hour in the owner's calendar).
          const minutes = Number.isInteger(q.minutes) && q.minutes! >= 5 && q.minutes! <= 720 ? q.minutes! : this.o.panel?.availability?.()?.meetings ?? 60;
          const item: AgendaItem = { id: randomBytes(6).toString('hex'), what, when, ...(start ? { start: start.toISOString(), minutes } : {}), ...(q.where ? { where: str(q.where, 120) } : {}), ...(q.with ? { with: str(q.with, 120) } : {}), ...(q.note ? { note: str(q.note, 500) } : {}), ...(agreed ? { agreed } : {}), by: assistant.label, at: new Date().toISOString() };
          this.agenda = [...this.agenda, item].slice(-100);
          await this.saveAgenda();
          return void res.json({ ok: true, id: item.id, status: agreed ? `agreed: by ${agreed.by}${agreed.speaks_for?.checked ? `, which speaks for ${agreed.speaks_for.house}` : ', an agent that showed no house it speaks for'}` : 'proposed: it holds the time (your human\'s calendar shows it as tentative); when they agree, send agenda { id, agreed_in }', note: 'in your human\'s agenda, in their house' });
        }
        // What its human is looking for (SPEC §6.8), from a photo or a few words: the house puts it on its card, and shops
        // offer. The most they'd pay stays in the house: offers over it are kept folded away, and no shop hears of it.
        if (p.kind === 'assistant.want') {
          const q = p as unknown as { name?: string; description?: string; properties?: Record<string, string | number>; quantity?: number; area?: string; currency?: string; days?: number; max_price?: number };
          if (!this.o.panel?.postWant) return void res.status(501).json({ error: 'this house can\'t list wants' });
          const currency = isCurrency(q.currency) ? q.currency : undefined;
          try {
            const w = await this.o.panel.postWant({ name: String(q.name ?? ''), description: q.description ? String(q.description) : undefined, properties: q.properties && typeof q.properties === 'object' ? q.properties : {}, quantity: Number.isInteger(q.quantity) ? q.quantity : undefined, area: q.area ? String(q.area) : undefined, currency, days: Number.isFinite(q.days) ? Number(q.days) : undefined },
              Number.isFinite(q.max_price) && q.max_price! > 0 && currency ? { amount: Number(q.max_price), currency } : undefined);
            this.touch();
            return void res.json({ ok: true, want: w, note: `on your human's card now: shops' agents find it at the Lake's /wants and send offers to the house; your human sees them in Chats and buys with a tap. ${q.max_price && !currency ? 'max_price was not kept: give currency too. ' : ''}Nothing in it says what they'd pay.` });
          } catch (e) { return void res.status(400).json({ error: (e as Error).message }); }
        }
        if (p.kind === 'assistant.want.close') {
          const ok = await this.o.panel?.closeWant?.(String((p as { id?: string }).id ?? ''));
          if (ok) this.touch();
          return void res.json(ok ? { ok: true } : { error: 'no want with that id' });
        }
        // An answer to a note left over plain web: its sender reads it at the private link it was given.
        // The owner's AI answered an agent's note itself (on duty, to someone the owner knows): the note says so.
        if (p.kind === 'assistant.answered') {
          const q = p as unknown as { note?: string; text?: string };
          const n = this.notes.find((x) => x.id === String(q.note ?? '') && !x.from.web);
          if (!n) return void res.status(404).json({ error: 'no note from an agent with that id' });
          n.answered = { text: String(q.text ?? '').trim().slice(0, 1000), by: assistant.label, at: new Date().toISOString() };
          void this.saveNotes();
          this.touch();
          return void res.json({ ok: true });
        }
        if (p.kind === 'assistant.reply') {
          const q = p as unknown as { note?: string; text?: string; final?: boolean };
          const r = this.answerWebNote(String(q.note ?? ''), String(q.text ?? ''), assistant.label, q.final !== false);
          return void res.status('error' in r ? 400 : 200).json('error' in r ? r : { ...r, note: 'they read it at the link they were given; your human sees it with the note' });
        }
        if (p.kind === 'assistant.forward') {
          // Words for the owner that came to their assistant while it was away: shown as a note, the sender's words, marked
          // as passed on by the assistant (its connector, not its judgement).
          const q = p as unknown as { from?: { name?: string; domain?: string; webId?: string; url?: string; key?: string }; text?: string; errand?: string; arrived?: string; ref?: string; stranger?: boolean };
          const text = String(q.text ?? '').trim().slice(0, 1000);
          if (!text || !q.from?.webId) return void res.status(400).json({ error: 'forward: { from: { name, domain, webId, url }, text }' });
          if (q.errand) {
            const sug = this.suggestions.find((x) => x.id === q.errand && x.by === assistant.kid && x.errand);
            const er = sug?.errand;
            if (!sug || !er || (er.state !== 'open' && er.state !== 'held')) return void res.status(404).json({ error: 'no open errand of yours with that id' });
            if (er.arrivals.length >= 20) return void res.status(429).json({ error: 'twenty things came in on that errand already: it waits for your human' });
            const from = { name: String(q.from.name ?? '').slice(0, 80), domain: String(q.from.domain ?? '').slice(0, 200), webId: String(q.from.webId).slice(0, 300), ...(q.from.url ? { url: String(q.from.url).slice(0, 300) } : {}), ...(q.from.key ? { key: String(q.from.key).slice(0, 100) } : {}) };
            const kind = String(q.arrived ?? 'message').slice(0, 60);
            er.arrivals.push({ at: new Date().toISOString(), from, kind, text, ...(q.ref ? { ref: String(q.ref).slice(0, 200) } : {}) });
            er.state = 'held';
            // A cart is a bill: yes means the AI pays when it's back, and the choice says so (run 77: "yes" heard, nobody paid).
            // A stranger's (first contact from that key) can be blocked from here: scam carts come while the AI is away.
            const yes = kind === 'trade.cart' ? 'Yes, I\'ll have my AI pay' : 'Yes, go ahead';
            sug.ask = { choices: [yes, 'No thanks', 'Ask my AI later', ...(q.stranger ? ['Block'] : [])] };
            sug.text = `${from.name || from.domain} answered your AI about: ${er.what}\n\n${text}`.slice(0, 1500);
            sug.at = new Date().toISOString();
            await this.saveSuggestions();
            this.notifyOwner('errand', `${from.name || from.domain} answered your AI about: ${er.what}`.slice(0, 160));
            return void res.json({ ok: true, held: sug.id, until: er.until, choices: sug.ask.choices });
          }
          const id = this.addNote({ from: { name: `${String(q.from.name ?? '').slice(0, 80)} (to your assistant, while it was away)`, domain: String(q.from.domain ?? ''), webId: String(q.from.webId), ...(q.from.url ? { url: String(q.from.url) } : {}), checked: false }, text });
          return void res.json(id ? { ok: true, note: id } : { ok: false, error: 'a few notes an hour from one sender' });
        }
        if (p.kind === 'assistant.duty') {
          const st = this.dutyState(assistant);
          const d = assistant.duty;
          const q = p as unknown as { action?: string; to?: { key?: string; name?: string }; runner?: { host?: string; since?: string; every?: number } };
          // The runner's look: where and since when, and a gap when it stopped looking for longer than three of its looks.
          if (d && q.runner?.host) {
            const now = new Date().toISOString(), every = Math.max(30, Math.min(3600, Number(q.runner.every) || 600));
            const prev = d.runner;
            const gaps = prev ? [...prev.gaps] : [];
            if (prev && Date.now() - Date.parse(prev.last) > 3 * every * 1000) gaps.push({ from: prev.last, to: now });
            d.runner = { host: String(q.runner.host).slice(0, 80), since: prev && prev.since === q.runner.since ? prev.since : String(q.runner.since ?? now).slice(0, 40), last: now, every, gaps: gaps.slice(-10) };
            if (!prev || gaps.length !== prev.gaps.length || prev.since !== d.runner.since || Date.now() - Date.parse(prev.last) > 10 * 60_000) await this.o.saveAssistants?.([...this.assistants.values()]);
          }
          const room = d && st.on && q.action ? this.dutyRoom(assistant, String(q.action), q.to) : undefined;
          return void res.json(d ? { ...st, kinds: d.kinds, cap: d.cap, bookings: Math.min(BOOKINGS_A_NIGHT, d.cap), until: d.until, ...(d.hours ? { hours: d.hours } : {}), ...(room ? { room } : {}) } : st);
        }
        if (p.kind === 'assistant.duty.log') {
          // What the AI on duty did or was refused, as its connector saw it: counted against the night's cap, and the
          // third refusal in a night takes it off duty (something keeps trying what it may not do).
          if (!assistant.duty) return void res.status(403).json({ error: 'this key is not on duty' });
          const q = p as unknown as { tool?: string; action?: string; to?: DutyEntry['to']; text?: string; reply?: unknown; refused?: string; limit?: boolean; receipt?: string; undo?: DutyEntry['undo'] };
          const before = this.dutyState(assistant);
          if (!q.refused && COUNTED.has(String(q.action)) && !before.on) return void res.json({ ok: false, on: false, why: before.why });
          const to = q.to ? { ...(q.to.name ? { name: String(q.to.name).slice(0, 80) } : {}), ...(q.to.webId ? { webId: String(q.to.webId).slice(0, 300) } : {}), ...(q.to.key ? { key: String(q.to.key).slice(0, 100) } : {}), ...(q.to.url ? { url: String(q.to.url).slice(0, 300) } : {}) } : undefined;
          const undo = q.undo && ['agenda', 'block', 'standing', 'correction'].includes(q.undo.kind) ? { kind: q.undo.kind, ref: String(q.undo.ref ?? '').slice(0, 300) } : undefined;
          const e: DutyEntry = { id: randomBytes(6).toString('hex'), by: assistant.kid, at: new Date().toISOString(), tool: String(q.tool ?? '').slice(0, 60), action: String(q.action ?? '').slice(0, 40), ...(to ? { to } : {}), ...(q.text ? { text: String(q.text).slice(0, 1500) } : {}), ...(q.reply !== undefined ? { reply: JSON.stringify(q.reply).length <= 4000 ? q.reply : `${JSON.stringify(q.reply).slice(0, 4000)}…` } : {}), ...(q.refused ? { refused: String(q.refused).slice(0, 300), ...(q.limit ? { limit: true } : {}) } : {}), ...(q.receipt ? { receipt: String(q.receipt).slice(0, 8000) } : {}), ...(undo ? { undo } : {}) };
          this.dutyLog.push(e);
          await this.saveDuty();
          const start = this.nightStart(assistant.duty);
          const tonight = this.dutyLog.filter((x) => x.by === assistant.kid && Date.parse(x.at) >= start);
          if (tonight.filter((x) => x.refused && !x.limit).length >= 3 && !this.isRevoked(assistant.duty.statusId)) await this.dutyOff(assistant, 'three refused actions in one night: off duty until your human puts you back on');
          const now = this.dutyState(assistant);
          return void res.json({ ok: true, entry: e.id, on: now.on, ...(now.on ? { used: now.used, cap: assistant.duty.cap } : { why: now.why }) });
        }
        if (p.kind === 'assistant.private_answer') {
          // The owner's private answer, for this assistant's connector to send as a secret count's shares (never shown to it
          // in a list or a notice). Once only: a second count can't reuse it to learn more (differencing).
          const q = p as unknown as { question?: string; options?: string[] };
          const sug = this.suggestions.find((x) => x.id === String(q.question ?? '') && x.by === assistant.kid && x.ask?.private);
          if (!sug?.ask?.answered) return void res.json({ error: sug ? 'your human hasn\'t answered it yet' : 'no private question of yours with that id' });
          if (JSON.stringify(q.options) !== JSON.stringify(sug.ask.choices)) return void res.json({ error: 'the count\'s options must be exactly the question\'s choices, in the same order' });
          if ((sug as Suggestion & { used?: string }).used) return void res.json({ error: 'that answer went into a count already' });
          (sug as Suggestion & { used?: string }).used = new Date().toISOString();
          await this.saveSuggestions();
          return void res.json({ choice: sug.ask.answered });
        }
        if (p.kind === 'assistant.freebusy') {
          // Whether the owner is free for this slot, from their own free hours and agenda: for a secret count, where the
          // assistant's connector sends it as shares (the Consent Compiler blueprint). Only the yes or no leaves here.
          const q = p as unknown as { start?: string; minutes?: number };
          const av = this.o.panel?.availability?.();
          if (!av) return void res.json({ error: 'your human hasn\'t set when they are free (Rules: When you\'re free)' });
          const start = Date.parse(String(q.start ?? ''));
          if (Number.isNaN(start)) return void res.status(400).json({ error: 'freebusy: { start (ISO 8601, with its offset), minutes? }' });
          const len = (Number.isInteger(q.minutes) && q.minutes! > 0 ? q.minutes! : av.meetings ?? 60) * 60_000;
          const busy = this.agenda.filter((x) => x.start).map((x) => ({ start: x.start!, ...(x.minutes ? { minutes: x.minutes } : {}) }));
          const free = freeSlots(av, busy, new Date(), 31, 2000).some((sl) => Date.parse(sl.start) <= start && start + len <= Date.parse(sl.end));
          return void res.json({ free });
        }
        if (p.kind === 'assistant.contact') {
          const q = p as unknown as { key?: string; name?: string; webId?: string };
          const key = String(q.key ?? '');
          if (!/^[\w-]{20,100}$/.test(key)) return void res.status(400).json({ error: 'contact: { key (its RFC 7638 thumbprint), name, webId }' });
          if (!this.contacts.has(key)) { this.contacts.set(key, { name: String(q.name ?? '').slice(0, 80), webId: String(q.webId ?? '').slice(0, 300), at: new Date().toISOString() }); await this.saveDuty(); }
          return void res.json({ ok: true });
        }
        if (p.kind === 'assistant.known') {
          // The duty's novelty rule (Fable, 5 Nov): known means the owner's side wrote to that key first, or a standing yes
          // names it. Having received from it isn't enough: a stranger who writes twice is still a stranger.
          const key = String((p as unknown as { key?: string }).key ?? '');
          // The owner's own say for this conversation comes first: "I reply" keeps their AI out of it; "My AI replies" lets it in.
          if (this.chatModes[key] === 'me') return void res.json({ known: false, why: 'your human answers this conversation themselves' });
          const why = this.knownBy(key) ?? (this.chatModes[key] === 'ai' ? 'your human said you may reply in this conversation' : undefined);
          return void res.json(why ? { known: true, why } : { known: false, why: 'first contact: your human hears of it first' });
        }
        if (p.kind === 'assistant.badge') {
          const badge = await this.assistantBadge(assistant);
          return void res.json(badge ? { badge } : { badge: null, why: 'this house can\'t vouch for you: pair again with your Lake WebID' });
        }
        if (p.kind === 'assistant.allowance') {
          // What this assistant may spend for its human: the owner's signed mandate, the house's card and its word for the
          // owner's key, so a payments agent can check the whole chain. The house signs no money itself.
          const a = this.allowanceFor(assistant.kid);
          if (!a || !this.o.vouchOwner || !this.o.card) return void res.json({ intent: null, why: 'your human has not given you an allowance (control panel: My AI → Manage your AIs → Allow spending)' });
          return void res.json({ intent: { credential: a.credential, card: this.o.card(), owner: await this.o.vouchOwner(this.ownerJwk!) }, amount: a.amount, currency: a.currency, until: a.until });
        }
      }
      // The owner's answer to an AI app's sign-in: yes makes a one-time assistant code and hands it to the sign-in, which
      // uses it at once for that AI's agent; no tells the sign-in so.
      if (p.kind === 'panel.connect.answer') {
        const q = p as unknown as { id?: string; yes?: boolean };
        const c = this.connects.get(String(q.id ?? ''));
        if (!c) return void res.status(404).json({ error: 'that sign-in has gone (they last 15 minutes)' });
        this.connects.delete(String(q.id));
        this.touch();
        const code = randomBytes(9).toString('base64url');
        if (q.yes) this.invites.set(code, { label: c.app, until: Date.now() + 15 * 60_000 });
        const house = this.o.publicUrl!.replace(/\/$/, '');
        const r2 = await fetch(c.back, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q.yes ? { ask: c.ask, house, code } : { ask: c.ask, house, refused: true }), signal: AbortSignal.timeout(20_000) }).catch((e: Error) => ({ ok: false, json: async () => ({ error: e.message }) }) as Response);
        const said = (await r2.json().catch(() => ({}))) as { ok?: boolean; error?: string; name?: string };
        if (!r2.ok) { this.invites.delete(code); return void res.status(502).json({ error: said.error ?? 'the sign-in didn\'t take it' }); }
        return void res.json({ ok: true, ...(said.name ? { name: said.name } : {}) });
      }
      if (p.kind === 'panel.assistant.invite') {
        // Fifteen minutes, one use: long enough to paste into a chat with your agent.
        const code = randomBytes(9).toString('base64url');
        this.invites.set(code, { label: String((p as unknown as { label?: string }).label ?? 'my assistant').slice(0, 60), until: Date.now() + 15 * 60_000 });
        return void res.json({ code, until: new Date(Date.now() + 15 * 60_000).toISOString() });
      }
      if (p.kind === 'panel.assistant.revoke') {
        const kid = String((p as unknown as { kid?: string }).kid ?? '');
        // Its badge goes with its key: the bit on the status list is set, so no payments agent pays the house through it.
        for (const k of kid === 'all' ? [...this.assistants.keys()] : [kid]) if (this.assistants.has(k)) this.revokedIds.add(`assistant:${k}`);
        await this.o.saveRevoked([...this.revokedIds]);
        const gone = kid === 'all' ? this.assistants.size : Number(this.assistants.delete(kid));
        if (kid === 'all') this.assistants.clear();
        await this.o.saveAssistants?.([...this.assistants.values()]);
        return void res.json({ revoked: gone });
      }
      // AI on duty: the owner signs what it may do while they're away; the grant comes with a one-time code for the runner.
      if (p.kind === 'panel.duty.draft') {
        const q = p as unknown as { kinds?: unknown; cap?: number; days?: number; hours?: { from?: string; to?: string; tz?: string } };
        const kinds = Array.isArray(q.kinds) ? [...new Set(q.kinds.map(String))] : [];
        if (!kinds.length || kinds.some((k) => !DUTY_KINDS.includes(k as DutyKind))) return void res.status(400).json({ error: `kinds: one or more of ${DUTY_KINDS.join(', ')} (never money)` });
        const cap = Math.round(Number(q.cap ?? 10)), days = Math.round(Number(q.days ?? 7));
        if (!(cap >= 1 && cap <= 50)) return void res.status(400).json({ error: 'cap: 1 to 50 actions a night' });
        if (!(days >= 1 && days <= 31)) return void res.status(400).json({ error: 'days: 1 to 31' });
        let hours: { from: string; to: string; tz: string } | undefined;
        if (q.hours) {
          const ok = (t?: string) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
          let tzOk = false;
          try { new Intl.DateTimeFormat('en', { timeZone: String(q.hours.tz) }); tzOk = !!q.hours.tz; } catch { /* checked below */ }
          if (!ok(q.hours.from) || !ok(q.hours.to) || q.hours.from === q.hours.to || !tzOk) return void res.status(400).json({ error: 'hours: { from: "22:00", to: "07:00", tz: "Australia/Brisbane" }' });
          hours = { from: q.hours.from!, to: q.hours.to!, tz: String(q.hours.tz) };
        }
        if (!this.o.statusUrl) return void res.status(501).json({ error: 'this house cannot keep a duty grant' });
        const statusId = `duty:${randomBytes(6).toString('hex')}`;
        const draft = dutyDraft(this.o.webId, { kinds: kinds as DutyKind[], cap, until: new Date(Date.now() + days * 86_400_000), ...(hours ? { hours } : {}) }, statusEntry(this.o.statusUrl(), await this.statusIndex(statusId)));
        this.dutyDrafts.set(statusId, { statusId, draft });
        return void res.json({ id: statusId, draft, note: 'sign it on this device and send it back with panel.duty.set' });
      }
      if (p.kind === 'panel.duty.set') {
        const q = p as unknown as { id?: string; credential?: string; label?: string; runner?: string };
        const d = this.dutyDrafts.get(String(q.id ?? ''));
        if (q.runner === 'house' && !(await this.o.dutyRunner?.status())?.can) return void res.status(400).json({ error: 'this house has no model to run your AI with: connect your own first' });
        if (!d) return void res.status(404).json({ error: 'no duty draft with that id: start again' });
        let vc;
        try { vc = await verifyCredential(String(q.credential ?? ''), this.ownerJwk); } catch { return void res.status(403).json({ error: 'the duty grant is not signed by your key' }); }
        const same = ['issuer', 'type', 'credentialSubject', 'credentialStatus'].every((k) => JSON.stringify((vc as unknown as Record<string, unknown>)[k]) === JSON.stringify(d.draft[k]));
        if (!same) return void res.status(400).json({ error: 'the duty grant does not match its draft' });
        const sub = vc.credentialSubject as unknown as { kinds: DutyKind[]; cap: number; until: string; hours?: Duty['hours'] };
        const duty: Duty = { statusId: d.statusId, credential: String(q.credential), kinds: sub.kinds, cap: sub.cap, until: sub.until, ...(sub.hours ? { hours: sub.hours } : {}), at: new Date().toISOString() };
        this.dutyDrafts.delete(d.statusId);
        const code = randomBytes(9).toString('base64url');
        this.invites.set(code, { label: String(q.label ?? 'AI on duty').slice(0, 60), until: Date.now() + 15 * 60_000, duty });
        // "Run it in my house": the house's own runner takes the code now, so nothing is copied anywhere.
        if (q.runner === 'house') { await this.o.dutyRunner!.start(code); return void res.json({ ok: true, runner: 'house', note: 'your house runs your AI on duty now, under the grant you signed' }); }
        return void res.json({ ok: true, code, until: new Date(Date.now() + 15 * 60_000).toISOString(), note: 'give this code to your AI on duty (it works once, for 15 minutes)' });
      }
      if (p.kind === 'panel.duty.off') {
        const kid = String((p as unknown as { kid?: string }).kid ?? '');
        const on = [...this.assistants.values()].filter((a) => a.duty && (!kid || a.kid === kid) && !this.isRevoked(a.duty.statusId));
        for (const a of on) await this.dutyOff(a, 'your human took you off duty');
        // With nobody left on duty, the house's own runner stops too (it would only look, but a model costs nothing asleep).
        if (![...this.assistants.values()].some((a) => a.duty && !this.isRevoked(a.duty.statusId) && !a.duty.off)) this.o.dutyRunner?.stop();
        return void res.json({ ok: true, off: on.length });
      }
      // Where the owner's AI on duty can run, and with whose model (never the key).
      if (p.kind === 'panel.duty.runner') return void res.json((await this.o.dutyRunner?.status()) ?? { can: false, model: null, running: false });
      // The owner's own model for the house to run their AI with: a key for Anthropic's API, kept in the house's data folder.
      if (p.kind === 'panel.model.set') {
        if (!this.o.dutyRunner) return void res.status(400).json({ error: 'this house can\'t run an AI' });
        const q = p as unknown as { provider?: string; key?: string; model?: string };
        if (q.provider !== 'anthropic') return void res.status(400).json({ error: 'provider: "anthropic" (Claude, with your API key)' });
        const key = String(q.key ?? '').trim();
        if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return void res.status(400).json({ error: 'that doesn\'t look like an Anthropic API key (it starts sk-ant-)' });
        const model = q.model ? String(q.model).trim() : undefined;
        if (model && !/^claude-[a-z0-9.-]{3,40}$/.test(model)) return void res.status(400).json({ error: 'model: a Claude model id, like claude-opus-5-5' });
        await this.o.dutyRunner.setModel({ provider: 'anthropic', apiKey: key, ...(model ? { model } : {}) });
        return void res.json({ ok: true, ...(await this.o.dutyRunner.status()) });
      }
      if (p.kind === 'panel.model.clear') {
        await this.o.dutyRunner?.setModel(null);
        return void res.json({ ok: true, ...((await this.o.dutyRunner?.status()) ?? {}) });
      }
      if (p.kind === 'panel.duty.log') {
        const since = Number((p as unknown as { since?: number }).since) || Date.now() - 24 * 3_600_000;
        const duties = [...this.assistants.values()].filter((a) => a.duty).map((a) => ({ kid: a.kid, label: a.label, seenAt: a.seenAt, kinds: a.duty!.kinds, cap: a.duty!.cap, until: a.duty!.until, ...(a.duty!.hours ? { hours: a.duty!.hours } : {}), state: this.dutyState(a), ...(a.duty!.off ? { off: a.duty!.off } : {}), ...(a.duty!.runner ? { runner: a.duty!.runner } : {}), summary: this.dutySummary(a, since) }));
        return void res.json({ duties, entries: this.dutyLog.filter((e) => Date.parse(e.at) >= since) });
      }
      if (p.kind === 'panel.duty.undo') {
        // Undo what the protocol lets be undone: the house's own (an agenda entry, a standing yes); the rest by the AI's
        // connector (unblock, a correction sent). A second undo in a night takes the AI off duty: the owner disagrees.
        const e = this.dutyLog.find((x) => x.id === String((p as unknown as { entry?: string }).entry ?? ''));
        if (!e?.undo) return void res.status(404).json({ error: 'nothing to undo for that entry' });
        if (e.undone) return void res.status(409).json({ error: 'already undone' });
        const a = this.assistants.get(e.by);
        if (e.undo.kind === 'agenda') { this.agenda = this.agenda.filter((x) => x.id !== e.undo!.ref); await this.saveAgenda(); }
        if (e.undo.kind === 'standing' && e.to?.key) await this.o.panel?.removeStanding?.(e.to.key);
        e.undone = new Date().toISOString();
        await this.saveDuty();
        this.news({ about: 'duty.undo', entry: { id: e.id, tool: e.tool, action: e.action, ...(e.to ? { to: e.to } : {}), undo: e.undo }, note: 'your human undid this: your connector does its part (unblock, or tell the other side)' }, e.by);
        if (a?.duty) {
          const start = this.nightStart(a.duty);
          if (this.dutyLog.filter((x) => x.by === a.kid && x.undone && Date.parse(x.undone) >= start).length >= 2 && !this.isRevoked(a.duty.statusId)) await this.dutyOff(a, 'your human undid two things tonight: off duty until they put you back on');
        }
        return void res.json({ ok: true, undone: e.id });
      }
      if (p.kind === 'panel.allowance.draft') {
        const q = p as unknown as { kid?: string; amount?: number; amountUsd?: number; currency?: string; days?: number };
        const a = this.assistants.get(String(q.kid ?? ''));
        const amount = Number(q.amount ?? q.amountUsd), days = Number(q.days ?? 7), currency = q.currency ?? 'USD';
        if (!a?.webId) return void res.status(400).json({ error: a ? 'that assistant connected before allowances existed: reconnect it with a new code' : 'no assistant with that key' });
        if (!isCurrency(currency)) return void res.status(400).json({ error: 'currency: a three-letter code, like USD or AUD' });
        if (!(amount > 0 && amount <= MAX_ALLOWANCE)) return void res.status(400).json({ error: `amount: more than 0, at most ${MAX_ALLOWANCE}` });
        if (!(days >= 1 && days <= MAX_ALLOWANCE_DAYS)) return void res.status(400).json({ error: `days: 1 to ${MAX_ALLOWANCE_DAYS}` });
        if (!this.o.statusUrl) return void res.status(501).json({ error: 'this house cannot keep allowances' });
        const statusId = `allowance:${randomBytes(6).toString('hex')}`;
        const draft = allowanceDraft(this.o.webId, a.webId, amount, new Date(Date.now() + days * 86_400_000), statusEntry(this.o.statusUrl(), await this.statusIndex(statusId)), currency);
        this.allowanceDrafts.set(statusId, { kid: a.kid, statusId, draft });
        return void res.json({ id: statusId, draft, note: 'sign it on this device and send it back with panel.allowance.set' });
      }
      if (p.kind === 'panel.allowance.set') {
        const q = p as unknown as { id?: string; credential?: string };
        const d = this.allowanceDrafts.get(String(q.id ?? ''));
        if (!d) return void res.status(404).json({ error: 'no allowance draft with that id: start again' });
        let vc;
        try {
          vc = await verifyCredential(String(q.credential ?? ''), this.ownerJwk);
        } catch {
          return void res.status(403).json({ error: 'the allowance is not signed by your key' });
        }
        // Exactly what was drafted: same assistant, amount, expiry and status bit.
        const same = ['issuer', 'type', 'credentialSubject', 'credentialStatus'].every((k) => JSON.stringify((vc as unknown as Record<string, unknown>)[k]) === JSON.stringify(d.draft[k]));
        if (!same) return void res.status(400).json({ error: 'the allowance does not match its draft' });
        const s = vc.credentialSubject as unknown as { budget: { amount: number; currency: string }; intent_expiry: string };
        const old = this.allowances.get(d.kid);
        if (old) await this.revoke(old.statusId);
        this.allowances.set(d.kid, { kid: d.kid, credential: String(q.credential), statusId: d.statusId, amount: s.budget.amount, currency: s.budget.currency, until: s.intent_expiry, at: new Date().toISOString() });
        this.allowanceDrafts.delete(d.statusId);
        await this.saveAllowances();
        this.news({ about: 'allowance', amount: s.budget.amount, currency: s.budget.currency, until: s.intent_expiry, note: 'your human signed you a spending allowance: lake_pay spends under it, in this currency. Within it, and in their free hours (lake_house free), you may say yes for them without asking: a booking, a purchase, a time to meet. Above it, about their data, or anything they would want to know first: ask them (lake_house_suggest)' }, d.kid);
        return void res.json({ ok: true, amount: s.budget.amount, currency: s.budget.currency, until: s.intent_expiry });
      }
      if (p.kind === 'panel.allowance.revoke') {
        const a = this.allowances.get(String((p as unknown as { kid?: string }).kid ?? ''));
        if (!a) return void res.status(404).json({ error: 'no allowance for that assistant' });
        await this.revoke(a.statusId);
        this.allowances.delete(a.kid);
        await this.saveAllowances();
        this.news({ about: 'allowance', revoked: true, note: 'your human took your spending allowance back' }, a.kid);
        return void res.json({ revoked: true, note: 'its bit is set on your house\'s status list: payments refuse it from now on' });
      }
      if (p.kind === 'panel.assistant.answer') {
        // The owner taps one of the choices a question offered; the assistants hear it (run 39's parcel favour waited
        // 17 minutes with no way to answer).
        // A choice, the owner's own words, or both (run 44: "the panel can't carry free text to me", so the assistant guessed
        // a café and deferred a bio). Words go to the assistant as the owner's; any note can be answered with them.
        const q = p as unknown as { id?: string; choice?: string; text?: string };
        const sug = this.suggestions.find((x) => x.id === q.id);
        const text = typeof q.text === 'string' ? q.text.trim().slice(0, 500) : '';
        if (!sug || (q.choice !== undefined && !sug.ask?.choices.includes(String(q.choice))) || (q.choice === undefined && !text)) return void res.status(400).json({ error: 'answer a note: one of its choices, your own words (text), or both' });
        if (q.choice !== undefined) sug.ask!.answered = String(q.choice);
        if (text) sug.reply = text;
        const er = sug.errand;
        if (er && q.choice !== undefined) {
          // "Ask my AI later" leaves it held for the assistant; anything else ends it, and Block blocks the one it waited on.
          if (q.choice === 'Ask my AI later') { delete sug.ask!.answered; er.state = 'held'; }
          else { er.state = q.choice === 'Block' ? 'closed' : 'answered'; er.ended = { at: new Date().toISOString(), how: q.choice === 'Block' ? 'blocked' : 'answered' }; }
          const blockUrl = er.arrivals.at(-1)?.from.url ?? er.with?.url;
          if (q.choice === 'Block' && blockUrl) this.news({ about: 'block', url: blockUrl, note: 'your human tapped Block on what came in on your errand: your connector turns its messages away from now on' }, sug.by);
        }
        await this.saveSuggestions();
        if (sug.ask?.private) this.news({ about: 'question.answered', suggestion: sug.id, question: sug.text.slice(0, 300), private: true, note: 'your human answered privately: the answer stays in their house. Send it into the secret count with lake_count { action: "answer", from_question: this id }: your connector sends it as the two shares, and you never see it' });
        else this.news({ about: 'question.answered', suggestion: sug.id, question: sug.text.slice(0, 300), ...(q.choice !== undefined ? { answer: String(q.choice) } : {}), ...(text ? { text, words: 'your human\'s own words' } : {}), ...(er ? { errand: this.errandNews(sug) } : {}) });
        return void res.json({ ok: true, ...(q.choice !== undefined ? { answered: String(q.choice) } : {}), ...(text ? { text } : {}) });
      }
      // Your key: a recovery code to write down, and a one-use link to move to another device.
      if (p.kind === 'panel.key') {
        const saved = JSON.parse(await readFile(this.recoveryFile(), 'utf8').catch(() => 'null')) as { at: string } | null;
        return void res.json({ recovery: saved ? { at: saved.at } : null });
      }
      if (p.kind === 'panel.recovery.make') {
        const raw = randomBytes(15);
        const code = Array.from(raw).map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
        const salt = randomBytes(16);
        await writeFile(this.recoveryFile(), JSON.stringify({ salt: salt.toString('base64'), hash: scryptSync(code, salt, 32).toString('base64'), at: new Date().toISOString() }), { mode: 0o600 });
        return void res.json({ code: code.match(/.{5}/g)!.join('-'), note: 'shown once: write it down. A new code replaces this one' });
      }
      if (p.kind === 'panel.pair.link') {
        this.token = await secret(join(this.o.dataDir, 'pairing-token'), true);
        this.tokenUntil = Date.now() + 30 * 60_000;
        return void res.json({ hash: `#pair=${this.token}`, until: new Date(this.tokenUntil).toISOString() });
      }
      // Notifications on this device: the house's public key to subscribe with, then the device's subscription (its push
      // service's address and keys), kept for up to five devices; a test; and off.
      // "Next time": after answering a request, the owner says what to do with the same from this agent. Always decline is a
      // mute (by key); always allow is a standing yes in their rules, below their own declines, for exactly what they
      // allowed (these fields or fewer, this long or shorter, at least this price), for 90 days.
      if (p.kind === 'panel.request.always') {
        const q = p as { request?: string; answer?: string };
        const req = this.pending.get(String(q.request ?? ''));
        if (!req) return void res.status(404).json({ error: 'no such request' });
        if (q.answer === 'decline') {
          const k = req.visitor.jkt ?? req.visitor.key;
          if (!k) return void res.status(400).json({ error: 'this request has no key to hold it against' });
          await this.mute(k);
          if (req.visitor.jkt) await this.o.panel?.removeStanding?.(req.visitor.jkt);
          this.news({ about: 'sender.muted', domain: req.visitor.domain, note: 'your human won\'t hear from this sender again: its requests, notes and knocks are declined at the door' });
          return void res.json({ ok: true, muted: req.visitor.domain });
        }
        if (q.answer !== 'allow') return void res.status(400).json({ error: 'answer: allow or decline' });
        if (!req.visitor.jkt || !this.o.panel?.addStanding) return void res.status(400).json({ error: 'a standing yes needs the agent\'s key, from a request it signed' });
        const ids = req.fields.filter((f) => identifyingFields().includes(f));
        if (ids.length) return void res.status(400).json({ error: `not for fields that identify you (${ids.join(', ')}): those are asked each time` });
        const price = req.price ?? { amount: req.priceUsd, currency: 'USD' };
        return void res.json(await this.o.panel.addStanding({ jkt: req.visitor.jkt, domain: req.visitor.domain, purpose: req.purpose, fields: req.fields, retention: req.retention, floor: price }));
      }
      if (p.kind === 'panel.standing') return void res.json({ standing: this.o.panel?.standing?.() ?? [] });
      if (p.kind === 'panel.standing.remove') {
        const q = p as { jkt?: string; purpose?: string };
        return void res.json((await this.o.panel?.removeStanding?.(String(q.jkt ?? ''), q.purpose ? String(q.purpose) : undefined)) ?? { ok: false, error: 'not here' });
      }
      if (p.kind === 'panel.push.key') return void res.json({ publicKey: (await this.pushes()).keys!.publicKey });
      if (p.kind === 'panel.push.subscribe') {
        const sub = (p as { subscription?: webpush.PushSubscription }).subscription;
        if (!sub || typeof sub.endpoint !== 'string' || !(/^https:\/\//.test(sub.endpoint) || (process.env.LAKE_PUSH_ALLOW_HTTP === '1' && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(sub.endpoint))) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return void res.status(400).json({ error: 'subscription: { endpoint (https), keys: { p256dh, auth } }' });
        const st = await this.pushes();
        st.subs = [...st.subs.filter((x) => x.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }].slice(-5);
        await this.savePushes();
        return void res.json({ ok: true, devices: st.subs.length });
      }
      if (p.kind === 'panel.push.off') {
        const st = await this.pushes();
        const endpoint = String((p as { endpoint?: unknown }).endpoint ?? '');
        st.subs = endpoint ? st.subs.filter((x) => x.endpoint !== endpoint) : [];
        await this.savePushes();
        return void res.json({ ok: true, devices: st.subs.length });
      }
      if (p.kind === 'panel.push.test') {
        this.pushedAt.delete('test');
        this.notifyOwner('test', 'Notifications are on. This is what they look like.');
        return void res.json({ ok: true, devices: (await this.pushes()).subs.length });
      }
      if (p.kind === 'panel.stream') {
        const t = randomBytes(16).toString('base64url');
        for (const [k, until] of this.streamTokens) if (until < Date.now()) this.streamTokens.delete(k);
        this.streamTokens.set(t, Date.now() + 60_000);
        return void res.json({ path: `stream?t=${t}`, version: this.version });
      }
      if (p.kind === 'panel.agenda.feed') {
        // The owner's calendar subscribes to this address; a reset makes the old one stop working.
        if ((p as unknown as { reset?: boolean }).reset) this.feedKey = await secret(join(this.o.dataDir, 'agenda-feed-key'), true);
        const base = this.o.panel?.door?.().address;
        return void res.json({ ok: true, path: `/owner/agenda.ics?key=${this.feedKey}`, ...(base ? { url: `${base}/owner/agenda.ics?key=${this.feedKey}` } : {}) });
      }
      if (p.kind === 'panel.agenda.remove') {
        const id = String((p as unknown as { id?: string }).id ?? '');
        this.agenda = this.agenda.filter((x) => x.id !== id);
        await this.saveAgenda();
        return void res.json({ ok: true });
      }
      if (p.kind === 'panel.note.mute') {
        const note = this.notes.find((x) => x.id === String((p as unknown as { id?: string }).id ?? ''));
        if (!note?.from.key) return void res.status(404).json({ error: 'no note at the door with that id' });
        await this.mute(note.from.key);
        this.news({ about: 'sender.muted', domain: note.from.domain, note: 'your human won\'t hear from this sender again: its notes and knocks are declined at the door' });
        return void res.json({ ok: true, muted: note.from.domain });
      }
      if (p.kind === 'panel.note.reply') {
        const q = p as unknown as { id?: string; text?: string };
        // A note an agent left ("ping stan"): the owner's answer goes back to it, signed by this house, from their phone.
        const lakeNote = this.notes.find((x) => x.id === String(q.id ?? '') && !x.from.web);
        if (lakeNote) {
          const text = String(q.text ?? '').trim().slice(0, 1000);
          if (!text) return void res.status(400).json({ error: 'text: the answer, up to 1000 characters' });
          if (!lakeNote.from.url) return void res.status(400).json({ error: 'that note came with no address to answer' });
          const sent = await this.o.panel?.replyAgent?.(lakeNote.from.url, { kind: 'note.reply', note: lakeNote.id, text, re: lakeNote.text.slice(0, 200) }).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }) as Record<string, any>);
          if (!sent || sent.kind === 'refused' || sent.kind === 'rejected') return void res.status(502).json({ error: `their agent didn't take it: ${JSON.stringify(sent?.problems ?? sent?.why ?? 'no answer')}` });
          lakeNote.answered = { text, by: 'you', at: new Date().toISOString() };
          if (lakeNote.from.key && !this.contacts.has(lakeNote.from.key)) { this.contacts.set(lakeNote.from.key, { name: lakeNote.from.name.slice(0, 80), webId: String(lakeNote.from.webId ?? '').slice(0, 300), at: new Date().toISOString() }); await this.saveDuty(); }
          void this.saveNotes();
          this.touch();
          return void res.json({ ok: true });
        }
        const r = this.answerWebNote(String(q.id ?? ''), String(q.text ?? ''), 'you');
        return void res.status('error' in r ? 400 : 200).json(r);
      }
      if (p.kind === 'panel.note.dismiss') {
        const id = String((p as unknown as { id?: string }).id ?? '');
        const gone = this.notes.find((x) => x.id === id);
        if (gone) this.closedNotes.set(id, { by: gone.from.webId, state: 'seen and set aside by the owner' });
        this.notes = this.notes.filter((x) => x.id !== id);
        void this.saveNotes();
        return void res.json({ ok: true });
      }
      // The owner's one tap on a warning (run 65: an assistant warned, and its human had no way to act on it): the
      // assistant's connector is told, by this house, to turn that agent's messages away from now on.
      if (p.kind === 'panel.assistant.block') {
        const sug = this.suggestions.find((x) => x.id === String((p as unknown as { id?: string }).id ?? ''));
        if (!sug?.sender) return void res.status(404).json({ error: 'no warning with that id' });
        if (!/^https?:\/\//.test(sug.sender)) return void res.status(400).json({ error: 'the warning names no address to block: ask your agent to block it (lake_block)' });
        this.news({ about: 'block', url: sug.sender, note: 'your human tapped Block on your warning: your connector turns its messages away from now on' }, sug.by);
        this.suggestions = this.suggestions.filter((x) => x.id !== sug.id);
        await this.saveSuggestions();
        this.touch();
        return void res.json({ ok: true });
      }
      if (p.kind === 'panel.assistant.dismiss') {
        const id = String((p as unknown as { id?: string }).id ?? '');
        const gone = this.suggestions.find((x) => x.id === id);
        this.suggestions = this.suggestions.filter((x) => x.id !== id);
        await this.saveSuggestions();
        if (gone?.errand && (gone.errand.state === 'open' || gone.errand.state === 'held')) {
          gone.errand.state = 'closed'; gone.errand.ended = { at: new Date().toISOString(), how: 'owner' };
          this.news({ about: 'errand.ended', errand: this.errandNews(gone) }, gone.by);
        }
        return void res.json({ ok: true });
      }
      if (p.kind === 'list') return void res.json(this.view(!!(signer !== this.ownerJwk?.kid)));
      if (p.kind === 'answer') return void res.json(await this.answer(p.request ?? '', p.answer ?? '', p.grant));
      if (p.kind === 'revoke') return void res.json({ revoked: await this.revoke(p.revoke ?? 'all') });
      if (p.kind === 'release' && this.o.leaseHours) {
        await this.release();
        return void res.json({ released: true });
      }
      const panel = this.o.panel;
      if (panel && typeof p.kind === 'string' && p.kind.startsWith('panel.')) {
        const q = p as unknown as { text?: string; pack?: string; terms?: Record<string, string | number>; offer?: string };
        // A panel action that can't be done says why, instead of failing the request.
        const answer = await ({
          'panel.overview': () => panel.overview(Number((q as { tz_offset?: number }).tz_offset)),
          'panel.rules': () => panel.rules(),
          'panel.door': async () => panel.door?.() ?? { error: 'this house has no door' },
          // The owner's free slots, around what is already in their agenda: what their assistant may offer (runs 49-50).
          'panel.free': async () => {
            const av = panel.availability?.();
            if (!av) return { set: false, slots: [], note: 'your human hasn\'t said when they are free to meet (control panel, Rules: When you\'re free): ask them for a time' };
            return { set: true, tz: av.tz, meetings: av.meetings ?? 60, slots: freeSlots(av, this.agenda.filter((x) => x.start).map((x) => ({ start: x.start!, ...(x.minutes ? { minutes: x.minutes } : {}) }))), note: 'free in their agenda now: offer a few. The one you offer, write in at once (lake_house_suggest agenda with start): it holds the time, as proposed; when they agree, add their message (agenda { id, agreed_in })' };
          },
          'panel.availability.set': async () => {
            const av = (q as { availability?: unknown }).availability;
            if (av === null) return panel.setAvailability?.(null) ?? { error: 'this house has no availability' };
            const problems = availabilityProblems(av);
            return problems.length ? { error: problems.join('; ') } : panel.setAvailability?.(av as Availability) ?? { error: 'this house has no availability' };
          },
          'panel.door.set': async () => panel.setDoor?.({ open: (q as { open?: unknown }).open === true, ...(typeof (q as { about?: unknown }).about === 'string' ? { about: String((q as { about: string }).about) } : {}), ...(typeof (q as { name?: unknown }).name === 'string' ? { name: String((q as { name: string }).name) } : {}), ...(typeof (q as { handle?: unknown }).handle === 'string' ? { handle: String((q as { handle: string }).handle) } : {}) }) ?? { error: 'this house has no door' },
          'panel.rules.set': () => panel.setRules(String(q.text ?? '')),
          'panel.activity': async () => panel.activity((q as { since?: number | string }).since),
          'panel.agents': async () => panel.agents(),
          'panel.money': () => panel.money(),
          'panel.consents': () => panel.consents(),
          'panel.access': async () => panel.access?.(Number((q as { tz_offset?: number }).tz_offset)) ?? { error: 'this house can\'t list access' },
          'panel.data': () => panel.data(),
          'panel.export': () => panel.exportAll(),
          'panel.market': () => panel.market(),
          'panel.intent.open': () => panel.openIntent(String(q.pack ?? ''), q.terms ?? {}),
          'panel.intent.close': () => panel.closeIntent(String(q.pack ?? '')),
          'panel.offer.accept': async () => {
            // Accepting releases the owner's facts at once; a price no assistant may pay leaves them out with nothing bought
            // (run 39: A$157.14 against an A$150 allowance). Said first; the owner may still go ahead.
            const price = panel.offerPrice?.(String(q.offer ?? ''));
            const live = [...this.allowances.values()].filter((a) => a.currency === price?.currency && Date.parse(a.until) > Date.now() && !this.isRevoked(a.statusId));
            const caps = live.map((a) => a.amount);
            // Only where the owner has an assistant pay in that currency: an owner with none pays themselves.
            if (price && caps.length && !(q as { even_over_allowance?: boolean }).even_over_allowance && caps.every((c) => c < price.amount)) {
              const top = live.reduce((x, y) => (y.amount > x.amount ? y : x));
              // Its assistant hears of it (run 48: the shop was refused at the owner's tap, and the assistant reported "no
              // answer yet"); the panel offers to raise that allowance in the same tap.
              this.news({ about: 'offer.over_allowance', offer: String(q.offer ?? ''), price, allowance: top.amount, note: 'your human tapped Accept, but it is more than you may spend: they were asked to raise your allowance or pay it themselves. Nothing is accepted yet' }, top.kid);
              return { error: `${price.currency} ${price.amount} is more than your assistant may spend (${price.currency} ${top.amount}): raise its allowance first, or accept even so (even_over_allowance) and pay it yourself`, code: 'over_allowance', price, allowance: { kid: top.kid, amount: top.amount } };
            }
            return panel.acceptOffer(String(q.offer ?? ''));
          },
          'panel.person.request': () => panel.requestPersonhood((q as { consent?: unknown }).consent, this.ownerJwk!),
          // A pledge with money (SPEC §11.4a): the house drafts the contribution for exactly this pledge, this device signs it,
          // and the house pays it held for the tally and signs. Without money, the tap is the signature.
          'panel.pledge.draft': async () => {
            const w = q as { tally?: string; id?: string };
            const terms = await panel.pledgeTerms?.(String(w.tally ?? ''), String(w.id ?? ''));
            if (!terms || terms.kind === 'refused') return { error: terms ? ((terms.problems as string[]) ?? ['refused']).join('; ') : 'this house can\'t read pledges' };
            if (!terms.money) return { free: true, terms };
            if (!this.o.statusUrl) return { error: 'this house cannot keep allowances' };
            const statusId = `pledge:${randomBytes(6).toString('hex')}`;
            const draft = pledgeDraft(this.o.webId, { tally: String(terms.tally), id: String(terms.id), text: String(terms.text) }, Number(terms.money.contribution.amount), String(terms.money.contribution.currency), new Date(Date.parse(String(terms.deadline)) + 2 * 86_400_000), statusEntry(this.o.statusUrl(), await this.statusIndex(statusId)));
            this.pledgeDrafts.set(statusId, { tally: String(w.tally), id: String(terms.id), draft });
            return { id: statusId, draft, terms, note: 'sign it on this device and send it back with panel.pledge.sign { draft, credential }' };
          },
          // A pledge's quorum question, answered on this device: the house sends it as a secret count's shares; nobody sees
          // it, the assistant included (it hears only that it was answered).
          'panel.pledge.quorum': async () => {
            const w = q as { tally?: string; id?: string; choice?: string; note?: string };
            const r = await panel.answerQuorum?.(String(w.tally ?? ''), String(w.id ?? ''), String(w.choice ?? '')) ?? { kind: 'refused', problems: ['this house can\'t answer a quorum'] };
            if (r.kind !== 'quorum.answered') return r;
            const sug = this.suggestions.find((x) => x.id === String(w.note ?? '') && x.pledge?.quorum);
            if (sug) {
              sug.pledge!.quorum!.answered = true;
              await this.saveSuggestions();
              this.news({ about: 'pledge.quorum.answered', pledge: sug.pledge!.id, tally: sug.pledge!.tally, note: 'your human answered the pledge\'s quorum question privately: you were not told the answer, and nobody else is. If enough people would join, the pledge opens for signing when its quorum closes: suggest it again then' }, sug.by);
            }
            return r;
          },
          // A promise circle (SPEC §11.4c): the owner calls on it, answers its asks, and says when help came. Each is a tap.
          'panel.circles': async () => ((await panel.circles?.()) ?? []).map((c) => { const x = c as { url: string; id: string }; const rule = this.circleRules.find((r) => r.tally === x.url && r.id === x.id); return rule ? { ...x, rule: { kinds: rule.kinds, perWeek: rule.perWeek } } : x; }),
          // "Say yes for me": a standing rule for one circle (perWeek 0 stops it).
          'panel.circle.rule': async () => {
            const w = q as { tally?: string; id?: string; kinds?: unknown; perWeek?: unknown };
            const perWeek = Number(w.perWeek ?? 0);
            if (!(Number.isInteger(perWeek) && perWeek >= 0 && perWeek <= 7)) return { error: 'perWeek: 0 (off) to 7' };
            const tally = String(w.tally ?? '').replace(/\/a2a\/?$/, ''), id = String(w.id ?? '');
            this.circleRules = this.circleRules.filter((r) => !(r.tally === tally && r.id === id));
            if (perWeek > 0) this.circleRules.push({ tally, id, ...(Array.isArray(w.kinds) && w.kinds.length ? { kinds: w.kinds.map(String) } : {}), perWeek, at: [] });
            await this.saveCircleRules();
            return { ok: true, perWeek };
          },
          // What the owner will help with, of the circle's kinds: calls for anything else never reach them.
          'panel.circle.offer': async () => {
            const w = q as { tally?: string; id?: string; kinds?: unknown };
            return panel.circleSend?.(String(w.tally ?? ''), { kind: 'circle.offer', id: String(w.id ?? ''), kinds: Array.isArray(w.kinds) ? w.kinds.map(String) : [] }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
          },
          'panel.circle.call': async () => {
            const w = q as { tally?: string; id?: string; need?: string; when?: string; help?: string; note?: string };
            // From an assistant's proposal: its circle, need and kind, sent once.
            const proposed = w.note ? this.suggestions.find((x) => x.id === w.note && x.circleCall && !x.circleCall.sent) : undefined;
            if (w.note && !proposed) return { error: 'no unsent proposal with that note' };
            if (proposed) { Object.assign(w, { tally: proposed.circleCall!.tally, id: proposed.circleCall!.id, need: proposed.circleCall!.need, help: proposed.circleCall!.help }); proposed.circleCall!.sent = true; await this.saveSuggestions(); }
            const tally = String(w.tally ?? '');
            const r = await panel.circleSend?.(tally, { kind: 'circle.call', id: String(w.id ?? ''), need: String(w.need ?? ''), ...(w.help ? { help: String(w.help) } : {}), ...(w.when ? { when: String(w.when) } : {}) }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
            if (r.kind === 'circle.called') await this.circleNote({ tally, id: String(w.id), call: String(r.call), need: String(w.need), ...(w.when ? { when: String(w.when) } : {}), role: 'caller', state: 'asking' }, `You asked your circle for: ${String(w.need).replace(/[.!?]+$/, '')}. ${r.asked} member${r.asked === 1 ? '' : 's'} asked, without your name; you hear when one says yes.`);
            return r;
          },
          'panel.circle.answer': async () => {
            const w = q as { note?: string; accept?: boolean; report?: boolean };
            const sug = this.suggestions.find((x) => x.id === String(w.note ?? '') && (x.circle?.role === 'ask' || x.circle?.role === 'pass' || x.circle?.role === 'vote'));
            if (!sug?.circle) return { error: 'no ask from your circle with that note' };
            if (sug.circle.state !== 'open') return { error: `it is ${sug.circle.state}` };
            const c = sug.circle;
            if (c.role === 'vote' && c.vote) {
              // Yes or no to a change in the circle's rules: sent as a secret count; nobody learns which.
              const r = await panel.voteCircle?.(c.tally, c.id, c.vote.id, w.accept === true) ?? { kind: 'refused', problems: ['this house can\'t vote'] };
              if (r.kind === 'circle.vote.answered') { c.state = 'accepted'; await this.saveSuggestions(); }
              return r;
            }
            if (c.role === 'pass' && c.pass) {
              // A favour passed to the owner to settle one owed to them: yes, and the house keeps the note as owed to them.
              const r = await panel.circleSend?.(c.tally, { kind: w.accept ? 'circle.pass.accept' : 'circle.pass.decline', id: c.id, pass: c.pass.id, settles: c.pass.settles }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
              if (r.kind === 'circle.pass.accepted') { await panel.fileFavour?.(c.pass.note, 'owed'); c.state = 'accepted'; }
              else if (r.kind === 'circle.pass.declined') c.state = 'declined';
              await this.saveSuggestions();
              return r;
            }
            const r = await panel.circleSend?.(c.tally, { kind: w.report ? 'circle.report' : w.accept ? 'circle.accept' : 'circle.decline', id: c.id, call: c.call }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
            if (r.kind === 'circle.matched') Object.assign(c, { state: 'accepted', contact: String(r.caller?.url ?? '') });
            else if (r.kind === 'circle.declined') c.state = 'declined';
            else if (r.kind === 'circle.reported') c.state = 'reported';
            else if (/taken/.test(JSON.stringify(r.problems ?? ''))) c.state = 'taken';
            await this.saveSuggestions();
            return r;
          },
          // It didn't go as it should: either side marks the call disputed; no favour is owed, and it counts against neither.
          // A change to a circle's rules, put to its members (SPEC §11.4c).
          'panel.circle.propose': async () => {
            const w = q as { tally?: string; id?: string; change?: unknown; note?: string };
            // From an assistant's proposal: its circle and change, sent once.
            const proposed = w.note ? this.suggestions.find((x) => x.id === w.note && x.circleVote && !x.circleVote.sent) : undefined;
            if (w.note && !proposed) return { error: 'no unsent proposal with that note' };
            if (proposed) { Object.assign(w, { tally: proposed.circleVote!.tally, id: proposed.circleVote!.id, change: proposed.circleVote!.change }); proposed.circleVote!.sent = true; await this.saveSuggestions(); }
            return panel.circleSend?.(String(w.tally ?? ''), { kind: 'circle.propose', id: String(w.id ?? ''), change: w.change ?? {} }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
          },
          // Bring someone onto the Lake: a one-time link to a house of their own (a hosted Lake; a few per owner).
          'panel.invite': async () => panel.invite?.() ?? { error: 'this house can\'t invite' },
          'panel.favour.pay': async () => {
            const sug = this.suggestions.find((x) => x.id === String((q as { note?: string }).note ?? '') && x.favourPay && !x.favourPay.paid);
            if (!sug?.favourPay) return { error: 'no unpaid cart with that note' };
            const r = await panel.payWithFavour?.(sug.favourPay.cart, sug.favourPay.seller) ?? { kind: 'refused', problems: ['this house can\'t pay with favours'] };
            if (r.kind === 'circle.paid') { sug.favourPay.paid = true; await this.saveSuggestions(); this.news({ about: 'favour.paid', cart: r.cart, note: 'your human paid it with a favour owed to them: the seller has the tally\'s receipt' }, sug.by); }
            return r;
          },
          // Who answers a conversation: the owner, or their AI on duty (by the sender's key).
          // Read up to here: a badge counts only what came after (8 Nov: it counted every message never answered).
          'panel.chat.seen': async () => {
            const w = q as { key?: string; at?: string };
            const key = String(w.key ?? '').slice(0, 300), at = String(w.at ?? '');
            if (!key || !Number.isFinite(Date.parse(at))) return { error: 'chat.seen: { key, at }' };
            if ((this.chatSeen[key] ?? '') < at) { this.chatSeen[key] = at; const keys = Object.keys(this.chatSeen); if (keys.length > 2000) delete this.chatSeen[keys[0]!]; await this.saveChatSeen(); }
            return { ok: true };
          },
          'panel.chat.mode': async () => {
            const w = q as { key?: string; mode?: string };
            const key = String(w.key ?? '');
            if (!key || !['ai', 'me'].includes(String(w.mode))) return { error: 'chat.mode: { key, mode: "ai" | "me" }' };
            this.chatModes[key] = w.mode as 'ai' | 'me';
            await this.saveChatModes();
            return { ok: true, mode: w.mode };
          },
          // Buying what a shop offered for a want (SPEC §6.8): the house drafts a purchase for exactly that cart, this device
          // signs it, and the house pays it, held until the owner says it arrived.
          'panel.want.close': async () => ((await panel.closeWant?.(String((q as { id?: string }).id ?? ''))) ? { ok: true } : { error: 'no want with that id' }),
          'panel.want.draft': async () => {
            const w = q as { want?: string; offer?: string };
            const offer = panel.wantOffer?.(String(w.want ?? ''), String(w.offer ?? ''));
            if (!offer || offer.state !== 'open') return { error: 'that offer is not open' };
            if (Date.parse(offer.expires) < Date.now() + 60_000) return { error: `${offer.seller.name}'s offer has run out: they can send it again` };
            if (!this.o.statusUrl) return { error: 'this house cannot pay' };
            const statusId = `buy:${randomBytes(6).toString('hex')}`;
            const draft = purchaseDraft(this.o.webId, { id: offer.cart.contents.id, merchant: offer.seller.name, total: offer.total }, new Date(Date.now() + 3_600_000), statusEntry(this.o.statusUrl(), await this.statusIndex(statusId)));
            this.buyDrafts.set(statusId, { want: String(w.want), offer: offer.id, draft });
            return { id: statusId, draft };
          },
          'panel.want.buy': async () => {
            const w = q as { draft?: string; credential?: string };
            const d = this.buyDrafts.get(String(w.draft ?? ''));
            if (!d) return { error: 'no purchase drafted with that id: start again' };
            let vc;
            try { vc = await verifyCredential(String(w.credential ?? ''), this.ownerJwk!); } catch { return { error: 'the purchase is not signed by your key' }; }
            if (!['issuer', 'type', 'credentialSubject', 'credentialStatus'].every((k) => JSON.stringify((vc as unknown as Record<string, unknown>)[k]) === JSON.stringify((d.draft as Record<string, unknown>)[k]))) return { error: 'the purchase does not match its draft' };
            if (!this.o.vouchOwner || !panel.buyWant) return { error: 'this house cannot pay' };
            this.buyDrafts.delete(String(w.draft));
            const r = await panel.buyWant(d.want, d.offer, { credential: String(w.credential), owner: await this.o.vouchOwner(this.ownerJwk!) });
            if (!r.error) this.news({ about: 'want.bought', want: d.want, offer: d.offer, note: 'your human bought it on their phone: paid by the house, held until they say it arrived. Nothing for you to pay.' });
            return r;
          },
          // Where to send what the owner buys (SPEC §6.8): the owner's own; an assistant key can neither read nor set it.
          'panel.address': async () => ({ address: (await panel.deliveryAddress?.()) ?? null }),
          'panel.address.set': async () => {
            const a = (q as { address?: unknown }).address;
            if (a === null) { await panel.setDeliveryAddress?.(null); return { ok: true, address: null }; }
            const problems = postalAddressProblems(a);
            if (problems.length) return { kind: 'refused', problems };
            const tidy = postalAddress(a as Record<string, unknown>);
            if (!panel.setDeliveryAddress) return { error: 'this house can\'t keep an address' };
            await panel.setDeliveryAddress(tidy);
            return { ok: true, address: tidy };
          },
          'panel.want.arrived': async () => panel.wantArrived?.(String((q as { want?: string }).want ?? '')) ?? { error: 'this house can\'t' },
          'panel.favour.pass': async () => panel.passFavour?.() ?? { kind: 'refused', problems: ['this house can\'t pass favours on'] },
          'panel.circle.dispute': async () => {
            const sug = this.suggestions.find((x) => x.id === String((q as { note?: string }).note ?? '') && (x.circle?.role === 'caller' || (x.circle?.role === 'ask' && x.circle.state === 'accepted')));
            if (!sug?.circle) return { error: 'no call of yours, or one you took, with that note' };
            const r = await panel.circleSend?.(sug.circle.tally, { kind: 'circle.dispute', id: sug.circle.id, call: sug.circle.call }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
            if (r.kind === 'circle.disputed') { sug.circle.state = 'disputed'; await this.saveSuggestions(); }
            return r;
          },
          'panel.circle.kept': async () => {
            const sug = this.suggestions.find((x) => x.id === String((q as { note?: string }).note ?? '') && x.circle?.role === 'caller');
            if (!sug?.circle) return { error: 'no call of yours with that note' };
            const c = sug.circle;
            const withdraw = (q as { withdraw?: boolean }).withdraw;
            // Thanks, as a favour note this house signs for its owner: one favour, to the member who helped.
            const note = !withdraw && c.contactWebId ? await panel.favourNote?.({ tally: c.tally, id: c.id, call: c.call, helper: c.contactWebId, need: c.need, ...(c.help ? { help: c.help } : {}) }) : undefined;
            const r = await panel.circleSend?.(c.tally, { kind: withdraw ? 'circle.withdraw' : 'circle.kept', id: c.id, call: c.call, ...(note ? { note } : {}) }) ?? { kind: 'refused', problems: ['this house can\'t reach circles'] };
            if (r.kind === 'circle.kept') c.state = 'done';
            if (r.kind === 'circle.withdrawn') c.state = 'withdrawn';
            await this.saveSuggestions();
            return r;
          },
          // A count answered from the owner's own record, on their tap: the house finds the answer and sends the shares;
          // the assistant hears only that it was answered.
          'panel.count.answer': async () => {
            const sug = this.suggestions.find((x) => x.id === String((q as { note?: string }).note ?? '') && x.count);
            if (!sug?.count) return { error: 'no count with that note' };
            if (sug.count.answered) return { error: 'answered already: a count takes one answer from each house' };
            const r = await this.o.panel?.answerFromRecord?.(sug.count) ?? { kind: 'refused', problems: ['this house can\'t answer counts'] };
            if (r.kind !== 'count.answered') return r;
            sug.count.answered = true;
            await this.saveSuggestions();
            this.news({ about: 'count.answered', count: sug.count.id, field: sug.count.field, note: 'your human counted it in, from their own record: it left their house only as two unreadable shares, and you were not told what it was' }, sug.by);
            return r;
          },
          'panel.pledge.sign': async () => {
            const w = q as { tally?: string; id?: string; draft?: string; credential?: string };
            if (!w.draft) return panel.signPledge(String(w.tally ?? ''), String(w.id ?? ''));
            const d = this.pledgeDrafts.get(String(w.draft));
            if (!d) return { error: 'no contribution drafted with that id: start again' };
            let vc;
            try { vc = await verifyCredential(String(w.credential ?? ''), this.ownerJwk!); } catch { return { error: 'the contribution is not signed by your key' }; }
            if (!['issuer', 'type', 'credentialSubject', 'credentialStatus'].every((k) => JSON.stringify((vc as unknown as Record<string, unknown>)[k]) === JSON.stringify(d.draft[k]))) return { error: 'the contribution does not match its draft' };
            if (!this.o.vouchOwner) return { error: 'this house cannot pay' };
            this.pledgeDrafts.delete(String(w.draft));
            return panel.signPledge(d.tally, d.id, { credential: String(w.credential), owner: await this.o.vouchOwner(this.ownerJwk!) });
          },
          'panel.pledge.reveal': () => panel.revealPledge(String((q as { tally?: string }).tally ?? ''), String((q as { id?: string }).id ?? '')),
          'panel.pledge.withdraw': async () => panel.withdrawPledge?.(String((q as { tally?: string }).tally ?? ''), String((q as { id?: string }).id ?? '')) ?? { error: 'this house can\'t take a signature back' },
        } as Record<string, () => Promise<unknown>>)[p.kind]?.().catch((e: Error) => ({ error: e.message }));
        if (answer !== undefined && p.kind === 'panel.offer.accept' && !(answer as { error?: string }).error) {
          // The assistant that suggested it is the one to pay: what was accepted, from whom, and the quoter's answer (its order).
          const x = answer as { id: string; title: string; quoter: { name: string; url: string }; result: { outputs: Record<string, number> }; labels?: Record<string, { label: string; unit?: string }>; currency?: string; answer?: Record<string, unknown> };
          this.news({ about: 'offer.accepted', offer: x.id, title: x.title, from: x.quoter, outputs: x.result.outputs, labels: x.labels, currency: x.currency, answer: x.answer, note: (x.answer as { cart?: string } | undefined)?.cart
            ? `your human accepted this offer themselves, on their phone. The shop has sent you a signed cart for exactly it (cart ${(x.answer as { cart: string }).cart}): pay it with lake_buy { action: "pay", cart }, with the money held until you accept the delivery. Tell your human it is paid and held until it arrives.`
            : 'your human accepted this offer themselves, on their phone: pay it with lake_pay, naming the order. When you tell them, be exact: it pays outright (an accepted offer is no cart, so nothing holds the money until delivery), and the delivery happens outside the Lake.' });
        }
        if (answer !== undefined) return void res.status((answer as { error?: string }).error ? 400 : 200).json(answer);
      }
      res.status(400).json({ error: 'unknown request' });
    });

    // The machine's operator (whoever holds the house's data folder) may pull every key at once.
    r.post('/operator/revoke-all', async (req, res) => {
      if (req.get('x-lake-operator') !== this.operatorToken) return void res.status(403).json({ error: 'operator token required' });
      res.json({ revoked: await this.revoke('all') });
    });

    if (appDir) r.use(express.static(appDir, { index: 'approvals.html' }));
    return r;
  }

  /** What the panel lists; for an assistant, a private answer shows only that it was given. */
  view(forAssistant = false) {
    return {
      webId: this.o.webId,
      until: this.leaseUntil()?.toISOString() ?? null,
      requests: [...this.pending.values()].filter((x) => x.status === 'pending'),
      connects: [...this.connects].filter(([, c]) => Date.now() - c.at < 15 * 60_000).map(([id, c]) => ({ id, app: c.app, from: c.from, number: c.number, at: new Date(c.at).toISOString() })),
      assistants: [...this.assistants.values()].map(({ kid, label, addedAt, seenAt, webId }) => { const a = this.allowanceFor(kid), w = this.waitingFor.get(kid); return { kid, label, addedAt, seenAt, ...(w ? { waiting: w } : {}), canHaveAllowance: !!webId, ...(a ? { allowance: { amount: a.amount, currency: a.currency, until: a.until } } : {}) }; }),
      suggestions: forAssistant ? this.suggestions.map((x) => { const y = x.ask?.private && x.ask.answered ? { ...x, ask: { ...x.ask, answered: 'answered privately' } } : x; if (!y.count?.mine) return y; const { mine: _m, ...c } = y.count; return { ...y, count: c }; }) : this.suggestions,
      // Answered: a reply in its thread after it (not the sender's own follow-up).
      // What the owner is looking for, and what shops offered (the signed carts stay in the house).
      wants: (this.o.panel?.wantsList?.() ?? []).filter((r) => !r.closed || Date.parse(r.closed) > Date.now() - 86_400_000).map((r) => ({ want: r.want, ...(r.limit ? { limit: r.limit } : {}), closed: r.closed, bought: r.bought, at: r.at, offers: r.offers.map(({ cart, receipt, ...o }) => ({ ...o, cart: cart.contents.id })) })),
      seen: forAssistant ? undefined : this.chatSeen,
      notes: this.notes.map((n) => { const w = this.webNotes.get(n.id); const a = this.webNotes.get(w?.thread ?? n.id)?.answers?.filter((x) => x.by !== 'sender' && x.at >= n.at).at(-1); const known = this.knownBy(n.from.key), twin = known ? undefined : this.lookalike(n.from); return { ...n, ...(a ? { answered: a } : {}), known: !!known, ...(known ? { known_why: known } : twin ? { known_why: twin, lookalike: true } : {}), mode: (n.from.key ? this.chatModes[n.from.key] : undefined) ?? (known && !n.from.web ? 'ai' : 'me') }; }),
      agenda: this.agenda,
      keys: [...this.grants.values()].filter((g) => !g.revoked && Date.parse(g.until) > Date.now()).map(({ jws: _, ...g }) => g),
    };
  }

  private async answer(id: string, answer: string, grant?: string) {
    const req = this.pending.get(id);
    if (!req || req.status !== 'pending') return { error: 'no such pending request' };
    if (answer === 'deny') {
      req.status = 'denied';
      // A No to an agent ends any standing yes for it on this purpose: the owner changed their mind about it.
      if (req.visitor.jkt) void this.o.panel?.removeStanding?.(req.visitor.jkt, req.purpose);
      if (req.visitor.key) {
        const k = `${req.visitor.key}|${req.purpose}`, again = this.ownerSaidNo(req.visitor.key, req.purpose);
        this.ownerNos.set(k, { offerId: req.offerId, at: Date.now(), until: Date.now() + (again ? 30 : 7) * 86_400_000 });
        void this.saveOwnerNos();
      }
      this.o.emit(makeEvent('approval.answered', this.o.actor, `agent:${req.visitor.domain}`, { answer: 'Deny' }));
      this.news({ about: 'request.answered', request: id, by: req.visitor.domain, answer: 'deny' });
      return { ok: true };
    }
    if (answer !== 'allow' || !grant) return { error: 'allow needs a grant signed on your device' };
    // The grant must be signed by the owner's key and say exactly what the owner was shown.
    let vc;
    try {
      vc = await verifyCredential(grant, this.ownerJwk!);
    } catch {
      return { error: 'grant is not signed by your key' };
    }
    const s = readAccessGrant(vc);
    const until = Date.parse((vc as { validUntil?: string }).validUntil ?? '');
    const ok = !!s &&
      vc.issuer === this.o.webId && s.owner === this.o.webId && s.grantee === req.visitor.webId && s.offer === req.offerId &&
      s.purpose === req.purpose && (s.study ?? null) === req.study && s.fields.every((f) => req.fields.includes(f)) &&
      // Its bit on the status list is the one the house drafted, so anyone can check it hasn't been revoked.
      JSON.stringify((vc as { credentialStatus?: unknown }).credentialStatus) === JSON.stringify((req.grantDraft as { credentialStatus?: unknown } | undefined)?.credentialStatus) &&
      until > Date.now() && until <= Date.now() + MAX_GRANT_MS + 60_000;
    if (!ok) return { error: 'grant does not match the request you were shown' };
    await this.o.writeGrant(req.offerId, grant);
    await this.o.writeConsent?.(req.offerId, consentRecord({
      id: req.offerId, owner: this.o.webId, visitor: { webId: req.visitor.webId, domain: req.visitor.domain }, purpose: req.purpose, dpvPurpose: PURPOSES[req.purpose]?.dpv ? `dpv:${PURPOSES[req.purpose]!.dpv}` : undefined,
      fields: s!.fields, retention: req.retention, until: new Date(until).toISOString(), method: { live: true }, agreement: req.offerId,
      status: (vc as { credentialStatus?: { id?: string } }).credentialStatus?.id, given: new Date().toISOString(), notice: digestSRI(JSON.stringify(req.grantDraft ?? {})),
    })).catch(() => {});
    this.record({ id: req.offerId, jws: grant, visitor: req.visitor.domain, fields: s!.fields, purpose: s!.purpose, until: new Date(until).toISOString(), authorizedBy: 'owner, live' });
    // Yes lifts an earlier No for this key and purpose: the owner's standing rule applies to it again.
    if (req.visitor.key && this.ownerNos.delete(`${req.visitor.key}|${req.purpose}`)) void this.saveOwnerNos();
    req.status = 'allowed';
    req.grant = grant;
    this.o.emit(makeEvent('approval.answered', this.o.actor, `agent:${req.visitor.domain}`, { answer: 'Allow' }));
    this.o.emit(makeEvent('grant.issued', this.o.actor, `agent:${req.visitor.domain}`, { hours: Math.round((until - Date.now()) / 3_600_000) }));
    this.news({ about: 'request.answered', request: id, by: req.visitor.domain, answer: 'allow', fields: s!.fields, until: new Date(until).toISOString() });
    return { ok: true };
  }
}

/** The agenda as iCalendar: entries with a start time become events, CONFIRMED when the other side agreed, TENTATIVE if not. */
export function agendaIcs(items: AgendaItem[], house: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const t = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Lake//house agenda//EN', 'X-WR-CALNAME:Agenda'];
  for (const x of items.filter((i) => i.start)) {
    const who = x.agreed ? `Agreed by ${x.agreed.by}${x.agreed.speaks_for?.checked ? ` (speaks for ${x.agreed.speaks_for.house})` : ''}: "${x.agreed.said}"` : 'Proposed: their side has not agreed yet';
    lines.push('BEGIN:VEVENT', `UID:${x.id}@${new URL(house).host}`, `DTSTAMP:${t(x.at)}`, `DTSTART:${t(x.start!)}`, `DURATION:PT${x.minutes ?? 60}M`, `SUMMARY:${esc(x.what)}`,
      ...(x.where ? [`LOCATION:${esc(x.where)}`] : []), `DESCRIPTION:${esc([x.when, x.with ? `with ${x.with}` : '', who, x.note ?? ''].filter(Boolean).join('\n'))}`,
      `STATUS:${x.agreed ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // Lines end in CRLF, and long ones fold at 75 octets (RFC 5545 §3.1).
  return lines.map((l) => { const out: string[] = []; let s = l; while (Buffer.byteLength(s) > 75) { let n = 75; while (Buffer.byteLength(s.slice(0, n)) > 75) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); }).join('\r\n') + '\r\n';
}

async function secret(path: string, rotate = false): Promise<string> {
  if (!rotate) {
    try {
      return (await readFile(path, 'utf8')).trim();
    } catch {
      // first start
    }
  }
  const s = randomBytes(12).toString('base64url');
  await writeFile(path, s, { mode: 0o600 });
  return s;
}

export type { Study };
