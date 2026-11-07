import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { checkPass, checkReveal, checkSdJwtAttachment, commitTo, getBeacon, openSeal, roundAfter, roundTimeMs, sealedRound, cardUrlFor, countContext, isCurrency, makeEvent, pledgeAgreement, unshardCounts, verifyCredential, verifyLakeCard, passChallenge, PERSON_IN_CONTEXT_VCT, sendLake, signMessage, verifyLakeData, type AgentCard, type LakeData } from '@thelakeprotocol/core';
import { specialist, type Specialist, type SpecialistOptions } from './review.js';

/**
 * A blind tally (SPEC §11.4): for pledges that bind only once enough sign ("nobody goes first"). Until the
 * threshold, it tells anyone how many have signed and nobody who, the opener included. At the threshold it
 * tells every signer, at once, who is in. If the deadline passes first, it forgets them. It knows who signed
 * (each signature is a signed message), so you trust it the way you trust an auditor; hiding signers even
 * from the tally needs cryptography this version doesn't have.
 */
interface Tally {
  id: string;
  text: string;
  threshold: number;
  deadline: number;
  opener: string;
  /** gathering: still finding its quorum (SPEC §11.4b); nobody can sign until it opens. */
  state: 'gathering' | 'open' | 'triggered' | 'lapsed';
  /** When it filled: a listed pledge stays in tally.list for a day after, so agents see what bound. */
  triggeredAt?: number;
  /** Count people, not identities: each signature needs a person stamp, and one person counts once (SPEC §6.4). */
  peopleOnly?: boolean;
  signers: { webId: string; domain: string; url: string; at: string; person?: string; hold?: string }[];
  /**
   * Money (SPEC §11.4a), in cents: each signer's contribution is held by the payments agent for this tally, whose word alone
   * moves it once the deadline passes: on to the payee if the pledge filled, back if it lapsed. With a refund bond from its
   * opener, a lapse also shares the bond among everyone who signed (a dominant assurance contract): saying yes costs
   * nothing if it doesn't happen, and pays. `counted`: the signers' holds, kept past a lapse until the money is settled.
   */
  quorum?: Quorum;
  circle?: Circle;
  money?: { contribution: number; currency: string; payee: { webId: string; url: string; name?: string }; bond?: { hold: string; amount: number }; counted: string[]; settled?: { outcome: 'filled' | 'lapsed'; at: string; each?: number } };
  /**
   * A blind pledge (SPEC §11.4): signatures are anonymous passes from a separate issuer, so this tally never learns who
   * signed; each pass carries a commitment to its signer, opened by the signer once the pledge has filled. Opened with
   * unveil, each pass also carries its signer's reveal sealed to a drand round just after the deadline (`unveil`), and the
   * tally opens them all at once, so nobody reveals first.
   */
  /** The opener asked for it to be listed (tally.list), so others can find it and see how many more it needs. */
  listed?: boolean;
  blind?: { issuer: string; publicJwk: JsonWebKey; passes: { commit: string; withdraw: string; at: string; sealed?: string; revealed?: { webId: string; domain: string; url: string } }[]; spent: string[]; unveil?: number; unveiled?: boolean };
}

/**
 * A quorum found in secret before anyone commits (SPEC §11.4b): each person privately answers "I'm in if at least N of us
 * are" (an option and its N; null for never), as a secret count the tally opens at its tellers and alone can close. When
 * it closes, the tally works out the largest group whose every member said they'd join a group that size, and opens the
 * pledge to bind at exactly that many, if it is at least its threshold. `joined`: who answered (one per person), never what.
 */
interface Quorum {
  options: string[]; atLeast: (number | null)[]; closes: number; count: string; tellers: { url: string; domain: string }[];
  joined: { webId: string; person: string; url: string }[];
  /** How it is signed once it opens: blind (and unveil), registered with the pass issuer only then. */
  blind?: boolean; unveil?: boolean;
  result?: { totals: Record<string, number>; counted: number; size: number; binds?: number; at: string; why?: string };
}

/**
 * A promise circle (SPEC §11.4c): a pledge whose signers each promise the others something (a meal, a school run, a
 * day's cover), so many times a year, and which, once it has filled and everyone is known, stays open for calls. A member
 * calls with what they need; the tally asks a few others, picked by a public drand round so it can't play favourites,
 * without saying who called; the first to accept is put in touch with the caller; when the caller says it happened, the
 * promise counts as kept. No money moves: what the circle holds is promises, and the record of keeping them.
 */
interface Circle {
  promise: string; times: number;
  /** Give before you take: how many favours a member may owe (across this tally's circles) and still call; 0: need-based, no limit. */
  limit?: number;
  /** The kinds of help a call may ask for (a CV, a form, tutoring…): a call names one, and goes only to members who offer it. */
  kinds?: string[];
  /** What it's about, as tags (kids-clothes, brisbane): agents whose humans offer or seek one of them are invited. */
  tags?: string[];
  /** Whom it has invited, by address, so nobody is invited twice. */
  invited?: string[];
  /** Takes calls its sister circles can't meet, here or on the Ocean's other tallies, and passes on its own (SPEC §11.4c). */
  sisters?: boolean;
  /** What each member offers, of those kinds (all of them until they say). */
  offers: Record<string, string[]>;
  calls: CircleCall[];
  /** Promises kept and asked, by member: what a member's record says. */
  kept: Record<string, number>; asked: Record<string, number>;
  /** Reports against a caller's key, by the members who made them; a key reported by enough members can't call. */
  reports: Record<string, string[]>;
  /**
   * Favours owed (SPEC §11.4c): each a note the helped member's house signed ("I received this from that member: one
   * favour"), countersigned by the helper's house. Cleared once a loop of them, across circles, cancels out.
   */
  notes?: FavourNote[];
  passes?: Pass[];
  /** Its record's latest checkpoint on the transparency log, and a digest of what it said, to log again only on a change. */
  checkpoint?: { index: number; origin: string; at: number; digest: string };
}
interface FavourNote {
  call: string; from: string; to: string; help?: string; at: number; digest: string; acked?: boolean; cleared?: string; disputed?: boolean;
  /** Passed on (SPEC §11.4c): who held it before, in order, and the house of whoever holds it now, when not a member. */
  passed?: string[]; toUrl?: string;
}
/** A favour owed to a member, offered by them to someone they owe, to settle that: accepted, the debtor owes the new holder. */
interface Pass { id: string; note: string; from: string; to: string; toUrl: string; settles: { tally: string; url: string; circle: string; digest: string }; endorsement: string; card: AgentCard; at: number; state: 'offered' | 'accepted' | 'declined' }
/** A loop of favours owed across circles, offered to every house in it; it clears once each consents. */
interface Clearing {
  id: string;
  /** The notes in the loop: here (no `tally`), or on another Lake's tally (its WebID and address). */
  notes: { circle: string; digest: string; from: string; to: string; tally?: string; url?: string }[];
  houses: string[]; consents: string[];
  /** Each house's signed consent, as it arrived: what the other tallies in the loop check before clearing theirs. */
  evidence?: Record<string, { card: AgentCard; envelope: LakeData['envelope'] }>;
  at: number; state: 'proposed' | 'cleared' | 'lapsed';
}
/** A favour owed, as tallies share them across the Ocean (SPEC §11.4c): only with each other, by signed request. */
interface Edge { tally: string; url: string; circle: string; text: string; digest: string; from: string; to: string; fromUrl: string; toUrl: string; help?: string }
interface CircleCall {
  id: string; need: string; kind?: string; when?: string; caller: string; callerKey: string; callerUrl: string; at: number; round: number;
  /** When the latest members were asked: unanswered for ASK_WITHIN, the next are asked. */
  askedAt: number;
  /** Members asked so far, in the drawn order, and who answered how. */
  order: string[]; asked: string[]; declined: string[];
  helper?: string; state: 'asking' | 'matched' | 'kept' | 'unmet' | 'withdrawn' | 'unconfirmed' | 'disputed';
  /** When it was matched: with no thanks for CONFIRM_WITHIN, it shows as unconfirmed, against the caller. */
  matchedAt?: number;
  /** Handed to a sister circle nobody here could take it: where it is being asked now, and the sisters tried so far. */
  away?: { tally: string; url: string; circle: string; call: string; text: string };
  tried?: string[];
  /** The helper's house, when the helper is in a sister circle. */
  helperUrl?: string;
  /** A sister circle's call, asked here: whose tally and call it is, that circle's text and promise. */
  guest?: { tally: string; url: string; circle: string; call: string; text: string; promise: string };
}

/**
 * The largest group that holds together (Granovetter's threshold model): the largest k such that at least k people said
 * they'd join a group of k or fewer. `totals[i]` people chose option i, whose threshold is `atLeast[i]` (null: never).
 */
export function quorumSize(totals: number[], atLeast: (number | null)[]): number {
  let size = 0;
  for (const v of [...new Set(atLeast.filter((x): x is number => x !== null))]) {
    const n = totals.reduce((a, c, i) => a + (atLeast[i] !== null && atLeast[i]! <= v ? c : 0), 0);
    if (n >= v) size = Math.max(size, n);
  }
  return size;
}

/**
 * How many must sign for a group of `size` to bind: the highest threshold among the answers in it. Each of them said
 * they'd join a group that big, so the pledge binds once that many sign, and the rest of the group can come late or not
 * at all (the largest group is 205; the highest threshold in it, 200).
 */
