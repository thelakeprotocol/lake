import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  allFields, countContext, fetchPasses, ownerKeyCredential, revealBlind, signBlind, type BlindSignature, lakeProfile, presentSdJwtVc, readSdJwtVc, PURPOSES, buildCard, describe, exportIdentity, fieldSpec, generateIdentity, identifyingFields, importIdentity, LakeLinks, makeEvent, packId, parseRules, sendLake, signCard, signMessage, verifyLakeData,
  type AgentCard, type Identity, type LakeData, type LakeEvent, type LakePack, type Rules,
} from '@thelakeprotocol/core';
import type express from 'express';
import { Housekeeper } from './housekeeper.js';
import { OwnerDesk, type PanelProvider } from './owner.js';
import { Parser } from 'n3';
import { createPodMcpServer } from './pod-mcp.js';
import type { OwnerSession } from './pod.js';
import { recordPaths } from './packs.js';
import { convertRecord, fetchConverterCert, fetchRecord, type RecordPaths, type Trust } from './record.js';
import { packFolders } from './typeindex.js';
import { connectRelay } from './relay.js';
import { createHouseServer } from './server.js';

export interface HouseOptions {
  name: string;
  rulesText: string;
  /** Logged-in session for this house's owner and pod. */
  owner: OwnerSession;
  /** Local secrets for this house (pairing and operator tokens). */
  dataDir: string;
  /** Where this house is reached, without /a2a: https://h, or https://h/t/<name> for a hosted house. */
  publicUrl: string;
  ownerUrl?: string;
  /** The use cases this house takes part in (loaded and registered by the caller). */
  packs: LakePack[];
  /** Where each pack's issuer is, by pack id. */
  issuerUrls: Record<string, string>;
  auditorUrl: string;
  /** The person checker this house asks for its stamp (SPEC §6.4), if any. */
  personUrl?: string;
  /** Teller addresses the operator vouches for. On a sandbox (no domain proof) these are the only tellers a house trusts. */
  tellerUrls?: string[];
  /** One or more Lake nodes, comma-separated. The house registers with and reports to each. */
  lakeUrl?: string;
  seed?: string;
  sandbox: boolean;
  openPairing?: boolean;
  /** With open pairing: a claim lasts this long, then the house resets for the next person. */
  leaseHours?: number;
  domain?: string;
  emit: (e: LakeEvent) => void;
  say: (msg: string) => void;
  /** Hosted houses skip the terminal QR code. */
  quiet?: boolean;
  /**
   * Behind a home router: be reached through the nodes instead of directly. The card then names a relay
   * address on each node, and `join()` opens the outgoing connections before registering.
   */
  relay?: { localPort: number };
}

export interface House {
  name: string;
  card: AgentCard;
  keeper: Housekeeper;
  desk: OwnerDesk;
  app: express.Express;
  link: LakeLinks | null;
  /** Register with the node (if any), follow its signals, and announce the house. */
  join: () => Promise<void>;
  leave: () => Promise<void>;
}

// Whose signatures count. A sandbox house with no trust section trusts the demo specialists and its packs' demo issuers, and says so.
const DEMO_TRUST: Omit<Trust, 'issuers' | 'regulators' | 'tellers'> = { auditors: ['audit.lake.local'], ethics: ['ethics.lake.local'], payments: ['payments.lake.local'] };

let appDir: string | undefined | null = null;
function approvalsApp() {
  if (appDir === null) {
    try {
      appDir = join(dirname(createRequire(import.meta.url).resolve('@thelakeprotocol/ui/package.json')), 'dist');
    } catch {
      appDir = undefined; // no approvals app built; the API still works
    }
  }
  return appDir;
}

