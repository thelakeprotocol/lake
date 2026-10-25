import {
  canonicalize, cardUrlFor, generateIdentity, proveDomain, sendLake, signMessage, verifyLakeCard, verifyLakeData,
  type AgentCard, type LakeData, type LakeProfile,
} from '@thelakeprotocol/core';
import { makeVisitor } from '@thelakeprotocol/visitor';
import { checkTarget, fromNode, rateLimit } from './net.js';
import { specialist, type SpecialistOptions, type Specialist } from './review.js';

type Status = 'pass' | 'fail' | 'warn';
interface Check { check: string; status: Status; detail: string }
// Run 24's rogue grocer showed its 10/10 to households as if it vouched for the business: say what it covers.
const SCOPE = 'This checks protocol conformance only: it says nothing about who runs the agent, whether it is on any register, or what it does with data.';
type Reply = { kind: 'report'; target: string; role?: string; passed: number; of: number; checks: Check[]; credential?: string; verdict: string };

/**
 * The Inspector: point it at any Lake agent (your house, your research agent, a node) and it checks it
 * against the protocol the way a stranger would: the card, its signature, the endpoint, a signed reply,
 * that it never acts on the same message twice, and that it refuses forged and unsigned cards and expired messages. All pass → a signed
 * conformance credential. For people building their own house or agent.
 */
export async function createInspector(o: SpecialistOptions & { nodeUrl?: string }): Promise<Specialist> {
  const publicOnly = o.url.startsWith('https://');
  const allowed = rateLimit(6, 60_000);
  const s: Specialist = await specialist<Reply>(o, 'Inspector', 'Checks any Lake agent the way a stranger would: card, signature, endpoint, signed replies, that a replay does nothing twice, and that it refuses forgeries. Send { kind: "inspect", url }.', 'inspect', async (p, from) => {
    if (p.kind !== 'inspect' || typeof p.url !== 'string') return { kind: 'refused', problems: ['send { kind: "inspect", url: "<the agent\'s A2A URL or its base URL>" }'] };
    if (!allowed(from)) return { kind: 'refused', problems: ['six inspections a minute; try again shortly'] };
    const r = await inspect(p.url, { publicOnly, sandbox: o.sandbox, nodeUrl: o.nodeUrl });
    const passed = r.checks.filter((c) => c.status !== 'fail').length;
    const allPass = passed === r.checks.length;
    const credential = allPass && r.profile
      ? await s.vc('LakeConformance', { id: r.profile.webId, card: r.cardUrl!, role: r.profile.role, checks: r.checks.map((c) => `${c.check}: ${c.status}`), lakeVersion: r.profile.lakeVersion, scope: SCOPE }, 30)
      : undefined;
    return {
      kind: 'report', target: p.url, role: r.profile?.role, passed, of: r.checks.length, checks: r.checks, credential,
      verdict: `${allPass ? 'Speaks the Lake: a stranger can find it, check its card is really its own, and can\'t fool it with the usual tricks.' : `${r.checks.length - passed} check(s) failed. Each one says what a stranger saw.`} ${SCOPE}`,
    };
  });
  return s;
}