export function quorumBinds(size: number, atLeast: (number | null)[]): number {
  return Math.max(0, ...atLeast.filter((x): x is number => x !== null && x <= size));
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** How many members a call asks at once; more are asked as these decline, or don't answer in time. */
const ASK_AT_ONCE = 3;
const ASK_WITHIN = Number(process.env.LAKE_CIRCLE_ASK_MS ?? 6 * 3_600_000);
/** Members who must report a caller's key before it can't call the circle any more. */
const SISTERS_TRIED = 3, REPORTS_TO_BAR = 3;
/** A matched call nobody thanked in this long shows as unconfirmed, against its caller. */
const CONFIRM_WITHIN = Number(process.env.LAKE_CIRCLE_CONFIRM_MS ?? 7 * 86_400_000);
/** Give before you take, unless the circle says otherwise: favours a member may owe and still call. */
const DEFAULT_LIMIT = 2;
const MAX_DAYS = 30;

export async function createTally(o: SpecialistOptions & { dataDir: string; personCheckers?: string[]; passesUrl?: string; paymentsUrl?: string; tellers?: string[]; nodeUrl?: string; log?: (entry: string, kind: string) => Promise<{ index: number; origin: string }> }) {
  const checkers = o.personCheckers ?? ['person.lake.local'];
  const file = `${o.dataDir}/tallies.json`;
  const tallies = new Map<string, Tally>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Tally[]).map((t) => [t.id, t]));
  const clearingsFile = `${o.dataDir}/clearings.json`;
  const clearings = new Map<string, Clearing>((JSON.parse(await readFile(clearingsFile, 'utf8').catch(() => '[]')) as Clearing[]).map((x) => [x.id, x]));
  const saveClearings = () => writeFile(clearingsFile, JSON.stringify([...clearings.values()].filter((x) => x.state === 'proposed' || Date.now() - x.at < 30 * 86_400_000))).catch(() => {});
  const save = () => writeFile(file, JSON.stringify([...tallies.values()])).catch(() => {});
  const counted = (t: Tally) => (t.blind ? t.blind.passes.length : t.signers.length);
  const view = (t: Tally) => ({ id: t.id, text: t.text, threshold: t.threshold, count: counted(t), deadline: new Date(t.deadline).toISOString(), state: t.state, ...(t.peopleOnly ? { people_only: true } : {}),
    // A blind pledge binds only when enough signers have revealed themselves, not just when enough passes are in (run 21:
    // "make pledges actually bind"): an anonymous signature is cheap until its signer stands by it.
    ...(t.blind ? { blind: true, issuer: t.blind.issuer, revealed: t.blind.passes.filter((x) => x.revealed).length, bound: t.blind.passes.filter((x) => x.revealed).length >= t.threshold } : {}),
    ...(t.blind?.unveil ? { unveil: { round: t.blind.unveil, opens: new Date(roundTimeMs(t.blind.unveil)).toISOString(), ...(t.blind.unveiled ? { opened: true } : {}) } } : {}),
    ...(t.money ? { money: moneyView(t, t.money) } : {}),
    ...(t.circle ? { circle: circleView(t, t.circle) } : {}),
    ...(t.quorum ? { quorum: { options: t.quorum.options, at_least: t.quorum.atLeast, closes: new Date(t.quorum.closes).toISOString(), count: t.quorum.count, tellers: t.quorum.tellers, answered: t.quorum.joined.length, ...(t.quorum.blind ? { blind: true } : {}), ...(t.quorum.result ? { result: t.quorum.result } : {}) } } : {}) });
  // A circle's record, for anyone: what each promises, how many are in it, and how its promises have been kept. Never who.
  const circleView = (t: Tally, c: Circle) => {
    const done = c.calls.filter((x) => x.state === 'kept' || x.state === 'unmet');
    const notes = c.notes ?? [];
    return { promise: c.promise, times_a_year: c.times, ...(c.kinds ? { kinds: c.kinds } : {}), ...(c.checkpoint ? { on_the_log: { index: c.checkpoint.index, origin: c.checkpoint.origin, at: new Date(c.checkpoint.at).toISOString() } } : {}), ...(c.sisters ? { sisters: { met_by_sisters: c.calls.filter((x) => x.away && x.state === 'kept').length, helped_sisters: c.calls.filter((x) => x.guest && x.state === 'kept').length } } : {}), ...(c.tags ? { tags: c.tags, invited: c.invited?.length ?? 0 } : {}), members: members(t).length, open: circleOpen(t), calls: c.calls.filter((x) => x.state !== 'withdrawn').length, kept: c.calls.filter((x) => x.state === 'kept').length, unmet: c.calls.filter((x) => x.state === 'unmet').length, of: done.length, unconfirmed: c.calls.filter((x) => x.state === 'unconfirmed').length, disputed: c.calls.filter((x) => x.state === 'disputed').length, limit: c.limit ?? DEFAULT_LIMIT, ...(notes.length ? { favours: { signed: notes.length, owed: notes.filter((n) => !n.cleared).length, cleared: notes.filter((n) => n.cleared).length } } : {}) };
  };
  // Who is in it, once that's known: a plain pledge's signers; a blind one's, once revealed.
  const members = (t: Tally): { webId: string; url: string }[] => (t.blind ? t.blind.passes.flatMap((x) => (x.revealed ? [{ webId: x.revealed.webId, url: x.revealed.url }] : [])) : t.signers.map(({ webId, url }) => ({ webId, url })));
  // Open for calls once it has filled and everyone is known (an unveiling pledge: once it has unveiled).
  const circleOpen = (t: Tally) => t.state === 'triggered' && (!t.blind?.unveil || !!t.blind.unveiled);
  // What signing costs, where it goes, and what a lapse would pay each signer were it to lapse now.
  const moneyView = (t: Tally, m: NonNullable<Tally['money']>) => {
    const n = counted(t);
    return {
      contribution: { amount: m.contribution / 100, currency: m.currency }, payee: m.payee, held_so_far: (n * m.contribution) / 100,
      agreement: pledgeAgreement(s.webId, t.id), ...(o.paymentsUrl ? { payments: o.paymentsUrl } : {}),
      ...(m.bond ? { bond: { amount: m.bond.amount / 100, currency: m.currency, each_if_it_lapsed_now: Math.floor(m.bond.amount / Math.max(1, n)) / 100 } } : {}),
      ...(m.settled ? { settled: m.settled } : {}),
      note: `each signer's ${m.currency} ${(m.contribution / 100).toFixed(2)} is held until the deadline: if it has filled, it goes to ${m.payee.name ?? m.payee.webId}; if not, it goes back${m.bond ? ', and the opener\'s bond is shared equally among everyone who signed' : ''}`,
    };
  };
  // Public counts go out late and in batches: a count that ticks the moment someone signs would let anyone match
  // it against that someone's other activity. (Six Claudes unmasked a blind pledge from the public feed that way.)
  const due = new Set<Tally>();
  let timer: NodeJS.Timeout | null = null;
  const report = (t: Tally) => {
    due.add(t);
    timer ??= setTimeout(() => {
      timer = null;
      for (const x of due) o.report?.(makeEvent('tally.update', 'self', undefined, { count: counted(x), threshold: x.threshold, state: x.state }));
      due.clear();
    }, 30_000 + Math.random() * 60_000);
  };

  // Messages the tally sends on its own: the trigger, and a lapse.
  const tell = async (url: string, body: Record<string, unknown>) => {
    try {
      const envelope = await signMessage(body, o.id, { iss: s.webId });
      await sendLake(url, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs: 10_000 });
    } catch {
      // A signer that has gone can still ask for the result with tally.count.
    }
  };
  const lapse = (t: Tally) => {
    if (t.state !== 'open' || t.deadline > Date.now()) return;
    t.state = 'lapsed';
    const gone = t.signers;
    t.signers = [];
    // A blind pledge forgets its passes, and with them any sealed reveals, unopened: their round comes after the deadline.
    if (t.blind) t.blind.passes = [];
    for (const x of gone) void tell(x.url, { kind: 'tally.lapsed', id: t.id, count: gone.length, threshold: t.threshold });
    report(t);
    void save();
  };
  // An unveiling pledge, once its round is out: the tally opens every sealed reveal itself (anyone could; only the tally
  // holds them) and tells everyone revealed who is in, all at once. The round comes after the deadline, so by then the
  // pledge has either filled or lapsed, and a lapsed one has already discarded its seals unopened.
  const unveiling = new Set<string>();
  const unveil = async (t: Tally) => {
    const b = t.blind;
    if (!b?.unveil || b.unveiled || t.state !== 'triggered' || roundTimeMs(b.unveil) > Date.now() || unveiling.has(t.id)) return;
    unveiling.add(t.id);
    try {
      // One fetch of the round, from any relay, checked against drand's key; if none answers, the next pass tries again.
      const beacon = await getBeacon(b.unveil);
      // Every seal opened first, then all of them shown at once: nobody's count should catch it half done.
      const opened = await Promise.all(b.passes.map(async (x) => (x.sealed && !x.revealed
        // A seal that doesn't open to its own signature leaves that signer unrevealed, as if it never revealed.
        ? checkReveal(await openSeal(x.sealed, beacon), { tally: s.webId, id: t.id, commit: x.commit, sandbox: o.sandbox }).catch(() => undefined)
        : x.revealed)));
      b.passes.forEach((x, i) => { x.revealed = opened[i]; delete x.sealed; });
      b.unveiled = true;
      void save();
      const signers = b.passes.flatMap((x) => (x.revealed ? [x.revealed] : []));
      for (const x of signers) if (x.url) void tell(x.url, { kind: 'tally.unveiled', ...view(t), signers: signers.map(({ domain, url }) => ({ domain, url })), unrevealed: b.passes.length - signers.length });
    } catch {
      // drand unreachable: next time
    } finally {
      unveiling.delete(t.id);
    }
  };
  // Its money, once the deadline has passed (SPEC §11.4a): the payments agent moves it on this tally's word, and only then.
  const settling = new Set<string>();
  const settleMoney = async (t: Tally) => {
    const m = t.money;
    if (!m || m.settled || t.deadline > Date.now() || t.state === 'open' || !o.paymentsUrl || settling.has(t.id)) return;
    settling.add(t.id);
    try {
      const outcome = t.state === 'triggered' ? 'filled' : 'lapsed';
      const r = await ask(o.paymentsUrl, { kind: 'pledge.settle', id: t.id, outcome, holds: m.counted, ...(m.bond ? { bond: m.bond.hold } : {}) }, 600_000);
      if (r.kind !== 'pledge.settled') return;
      m.settled = { outcome, at: new Date().toISOString(), ...(r.bond ? { each: Number(r.bond.each) } : {}) };
      void save();
      report(t);
    } catch {
      // the payments agent unreachable: the next pass tries again (its holds last past the deadline)
    } finally {
      settling.delete(t.id);
    }
  };
  setInterval(() => { for (const t of tallies.values()) { void gather(t); lapse(t); void unveil(t); void settleMoney(t); circleTick(t); } }, Number(process.env.LAKE_TALLY_TICK_MS ?? 30_000)).unref();

  // A signed request of the tally's own (to the pass issuer), and its verified reply.
  const ask = async (url: string, body: Record<string, unknown>, timeoutMs = 20_000) => {
    const envelope = await signMessage(body, o.id, { iss: s.webId });
    const raw = await sendLake(url, { lake: '0.1', card: s.card, envelope: envelope as LakeData['envelope'] }, { me: o.id, timeoutMs });
    const v = await verifyLakeData<Record<string, unknown>>(raw as LakeData<Record<string, unknown>>, { sandbox: o.sandbox });
    if (!v.ok) throw new Error(v.rejection.why);
    return v.payload as Record<string, any>;
  };

  // A blind pledge: the pass issuer makes a key for it alone; signers get their passes there, not here. A pledge that first
  // finds its quorum registers only once it opens, so nobody fetches a pass for one that never does.
  const registerBlind = async (t: Tally, unveil: boolean): Promise<string | null> => {
    if (!o.passesUrl) return 'this tally has no pass issuer for blind pledges';
    const r = await ask(o.passesUrl, { kind: 'pass.register', id: t.id, deadline: new Date(t.deadline).toISOString(), people_only: t.peopleOnly === true }).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }) as Record<string, any>);
    if (r.kind !== 'pass.registered') return `the pass issuer: ${(r.problems ?? [r.kind]).join('; ')}`;
    // Unveil: reveals sealed to the first drand round after the deadline, when the pledge has filled or lapsed for good.
    t.blind = { issuer: String(r.issuer), publicJwk: r.publicJwk as JsonWebKey, passes: [], spent: [], ...(unveil ? { unveil: roundAfter(0, t.deadline) } : {}) };
    return null;
  };
  // The quorum closes: the tally alone collects its count, over those who answered (one per person), and opens the pledge
  // at the largest group that holds together, or lets it lapse. Everyone who answered is told, at once.
  const gathering = new Set<string>();
  const gather = async (t: Tally) => {
    const q = t.quorum;
    if (!q || t.state !== 'gathering' || q.closes > Date.now() || gathering.has(t.id)) return;
    gathering.add(t.id);
    try {
      const [leader, helper] = q.tellers as [{ url: string; domain: string }, { url: string; domain: string }];
      const reported = ((await ask(leader.url, { kind: 'count.members', id: q.count })).members as string[] | undefined) ?? [];
      const members = reported.filter((m) => q.joined.some((j) => j.webId === m));
      let totals: number[] | undefined, why: string | undefined, counted = 0;
      if (members.length < 3) why = `${members.length} answered; a count needs at least 3`;
      else {
        const lead = await ask(leader.url, { kind: 'count.close', id: q.count, members }, 120_000);
        const help = lead.kind === 'count.share' ? await ask(helper.url, { kind: 'count.collect', id: q.count }, 120_000) : lead;
        if (lead.kind !== 'count.share' || help.kind !== 'count.share') why = `the tellers: ${((help.problems as string[] | undefined) ?? [String(help.kind)]).join('; ')}`;
        else { totals = unshardCounts(q.options.length, [lead.share, help.share], Number(lead.count)); counted = Number(lead.count); }
      }
      const size = totals ? quorumSize(totals, q.atLeast) : 0;
      q.result = { totals: Object.fromEntries(q.options.map((x, i) => [x, totals?.[i] ?? 0])), counted, size, ...(totals && size >= t.threshold ? { binds: Math.max(t.threshold, quorumBinds(size, q.atLeast)) } : {}), at: new Date().toISOString(), ...(why ? { why } : totals && size < t.threshold ? { why: `the largest group that holds together is ${size}, under the ${t.threshold} it needs` } : {}) };
      if (totals && size >= t.threshold) {
        t.threshold = Math.max(t.threshold, quorumBinds(size, q.atLeast));
        const err = q.blind ? await registerBlind(t, !!q.unveil) : null;
        if (err) q.result.why = err;
        t.state = err ? 'lapsed' : 'open';
      } else t.state = 'lapsed';
      void save();
      report(t);
      for (const j of q.joined) if (j.url) void tell(j.url, { kind: t.state === 'open' ? 'tally.quorum.opened' : 'tally.quorum.lapsed', ...view(t) });
    } catch {
      // The tellers unreachable: the next pass tries again, for an hour.
      if (Date.now() > q.closes + 3_600_000) { t.state = 'lapsed'; q.result = { totals: {}, counted: 0, size: 0, at: new Date().toISOString(), why: 'its tellers never answered' }; void save(); }
    } finally {
      gathering.delete(t.id);
    }
  };

  // A circle's calls (SPEC §11.4c): only its members call or answer, each caller is named only to the one who takes the
  // call, and the order members are asked in comes from a public drand round.
  // Loops of favours owed, across every circle here (SPEC §11.4c): A owes B in one circle, B owes C in another, C owes A in
  // a third. Each such loop is offered to its houses; once all consent, every note in it is cleared and they're square.
  // Only countersigned notes, each in at most one open offer; loops of up to six.
  // This tally's own favours owed, as edges: what it shares with the Ocean's other tallies.
  const busyHere = () => new Set([...clearings.values()].filter((x) => x.state === 'proposed').flatMap((x) => x.notes.map((n) => n.digest)));
  const localEdges = (): Edge[] => {
    const busy = busyHere();
    const out: Edge[] = [];
    for (const t of tallies.values()) {
      const ms = t.circle ? members(t) : [];
      for (const n of t.circle?.notes ?? []) if (n.acked && !n.cleared && !n.disputed && !busy.has(n.digest)) out.push({ tally: s.webId, url: s.card.supportedInterfaces?.[0]?.url ?? '', circle: t.id, text: t.text, digest: n.digest, from: n.from, to: n.to, fromUrl: ms.find((m) => m.webId === n.from)?.url ?? t.circle!.calls.find((x) => x.id === n.call)?.callerUrl ?? '', toUrl: n.toUrl ?? ms.find((m) => m.webId === n.to)?.url ?? '', ...(n.help ? { help: n.help } : {}) });
    }
    return out;
  };
  // The Ocean's other tallies (on the Lakes this one's node knows), and their edges, asked for by signed request.
  const remoteEdges = async (): Promise<Edge[]> => {
    if (!o.nodeUrl) return [];
    const rows = await fetch(`${o.nodeUrl}/cards?skill=tally&idle=1`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ card: AgentCard }[]>).catch(() => []);
    const urls = [...new Set(rows.map((r) => r.card?.supportedInterfaces?.[0]?.url).filter((u): u is string => !!u && u !== s.card.supportedInterfaces?.[0]?.url))].slice(0, 20);
    const got = await Promise.all(urls.map((u) => ask(u, { kind: 'tally.edges' }, 8000).then((r) => (Array.isArray(r.edges) ? (r.edges as Edge[]).slice(0, 2000) : [])).catch(() => [])));
    return got.flat();
  };
  // Loops of favours owed (SPEC §11.4c), here and across the Ocean's tallies: A owes B in one circle, B owes C in another,
  // C owes A in a third. Of the tallies holding a loop's notes, the one with the lowest WebID offers it to its houses (so
  // nobody offers it twice); once all consent, each tally clears its own notes. Only countersigned notes; loops of up to six.
  let looking: Promise<void> | null = null, again = false;
  const findLoops = (): Promise<void> => {
    if (looking) { again = true; return looking; }
    return (looking = lookForLoops().finally(() => { looking = null; if (again) { again = false; void findLoops(); } }));
  };
  const lookForLoops = async () => {
    const edges = [...localEdges(), ...(await remoteEdges())];
    const used = new Set<string>();
    const nudge = new Set<string>();
    for (const start of edges) {
      if (used.has(start.digest)) continue;
      const path: Edge[] = [start];
      const walk = (at: string, depth: number): boolean => {
        if (at === start.from) return true;
        if (depth >= 6) return false;
        for (const e of edges) {
          if (e.from !== at || used.has(e.digest) || path.includes(e)) continue;
          path.push(e);
          if (walk(e.to, depth + 1)) return true;
          path.pop();
        }
        return false;
      };
      if (!walk(start.to, 1)) continue;
      for (const e of path) used.add(e.digest);
      const proposer = [...new Set(path.map((e) => e.tally))].sort()[0];
      // Another tally offers this one: it may not have looked since the last note was countersigned here, so say so.
      if (proposer !== s.webId) { nudge.add(path.find((e) => e.tally === proposer)!.url); continue; }
      const x: Clearing = { id: randomBytes(6).toString('hex'), notes: path.map((e) => ({ circle: e.circle, digest: e.digest, from: e.from, to: e.to, ...(e.tally !== s.webId ? { tally: e.tally, url: e.url } : {}) })), houses: [...new Set(path.map((e) => e.from))], consents: [], evidence: {}, at: Date.now(), state: 'proposed' };
      clearings.set(x.id, x);
      const circles = [...new Map(path.map((e) => [`${e.tally}|${e.circle}`, { tally: e.tally, id: e.circle }])).values()];
      for (const e of path) {
        const owed = path.find((y) => y.to === e.from)!;
        void tell(e.fromUrl, { kind: 'circle.clear', clearing: x.id, ids: circles.map((c) => c.id), where: circles, circles: circles.length, lakes: new Set(path.map((y) => y.tally)).size, length: path.length, you_owe: { circle: e.circle, text: e.text, help: e.help, digest: e.digest }, owed_to_you: { circle: owed.circle, text: owed.text, help: owed.help, digest: owed.digest }, note: 'a loop of favours owed across circles: you owe one and are owed one, so consenting squares you and everyone in the loop' });
      }
    }
    void saveClearings();
    for (const url of nudge) void ask(url, { kind: 'tally.look' }, 8000).catch(() => {});
  };
  // Loops can close on another Lake's tally without a word to this one; look now and then as well.
  if (o.nodeUrl) setInterval(() => void findLoops(), Number(process.env.LAKE_TALLY_LOOPS_MS ?? 600_000)).unref();
  // Another tally's loop has cleared: it forwards each house's signed consent, and this tally clears a note of its own only
  // if both its houses signed consent to this very loop, naming that note (the one owing it, and the one owed).
  const clearRemote = async (p: Record<string, unknown>) => {
    const notes = (Array.isArray(p.notes) ? p.notes : []) as { circle: string; digest: string }[];
    const evidence = (p.evidence ?? {}) as Record<string, { card: AgentCard; envelope: LakeData['envelope'] }>;
    let cleared = 0;
    for (const n of notes) {
      const note = tallies.get(n.circle)?.circle?.notes?.find((y) => y.digest === n.digest);
      if (!note || note.cleared || note.disputed) continue;
      const signed = async (w: string, side: 'owe' | 'owed') => {
        const ev = evidence[w];
        const v = ev ? await verifyLakeData<Record<string, unknown>>({ lake: '0.1', card: ev.card, envelope: ev.envelope } as LakeData<Record<string, unknown>>, { sandbox: o.sandbox, now: (ev.envelope as { payload?: { iat?: number } }).payload?.iat }).catch(() => null) : null;
        return !!v?.ok && v.profile.webId === w && v.payload.kind === 'circle.clear.consent' && v.payload.clearing === p.clearing && v.payload[side] === note.digest;
      };
      if (!(await signed(note.from, 'owe')) || !(await signed(note.to, 'owed'))) continue;
      note.cleared = String(p.clearing);
      cleared++;
    }
    if (cleared) void save();
    return { kind: 'tally.cleared', clearing: p.clearing, cleared };
  };
  const consent = async (id: string, from: string, owe: string, owed: string, card: AgentCard, envelope: LakeData['envelope']) => {
    const x = clearings.get(id);
    if (!x || x.state !== 'proposed') return { kind: 'refused', problems: ['no loop waiting with that id'] };
    if (!x.houses.includes(from)) return { kind: 'refused', problems: ['you are not in this loop'] };
    if (!x.notes.some((n) => n.from === from && n.digest === owe) || !x.notes.some((n) => n.to === from && n.digest === owed)) return { kind: 'refused', problems: ['name the note you owe (owe) and the one owed to you (owed) in this loop'] };
    if (!x.consents.includes(from)) x.consents.push(from);
    (x.evidence ??= {})[from] = { card, envelope };
    if (x.consents.length === x.houses.length) {
      x.state = 'cleared';
      for (const n of x.notes) if (!n.tally) { const note = tallies.get(n.circle)?.circle?.notes?.find((y) => y.digest === n.digest); if (note) note.cleared = x.id; }
      void save();
      // The other Lakes' tallies in the loop clear theirs, on the houses' own signed consents.
      for (const url of new Set(x.notes.filter((n) => n.url).map((n) => n.url!))) void ask(url, { kind: 'tally.cleared', clearing: x.id, notes: x.notes.filter((n) => n.url === url).map(({ circle, digest }) => ({ circle, digest })), evidence: x.evidence }, 20_000).catch(() => {});
      const where = [...new Map(x.notes.map((n) => [`${n.tally ?? s.webId}|${n.circle}`, { tally: n.tally ?? s.webId, id: n.circle }])).values()];
      const lakes = new Set(x.notes.map((n) => n.tally ?? s.webId)).size;
      const urlOf = new Map<string, string>([...tallies.values()].flatMap((tt) => (tt.circle ? members(tt) : [])).map((m) => [m.webId, m.url]));
      for (const w of x.houses) {
        const url = urlOf.get(w) ?? (x.evidence?.[w]?.card.supportedInterfaces?.[0]?.url ?? '');
        if (url) void tell(url, { kind: 'circle.cleared', clearing: x.id, id: x.notes[0]!.circle, ids: x.notes.map((n) => n.circle), where, circles: where.length, lakes, length: x.notes.length });
      }
    }
    void saveClearings();
    return { kind: x.state === 'cleared' ? 'circle.cleared' : 'circle.consented', clearing: x.id, consents: x.consents.length, of: x.houses.length };
  };
  // Sister circles (SPEC §11.4c): a call nobody in its circle can take goes, unnamed, to another circle that takes such
  // calls, here or on another tally in the Ocean, in an order drawn from the call's drand round; up to three are tried.
  const sisterCircles = () => [...tallies.values()].filter((t) => t.circle?.sisters && circleOpen(t)).map((t) => ({ id: t.id, text: t.text, promise: t.circle!.promise, ...(t.circle!.kinds ? { kinds: t.circle!.kinds } : {}), members: members(t).length }));
  const myUrl = () => s.card.supportedInterfaces?.[0]?.url ?? '';
  // To another tally, or to this one when the sister circle is here.
  const toTally = (url: string, body: Record<string, unknown>): Promise<Record<string, any>> => (url === myUrl() ? between(body, s.webId, url) : ask(url, body, 15_000)).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }));
  const overflow = async (t: Tally, call: CircleCall) => {
    const c = t.circle!;
    call.away = undefined;
    call.tried ??= [];
    const fits = (k?: string[]) => (call.kind ? !!k?.includes(call.kind) : !k);
    const here = sisterCircles().filter((x) => x.id !== t.id).map((x) => ({ ...x, tally: s.webId, url: myUrl() }));
    const there = (await Promise.all((await otherTallies()).map(async (o2) => ((await ask(o2.url, { kind: 'tally.list' }, 8000).catch(() => ({}))) as { sisters?: typeof here }).sisters?.slice(0, 50).map((x) => ({ ...x, tally: o2.webId, url: o2.url })) ?? []))).flat();
    const beacon = await getBeacon(call.round).catch(() => null);
    const rank = (x: { tally: string; id: string }) => createHash('sha256').update(`${beacon?.randomness ?? call.round}|${call.id}|${x.tally}|${x.id}`).digest('hex');
    const order = [...here, ...there].filter((x) => fits(x.kinds) && !call.tried!.includes(`${x.tally}|${x.id}`)).sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
    for (const x of order) {
      if (call.tried.length >= SISTERS_TRIED || call.state !== 'asking') break;
      call.tried.push(`${x.tally}|${x.id}`);
      const r = await toTally(x.url, { kind: 'tally.overflow', circle: x.id, need: call.need, ...(call.kind ? { help: call.kind } : {}), ...(call.when ? { when: call.when } : {}), promise: c.promise, from: { circle: t.id, call: call.id, text: t.text }, caller: { webId: call.caller, url: call.callerUrl } });
      if (r.kind === 'tally.overflow.asking') { call.away = { tally: x.tally, url: x.url, circle: x.id, call: String(r.call), text: x.text }; void save(); return; }
    }
    if (call.state !== 'asking') return;
    call.state = 'unmet';
    void save();
    void tell(call.callerUrl, { kind: 'circle.unmet', id: t.id, call: call.id, need: call.need });
  };
  // The Ocean's other tallies, from this tally's node: each one's address and WebID, from its card the node checked.
  let tallyCache: { at: number; list: { url: string; webId: string }[] } | undefined;
  const otherTallies = async () => {
    if (!o.nodeUrl) return [];
    // Briefly: a tally that has just joined the Ocean shouldn't wait long to be found (and an empty list isn't kept).
    if (tallyCache && Date.now() - tallyCache.at < 15_000) return tallyCache.list;
    const rows = await fetch(`${o.nodeUrl}/cards?skill=tally&idle=1`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ card: AgentCard }[]>).catch(() => []);
    const out = new Map<string, { url: string; webId: string }>();
    for (const r of rows.slice(0, 50)) {
      const url = r.card?.supportedInterfaces?.[0]?.url;
      if (!url || url === myUrl() || out.has(url)) continue;
      const prof = await verifyLakeCard(r.card).catch(() => null);
      if (prof?.role === 'specialist' && prof.tags.includes('tally')) out.set(url, { url, webId: prof.webId });
    }
    const list = [...out.values()].slice(0, 20);
    tallyCache = list.length ? { at: Date.now(), list } : undefined;
    return list;
  };
  // Give before you take, across the Ocean: what a member owes on this tally and on every other tally it can reach (a
  // tally that doesn't answer counts nothing), so owing the limit in one circle can't be dodged by calling another's.
  const standing = async (w: string) => owedBy(w) + (await Promise.all((await otherTallies()).map((t2) => ask(t2.url, { kind: 'tally.standing', webId: w }, 5000).then((r) => Math.max(0, Math.min(1000, Number(r.owes) || 0))).catch(() => 0)))).reduce((a, b) => a + b, 0);
  // What one tally tells another about a call handed between sister circles: `from` is the sending tally's WebID.
  const between = async (p: Record<string, unknown>, from: string, fromUrl: string): Promise<{ kind: string } & Record<string, any>> => {
    const no = (why: string) => ({ kind: 'refused', problems: [why] });
    const t = tallies.get(String(p.circle ?? ''));
    const c = t?.circle;
    if (!t || !c) return no('no circle with that id here');
    if (p.kind === 'tally.overflow') {
      // A sister circle's call: asked of the members here who offer that kind, as for one of their own.
      if (!c.sisters || !circleOpen(t)) return no('this circle takes no calls from sister circles');
      const kind = typeof p.help === 'string' ? p.help : undefined;
      if (kind ? !c.kinds?.includes(kind) : !!c.kinds) return no('this circle offers no such help');
      const caller = (p.caller ?? {}) as { webId?: string; url?: string }, origin = (p.from ?? {}) as { circle?: string; call?: string; text?: string };
      if (!caller.webId || !caller.url || !origin.circle || !origin.call) return no('caller and from are needed');
      const lim = c.limit ?? DEFAULT_LIMIT, owe = lim > 0 ? await standing(caller.webId) : 0;
      if (lim > 0 && owe >= lim) return no('the caller owes as many favours here as this circle allows');
      const year = Date.now() - 365 * 86_400_000;
      const keptThisYear = (w: string) => c.calls.filter((x) => x.helper === w && x.state === 'kept' && x.at > year).length;
      const round = roundAfter(-6000) - 1;
      const beacon = await getBeacon(round).catch(() => null);
      const id = randomBytes(6).toString('hex');
      const rank = (w: string) => createHash('sha256').update(`${beacon?.randomness ?? round}|${id}|${w}`).digest('hex');
      const order = members(t).filter((m) => m.webId !== caller.webId && keptThisYear(m.webId) < c.times && (!kind || (c.offers[m.webId] ?? c.kinds ?? []).includes(kind))).map((m) => m.webId).sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
      if (!order.length) return no('nobody here offers that just now');
      const call: CircleCall = { id, need: String(p.need ?? '').slice(0, 300), ...(kind ? { kind } : {}), ...(typeof p.when === 'string' ? { when: p.when.slice(0, 80) } : {}), caller: caller.webId, callerKey: `guest:${caller.webId}`, callerUrl: caller.url, at: Date.now(), round: beacon?.round ?? round, askedAt: Date.now(), order, asked: [], declined: [], state: 'asking', guest: { tally: from, url: fromUrl, circle: origin.circle, call: origin.call, text: String(origin.text ?? '').slice(0, 200), promise: String(p.promise ?? '').slice(0, 300) } };
      c.calls.push(call);
      askNext(t, call);
      void save();
      return { kind: 'tally.overflow.asking', circle: t.id, call: id };
    }
    // The rest name a call on either side: one of ours away at the sender's, or the sender's asked here.
    const call = c.calls.find((x) => x.id === String(p.call ?? '') && (x.away?.tally === from || x.guest?.tally === from));
    if (!call) return no('no such call between us');
    if (p.kind === 'tally.overflow.matched' && call.away && call.state === 'asking') {
      const h = (p.helper ?? {}) as { url?: string; webId?: string };
      call.helper = String(h.webId ?? ''); call.helperUrl = String(h.url ?? '');
      call.state = 'matched'; call.matchedAt = Date.now();
      void save();
      void tell(call.callerUrl, { kind: 'circle.matched', id: t.id, call: call.id, need: call.need, helper: { url: call.helperUrl, webId: call.helper }, sister: String(p.sister ?? '').slice(0, 200) });
      return { kind: 'tally.overflow.ok' };
    }
    if (p.kind === 'tally.overflow.unmet' && call.away && call.state === 'asking') { void overflow(t, call); return { kind: 'tally.overflow.ok' }; }
    if (p.kind === 'tally.overflow.kept' && call.guest && call.state === 'matched') {
      // The caller's tally checked the note against the caller's key; this one checks it names the caller and its helper.
      let note: FavourNote | undefined;
      if (typeof p.note === 'string') {
        const vc = JSON.parse(Buffer.from(p.note.split('.')[1] ?? '', 'base64url').toString() || '{}') as { issuer?: string; credentialSubject?: { id?: string } };
        if (vc.issuer !== call.caller || vc.credentialSubject?.id !== call.helper) return no('the note is not from this call\'s caller to its helper');
        note = { call: call.id, from: call.caller, to: call.helper!, ...(call.kind ? { help: call.kind } : {}), at: Date.now(), digest: createHash('sha256').update(p.note).digest('hex') };
      }
      call.state = 'kept';
      c.kept[call.helper!] = (c.kept[call.helper!] ?? 0) + 1;
      if (note) (c.notes ??= []).push(note);
      void save();
      report(t);
      void tell(members(t).find((m) => m.webId === call.helper)?.url ?? '', { kind: 'circle.kept', id: t.id, call: call.id, need: call.need, kept: c.kept[call.helper!], guest: call.guest.text, ...(note ? { note: String(p.note), digest: note.digest } : {}) });
      return { kind: 'tally.overflow.ok' };
    }
    if (p.kind === 'tally.overflow.withdrawn' && call.guest && (call.state === 'asking' || call.state === 'matched')) {
      call.state = 'withdrawn';
      void save();
      for (const w of call.helper ? [call.helper] : call.asked) void tell(members(t).find((m) => m.webId === w)?.url ?? '', { kind: 'circle.withdrawn', id: t.id, call: call.id });
      return { kind: 'tally.overflow.ok' };
    }
    if (p.kind === 'tally.overflow.disputed' && ['matched', 'kept', 'unconfirmed'].includes(call.state)) {
      call.state = 'disputed';
      for (const n of c.notes ?? []) if (n.call === call.id && !n.cleared) n.disputed = true;
      void save();
      void tell(call.away ? call.callerUrl : members(t).find((m) => m.webId === call.helper)?.url ?? '', { kind: 'circle.disputed', id: t.id, call: call.id, need: call.need });
      return { kind: 'tally.overflow.ok' };
    }
    return no(`it is ${call.state}`);
  };

  // A favour passed on (SPEC §11.4c): B, owed one by A, offers it to C, whom B owes one, to settle that. C agrees on their
  // phone; then A owes C, and B is square with C. Like a bill of exchange endorsed by hand: each holder is named, at most
  // three, and only to settle a favour already owed, so it never becomes paper anyone can hold.
  const noteOn = async (where: { tally?: string; url: string; circle: string; digest: string }) => {
    if (where.url === myUrl()) { const n = tallies.get(where.circle)?.circle?.notes?.find((x) => x.digest === where.digest); const t = tallies.get(where.circle); return n && t ? { tally: s.webId, from: n.from, to: n.to, acked: !!n.acked, live: !n.cleared && !n.disputed, toUrl: n.toUrl ?? members(t).find((m) => m.webId === n.to)?.url ?? '' } : undefined; }
    const r = await ask(where.url, { kind: 'tally.note', circle: where.circle, digest: where.digest }, 8000).catch(() => null);
    return r?.kind === 'tally.note' ? (r as { tally: string; from: string; to: string; acked: boolean; live: boolean; toUrl: string }) : undefined;
  };
  const offerPass = async (t: Tally, p: Record<string, unknown>, from: string, card: AgentCard) => {
    const no = (why: string) => ({ kind: 'refused', problems: [why] });
    const c = t.circle!;
    const jws = String(p.note ?? ''), digest = createHash('sha256').update(jws).digest('hex');
    const n = (c.notes ?? []).find((x) => x.digest === digest);
    if (!n || n.to !== from || !n.acked || n.cleared || n.disputed) return no('no favour owed to you with that note here, countersigned and not yet cleared');
    if ((n.passed?.length ?? 0) >= 2) return no('this favour has been passed on as often as it can be (three holders)');
    const st = (p.settles ?? {}) as { url?: string; circle?: string; digest?: string };
    if (!st.url || !st.circle || !st.digest) return no('settles: { url, circle, digest }: the favour you owe, that this one settles');
    const owed = await noteOn({ url: st.url, circle: st.circle, digest: st.digest });
    if (!owed || owed.from !== from || !owed.acked || !owed.live) return no('settles: no favour you owe with that note, countersigned and not yet cleared');
    if (owed.to === n.from) return no('they owe you one and you owe them one: that clears by itself');
    let sub: { id?: string; note?: string; settles?: string };
    try {
      const vc = await verifyCredential(String(p.endorsement ?? ''), (await verifyLakeCard(card)).publicJwk);
      sub = vc.credentialSubject as typeof sub;
      if (!vc.type.includes('LakeFavourEndorsement') || vc.issuer !== from || sub.id !== owed.to || sub.note !== digest || sub.settles !== st.digest) throw new Error('it does not pass this note to whom you owe, to settle that one');
    } catch (e) { return no(`endorsement: ${(e as Error).message}`); }
    const x: Pass = { id: randomBytes(6).toString('hex'), note: digest, from, to: owed.to, toUrl: owed.toUrl, settles: { tally: owed.tally, url: st.url, circle: st.circle, digest: st.digest }, endorsement: String(p.endorsement), card, at: Date.now(), state: 'offered' };
    (c.passes ??= []).push(x);
    c.passes = c.passes.slice(-200);
    void save();
    void tell(owed.toUrl, { kind: 'circle.pass.offer', id: t.id, pass: x.id, where: [{ tally: owed.tally, id: st.circle }], note: jws, settles: st.digest, ...(n.help ? { help: n.help } : {}) });
    return { kind: 'circle.pass.offered', id: t.id, pass: x.id, note: 'offered: once they agree, the one who owes you owes them, and you are square with them' };
  };
  const answerPass = async (t: Tally, p: Record<string, unknown>, from: string, card: AgentCard, envelope: LakeData['envelope']) => {
    const no = (why: string) => ({ kind: 'refused', problems: [why] });
    const c = t.circle!;
    const x = (c.passes ?? []).find((y) => y.id === String(p.pass ?? '') && y.to === from);
    if (!x || x.state !== 'offered') return no('no favour offered to you with that id');
    if (p.kind === 'circle.pass.decline') { x.state = 'declined'; void save(); void tell(members(t).find((m) => m.webId === x.from)?.url ?? '', { kind: 'circle.pass.declined', id: t.id, pass: x.id }); return { kind: 'circle.pass.declined', id: t.id, pass: x.id }; }
    if (p.settles !== x.settles.digest) return no('settles: the digest of the favour it settles, as offered');
    const n = (c.notes ?? []).find((y) => y.digest === x.note);
    if (!n || n.to !== x.from || n.cleared || n.disputed) return no('that favour is no longer theirs to pass on');
    // The favour it settles is cleared where it is kept, on the holder's endorsement and the new holder's own yes.
    const evidence = { endorsement: x.endorsement, card: x.card, acceptance: { card, envelope } };
    const done = x.settles.url === myUrl() ? await settle({ circle: x.settles.circle, digest: x.settles.digest, pass: x.id, ...evidence }) : await ask(x.settles.url, { kind: 'tally.passed', circle: x.settles.circle, digest: x.settles.digest, pass: x.id, ...evidence }, 15_000).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }));
    if (done.kind !== 'tally.passed') return no(`the favour it settles couldn't be cleared: ${JSON.stringify(done.problems ?? done.kind)}`);
    x.state = 'accepted';
    (n.passed ??= []).push(n.to);
    n.to = from; n.toUrl = x.toUrl;
    void save();
    const urlOf = (w: string) => members(t).find((m) => m.webId === w)?.url ?? '';
    void tell(urlOf(n.from), { kind: 'circle.passed', id: t.id, call: n.call, note: n.digest });
    void tell(urlOf(x.from), { kind: 'circle.pass.accepted', id: t.id, pass: x.id });
    void findLoops();
    return { kind: 'circle.pass.accepted', id: t.id, pass: x.id, note: 'the favour is yours now: the one who owed it owes you, and whoever passed it to you is square with you' };
  };
  // Here, the favour a pass settles: cleared once its debtor endorsed the pass to its creditor and the creditor said yes.
  const settle = async (p: Record<string, unknown>): Promise<{ kind: string } & Record<string, any>> => {
    const no = (why: string) => ({ kind: 'refused', problems: [why] });
    const m = tallies.get(String(p.circle ?? ''))?.circle?.notes?.find((y) => y.digest === String(p.digest ?? ''));
    if (!m || !m.acked || m.cleared || m.disputed) return no('no such favour owed here, live');
    try {
      const prof = await verifyLakeCard(p.card as AgentCard);
      const vc = await verifyCredential(String(p.endorsement ?? ''), prof.publicJwk);
      const sub = vc.credentialSubject as { id?: string; settles?: string };
      if (prof.webId !== m.from || vc.issuer !== m.from || !vc.type.includes('LakeFavourEndorsement') || sub.id !== m.to || sub.settles !== m.digest) throw new Error('the endorsement is not its debtor\'s, to its creditor, for it');
      const acc = p.acceptance as { card: AgentCard; envelope: LakeData['envelope'] };
      const v = await verifyLakeData<Record<string, unknown>>({ lake: '0.1', card: acc?.card, envelope: acc?.envelope } as LakeData<Record<string, unknown>>, { sandbox: o.sandbox, now: (acc?.envelope as { payload?: { iat?: number } })?.payload?.iat });
      if (!v.ok || v.profile.webId !== m.to || v.payload.kind !== 'circle.pass.accept' || v.payload.pass !== p.pass || v.payload.settles !== m.digest) throw new Error('its creditor did not accept this pass');
    } catch (e) { return no((e as Error).message); }
    m.cleared = `pass:${String(p.pass)}`;
    void save();
    return { kind: 'tally.passed', circle: p.circle, digest: m.digest };
  };
  const notes = async (p: Record<string, unknown>) => {
    if (p.kind === 'tally.passed') return settle(p);
    const r = await noteOn({ url: myUrl(), circle: String(p.circle ?? ''), digest: String(p.digest ?? '') });
    return r ? { kind: 'tally.note', ...r } : { kind: 'refused', problems: ['no such favour here'] };
  };

  // A circle's record on the transparency log (SPEC §11.4c): its counts and every favour note's digest with where it stands,
  // signed by this tally, whenever it changed. Nobody holds the record but the log: a note can't later be dropped or
  // rewritten without an earlier checkpoint showing it, and a member can check their own notes are there.
  const checkpoint = async (t: Tally) => {
    const c = t.circle;
    if (!o.log || !c || !circleOpen(t)) return;
    const v = circleView(t, c);
    const notes = (c.notes ?? []).map((n) => `${n.digest.slice(0, 32)}:${n.disputed ? 'disputed' : n.cleared ? 'cleared' : n.acked ? 'owed' : 'signed'}${n.passed?.length ? `:passed${n.passed.length}` : ''}`).sort();
    const body = { kind: 'circle.checkpoint', tally: s.webId, id: t.id, text: t.text, members: v.members, calls: v.calls, kept: v.kept, unmet: v.unmet, notes };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (c.checkpoint?.digest === digest) return;
    const envelope = await signMessage({ ...body, at: new Date().toISOString() }, o.id, { iss: s.webId, ttl: 10 * 365 * 86_400 });
    const entry = JSON.stringify({ card: s.card, envelope });
    if (entry.length > 60_000) return;
    const r = await o.log(entry, 'agent').catch(() => null);
    if (r) { c.checkpoint = { index: r.index, origin: r.origin, at: Date.now(), digest }; void save(); }
  };
  setInterval(() => { for (const t of tallies.values()) void checkpoint(t); }, Number(process.env.LAKE_TALLY_CHECKPOINT_MS ?? 3_600_000)).unref();

  // Agents whose cards say offering:<tag> or seeking:<tag> for one of the circle's tags, on this tally's node: each hears of
  // it once (circle.invite), and its AI brings it to its human, who decides. At most 500 a circle.
  const inviteMatches = async (t: Tally) => {
    const c = t.circle!;
    if (!o.nodeUrl || !c.tags?.length) return;
    const found = new Map<string, string>();
    for (const tag of c.tags) for (const side of ['offering', 'seeking']) {
      const rows = await fetch(`${o.nodeUrl}/cards?idle=1&tag=${encodeURIComponent(`${side}:${tag}`)}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json() as Promise<{ card: AgentCard }[]>).catch(() => []);
      for (const r of rows) { const url = r.card?.supportedInterfaces?.[0]?.url; if (url && !found.has(url)) found.set(url, `${side}:${tag}`); }
    }
    c.invited ??= [];
    for (const [url, why] of found) {
      if (c.invited.includes(url) || c.invited.length >= 500) continue;
      c.invited.push(url);
      void tell(url, { kind: 'circle.invite', ...view(t), tally: s.card.supportedInterfaces?.[0]?.url, because: why, note: `a new circle about something your human said they ${why.startsWith('offering') ? 'offer' : 'are looking for'}: bring it to them (lake_house_suggest { text, pledge: { tally, id } }); they decide on their phone` });
    }
    void save();
  };
  // What a member owes across every circle here: favour notes not cleared or disputed, and calls they never thanked.
  const owedBy = (w: string) => [...tallies.values()].reduce((n, t) => n + (t.circle?.notes ?? []).filter((x) => x.from === w && !x.cleared && !x.disputed).length + (t.circle?.calls ?? []).filter((x) => x.caller === w && x.state === 'unconfirmed').length, 0);
  // The next members in a call's drawn order, once all asked so far said no (or didn't answer in time); nobody left: unmet.
  const askNext = (t: Tally, call: CircleCall) => {
    const c = t.circle!, all = members(t);
    const next = call.order.filter((w) => !call.asked.includes(w)).slice(0, ASK_AT_ONCE);
    if (next.length) {
      call.asked.push(...next);
      call.askedAt = Date.now();
      for (const w of next) { c.asked[w] = (c.asked[w] ?? 0) + 1; void tell(all.find((m) => m.webId === w)?.url ?? '', { kind: 'circle.ask', id: t.id, call: call.id, need: call.need, ...(call.guest ? { guest: call.guest.text, their_promise: call.guest.promise } : {}), ...(call.kind ? { help: call.kind } : {}), ...(call.when ? { when: call.when } : {}), promise: c.promise, text: t.text }); }
    } else if (call.guest) {
      call.state = 'unmet';
      void toTally(call.guest.url, { kind: 'tally.overflow.unmet', circle: call.guest.circle, call: call.guest.call });
    } else if (c.sisters && (call.tried?.length ?? 0) < SISTERS_TRIED) {
      void overflow(t, call);
    } else {
      call.state = 'unmet';
      void tell(call.callerUrl, { kind: 'circle.unmet', id: t.id, call: call.id, need: call.need });
    }
  };
  // A call nobody asked answers in time goes on to the next members (each tally's 30-second pass).
  const circleTick = (t: Tally) => {
    for (const call of t.circle?.calls ?? []) {
      if (call.state === 'matched' && call.matchedAt && Date.now() - call.matchedAt > CONFIRM_WITHIN) { call.state = 'unconfirmed'; void save(); continue; }
      if (call.state !== 'asking' || call.away || Date.now() - call.askedAt < ASK_WITHIN) continue;
      for (const w of call.asked) if (!call.declined.includes(w)) call.declined.push(w);
      askNext(t, call);
      void save();
    }
  };
  const circle = async (t: Tally, p: Record<string, unknown>, from: string, card: AgentCard, key: string, envelope: LakeData['envelope']): Promise<{ kind: string } & Record<string, unknown>> => {
    const c = t.circle;
    const no = (why: string) => ({ kind: 'refused', problems: [why] });
    if (!c) return no('this pledge is not a promise circle');
    if (!circleOpen(t)) return no(`the circle opens for calls once the pledge has filled and everyone is known (it is ${t.state}${t.blind?.unveil && !t.blind.unveiled ? ', not yet unveiled' : ''})`);
    const all = members(t);
    const me = all.find((m) => m.webId === from);
    if (p.kind === 'circle.pass.accept' || p.kind === 'circle.pass.decline') return answerPass(t, p, from, card, envelope);
    if (!me) return no('only the circle\'s members call it or answer its calls');
    const year = Date.now() - 365 * 86_400_000;
    const keptThisYear = (w: string) => c.calls.filter((x) => x.helper === w && x.state === 'kept' && x.at > year).length;
    const urlOf = (w: string) => all.find((m) => m.webId === w)?.url ?? '';
    // Circles saved before offers and reports existed have neither.
    c.offers ??= {}; c.reports ??= {};
    const offersOf = (w: string) => c.offers[w] ?? c.kinds ?? [];
    if (p.kind === 'circle.record') {
      const open = (c.notes ?? []).filter((n) => !n.cleared);
      return { kind: 'circle.record', id: t.id, ...circleView(t, c), you: { kept: c.kept[from] ?? 0, asked: c.asked[from] ?? 0, owed_to_you: open.filter((n) => n.to === from && !n.disputed).length, you_owe: open.filter((n) => n.from === from && !n.disputed).length, owe_everywhere: owedBy(from), can_ask: !(c.limit ?? DEFAULT_LIMIT) || owedBy(from) < (c.limit ?? DEFAULT_LIMIT), ...(c.kinds ? { offers: offersOf(from) } : {}), calls: c.calls.filter((x) => x.caller === from).map(({ id, need, state, at }) => ({ id, need, state, at: new Date(at).toISOString() })) } };
    }
    if (p.kind === 'circle.pass') return offerPass(t, p, from, card);
    if (p.kind === 'circle.offer') {
      // What this member will help with, of the circle's kinds: calls for anything else never reach them.
      const kinds = Array.isArray(p.kinds) ? p.kinds.map(String) : [];
      if (!c.kinds) return no('this circle has no kinds of help to choose from: each member promised the same thing');
      if (!kinds.length || kinds.some((k) => !c.kinds!.includes(k))) return no(`kinds: one or more of ${c.kinds.join(', ')}`);
      c.offers[from] = [...new Set(kinds)];
      void save();
      return { kind: 'circle.offered', id: t.id, offers: c.offers[from] };
    }
    if (p.kind === 'circle.call') {
      const need = String(p.need ?? '').trim(), when = typeof p.when === 'string' ? p.when.slice(0, 80) : undefined;
      if (!need || need.length > 300) return no('need: what you need, in a few words (up to 300 characters)');
      // A call asks for one of the kinds of help members promised, and only those who offer it are asked.
      const kind = c.kinds ? String(p.help ?? '') : undefined;
      if (c.kinds && !c.kinds.includes(kind!)) return no(`help: which kind of help, one of ${c.kinds.join(', ')}; the need says the details`);
      if ((c.reports[key]?.length ?? 0) >= REPORTS_TO_BAR) return no(`${REPORTS_TO_BAR} members reported calls from this key: it can't call this circle`);
      const open = c.calls.find((x) => x.caller === from && (x.state === 'asking' || x.state === 'matched'));
      if (open) return no(`your call "${open.need}" is still open: say it happened (circle.kept) or withdraw it (circle.withdraw) first`);
      // A call nobody could take, or withdrawn, doesn't use up one of yours.
      const mine = c.calls.filter((x) => x.caller === from && x.at > year && (x.state === 'asking' || x.state === 'matched' || x.state === 'kept')).length;
      if (mine >= c.times) return no(`you have called ${mine} time${mine === 1 ? '' : 's'} this year; each member may call ${c.times}`);
      // Give before you take: owing as many favours as the circle allows, help someone first (a loop may square you).
      const lim = c.limit ?? DEFAULT_LIMIT, owe = lim > 0 ? await standing(from) : 0;
      if (lim > 0 && owe >= lim) return no(`you owe ${owe} favour${owe === 1 ? '' : 's'} across your circles, as many as this circle lets a member owe and still ask: help someone first (say yes to an ask), and you can ask again`);
      // Who may be asked: everyone else who hasn't yet kept all they promised this year, in an order drawn from a drand
      // round already out, so anyone can check the tally picked nobody.
      const round = roundAfter(-6000) - 1;
      const beacon = await getBeacon(round).catch(() => null);
      const id = randomBytes(6).toString('hex');
      const rank = (w: string) => createHash('sha256').update(`${beacon?.randomness ?? round}|${id}|${w}`).digest('hex');
      const order = all.filter((m) => m.webId !== from && keptThisYear(m.webId) < c.times && (!kind || offersOf(m.webId).includes(kind))).map((m) => m.webId).sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
      if (!order.length && !c.sisters) return no(kind ? `nobody else in the circle offers ${kind}, or all who do have kept what they promised this year` : 'nobody in the circle can be asked: every other member has kept what they promised this year');
      const call: CircleCall = { id, need, ...(kind ? { kind } : {}), ...(when ? { when } : {}), caller: from, callerKey: key, callerUrl: me.url || card.supportedInterfaces?.[0]?.url || '', at: Date.now(), round: beacon?.round ?? round, askedAt: Date.now(), order, asked: [], declined: [], state: 'asking' };
      c.calls.push(call);
      askNext(t, call);
      void save();
      if (!call.asked.length) return { kind: 'circle.called', id: t.id, call: id, asked: 0, round: call.round, sisters: true, note: 'nobody here can take it, so it goes to a sister circle, without saying who you are; you hear when someone says yes' };
      return { kind: 'circle.called', id: t.id, call: id, asked: call.asked.length, round: call.round, note: `asked ${call.asked.length} member${call.asked.length === 1 ? '' : 's'}, in an order drawn from drand round ${call.round}, without saying who you are; you hear when one says yes` };
    }
    const call = c.calls.find((x) => x.id === String(p.call ?? ''));
    if (!call) return no('no call with that id in this circle');
    if (p.kind === 'circle.accept' || p.kind === 'circle.decline' || p.kind === 'circle.report') {
      if (!call.asked.includes(from)) return no('you weren\'t asked to take this call');
      if (call.state !== 'asking') return no(call.state === 'matched' ? 'someone else has taken it: thank you' : `it is ${call.state}`);
      if (p.kind === 'circle.accept') {
        call.helper = from;
        call.state = 'matched';
        call.matchedAt = Date.now();
        void save();
        // The two meet: each gets the other's house to reach. The others asked hear it's taken.
        if (call.guest) void toTally(call.guest.url, { kind: 'tally.overflow.matched', circle: call.guest.circle, call: call.guest.call, helper: { url: me.url, webId: me.webId }, sister: t.text });
        else void tell(call.callerUrl, { kind: 'circle.matched', id: t.id, call: call.id, need: call.need, helper: { url: me.url, webId: me.webId } });
        for (const w of call.asked) if (w !== from) void tell(urlOf(w), { kind: 'circle.filled', id: t.id, call: call.id });
        return { kind: 'circle.matched', id: t.id, call: call.id, need: call.need, ...(call.when ? { when: call.when } : {}), caller: { url: call.callerUrl }, note: 'you have it: reach them at their house; when it\'s done, they say so and your promise counts as kept' };
      }
      if (!call.declined.includes(from)) call.declined.push(from);
      // A report is a no too, and counts against the caller's key (never its name): enough members, and it can't call.
      if (p.kind === 'circle.report') c.reports[call.callerKey] = [...new Set([...(c.reports[call.callerKey] ?? []), from])];
      // Everyone asked so far said no: the next few in the drawn order; nobody left: unmet.
      if (call.asked.every((w) => call.declined.includes(w))) askNext(t, call);
      void save();
      return { kind: p.kind === 'circle.report' ? 'circle.reported' : 'circle.declined', id: t.id, call: call.id, note: p.kind === 'circle.report' ? 'reported, and passed on: the caller isn\'t told who reported it' : 'passed on to the next member; nobody else learns you said no' };
    }
    if (p.kind === 'circle.dispute') {
      // Either side says it didn't go as it should: recorded as disputed, no favour owed for it, and it counts against
      // neither (the record shows that it happened, not who was right).
      if (from !== call.caller && from !== call.helper) return no('only the two people in a call can dispute it');
      if (!['matched', 'kept', 'unconfirmed'].includes(call.state)) return no(`it is ${call.state}`);
      call.state = 'disputed';
      for (const n of c.notes ?? []) if (n.call === call.id && !n.cleared) n.disputed = true;
      void save();
      const away = from === call.caller ? call.away : call.guest;
      if (away) void toTally(away.url, { kind: 'tally.overflow.disputed', circle: away.circle, call: away.call });
      else void tell(from === call.caller ? urlOf(call.helper!) : call.callerUrl, { kind: 'circle.disputed', id: t.id, call: call.id, need: call.need });
      return { kind: 'circle.disputed', id: t.id, call: call.id, note: 'recorded as disputed: no favour is owed for it, and it counts against neither of you' };
    }
    if (p.kind === 'circle.ack') {
      // The helper's house countersigns the favour note it was sent: from then on it can clear in a loop.
      const n = (c.notes ?? []).find((x) => x.call === call.id && x.digest === String(p.digest ?? ''));
      if (!n || n.to !== from) return no('no favour note to you with that digest on this call');
      n.acked = true;
      void save();
      void findLoops();
      return { kind: 'circle.acked', id: t.id, call: call.id };
    }
    if (from !== call.caller) return no('only whoever called says it happened, or withdraws it');
    if (p.kind === 'circle.kept') {
      if (call.state !== 'matched' && call.state !== 'unconfirmed') return no(`it is ${call.state}`);
      // The thanks, as a favour note the caller's house signed: this call, this helper, one favour. Checked against the
      // caller's own key before it counts; the helper's house gets it and countersigns (circle.ack).
      let note: FavourNote | undefined;
      if (p.note !== undefined) {
        try {
          const vc = await verifyCredential(String(p.note), (await verifyLakeCard(card)).publicJwk);
          const sub = vc.credentialSubject as { id?: string; call?: string; circle?: { id?: string } };
          if (!vc.type.includes('LakeFavour') || vc.issuer !== from || sub.id !== call.helper || sub.call !== call.id || sub.circle?.id !== t.id) throw new Error('it is not a favour note for this call, from you, to its helper');
          note = { call: call.id, from, to: call.helper!, ...(call.kind ? { help: call.kind } : {}), at: Date.now(), digest: createHash('sha256').update(String(p.note)).digest('hex') };
        } catch (e) {
          return no(`note: ${(e as Error).message}`);
        }
      }
      call.state = 'kept';
      if (call.away) {
        void save();
        report(t);
        void toTally(call.away.url, { kind: 'tally.overflow.kept', circle: call.away.circle, call: call.away.call, ...(note ? { note: String(p.note) } : {}) });
        return { kind: 'circle.kept', id: t.id, call: call.id, ...circleView(t, c) };
      }
      c.kept[call.helper!] = (c.kept[call.helper!] ?? 0) + 1;
      if (note) (c.notes ??= []).push(note);
      void save();
      report(t);
      void tell(urlOf(call.helper!), { kind: 'circle.kept', id: t.id, call: call.id, need: call.need, kept: c.kept[call.helper!], ...(note ? { note: String(p.note), digest: note.digest } : {}) });
      return { kind: 'circle.kept', id: t.id, call: call.id, ...circleView(t, c) };
    }
    // circle.withdraw
    if (call.state !== 'asking' && call.state !== 'matched') return no(`it is ${call.state}`);
    call.state = 'withdrawn';
    void save();
    if (call.away) void toTally(call.away.url, { kind: 'tally.overflow.withdrawn', circle: call.away.circle, call: call.away.call });
    else for (const w of call.helper ? [call.helper] : call.asked) void tell(urlOf(w), { kind: 'circle.withdrawn', id: t.id, call: call.id });
    return { kind: 'circle.withdrawn', id: t.id, call: call.id };
  };

  /** A blind pledge's messages: a pass to sign, a secret to withdraw, a salt to reveal yourself once it has filled. */
  const blindly = async (t: Tally, p: Record<string, unknown>, from: string, profile: { ownerDomain: string }, card: AgentCard) => {
    const b = t.blind!;
    const hex = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
    if (p.kind === 'tally.sign') {
      if (t.state !== 'open' && t.state !== 'triggered') return { kind: 'refused', problems: [`it has ${t.state}`] };
      if (t.deadline < Date.now()) return { kind: 'refused', problems: ['its deadline has passed'] };
      if (typeof p.pass !== 'string' || !hex(p.commit) || !hex(p.withdraw)) return { kind: 'refused', problems: ['a blind pledge takes { pass, commit, withdraw }: a pass from its issuer, sha256(your webId|salt), sha256(a withdraw secret). Send it from a throwaway identity; lake_pledge does all of this.'] };
      // An unveiling pledge takes only signatures whose reveal is sealed to its round, so nobody can hold theirs back; the
      // refusal says the round, before the pass is spent.
      if (b.unveil && (typeof p.sealed !== 'string' || p.sealed.length > 64_000 || sealedRound(p.sealed) !== b.unveil)) return { kind: 'refused', problems: [`this pledge unveils everyone at once: add sealed, your own signed tally.reveal { tally: <this tally's webId>, id, salt } with your card ({ lake, card, envelope } as JSON), sealed to drand round ${b.unveil}; lake_pledge does it`], unveil: { round: b.unveil } };
      const ok = await checkPass(p.pass, b.publicJwk, passChallenge(b.issuer, t.id, s.webId));
      if (!ok.ok) return { kind: 'refused', problems: [ok.why] };
      if (b.spent.includes(ok.nonce)) return { kind: 'refused', problems: ['that pass has been used'] };
      b.spent.push(ok.nonce);
      b.passes.push({ commit: String(p.commit), withdraw: String(p.withdraw), at: new Date().toISOString(), ...(b.unveil ? { sealed: String(p.sealed) } : {}) });
      if (t.state === 'open' && b.passes.length >= t.threshold) {
        t.state = 'triggered';
        t.triggeredAt = Date.now();
      }
      void save();
      report(t);
      return { kind: t.state === 'triggered' ? 'tally.triggered' : 'tally.signed', ...view(t), note: t.state === 'triggered' ? (b.unveil ? `It has filled: every sealed reveal opens at once at ${new Date(roundTimeMs(b.unveil)).toISOString()}, and each signer is told who is in.` : 'It has filled: reveal yourself with tally.reveal { id, salt } from your own identity.') : 'Counted, by a pass nobody can trace to you.' };
    }
    if (p.kind === 'tally.withdraw') {
      if (t.state !== 'open') return { kind: 'refused', problems: [`it has ${t.state}; nothing to withdraw from`] };
      const h = createHash('sha256').update(String(p.secret ?? '')).digest('hex');
      const before = b.passes.length;
      b.passes = b.passes.filter((x) => x.withdraw !== h);
      if (b.passes.length === before) return { kind: 'refused', problems: ['no signature with that withdraw secret'] };
      void save();
      report(t);
      return { kind: 'tally.withdrawn', ...view(t) };
    }
    const revealed = () => b.passes.filter((x) => x.revealed).map((x) => x.revealed!);
    if (p.kind === 'tally.reveal') {
      // Once it has filled, each signer opens its own commitment, as itself.
      if (t.state !== 'triggered') return { kind: 'refused', problems: ['reveal once it has filled; until then nobody, this tally included, knows who signed'] };
      const c = commitTo(from, String(p.salt ?? ''));
      const mine = b.passes.find((x) => x.commit === c);
      if (!mine) return { kind: 'refused', problems: ['no signature commits to you with that salt'] };
      mine.revealed ??= { webId: from, domain: profile.ownerDomain, url: card.supportedInterfaces?.[0]?.url ?? '' };
      void save();
      return { kind: 'tally.revealed', ...view(t), signers: revealed().map(({ domain, url }) => ({ domain, url })), unrevealed: b.passes.length - revealed().length };
    }
    // tally.count: the count for anyone; who has revealed, to those who have revealed and to the opener.
    const show = t.state === 'triggered' && (revealed().some((x) => x.webId === from) || profile.ownerDomain === t.opener);
    return { kind: 'tally.count', ...view(t), ...(show ? { signers: revealed().map(({ domain, url }) => ({ domain, url })), unrevealed: b.passes.length - revealed().length } : {}) };
  };

  const s: Specialist = await specialist<{ kind: string }>(o, 'Tally', 'A blind tally for pledges that bind only once enough sign. Until the threshold it says how many have signed, never who (not even to whoever opened it); then it tells every signer at once. With people_only, it counts people instead of identities: each signature needs a person stamp for this tally (its context is \"<this tally\'s webId>|<id>\"), presented to this tally. A pledge that counts households or people should be people_only: otherwise any agent\'s key counts as one (run 39: an organiser\'s agent counted itself as a household). A house signs as its owner, with the owner\'s person stamp. Opened with blind: true, nobody (this tally included) learns who signed: signatures are anonymous passes from a pass issuer, and signers reveal themselves once it fills (lake_pledge does it). With unveil: true as well, nobody reveals first: each signer\'s reveal is sealed to a drand round just after the deadline, and if it filled, this tally opens them all at once then; if it lapsed, it discards them unopened. With money ({ contribution: { amount, currency }, payee: { webId, url, name? }, bond?: { hold } }), each signature needs its contribution held for this pledge by the payments agent (sign with { hold }); at the deadline the payments agent, on this tally\'s word, pays them all to the payee if it filled, or gives them all back if it lapsed, and shares the opener\'s bond (people_only pledges) equally among the signers: saying yes costs nothing if it doesn\'t happen, and pays. With quorum ({ options, at_least, closes }, people_only), nobody signs at first: each person privately answers "I\'m in if at least N of us are" from their house, as a secret count only this tally can close; when it closes, the tally opens the pledge to bind at the largest group whose every member said they\'d join a group that size (if that is at least threshold), or lets it lapse, and tells everyone who answered at once. With circle ({ promise, times }, people_only), it is a promise circle: each signer promises the others something so many times a year; once it has filled and everyone is known, members send circle.call { id, need, when? }, a few others (in an order drawn from a public drand round) get circle.ask without the caller\'s name, the first circle.accept { id, call } is put in touch with the caller, and the caller\'s circle.kept { id, call } counts the promise kept (circle.decline, circle.withdraw, circle.record { id }). No money moves. Send { kind: "tally.open", id, text, threshold, deadline, people_only?, blind?, unveil?, listed?, money?, quorum?, circle? } (listed: anyone can find it with tally.list, with how many more it needs), { kind: "tally.sign", id }, { kind: "tally.withdraw", id }, { kind: "tally.count", id } or { kind: "tally.list" }.', 'tally', async (p, from, profile, card: AgentCard, envelope) => {
    const id = String(p.id ?? '');
    if (p.kind === 'tally.open') {
      const threshold = Number(p.threshold), deadline = Date.parse(String(p.deadline ?? ''));
      const problems = [
        ...(ID.test(id) ? [] : ['id: a short code, lowercase letters, digits and dashes']),
        ...(tallies.has(id) ? [`id: "${id}" is taken; pick another`] : []),
        ...(typeof p.text === 'string' && p.text.trim() && p.text.length <= 600 ? [] : ['text: what signers commit to, up to 600 characters']),
        ...(Number.isInteger(threshold) && threshold >= 2 && threshold <= 100_000 ? [] : ['threshold: a whole number, at least 2']),
        ...(deadline > Date.now() && deadline < Date.now() + MAX_DAYS * 86_400_000 ? [] : [`deadline: a time in the next ${MAX_DAYS} days`]),
      ];
      if (p.unveil === true && p.blind !== true) problems.push('unveil: for blind pledges (blind: true), whose signers are hidden until they reveal');
      // Money: what each signer puts in, held until the deadline, and to whom it goes if it fills; and the opener's bond.
      const money = p.money as { contribution?: { amount?: unknown; currency?: unknown }; payee?: { webId?: unknown; url?: unknown; name?: unknown }; bond?: { hold?: unknown } } | undefined;
      const cents = Math.round(Number(money?.contribution?.amount) * 100), currency = String(money?.contribution?.currency ?? '');
      if (money) {
        if (!o.paymentsUrl) problems.push('money: this tally has no payments agent to hold it');
        if (p.blind === true) problems.push('money: not for blind pledges (whoever holds the money sees who paid it)');
        if (!(cents >= 1 && cents <= 1_000_000 && Math.abs(Number(money.contribution?.amount) * 100 - cents) < 1e-6)) problems.push('money.contribution: { amount: what each signer puts in, in whole cents, up to 10000; currency }');
        if (!isCurrency(currency)) problems.push('money.contribution.currency: a three-letter code, like AUD');
        if (typeof money.payee?.webId !== 'string' || !/^https?:\/\/\S+$/.test(String(money.payee?.url ?? ''))) problems.push('money.payee: { webId, url, name? }: who is paid if it fills');
        if (money.bond && p.people_only !== true) problems.push('money.bond: for people_only pledges, or one person could sign many times and take most of the bond');
      }
      if (problems.length) return { kind: 'refused', problems };
      let bond: { hold: string; amount: number } | undefined;
      if (money?.bond) {
        // The bond, held for this pledge before it opens: what a lapse shares among the signers.
        const r = await ask(o.paymentsUrl!, { kind: 'pledge.hold', id, hold: String(money.bond.hold ?? '') }).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }) as Record<string, any>);
        const wrong = r.kind !== 'pledge.hold' ? `the payments agent: ${(r.problems ?? [r.kind]).join('; ')}` : r.status !== 'held' ? `it was ${r.status}` : r.bond !== true ? 'it was paid as a contribution, not a bond' : r.currency !== currency ? `it is in ${r.currency}, the contributions in ${currency}` : Date.parse(r.until) < deadline + 3_600_000 ? 'it goes back before the pledge can settle: hold it until at least an hour after the deadline' : '';
        if (wrong) return { kind: 'refused', problems: [`money.bond: pay the bond held for this pledge first (hold: true, pledge: { tally: ${s.webId}, id: "${id}", bond: true, until }, agreement ${pledgeAgreement(s.webId, id, true)}), then open it with { bond: { hold } }: ${wrong}`] };
        bond = { hold: String(r.hold), amount: Math.round(Number(r.amount) * 100) };
      }
      const t: Tally = { id, text: String(p.text).trim(), threshold, deadline, opener: profile.ownerDomain, state: 'open', signers: [], ...(p.people_only === true ? { peopleOnly: true } : {}), ...(p.listed === true ? { listed: true } : {}),
        ...(money ? { money: { contribution: cents, currency, payee: { webId: String(money.payee!.webId), url: String(money.payee!.url), ...(typeof money.payee!.name === 'string' ? { name: money.payee!.name.slice(0, 80) } : {}) }, ...(bond ? { bond } : {}), counted: [] } } : {}) };
      if (p.circle !== undefined) {
        const c = p.circle as { promise?: unknown; times?: unknown; kinds?: unknown; tags?: unknown; limit?: unknown; sisters?: unknown };
        const limit = c.limit === undefined ? DEFAULT_LIMIT : Number(c.limit);
        if (!(Number.isInteger(limit) && limit >= 0 && limit <= 50)) return { kind: 'refused', problems: ['circle.limit: how many favours a member may owe and still ask (0: need-based, no limit; default 2)'] };
        const tags = Array.isArray(c.tags) ? [...new Set(c.tags.map((x) => String(x).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean))] : [];
        if (tags.length > 8 || tags.some((x) => x.length > 32)) return { kind: 'refused', problems: ['circle.tags: up to 8 short tags (kids-clothes, brisbane): agents whose humans offer or seek one are invited'] };
        const times = Number(c.times ?? 1);
        const kinds = Array.isArray(c.kinds) ? c.kinds.map((k) => String(k).trim()).filter(Boolean) : undefined;
        if (kinds && (kinds.length < 2 || kinds.length > 12 || kinds.some((k) => k.length > 40) || new Set(kinds).size !== kinds.length)) return { kind: 'refused', problems: ['circle.kinds: 2 to 12 different kinds of help, each up to 40 characters (a call names one; members say which they offer)'] };
        if (typeof c.promise !== 'string' || !c.promise.trim() || c.promise.length > 300 || !(Number.isInteger(times) && times >= 1 && times <= 12) || money) return { kind: 'refused', problems: ['circle: { promise: what each member promises the others (up to 300 characters), times: how many times a year, 1 to 12 }; not with money'] };
        if (p.people_only !== true) return { kind: 'refused', problems: ['circle: for people_only pledges: one member per person, so nobody is asked twice by one person with two houses'] };
        t.circle = { promise: c.promise.trim(), times, limit, ...(kinds ? { kinds } : {}), ...(tags.length ? { tags, invited: [] } : {}), ...(c.sisters === true ? { sisters: true } : {}), offers: {}, calls: [], kept: {}, asked: {}, reports: {} };
      }
      if (p.quorum !== undefined) {
        // A quorum first (SPEC §11.4b): a secret count of everyone's "I'm in if at least N are", at this tally's tellers.
        const q = p.quorum as { options?: unknown; at_least?: unknown; closes?: unknown };
        const options = Array.isArray(q.options) ? q.options.map(String) : [];
        const atLeast = Array.isArray(q.at_least) ? q.at_least.map((x) => (x === null ? null : Number(x))) : [];
        const closes = Date.parse(String(q.closes ?? ''));
        const wrong = [
          ...(options.length >= 2 && options.length <= 16 && options.every((x) => x.trim() && x.length <= 100) && new Set(options).size === options.length ? [] : ['quorum.options: 2 to 16 different answers, each up to 100 characters']),
          ...(atLeast.length === options.length && atLeast.every((x) => x === null || (Number.isInteger(x) && x >= 0 && x <= 100_000)) ? [] : ['quorum.at_least: for each option, the group size it means ("I\'m in if at least N of us are"), or null for never']),
          ...(closes > Date.now() + 60_000 && closes < deadline - 60_000 && closes < Date.now() + 72 * 3_600_000 ? [] : ['quorum.closes: when answers stop, at least a minute from now and a minute before the deadline, within 72 hours']),
          ...(p.people_only === true ? [] : ['quorum: for people_only pledges, one answer per person']),
          ...(money ? ['quorum: not with money'] : []),
          ...((o.tellers?.length ?? 0) >= 2 ? [] : ['this tally runs no pair of tellers to count a quorum']),
        ];
        if (wrong.length) return { kind: 'refused', problems: wrong };
        let tellers: { url: string; domain: string }[];
        try {
          tellers = await Promise.all(o.tellers!.slice(0, 2).map(async (url) => ({ url, domain: (await verifyLakeCard((await (await fetch(cardUrlFor(url), { signal: AbortSignal.timeout(8000) })).json()) as AgentCard)).ownerDomain })));
        } catch (e) {
          return { kind: 'refused', problems: [`its tellers: ${(e as Error).message}`] };
        }
        const count = `quorum:${id}`;
        const r = await ask(tellers[0]!.url, { kind: 'count.open', id: count, length: options.length, min: 3, deadline: new Date(closes).toISOString(), helper: tellers[1] }).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }) as Record<string, any>);
        if (r.kind !== 'count.opened') return { kind: 'refused', problems: [`the tellers: ${(r.problems ?? [r.kind]).join('; ')}`] };
        t.state = 'gathering';
        t.quorum = { options, atLeast, closes, count, tellers, joined: [], ...(p.blind === true ? { blind: true, ...(p.unveil === true ? { unveil: true } : {}) } : {}) };
      } else if (p.blind === true) {
        const err = await registerBlind(t, p.unveil === true);
        if (err) return { kind: 'refused', problems: [err] };
      }
      tallies.set(id, t);
      void save();
      // A listed circle finds its people: every agent whose human offers or seeks one of its tags is told, once.
      if (t.circle?.tags?.length && t.listed) void inviteMatches(t);
      report(t);
      return { kind: 'tally.opened', ...view(t) };
    }
    // Pledges their openers listed, still open: what each says and how many more it needs (run 22's pledges lapsed one short).
    // And those that filled in the last day, with where they stand (run 31: a pledge that filled vanished from the list,
    // and nobody could see it had bound). When it filled isn't said: that moment would point at its last signer.
    if (p.kind === 'tally.list') {
      for (const t of tallies.values()) lapse(t);
      const listed = [...tallies.values()].filter((t) => t.listed);
      return {
        kind: 'tally.list',
        pledges: listed.filter((t) => t.state === 'open').map((t) => ({ ...view(t), needs: Math.max(0, t.threshold - counted(t)) })),
        // Still finding their quorum: answer privately from a house; they open for signing only if enough would join.
        gathering: listed.filter((t) => t.state === 'gathering').map(view),
        // Promise circles still taking members (until their deadline), filled or not: what each promises, and how they keep it.
        circles: listed.filter((t) => t.circle && (t.state === 'open' || t.state === 'triggered') && t.deadline > Date.now()).map((t) => ({ ...view(t), needs: Math.max(0, t.threshold - counted(t)) })),
        filled: listed.filter((t) => t.state === 'triggered' && Date.now() - (t.triggeredAt ?? 0) < 86_400_000).map(view),
        // Circles that take each other's calls nobody in them can take (SPEC §11.4c), listed or not: that's what they're for.
        sisters: sisterCircles(),
      };
    }
    if (!['tally.sign', 'tally.withdraw', 'tally.count', 'tally.reveal', 'tally.quorum', 'circle.call', 'circle.accept', 'circle.decline', 'circle.report', 'circle.offer', 'circle.kept', 'circle.ack', 'circle.dispute', 'circle.withdraw', 'circle.record', 'circle.clear.consent', 'tally.edges', 'tally.cleared', 'tally.look', 'tally.standing', 'tally.note', 'tally.passed', 'circle.pass', 'circle.pass.accept', 'circle.pass.decline', 'tally.overflow', 'tally.overflow.matched', 'tally.overflow.unmet', 'tally.overflow.kept', 'tally.overflow.withdrawn', 'tally.overflow.disputed'].includes(String(p.kind))) return { kind: 'refused', problems: ['send tally.open { id, text, threshold, deadline, people_only?, blind?, listed? }, tally.list, tally.sign { id }, tally.withdraw { id }, tally.count { id } or (blind) tally.reveal { id, salt }'] };
    if (p.kind === 'circle.clear.consent') return consent(String(p.clearing ?? ''), from, String(p.owe ?? ''), String(p.owed ?? ''), card, envelope);
    // Between tallies across the Ocean: favours owed (to tallies only), and a loop another tally cleared.
    if (p.kind === 'tally.edges' || p.kind === 'tally.cleared' || p.kind === 'tally.look' || p.kind === 'tally.standing' || p.kind === 'tally.note' || p.kind === 'tally.passed' || String(p.kind).startsWith('tally.overflow')) {
      if (profile.role !== 'specialist' || !profile.tags.includes('tally')) return { kind: 'refused', problems: ['for tallies only'] };
      if (String(p.kind).startsWith('tally.overflow')) return between(p, from, card.supportedInterfaces?.[0]?.url ?? '');
      if (p.kind === 'tally.look') { void findLoops(); return { kind: 'tally.looking' }; }
      if (p.kind === 'tally.standing') return { kind: 'tally.standing', owes: owedBy(String(p.webId ?? '')) };
      if (p.kind === 'tally.note' || p.kind === 'tally.passed') return notes(p);
      return p.kind === 'tally.edges' ? { kind: 'tally.edges', edges: localEdges() } : clearRemote(p);
    }
    const t = tallies.get(id);
    if (!t) return { kind: 'refused', problems: [`no tally called "${id}"`] };
    lapse(t);
    if (p.kind === 'tally.quorum') {
      // One answer per person: the house shows its person stamp for this pledge, then sends its answer to the count.
      const q = t.quorum;
      if (!q || t.state !== 'gathering' || q.closes < Date.now()) return { kind: 'refused', problems: [q ? 'its quorum has closed' : 'this pledge asks no quorum question'] };
      const context = countContext(s.webId, t.id);
      const stamp = await checkSdJwtAttachment(p.person as { credential?: unknown; card?: AgentCard } | undefined, { trusted: checkers, vct: PERSON_IN_CONTEXT_VCT, subject: from, holder: profile.publicJwk, aud: s.webId, nonce: t.id, sandbox: o.sandbox });
      if (!stamp.ok || stamp.claims.context !== context) return { kind: 'refused', problems: [`its quorum counts people: attach a person stamp for "${context}" from ${checkers.join(' or ')} (${stamp.ok ? 'it is for another count' : stamp.why})`] };
      const person = String(stamp.claims.person ?? '');
      if (q.joined.some((x) => x.person === person || x.webId === from)) return { kind: 'refused', problems: ['you have answered already: one answer per person'] };
      q.joined.push({ webId: from, person, url: card.supportedInterfaces?.[0]?.url ?? '' });
      void save();
      return { kind: 'tally.joined', id: t.id, answered: q.joined.length, closes: new Date(q.closes).toISOString(), count: q.count, tellers: q.tellers, note: 'now send your answer to the count: one option, as two unreadable shares, one to each of these tellers. Only the totals come out, to this tally alone, when the quorum closes.' };
    }
    if (String(p.kind).startsWith('circle.')) return circle(t, p, from, card, String(profile.publicJwk.kid ?? from), envelope);
    if (t.state === 'gathering' && p.kind !== 'tally.count') return { kind: 'refused', problems: [`it is still finding its quorum: it opens for signing at ${new Date(t.quorum!.closes).toISOString()} only if enough people privately said they'd join`] };
    if (t.blind) {
      await unveil(t);
      return blindly(t, p, from, profile, card);
    }
    const signed = t.signers.some((x) => x.webId === from);
    if (p.kind === 'tally.count') {
      // Names only after the trigger, and only to those who signed or opened it.
      const show = t.state === 'triggered' && (signed || profile.ownerDomain === t.opener);
      return { kind: 'tally.count', ...view(t), ...(show ? { signers: t.signers.map(({ domain, url }) => ({ domain, url })) } : {}) };
    }
    if (p.kind === 'tally.withdraw') {
      if (t.state !== 'open') return { kind: 'refused', problems: [`it has ${t.state}; nothing to withdraw from`] };
      const mine = t.signers.find((x) => x.webId === from);
      t.signers = t.signers.filter((x) => x.webId !== from);
      // Its contribution goes back at once: taken back before it filled, it never bound them.
      if (t.money && mine?.hold) {
        t.money.counted = t.money.counted.filter((h) => h !== mine.hold);
        await ask(o.paymentsUrl!, { kind: 'pledge.release', id: t.id, hold: mine.hold }).catch(() => undefined);
      }
      void save();
      report(t);
      return { kind: 'tally.withdrawn', ...view(t) };
    }
    if (p.kind === 'tally.sign') {
      // A pledge that has triggered still takes signatures until its deadline: more people standing by it (run 16 turned
      // a late signer away).
      if (t.state !== 'open' && t.state !== 'triggered') return { kind: 'refused', problems: [`it has ${t.state}`] };
      if (t.deadline < Date.now()) return { kind: 'refused', problems: ['its deadline has passed'] };
      // One signature per signed identity; in a people-only tally, also one per person, whatever number of houses they have.
      let person: string | undefined;
      if (t.peopleOnly) {
        // A stamp for this tally only (its own person number), presented to this tally, by the signer's own key.
        const context = countContext(s.webId, t.id);
        const stamp = await checkSdJwtAttachment(p.person as { credential?: unknown; card?: AgentCard } | undefined, { trusted: checkers, vct: PERSON_IN_CONTEXT_VCT, subject: from, holder: profile.publicJwk, aud: s.webId, nonce: t.id, sandbox: o.sandbox });
        if (!stamp.ok || stamp.claims.context !== context) return { kind: 'refused', problems: [`this tally counts people: attach a person stamp for "${context}" from ${checkers.join(' or ')}, presented to this tally (${stamp.ok ? 'it is for another count' : stamp.why}). A house's owner gets a stamp in their control panel (Home → One person, one house), then signs the pledge there; an assistant can't do either.`] };
        person = String(stamp.claims.person ?? '');
      }
      const counted = signed || (person !== undefined && t.signers.some((x) => x.person === person));
      // A pledge with money counts a signature only with its contribution held for it, paid for this very house.
      let hold: string | undefined;
      if (t.money) {
        const m = t.money;
        if (counted) return { kind: 'refused', problems: ['you have signed already, and your contribution is held'] };
        hold = String(p.hold ?? '');
        if (!hold) return { kind: 'refused', problems: [`this pledge holds ${m.currency} ${(m.contribution / 100).toFixed(2)} from each signer: pay it held for this pledge (to ${m.payee.webId} through ${o.paymentsUrl}, agreement ${pledgeAgreement(s.webId, t.id)}, hold: true, pledge: { tally: ${s.webId}, id: "${t.id}", until: after the deadline }), then sign with { hold }. A house's owner does both with one tap in their control panel.`] };
        if (m.counted.includes(hold)) return { kind: 'refused', problems: ['that contribution is counted already'] };
        const r = await ask(o.paymentsUrl!, { kind: 'pledge.hold', id: t.id, hold }).catch((e: Error) => ({ kind: 'refused', problems: [e.message] }) as Record<string, any>);
        const wrong = r.kind !== 'pledge.hold' ? `the payments agent: ${(r.problems ?? [r.kind]).join('; ')}` : r.status !== 'held' ? `it was ${r.status}` : r.bond ? 'that is a bond, not a contribution'
          : Math.round(Number(r.amount) * 100) !== m.contribution || r.currency !== m.currency ? `it holds ${r.currency} ${r.amount}; this pledge takes ${m.currency} ${(m.contribution / 100).toFixed(2)}`
          : r.payee !== m.payee.webId ? `it pays ${r.payee}, not this pledge's payee (${m.payee.webId})` : r.by !== from ? 'it was paid for another house' : Date.parse(r.until) < t.deadline + 3_600_000 ? 'it goes back before the pledge can settle: hold it until at least an hour after the deadline' : '';
        if (wrong) return { kind: 'refused', problems: [`your contribution: ${wrong}`] };
        m.counted.push(hold);
      }
      if (!counted) t.signers.push({ webId: from, domain: profile.ownerDomain, url: card.supportedInterfaces?.[0]?.url ?? '', at: new Date().toISOString(), ...(person ? { person } : {}), ...(hold ? { hold } : {}) });
      if (t.state === 'open' && t.signers.length >= t.threshold) {
        t.state = 'triggered';
        t.triggeredAt = Date.now();
        const signers = t.signers.map(({ domain, url }) => ({ domain, url }));
        for (const x of t.signers) if (x.webId !== from && x.url) void tell(x.url, { kind: 'tally.triggered', id: t.id, text: t.text, count: t.signers.length, signers });
      }
      void save();
      report(t);
      // The reply names the signer and is signed by the tally: the signer's proof, to show anyone (lake_verify checks it),
      // so "I've signed" never has to be taken on trust (run 16).
      return { kind: t.state === 'triggered' ? 'tally.triggered' : 'tally.signed', ...view(t), signer: { webId: from, domain: profile.ownerDomain }, proof: 'this signed reply is your proof that you signed: forward it as it is', ...(t.state === 'triggered' ? { signers: t.signers.map(({ domain, url }) => ({ domain, url })) } : {}) };
    }
    return { kind: 'refused', problems: ['send tally.open, tally.sign, tally.withdraw or tally.count'] };
  }, [], true, (p) => (p.kind === 'tally.sign' || p.kind === 'tally.withdraw') && (typeof p.pass === 'string' || typeof p.secret === 'string'));
  // A pledge's public page, for anyone to follow (counts only, as tally.count shows anyone: never who signed or answered),
  // and the same as JSON. A listed pledge only: an unlisted one is its signers' business.
  s.app.get('/p/:id.json', (req, res) => {
    const t = tallies.get(req.params.id);
    if (!t?.listed) return void res.status(404).json({ error: 'no listed pledge with that id' });
    lapse(t);
    res.set('cache-control', 'no-store').json(view(t));
  });
  s.app.get('/p/:id', (req, res) => {
    const t = tallies.get(req.params.id);
    if (!t?.listed) return void res.status(404).type('text/plain').send('No listed pledge with that id.');
    res.type('html').send(pledgePage(t.id, t.text));
  });
  return s;
}