/** Sets up one house on a pod that is already running: folders, wallet, record, MCP door, housekeeper, owner's desk. */
export async function startHouse(o: HouseOptions): Promise<House> {
  const { owner, say } = o;
  const actor = `house:${o.name}`;
  const demoIssuers = o.packs.map((p) => p.source?.issuer.domain).filter((d): d is string => !!d);
  const demoRegulators = o.packs.map((p) => p.authority?.domain).filter((d): d is string => !!d);
  const trustFrom = (rules: Rules): Trust => {
    const t = rules.trust;
    return {
      issuers: t?.issuers ?? (o.sandbox ? demoIssuers : []), auditors: t?.auditors ?? (o.sandbox ? DEMO_TRUST.auditors : []),
      ethics: t?.ethics ?? (o.sandbox ? DEMO_TRUST.ethics : []), payments: t?.payments ?? (o.sandbox ? DEMO_TRUST.payments : []),
      regulators: t?.regulators ?? (o.sandbox ? demoRegulators : []),
      // On a sandbox nobody proves a domain, so a teller is trusted by the address its operator gave, never by the name it claims.
      tellers: t?.tellers ?? (o.sandbox ? o.tellerUrls ?? [] : []),
    };
  };
  let link: LakeLinks | null = null;
  // What happened at this door, for the owner's control panel. Kept in memory; the pod keeps the agreements and audit log.
  const activity: { at: string; kind: string; text: string; subject?: string; data?: LakeEvent['data'] }[] = [];
  const emit = (e: LakeEvent) => {
    o.emit(e);
    link?.report(e);
    activity.unshift({ at: e.at, kind: e.kind, text: describe(e), subject: e.subject, data: e.data });
    activity.length = Math.min(activity.length, 300);
  };

  // Folders and wallet. The owner sets these up; after this the housekeeper only goes through MCP.
  for (const f of ['', 'agreements/', 'receipts/', 'wallet/', 'audit/', 'settings/', 'offers/']) await ensureContainer(owner, f);
  // Each pack's data lives where the pod's Type Index says (registered there the first time).
  const folders = await packFolders(owner, o.packs, say);
  const paths = recordPaths(o.packs, folders);
  for (const p of o.packs) for (const f of [paths.get(p.id)!.folder, `${paths.get(p.id)!.folder}original/`]) await ensureContainer(owner, f);

  // The owner's rules. Edits made in the control panel live in their pod and win over the file the house started with,
  // but only once someone owns the house: a hosted house nobody has claimed follows its operator's current persona, so
  // an operator's fix reaches it (the sandbox's houses kept stale trust lists from their first boot).
  let rulesText = o.rulesText;
  const ownerKey = await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`).catch(() => null);
  const saved = o.leaseHours && !ownerKey?.ok ? { ok: false, text: async () => '' } : await owner.fetch(`${owner.podRoot}settings/rules.yaml`);
  if (saved.ok) {
    const text = await saved.text();
    try {
      parseRules(text);
      rulesText = text;
    } catch (e) {
      say(`WARNING: the rules saved in your pod don't parse (${(e as Error).message}); using the file this house started with`);
    }
  } else await put(owner, 'settings/rules.yaml', rulesText, 'text/yaml');
  const rules = parseRules(rulesText);
  const trust = trustFrom(rules);
  const id = await walletIdentity(owner);
  const nodes = (o.lakeUrl ?? '').split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
  const relayed = o.relay && nodes.length ? nodes.map((n) => `${n}/relay/${id.kid.replace(/[^a-zA-Z0-9]/g, '')}/a2a`) : null;
  if (!rules.trust && o.sandbox) say(`no trust section in rules.yaml; sandbox default: issuers ${demoIssuers.join(', ')}, auditor ${DEMO_TRUST.auditors}, ethics ${DEMO_TRUST.ethics}`);

  // The card is the house's public face, so the owner's rules decide what it says: its interest tags, and whether it names
  // the kinds of data it holds (privacy.show_packs). Hidden, agents searching by kind of data won't find it; that is the trade.
  const cardFor = async (r: Rules) => {
    const show = r.privacy?.show_packs !== false;
    return signCard(
      buildCard(
        {
          name: `House ${o.name}`,
          description: `Housekeeper for ${o.name}. Answers by its owner's rules. Data never leaves.`,
          url: relayed?.[0] ?? `${o.publicUrl}/a2a`,
          alsoAt: relayed?.slice(1),
          // One skill per pack (`health-study`, `mortgage-study`), so agents find the houses that can answer them.
          skills: show
            ? o.packs.map((p) => ({ id: `${p.id}-study`, name: p.title, description: `Considers ${p.title.toLowerCase()} offers by its owner's rules`, tags: r.tags ?? [] }))
            : [{ id: 'offers', name: 'Offers', description: 'Considers offers by its owner\'s rules', tags: r.tags ?? [] }],
          profile: { role: 'house', webId: owner.webId, ownerDomain: o.domain ?? new URL(o.publicUrl).hostname, tags: r.tags ?? [], packs: show ? o.packs.map(packId) : [] },
        },
        id,
      ),
      id,
    );
  };
  const card = await cardFor(rules);

  // One record per pack: signed by the pack's issuer, converted in the pod, checked against the pack's shapes, signed again by the housekeeper.
  const records: { pack: LakePack; paths: RecordPaths; claimsUrl: string }[] = [];
  // What a stored credential is about, read without verifying: enough to notice that the pack's converter changed since it was
  // made (an upgrade), so the house gets a fresh certificate and record instead of failing its own check forever. The full check runs later.
  const subjectOf = async (path: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const res = await owner.fetch(owner.podRoot + path);
      if (!res.ok) return undefined;
      const text = (await res.text()).trim();
      const jws = text.startsWith('{') ? (JSON.parse(text) as { credential: string }).credential : text;
      return JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString()).credentialSubject;
    } catch {
      return undefined;
    }
  };
  for (const p of o.packs.filter((x) => x.source)) {
    const at = paths.get(p.id)!;
    const claimsUrl = `${owner.podRoot}${at.claims}`;
    records.push({ pack: p, paths: at, claimsUrl });
    if ((await subjectOf(at.converterCert))?.id !== `urn:lake:converter:${p.source!.converter}`) {
      say(`asking the auditor at ${o.auditorUrl} to certify the ${p.id} converter`);
      try {
        await put(owner, at.converterCert, JSON.stringify(await fetchConverterCert(o.auditorUrl, { id, card, webId: owner.webId }, p)), 'application/json');
      } catch (e) {
        say(`WARNING: ${(e as Error).message}. Uncertified converter: this house's ${p.id} data can't be used.`);
      }
    }
    if ((await subjectOf(at.claimsCredential))?.converter !== p.source!.converter) {
      const issuerUrl = o.issuerUrls[p.id];
      if (!issuerUrl) { say(`WARNING: no issuer for ${p.id}; this house holds no ${p.id} record`); continue; }
      say(`asking the ${p.id} issuer at ${issuerUrl} for a signed synthetic record`);
      try {
        const r = await fetchRecord(issuerUrl, owner.webId, p);
        const c = await convertRecord(r, p, { webId: owner.webId, claimsUrl, id, converterCert: owner.podRoot + at.converterCert });
        await put(owner, at.original, r.original, p.source!.mediaType);
        await put(owner, at.credential, r.credential, 'text/plain');
        await put(owner, at.issuer, JSON.stringify({ recordId: r.recordId, card: r.issuerCard }), 'application/json');
        await put(owner, at.claims, c.turtle, 'text/turtle');
        await put(owner, at.claimsCredential, c.credential, 'text/plain');
        say(`${p.id} record stored: ${c.claims.length} claims (${[...new Set(c.claims.map((x) => x.field))].join(', ')})`);
      } catch (e) {
        say(`WARNING: ${(e as Error).message}. This house holds no signed ${p.id} record and won't take part in ${p.id} offers.`);
      }
    }
  }

  // The housekeeper and its MCP door to the pod: reads anything; writes only agreements, receipts and its audit log.
  const mcp = createPodMcpServer({ podRoot: owner.podRoot, fetch: owner.fetch, allowWrite: ['agreements/', 'audit/', 'receipts/', 'offers/'], claimsDocs: records.map((r) => r.paths.claims) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const podClient = new Client({ name: `housekeeper-${o.name}`, version: '0.1.0' });
  await podClient.connect(clientSide);

  // The owner's desk. The owner's key is made on their device; the house keeps only its public half, in the pod.
  // Signals from the node this house follows: refreshed every 2 s, verified against the node's own card.
  const signals = { blocklist: new Set<string>(), reputation: {} as Record<string, number> };
  let keeperRef: Housekeeper | null = null;
  // Everyone holds this one card object, so a re-signed card is changed in place; then the nodes hear of it.
  const recard = async (r: Rules) => { Object.assign(card, await cardFor(r)); await link?.register(3); };
  const panel = panelFor({ o, owner, id, actor, activity, card, recard, desk: () => desk, keeper: () => keeperRef!, signals: () => signals, trustFrom, nodes, relayed, records });
  const desk = new OwnerDesk({
    panel,
    dataDir: o.dataDir, webId: owner.webId, actor, openPairing: !!o.openPairing && o.sandbox, emit,
    readOwnerKey: async () => { const r = await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`); return r.ok ? r.json() : null; },
    saveOwnerKey: (jwk) => put(owner, 'wallet/owner.jwk.json', JSON.stringify(jwk), 'application/json'),
    writeGrant: (gid, jws) => put(owner, `agreements/${gid}.grant.jwt`, jws, 'text/plain'),
    saveRevoked: (ids) => put(owner, 'agreements/revoked.json', JSON.stringify(ids), 'application/json'),
    loadRevoked: async () => { const r = await owner.fetch(`${owner.podRoot}agreements/revoked.json`); return r.ok ? r.json() : []; },
    saveStatus: (indexes) => put(owner, 'agreements/status-indexes.json', JSON.stringify(indexes), 'application/json'),
    loadStatus: async () => { const r = await owner.fetch(`${owner.podRoot}agreements/status-indexes.json`); return r.ok ? r.json() : {}; },
    leaseHours: o.leaseHours,
    clearOwnerKey: async () => { await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`, { method: 'DELETE' }); },
    saveAssistants: (keys) => put(owner, 'wallet/assistants.json', JSON.stringify(keys), 'application/json'),
    saveAllowances: (a) => put(owner, 'wallet/allowances.json', JSON.stringify(a), 'application/json'),
    loadAllowances: async () => { const r = await owner.fetch(`${owner.podRoot}wallet/allowances.json`); return r.ok ? r.json() : []; },
    // The house vouches for its owner's key (for a payments agent checking an allowance); it never signs money itself.
    vouchOwner: (ownerJwk) => ownerKeyCredential(id, owner.webId, ownerJwk, 1),
    card: () => card,
    statusUrl: () => keeperRef!.statusUrl,
    loadAssistants: async () => { const r = await owner.fetch(`${owner.podRoot}wallet/assistants.json`); return r.ok ? r.json() : []; },
    // News for the owner's assistants: a signed message from this house into their Lake inbox (the reply is just "received").
    tell: async (url, payload) => {
      const envelope = await signMessage(payload, id, { iss: owner.webId });
      await sendLake(url.replace(/\/?$/, '').replace(/(\/a2a)?$/, '/a2a'), { lake: '0.1', card, envelope: envelope as LakeData['envelope'] }, { me: id, timeoutMs: 15_000 });
    },
    offerIds: () => [...(keeperRef?.market.offers.keys() ?? [])],
    // The next person gets the house as it started: its original rules.
    onRelease: async () => {
      await put(owner, 'settings/rules.yaml', o.rulesText, 'text/yaml');
      // The stamp said who owned it: the next person to claim the house gets their own, or none.
      await owner.fetch(`${owner.podRoot}wallet/personhood.json`, { method: 'DELETE' }).catch(() => {});
      const fresh = parseRules(o.rulesText);
      keeperRef?.setRules(fresh, o.rulesText, trustFrom(fresh));
      // The next owner starts with an empty door: the last owner's visitors and decisions were theirs.
      activity.length = 0;
      say('the lease ended: keys revoked, owner forgotten, rules reset. Anyone can claim this house now.');
    },
  });
  const pairing = await desk.init();
  const ownerUrl = `${(o.ownerUrl ?? o.publicUrl).replace(/\/$/, '')}/owner/`;
  if (pairing.paired) say(`owner paired. Approvals app: ${ownerUrl}`);
  else if (!o.quiet) {
    const pairLink = `${ownerUrl}#pair=${pairing.token}`;
    say(`no owner yet. On your phone, open ${pairLink}${o.openPairing && o.sandbox ? ' (sandbox: the first device to open it becomes the owner)' : ''}`);
    const { default: qrcode } = await import('qrcode-terminal');
    qrcode.generate(pairLink, { small: true }, (q: string) => console.log(q));
  }

  const keeper = new Housekeeper({
    name: o.name, webId: owner.webId, id, card, rules, rulesText, trust, pod: podClient, records, sandbox: o.sandbox, say, nodes, links: () => link, seed: o.seed, emit, desk,
    signals: () => signals,
  });
  keeperRef = keeper;
  const check = await keeper.verifyOwnRecord();
  say(check.ok ? 'record chain verified: trusted issuer → original → certified converter → housekeeper' : `record chain BROKEN: ${check.why}`);

  const app = createHouseServer(card, id, keeper, desk, approvalsApp());
  return {
    name: o.name, card, keeper, desk, app,
    get link() { return link; },
    join: async () => {
      if (relayed && o.relay) {
        // Open the way in first: the node checks our card through it when we register.
        const relays = nodes.map((n) => connectRelay({ nodeUrl: n, card, id, webId: owner.webId, localPort: o.relay!.localPort, log: say }));
        await Promise.race([Promise.all(relays.map((r) => r.connected)), new Promise((ok) => setTimeout(ok, 15_000))]);
      }
      if (o.lakeUrl) {
        link = new LakeLinks({ nodeUrls: nodes, card, identity: id, webId: owner.webId, log: say });
        const ids = await link.register();
        ids.forEach((nodeId, i) => { if (nodeId) say(`registered with the Lake node at ${nodes[i]} as ${nodeId}`); });
        link.keepAlive(5_000 + Math.floor(Math.random() * 10_000));
        setInterval(async () => {
          const s = await link?.signals();
          if (s) { signals.blocklist = new Set(s.blocklist); signals.reputation = s.reputation; }
        }, 2000).unref();
      }
      emit(makeEvent('house.joined', actor, undefined, { tags: (rules.tags ?? []).join(',') }));
      // Intents the owner opened before a restart, then the standing ones in their rules.
      await keeper.market.load();
      await keeper.market.resume();
      for (const x of keeper.rules.intents ?? []) await keeper.market.open(x.pack, x.terms).catch((e: Error) => say(`intent for ${x.pack}: ${e.message}`));
    },
    leave: async () => {
      emit(makeEvent('house.left', actor));
      await link?.flush();
    },
  };
}