export async function inspect(target: string, o: { publicOnly: boolean; sandbox: boolean; nodeUrl?: string }) {
  const checks: Check[] = [];
  const add = (check: string, status: Status, detail: string) => checks.push({ check, status, detail });
  const base = target.replace(/\/$/, '');
  const cardUrl = base.endsWith('agent-card.json') ? base : base.endsWith('/a2a') ? cardUrlFor(base) : `${base}/.well-known/agent-card.json`;
  try {
    await checkTarget(cardUrl, o.publicOnly);
  } catch (e) {
    add('address', 'fail', (e as Error).message);
    return { checks, cardUrl };
  }

  let card: AgentCard;
  try {
    const res = await fetch(cardUrl, { headers: { 'A2A-Version': '1.0' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    card = (await res.json()) as AgentCard;
    add('card', 'pass', `served at ${cardUrl}`);
  } catch (e) {
    add('card', 'fail', `no Agent Card at ${cardUrl}: ${(e as Error).message}`);
    return { checks, cardUrl };
  }

  let profile: LakeProfile;
  try {
    profile = await verifyLakeCard(card);
    add('signature', 'pass', `card signed by key ${profile.publicJwk.kid}; role ${profile.role}, Lake ${profile.lakeVersion}`);
  } catch (e) {
    add('signature', 'fail', `the card does not verify: ${(e as Error).message}`);
    return { checks, cardUrl };
  }

  const proof = await proveDomain(profile, { sandbox: false });
  add('domain', proof.ok ? 'pass' : 'warn', proof.ok ? `${profile.ownerDomain} vouches for this key (${proof.via})` : `${profile.ownerDomain} doesn't vouch for this key yet (${proof.reason}). The sandbox lets that pass; the real Lake won't.`);

  const endpoint = card.supportedInterfaces?.[0]?.url;
  if (!endpoint) {
    add('endpoint', 'fail', 'the card names no A2A endpoint');
    return { checks, cardUrl, profile };
  }
  try {
    await checkTarget(endpoint, o.publicOnly);
    const served = (await (await fetch(cardUrlFor(endpoint), { headers: { 'A2A-Version': '1.0' }, signal: AbortSignal.timeout(8000), redirect: 'error' })).json()) as AgentCard;
    const same = canonicalize(served.signatures) === canonicalize(card.signatures);
    add('endpoint', same ? 'pass' : 'fail', same ? `${endpoint} serves this same card` : `${endpoint} serves a different card`);
  } catch (e) {
    add('endpoint', 'fail', `${endpoint}: ${(e as Error).message}`);
    return { checks, cardUrl, profile };
  }

  // A throwaway key per inspection, so the tricks below can't get anyone's real key quarantined.
  const probe = await makeVisitor(await generateIdentity(), `probe-${Math.floor(Math.random() * 1e6)}.inspector.example`, 'Inspector probe');
  const send = async (data: LakeData) => {
    const reply = await sendLake(endpoint, data, { me: probe.id, timeoutMs: 10_000 });
    const v = await verifyLakeData<Record<string, unknown>>(reply as LakeData<Record<string, unknown>>, { sandbox: true });
    if (!v.ok) throw new Error(`its reply did not verify: ${v.rejection.why}`);
    if (v.profile.publicJwk.kid !== profile.publicJwk.kid) throw new Error('its reply was signed by a different key than its card');
    return v.payload;
  };
  const refused = (r: Record<string, unknown>) => r.kind === 'rejected' || r.kind === 'refused';
  const why = (r: Record<string, unknown>) => String(r.code ?? (r.problems as string[] | undefined)?.[0] ?? r.kind);
  const message = async (payload: Record<string, unknown>, now?: number) => ({ lake: '0.1', card: probe.card, envelope: (await signMessage(payload, probe.id, { iss: probe.webId, now, ttl: 60 })) as LakeData['envelope'] }) as LakeData;

  // Nothing the agent would act on: it should answer, signed, and say it doesn't know what this is.
  const ping = await message({ kind: 'ping' });
  let first: Record<string, unknown>;
  try {
    first = await send(ping);
    add('signed reply', 'pass', `answered over A2A, signed by the card's key (${first.kind}${refused(first) ? `: ${why(first)}` : ''})`);
  } catch (e) {
    add('signed reply', 'fail', (e as Error).message);
    return { checks, cardUrl, profile };
  }
  const trick = async (name: string, data: LakeData, expect: string) => {
    try {
      const r = await send(data);
      add(name, refused(r) ? 'pass' : 'fail', refused(r) ? `refused (${why(r)})` : `accepted it (${r.kind}). It should refuse: ${expect}`);
    } catch (e) {
      add(name, 'fail', (e as Error).message);
    }
  };
  // The same signed message again (a sender retrying after a dropped connection, or someone replaying it) must not be
  // acted on twice. SPEC §3: the answer is the reply it gave the first time, the very same signed envelope.
  try {
    const again = await send(ping);
    const same = canonicalize(again) === canonicalize(first);
    add('a replay does nothing twice', same ? 'pass' : refused(again) ? 'warn' : 'fail', same
      ? 'answered the copy with its first reply, signed the same: recognised, and done once'
      : refused(again) ? `refused the copy (${why(again)}): safe, but SPEC §3 asks for the first reply again, so a sender whose connection dropped can retry`
      : `answered the copy anew (${again.kind}): it acts on the same message twice`);
  } catch (e) {
    add('a replay does nothing twice', 'fail', (e as Error).message);
  }
  const forged = structuredClone(probe.card);
  forged.capabilities!.extensions[0]!.params!.ownerDomain = 'trusted-hospital.example';
  await trick('refuses a forged card', { ...(await message({ kind: 'ping' })), card: forged }, 'the card was edited after it was signed');
  await trick('refuses an unsigned card', { ...(await message({ kind: 'ping' })), card: { ...probe.card, signatures: [] } }, 'the card carries no signature');
  await trick('refuses an expired message', await message({ kind: 'ping' }, Date.now() - 10 * 60_000), 'the message expired ten minutes ago');

  if (o.nodeUrl) {
    const listed = await fromNode<{ card: AgentCard }[]>(o.nodeUrl, '/cards');
    const found = listed?.some((l) => canonicalize(l.card.signatures) === canonicalize(card.signatures));
    add('listed', found ? 'pass' : 'warn', found ? 'the sandbox node lists it' : 'the sandbox node doesn\'t list it (fine: agents can be found at their own address too)');
  }
  return { checks, cardUrl, profile };
}