const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The public page: a static shell that reads the pledge's JSON every few seconds. */
function pledgePage(id: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pledge: ${esc(text.slice(0, 60))}</title>
<style>
:root{--bg:#f7f7f4;--fg:#1c1d1f;--muted:#6b6f76;--line:#dcdcd6;--accent:#0f7a5c;--bar:#cfe6dc;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#ecece8;--muted:#9aa0a6;--line:#2a2e33;--accent:#4fd1a5;--bar:#1f3b31;--warn:#e0a84b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:28px 16px 48px}h1{font-size:22px;line-height:1.3;margin:0 0 6px}
.state{display:inline-block;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:2px 10px;margin:8px 0 18px}
.big{font-size:56px;font-weight:700;line-height:1;margin:0}.of{color:var(--muted);font-size:18px}
.row{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:14px}.row span:first-child{flex:0 0 46%;color:var(--muted)}
.bar{flex:1;height:18px;background:var(--line);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--bar)}.bar i.in{background:var(--accent)}
.row b{flex:0 0 36px;text-align:right}p.note{color:var(--muted);font-size:14px}section{border-top:1px solid var(--line);margin-top:22px;padding-top:16px}
</style></head><body><main>
<h1>${esc(text)}</h1><div id="state" class="state">…</div>
<div id="main"></div><section id="circle" hidden></section><section id="quorum" hidden></section>
<p class="note">Counts only: this page never shows who answered or signed. Real signatures; on the sandbox, synthetic people and play money. <a href="https://lake.doneinfifty.com/docs/spec">How it works</a></p>
</main><script>
const id=${JSON.stringify(id)};const $=(x)=>document.getElementById(x);
const when=(iso)=>new Date(iso).toLocaleString([], {weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const esc=(x)=>String(x).replace(/[&<>"']/g,(c)=>'&#'+c.charCodeAt(0)+';');
async function tick(){
  let v; try{v=await (await fetch(id+'.json',{cache:'no-store'})).json()}catch{return}
  const q=v.quorum, label={gathering:'Finding its quorum, in secret',open:'Open for signing',triggered:'Filled',lapsed:'Lapsed'}[v.state]||v.state;
  $('state').textContent=v.unveil&&v.unveil.opened?'Filled · everyone revealed':label;
  let h='';
  if(v.state==='gathering'){h='<p class="big">'+q.answered+'</p><p class="of">families have answered privately. Answers close '+when(q.closes)+'. Nobody can sign until then, and only if enough would join.</p>'}
  else if(v.state==='lapsed'){h='<p class="big">'+v.count+'</p><p class="of">'+esc((q&&q.result&&q.result.why)||('of '+v.threshold+' needed by '+when(v.deadline)))+'</p>'}
  else{const out=v.unveil&&v.unveil.opened;h='<p class="big">'+v.count+' <span class="of">signed, '+v.threshold+' needed</span></p><p class="of">'+(out?'Signed blind, then everyone was revealed in the same moment, at '+when(v.unveil.opens)+' (drand round '+v.unveil.round+').':(v.blind?'Signed blind: nobody knows who until '+(v.unveil?'everyone is revealed at the same moment, '+when(v.unveil.opens):'it fills')+'.':'')+' Signing closes '+when(v.deadline)+'.')+'</p>';
    if(v.blind)h+='<p class="of">Revealed: <b>'+v.revealed+'</b> of '+v.count+'</p>'}
  $('main').innerHTML=h;
  const c=v.circle;if(c){$('circle').hidden=false;$('circle').innerHTML='<p><b>A promise circle.</b> Each member promised the others '+esc(c.promise)+', '+(c.times_a_year===1?'once':c.times_a_year+' times')+' a year. No money.</p>'+(c.open?'<p class="big">'+c.kept+' <span class="of">promises kept, of '+c.of+' calls</span></p>'+(c.favours?'<p class="of">'+c.favours.signed+' favours signed as owed; <b>'+c.favours.cleared+'</b> cleared in loops across circles, so those members are square. Nobody paid anything.</p>':'')+(c.on_the_log?'<p class="of">Its record is on the transparency log ('+esc(c.on_the_log.origin)+', entry '+c.on_the_log.index+', '+new Date(c.on_the_log.at).toLocaleString()+'): every favour note, by fingerprint, and where it stands.</p>':'')+'<p class="of">'+c.members+' members. When one asks for help, a few others are asked, picked by a public draw, without knowing who asked.</p>':'<p class="of">It opens for calls once it has filled and everyone is known.</p>')}
  if(q&&q.result){const r=q.result,max=Math.max(1,...Object.values(r.totals));
    $('quorum').hidden=false;$('quorum').innerHTML='<p><b>The secret count:</b> '+r.counted+' families answered "I\\'m in if at least how many are?"</p>'+q.options.map((o,i)=>{const n=r.totals[o]||0,inq=q.at_least[i]!==null&&q.at_least[i]<=r.size;return '<div class="row"><span>'+esc(o)+'</span><div class="bar"><i class="'+(inq?'in':'')+'" style="width:'+(100*n/max)+'%"></i></div><b>'+n+'</b></div>'}).join('')+'<p class="of">'+(r.size?'<b>'+r.size+'</b> families hold together: each said they\\'d join a group that size or smaller'+(r.binds?', so it binds once '+r.binds+' sign, the most any of them asked for.':'.'):'')+(r.why?' '+esc(r.why):'')+'</p>'}
}
tick();setInterval(tick,3000);
</script></body></html>`;
}