async function ensureContainer(o: OwnerSession, path: string) {
  const url = o.podRoot + path;
  if ((await o.fetch(url, { method: 'HEAD' })).ok) return;
  // The portable way to make a container on any Solid server (CSS, ESS, …): PUT with the container type.
  const res = await o.fetch(url, { method: 'PUT', headers: { 'content-type': 'text/turtle', link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"', 'if-none-match': '*' } });
  if (!res.ok && res.status !== 412) throw new Error(`could not create ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
}

async function put(o: OwnerSession, path: string, body: string, contentType: string) {
  const res = await o.fetch(o.podRoot + path, { method: 'PUT', headers: { 'content-type': contentType }, body });
  if (!res.ok) throw new Error(`could not write ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
}

/** The housekeeper's signing key lives in the owner's pod, in /wallet/, readable only by the owner. */
async function walletIdentity(o: OwnerSession): Promise<Identity> {
  const res = await o.fetch(`${o.podRoot}wallet/identity.json`);
  if (res.ok) return importIdentity(await res.json());
  const fresh = await generateIdentity();
  await put(o, 'wallet/identity.json', JSON.stringify(await exportIdentity(fresh)), 'application/json');
  return fresh;
}

const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

/** What a container holds, as paths relative to the pod root. */
async function listContainer(o: OwnerSession, path: string): Promise<string[]> {
  const res = await o.fetch(o.podRoot + path, { headers: { accept: 'text/turtle' } });
  if (!res.ok) return [];
  const quads = new Parser({ baseIRI: o.podRoot + path }).parse(await res.text());
  return quads.filter((q) => q.predicate.value === LDP_CONTAINS).map((q) => q.object.value.slice(o.podRoot.length));
}

const decode = (jws: string) => {
  try {
    return JSON.parse(Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString()) as Record<string, any>;
  } catch {
    return null;
  }
};

/** Everything the owner's control panel shows and changes. Every call arrives signed by the owner's key. */
function panelFor(x: {
  o: HouseOptions; owner: OwnerSession; id: Identity; actor: string; activity: { at: string; kind: string; text: string; subject?: string; data?: LakeEvent['data'] }[];
  card: AgentCard; recard: (r: Rules) => Promise<void>; desk: () => OwnerDesk; keeper: () => Housekeeper; signals: () => { reputation: Record<string, number> };
  records: { pack: LakePack; paths: RecordPaths }[];
  trustFrom: (r: Rules) => Trust; nodes: string[]; relayed: string[] | null;
}): PanelProvider {
  const { owner } = x;
  // A signed request from this house to another agent, and its verified reply.
  const send = async (url: string, payload: Record<string, unknown>) => {
    const envelope = await signMessage(payload, x.id, { iss: owner.webId });
    const reply = await sendLake(url.replace(/\/?$/, '').replace(/(\/a2a)?$/, '/a2a'), { lake: '0.1', card: x.card, envelope: envelope as LakeData['envelope'] }, { me: x.id, timeoutMs: 15_000 });
    const v = await verifyLakeData<Record<string, unknown>>(reply as LakeData<Record<string, unknown>>, { sandbox: x.o.sandbox });
    if (!v.ok) throw new Error(v.rejection.why);
    return { payload: v.payload, card: (reply as LakeData).card };
  };
  const stamp = async (): Promise<{ credential: string; card: AgentCard; person: string } | null> => {
    const r = await owner.fetch(`${owner.podRoot}wallet/personhood.json`).catch(() => null);
    return r?.ok ? r.json() : null;
  };
  // On a leased house, what happened is counted from this owner's claim, like its money: a house that was free a minute
  // ago may have answered someone before it was yours (run 18 saw a join from before the claim).
  const mine = () => { const since = x.desk().claimedAt(); return since ? x.activity.filter((a) => Date.parse(a.at) >= since) : x.activity; };
  // Blind pledges this house signed: the salt reveals it once a pledge fills (kept in the owner's wallet).
  const blindPledges = async (): Promise<BlindSignature[]> => { const r = await owner.fetch(`${owner.podRoot}wallet/pledges.json`).catch(() => null); return r?.ok ? r.json() : []; };
  const money = async () => {
    const files = (await listContainer(owner, 'receipts/')).filter((f) => f.endsWith('.receipt.jwt'));
    const receipts = (await Promise.all(files.map(async (f) => {
      const r = await owner.fetch(owner.podRoot + f);
      const vc = r.ok ? decode(await r.text()) : null;
      const s = vc?.credentialSubject;
      return s ? { file: f, amount: Number(s.amount?.value ?? 0), currency: s.amount?.currency ?? 'USD', agreement: String(s.agreement ?? ''), from: String(vc!.issuer), payer: s.payer ? String(s.payer) : undefined, at: String(vc!.validFrom), settlement: String(s.settlement ?? '') } : null;
    }))).filter(Boolean) as { amount: number; at: string }[];
    // On a leased house, money is counted from this owner's claim: the last owner's earnings were never theirs.
    const since = x.desk().claimedAt();
    if (since) receipts.splice(0, receipts.length, ...receipts.filter((r) => Date.parse(r.at) >= since));
    receipts.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: receipts.reduce((n, r) => n + r.amount, 0), receipts };
  };
  return {
    async overview(tzOffset?: number) {
      // "Today" is the owner's day: the panel says how far its clock is from UTC (minutes, as the browser counts them).
      const offset = Number.isFinite(tzOffset) ? Number(tzOffset) : 0;
      const midnight = (() => { const d = new Date(Date.now() - offset * 60_000); d.setUTCHours(0, 0, 0, 0); return d.getTime() + offset * 60_000; })();
      const claims = await x.keeper().allClaims();
      const chain = await x.keeper().verifyOwnRecord();
      const view = x.desk().view();
      return {
        name: x.o.name, webId: owner.webId, podRoot: owner.podRoot,
        reachedAt: x.card.supportedInterfaces.map((i) => i.url), relayed: !!x.relayed, nodes: x.nodes,
        holds: [...new Set(claims.map((c) => c.field))], claims: claims.length,
        record: chain.ok ? { ok: true } : { ok: false, why: chain.why },
        knocksToday: mine().filter((a) => a.kind === 'knock' && Date.parse(a.at) >= midnight).length,
        blockedToday: mine().filter((a) => a.kind === 'attack.blocked' && Date.parse(a.at) >= midnight).length,
        pending: view.requests.length, keys: view.keys.length,
        earned: (await money()).total,
        rulesOwner: x.keeper().rules.owner,
        person: await stamp().then((s) => (s ? { stamped: true, by: s.card?.name, person: s.person.slice(-8) } : { stamped: false, checker: !!x.o.personUrl })),
      };
    },
    async rules() {
      // The fields the owner can name in rules: every pack's, plus the identifying ones packs warn about.
      const fields = [...allFields().map((f) => ({ name: f, label: fieldSpec(f)!.label, pack: fieldSpec(f)!.pack.id })), ...identifyingFields().map((f) => ({ name: f, label: f.replace(/_/g, ' '), pack: 'identifying' }))];
      return { text: x.keeper().rulesText, rules: x.keeper().rules, fields, purposes: Object.entries(PURPOSES).map(([name, p]) => ({ name, label: p.label, within: p.within })) };
    },
    async setRules(text: string) {
      let rules: Rules;
      try {
        rules = parseRules(text);
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
      await put(owner, 'settings/rules.yaml', text, 'text/yaml');
      const before = x.keeper().rules;
      x.keeper().setRules(rules, text, x.trustFrom(rules));
      if (JSON.stringify([before.tags, before.privacy]) !== JSON.stringify([rules.tags, rules.privacy])) await x.recard(rules).catch((e: Error) => x.o.say(`card: ${e.message}`));
      x.o.say('the owner changed their rules in the control panel');
      return { ok: true as const };
    },
    activity: () => mine().slice(0, 100),
    agents() {
      const by = new Map<string, { agent: string; knocks: number; last: string; lastDecision?: string; blocked: number }>();
      for (const a of [...mine()].reverse()) {
        if (!a.subject) continue;
        const e = by.get(a.subject) ?? { agent: a.subject, knocks: 0, last: a.at, blocked: 0 };
        if (a.kind === 'knock') e.knocks++;
        if (a.kind === 'decision') e.lastDecision = String(a.data?.decision ?? '');
        if (a.kind === 'attack.blocked') e.blocked++;
        e.last = a.at;
        by.set(a.subject, e);
      }
      const rep = x.signals().reputation;
      return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).map((e) => ({ ...e, reputation: e.agent.startsWith('agent:') ? rep[e.agent.slice(6)] ?? null : null }));
    },
    money,
    async data() {
      const claims = await x.keeper().allClaims();
      const chain = await x.keeper().verifyOwnRecord();
      const json = (path: string) => owner.fetch(owner.podRoot + path).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ card?: AgentCard } | null>;
      // Where each pack's record came from: who signed it, which converter turned it into claims, who certified that.
      const sources = await Promise.all(x.records.map(async (r) => {
        const check = await x.keeper().verifyOwnRecord(Object.keys(r.pack.fields));
        return {
          pack: r.pack.id, title: r.pack.title, folder: r.paths.folder, issuer: (await json(r.paths.issuer))?.card?.name ?? null,
          converter: r.pack.source!.converter, certifiedBy: (await json(r.paths.converterCert))?.card?.name ?? null,
          ok: check.ok, why: check.ok ? undefined : check.why,
        };
      }));
      const folders: Record<string, number> = {};
      for (const f of [...x.records.map((r) => r.paths.folder), 'agreements/', 'receipts/', 'audit/', 'wallet/', 'settings/']) folders[f] = (await listContainer(owner, f)).length;
      return {
        claims: claims.map((c) => ({ ...c, label: fieldSpec(c.field)?.label ?? c.field })), record: chain.ok ? { ok: true } : { ok: false, why: chain.why },
        sources, folders,
      };
    },
    async market() {
      const m = x.keeper().market;
      return {
        intents: [...m.intents.values()],
        offers: [...m.offers.values()].sort((a, b) => Number(b.result.eligible) - Number(a.result.eligible) || (a.result.outputs.rate ?? 99) - (b.result.outputs.rate ?? 99)),
        packs: x.records.filter((r) => r.pack.intent).map((r) => ({ id: packId(r.pack), title: r.pack.title, terms: r.pack.intent!.terms })),
      };
    },
    openIntent: (pack, terms) => x.keeper().market.open(pack, terms),
    async requestPersonhood(consent, ownerJwk) {
      if (!x.o.personUrl) throw new Error('no person checker is set for this house');
      const { payload, card } = await send(x.o.personUrl, { kind: 'personhood.request', owner: ownerJwk, consent });
      if (payload.kind !== 'stamped') throw new Error(((payload.problems as string[]) ?? ['refused']).join('; '));
      // The stamp's person number is hidden; the owner's own wallet may read it.
      const person = String((await readSdJwtVc(String(payload.credential))).person ?? '');
      await put(owner, 'wallet/personhood.json', JSON.stringify({ credential: payload.credential, card, person }), 'application/json');
      return { stamped: true, by: card.name };
    },
    async signPledge(tally, id) {
      const s = await stamp();
      const { payload: before, card: tallyCard } = await send(tally, { kind: 'tally.count', id });
      const counter = lakeProfile(tallyCard)!.webId;
      // A person stamp for one context: its own person number, so counts can't link this owner's houses. The checker,
      // shown the stamp's hidden number, makes it; whoever counts is shown it, bound to this house's key.
      const stampFor = async (context: string, aud: string, nonce: string) => {
        if (!s) return undefined;
        const checker = lakeProfile(s.card)!.webId;
        const { payload, card } = await send(s.card.supportedInterfaces[0]!.url, { kind: 'personhood.context', context, stamp: await presentSdJwtVc(s.credential, ['person'], x.id, { aud: checker, nonce: context }) });
        if (payload.kind !== 'stamped') throw new Error(`the person checker: ${((payload.problems as string[]) ?? [String(payload.kind)]).join('; ')}`);
        return { credential: await presentSdJwtVc(String(payload.credential), [], x.id, { aud, nonce }), card };
      };
      if (before.blind) {
        // A blind pledge: passes for every open one at once, signed from a throwaway identity; the salt and secret stay
        // in the owner's wallet, to reveal the house once it fills.
        const issuer = (await Promise.all(x.nodes.map((n) => fetch(`${n}/cards?skill=passes`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ card: AgentCard }[]>).catch(() => [])))).flat()[0]?.card;
        if (!issuer) return { kind: 'refused', problems: ['no pass issuer on this Lake'] };
        const issuerWebId = lakeProfile(issuer)!.webId;
        const ask = async (url: string, payload: Record<string, unknown>) => (await send(url, payload)).payload as Record<string, any>;
        const person = before.people_only ? await stampFor(countContext(issuerWebId, 'passes'), issuerWebId, 'passes') : undefined;
        const pass = (await fetchPasses(issuer.supportedInterfaces[0]!.url, ask, person)).find((p) => p.tally === counter && p.id === id);
        if (!pass) return { kind: 'refused', problems: ['no pass for this pledge: this house may have one already, or it counts people and the house has no person stamp'] };
        const signed = await signBlind(tally, pass, owner.webId, { sandbox: x.o.sandbox });
        if (signed.reply.kind === 'tally.signed' || signed.reply.kind === 'tally.triggered') await put(owner, 'wallet/pledges.json', JSON.stringify([...(await blindPledges()), { ...signed, tally, reply: undefined }]), 'application/json');
        return signed.reply;
      }
      const person = before.people_only ? await stampFor(countContext(counter, id), counter, id) : undefined;
      const { payload } = await send(tally, { kind: 'tally.sign', id, ...(person ? { person } : {}) });
      return payload;
    },
    async revealPledge(tally, id) {
      const s = (await blindPledges()).find((p) => p.tally === tally && p.id === id);
      if (!s) return { kind: 'refused', problems: ['this house has no blind signature on that pledge'] };
      return revealBlind(tally, async (url, payload) => (await send(url, payload)).payload as Record<string, any>, s);
    },
    async closeIntent(pack) { await x.keeper().market.close(pack); return { ok: true }; },
    acceptOffer: (id) => x.keeper().market.accept(id),
    async exportAll() {
      // Everything in the pod, so the owner can move house. Includes the wallet: it is theirs.
      const files: Record<string, string> = {};
      const walk = async (path: string) => {
        for (const child of await listContainer(owner, path)) {
          if (child.endsWith('/')) await walk(child);
          else {
            const r = await owner.fetch(owner.podRoot + child);
            if (r.ok) files[child] = await r.text();
          }
        }
      };
      await walk('');
      return { lake: '0.1', exportedAt: new Date().toISOString(), webId: owner.webId, files };
    },
  };
}
