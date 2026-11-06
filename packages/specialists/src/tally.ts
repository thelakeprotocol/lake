import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { checkPass, checkReveal, checkSdJwtAttachment, commitTo, getBeacon, openSeal, roundAfter, roundTimeMs, sealedRound, cardUrlFor, countContext, isCurrency, makeEvent, pledgeAgreement, unshardCounts, verifyLakeCard, passChallenge, PERSON_IN_CONTEXT_VCT, sendLake, signMessage, verifyLakeData, type AgentCard, type LakeData } from '@thelakeprotocol/core';
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
  result?: { totals: Record<string, number>; counted: number; size: number; at: string; why?: string };
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

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_DAYS = 30;

export async function createTally(o: SpecialistOptions & { dataDir: string; personCheckers?: string[]; passesUrl?: string; paymentsUrl?: string; tellers?: string[] }) {
  const checkers = o.personCheckers ?? ['person.lake.local'];
  const file = `${o.dataDir}/tallies.json`;
  const tallies = new Map<string, Tally>((JSON.parse(await readFile(file, 'utf8').catch(() => '[]')) as Tally[]).map((t) => [t.id, t]));
  const save = () => writeFile(file, JSON.stringify([...tallies.values()])).catch(() => {});
  const counted = (t: Tally) => (t.blind ? t.blind.passes.length : t.signers.length);
  const view = (t: Tally) => ({ id: t.id, text: t.text, threshold: t.threshold, count: counted(t), deadline: new Date(t.deadline).toISOString(), state: t.state, ...(t.peopleOnly ? { people_only: true } : {}),
    // A blind pledge binds only when enough signers have revealed themselves, not just when enough passes are in (run 21:
    // "make pledges actually bind"): an anonymous signature is cheap until its signer stands by it.
    ...(t.blind ? { blind: true, issuer: t.blind.issuer, revealed: t.blind.passes.filter((x) => x.revealed).length, bound: t.blind.passes.filter((x) => x.revealed).length >= t.threshold } : {}),
    ...(t.blind?.unveil ? { unveil: { round: t.blind.unveil, opens: new Date(roundTimeMs(t.blind.unveil)).toISOString(), ...(t.blind.unveiled ? { opened: true } : {}) } } : {}),
    ...(t.money ? { money: moneyView(t, t.money) } : {}),
    ...(t.quorum ? { quorum: { options: t.quorum.options, at_least: t.quorum.atLeast, closes: new Date(t.quorum.closes).toISOString(), count: t.quorum.count, tellers: t.quorum.tellers, answered: t.quorum.joined.length, ...(t.quorum.blind ? { blind: true } : {}), ...(t.quorum.result ? { result: t.quorum.result } : {}) } } : {}) });
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
      for (const x of b.passes) {
        if (x.sealed && !x.revealed) {
          // A seal that doesn't open to its own signature leaves that signer unrevealed, as if it never revealed.
          x.revealed = await checkReveal(await openSeal(x.sealed, beacon), { tally: s.webId, id: t.id, commit: x.commit, sandbox: o.sandbox }).catch(() => undefined);
        }
        delete x.sealed;
      }
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
  setInterval(() => { for (const t of tallies.values()) { void gather(t); lapse(t); void unveil(t); void settleMoney(t); } }, Number(process.env.LAKE_TALLY_TICK_MS ?? 30_000)).unref();

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
      q.result = { totals: Object.fromEntries(q.options.map((x, i) => [x, totals?.[i] ?? 0])), counted, size, at: new Date().toISOString(), ...(why ? { why } : totals && size < t.threshold ? { why: `the largest group that holds together is ${size}, under the ${t.threshold} it needs` } : {}) };
      if (totals && size >= t.threshold) {
        t.threshold = size;
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

  const s: Specialist = await specialist<{ kind: string }>(o, 'Tally', 'A blind tally for pledges that bind only once enough sign. Until the threshold it says how many have signed, never who (not even to whoever opened it); then it tells every signer at once. With people_only, it counts people instead of identities: each signature needs a person stamp for this tally (its context is \"<this tally\'s webId>|<id>\"), presented to this tally. A pledge that counts households or people should be people_only: otherwise any agent\'s key counts as one (run 39: an organiser\'s agent counted itself as a household). A house signs as its owner, with the owner\'s person stamp. Opened with blind: true, nobody (this tally included) learns who signed: signatures are anonymous passes from a pass issuer, and signers reveal themselves once it fills (lake_pledge does it). With unveil: true as well, nobody reveals first: each signer\'s reveal is sealed to a drand round just after the deadline, and if it filled, this tally opens them all at once then; if it lapsed, it discards them unopened. With money ({ contribution: { amount, currency }, payee: { webId, url, name? }, bond?: { hold } }), each signature needs its contribution held for this pledge by the payments agent (sign with { hold }); at the deadline the payments agent, on this tally\'s word, pays them all to the payee if it filled, or gives them all back if it lapsed, and shares the opener\'s bond (people_only pledges) equally among the signers: saying yes costs nothing if it doesn\'t happen, and pays. With quorum ({ options, at_least, closes }, people_only), nobody signs at first: each person privately answers "I\'m in if at least N of us are" from their house, as a secret count only this tally can close; when it closes, the tally opens the pledge to bind at the largest group whose every member said they\'d join a group that size (if that is at least threshold), or lets it lapse, and tells everyone who answered at once. Send { kind: "tally.open", id, text, threshold, deadline, people_only?, blind?, unveil?, listed?, money?, quorum? } (listed: anyone can find it with tally.list, with how many more it needs), { kind: "tally.sign", id }, { kind: "tally.withdraw", id }, { kind: "tally.count", id } or { kind: "tally.list" }.', 'tally', async (p, from, profile, card: AgentCard) => {
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
        filled: listed.filter((t) => t.state === 'triggered' && Date.now() - (t.triggeredAt ?? 0) < 86_400_000).map(view),
      };
    }
    if (!['tally.sign', 'tally.withdraw', 'tally.count', 'tally.reveal', 'tally.quorum'].includes(String(p.kind))) return { kind: 'refused', problems: ['send tally.open { id, text, threshold, deadline, people_only?, blind?, listed? }, tally.list, tally.sign { id }, tally.withdraw { id }, tally.count { id } or (blind) tally.reveal { id, salt }'] };
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
<div id="main"></div><section id="quorum" hidden></section>
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
  else{const out=v.unveil&&v.unveil.opened;h='<p class="big">'+v.count+' <span class="of">of '+v.threshold+' signed</span></p><p class="of">'+(out?'Signed blind, then everyone was revealed in the same moment, at '+when(v.unveil.opens)+' (drand round '+v.unveil.round+').':(v.blind?'Signed blind: nobody knows who until '+(v.unveil?'everyone is revealed at the same moment, '+when(v.unveil.opens):'it fills')+'.':'')+' Signing closes '+when(v.deadline)+'.')+'</p>';
    if(v.blind)h+='<p class="of">Revealed: <b>'+v.revealed+'</b> of '+v.count+'</p>'}
  $('main').innerHTML=h;
  if(q&&q.result){const r=q.result,max=Math.max(1,...Object.values(r.totals));
    $('quorum').hidden=false;$('quorum').innerHTML='<p><b>The secret count:</b> '+r.counted+' families answered "I\\'m in if at least how many are?"</p>'+q.options.map((o,i)=>{const n=r.totals[o]||0,inq=q.at_least[i]!==null&&q.at_least[i]<=r.size;return '<div class="row"><span>'+esc(o)+'</span><div class="bar"><i class="'+(inq?'in':'')+'" style="width:'+(100*n/max)+'%"></i></div><b>'+n+'</b></div>'}).join('')+'<p class="of">'+(r.size?'<b>'+r.size+'</b> families hold together: each said they\\'d join a group that size or smaller.':'')+(r.why?' '+esc(r.why):'')+'</p>'}
}
tick();setInterval(tick,3000);
</script></body></html>`;
}
