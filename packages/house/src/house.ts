import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildCard, describe, exportIdentity, generateIdentity, importIdentity, LakeLinks, makeEvent, parseRules, signCard,
  type AgentCard, type Identity, type LakeEvent, type Rules,
} from '@thelakeprotocol/core';
import type express from 'express';
import { Housekeeper } from './housekeeper.js';
import { OwnerDesk, type PanelProvider } from './owner.js';
import { Parser } from 'n3';
import { createPodMcpServer } from './pod-mcp.js';
import type { OwnerSession } from './pod.js';
import { convertRecord, fetchConverterCert, fetchRecord, RECORD, type Trust } from './record.js';
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
  issuerUrl: string;
  auditorUrl: string;
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

// Whose signatures count. A sandbox house with no trust section trusts the demo specialists, and says so.
const DEMO_TRUST: Trust = { issuers: ['issuer.lake.local'], auditors: ['audit.lake.local'], ethics: ['ethics.lake.local'], payments: ['payments.lake.local'] };

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
  const trustFrom = (rules: Rules): Trust => {
    const t = rules.trust;
    return {
      issuers: t?.issuers ?? (o.sandbox ? DEMO_TRUST.issuers : []), auditors: t?.auditors ?? (o.sandbox ? DEMO_TRUST.auditors : []),
      ethics: t?.ethics ?? (o.sandbox ? DEMO_TRUST.ethics : []), payments: t?.payments ?? (o.sandbox ? DEMO_TRUST.payments : []),
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
  for (const f of ['', 'health/', 'health/original/', 'finance/', 'agreements/', 'receipts/', 'wallet/', 'audit/', 'settings/']) await ensureContainer(owner, f);

  // The owner's rules. Edits made in the control panel live in their pod and win over the file the house started with.
  let rulesText = o.rulesText;
  const saved = await owner.fetch(`${owner.podRoot}settings/rules.yaml`);
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
  if (!rules.trust && o.sandbox) say(`no trust section in rules.yaml; sandbox default: issuer ${DEMO_TRUST.issuers}, auditor ${DEMO_TRUST.auditors}, ethics ${DEMO_TRUST.ethics}`);

  const card = await signCard(
    buildCard(
      {
        name: `House ${o.name}`,
        description: `Housekeeper for ${o.name}. Answers by its owner's rules. Data never leaves.`,
        url: relayed?.[0] ?? `${o.publicUrl}/a2a`,
        alsoAt: relayed?.slice(1),
        skills: [{ id: 'health-study', name: 'Health study', description: "Considers research offers by its owner's rules", tags: rules.tags ?? [] }],
        profile: { role: 'house', webId: owner.webId, ownerDomain: o.domain ?? new URL(o.publicUrl).hostname, tags: rules.tags ?? [] },
      },
      id,
    ),
    id,
  );

  // The record: signed by the issuer, converted in the pod, signed again by the housekeeper.
  const claimsUrl = `${owner.podRoot}${RECORD.claims}`;
  const missing = async (path: string) => (await owner.fetch(owner.podRoot + path, { method: 'HEAD' })).status === 404;
  if (await missing(RECORD.converterCert)) {
    say(`asking the auditor at ${o.auditorUrl} to certify this house's converter`);
    try {
      const cert = await fetchConverterCert(o.auditorUrl, { id, card, webId: owner.webId });
      await put(owner, RECORD.converterCert, JSON.stringify(cert), 'application/json');
    } catch (e) {
      say(`WARNING: ${(e as Error).message}. Uncertified converter: this house's data can't be used in studies.`);
    }
  }
  if (await missing(RECORD.claims)) {
    say(`asking the issuer at ${o.issuerUrl} for a signed synthetic record`);
    try {
      const r = await fetchRecord(o.issuerUrl, owner.webId);
      const c = await convertRecord(r, { webId: owner.webId, claimsUrl, id, converterCert: owner.podRoot + RECORD.converterCert });
      await put(owner, RECORD.bundle, r.bundle, 'application/json');
      await put(owner, RECORD.credential, r.credential, 'text/plain');
      await put(owner, RECORD.issuer, JSON.stringify({ recordId: r.recordId, card: r.issuerCard }), 'application/json');
      await put(owner, RECORD.claims, c.turtle, 'text/turtle');
      await put(owner, RECORD.claimsCredential, c.credential, 'text/plain');
      say(`record stored: ${c.claims.length} claims (${[...new Set(c.claims.map((x) => x.field))].join(', ')})`);
    } catch (e) {
      say(`WARNING: ${(e as Error).message}. This house holds no signed record and will not join studies.`);
    }
  }

  // The housekeeper and its MCP door to the pod: reads anything; writes only agreements, receipts and its audit log.
  const mcp = createPodMcpServer({ podRoot: owner.podRoot, fetch: owner.fetch, allowWrite: ['agreements/', 'audit/', 'receipts/'] });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const podClient = new Client({ name: `housekeeper-${o.name}`, version: '0.1.0' });
  await podClient.connect(clientSide);

  // The owner's desk. The owner's key is made on their device; the house keeps only its public half, in the pod.
  // Signals from the node this house follows: refreshed every 2 s, verified against the node's own card.
  const signals = { blocklist: new Set<string>(), reputation: {} as Record<string, number> };
  let keeperRef: Housekeeper | null = null;
  const panel = panelFor({ o, owner, actor, activity, card, desk: () => desk, keeper: () => keeperRef!, signals: () => signals, trustFrom, nodes, relayed });
  const desk = new OwnerDesk({
    panel,
    dataDir: o.dataDir, webId: owner.webId, actor, openPairing: !!o.openPairing && o.sandbox, emit,
    readOwnerKey: async () => { const r = await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`); return r.ok ? r.json() : null; },
    saveOwnerKey: (jwk) => put(owner, 'wallet/owner.jwk.json', JSON.stringify(jwk), 'application/json'),
    writeGrant: (gid, jws) => put(owner, `agreements/${gid}.grant.jwt`, jws, 'text/plain'),
    saveRevoked: (ids) => put(owner, 'agreements/revoked.json', JSON.stringify(ids), 'application/json'),
    loadRevoked: async () => { const r = await owner.fetch(`${owner.podRoot}agreements/revoked.json`); return r.ok ? r.json() : []; },
    leaseHours: o.leaseHours,
    clearOwnerKey: async () => { await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`, { method: 'DELETE' }); },
    // The next person gets the house as it started: its original rules.
    onRelease: async () => {
      await put(owner, 'settings/rules.yaml', o.rulesText, 'text/yaml');
      const fresh = parseRules(o.rulesText);
      keeperRef?.setRules(fresh, o.rulesText, trustFrom(fresh));
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
    name: o.name, webId: owner.webId, id, card, rules, rulesText, trust, pod: podClient, claimsUrl, sandbox: o.sandbox, seed: o.seed, emit, desk,
    signals: () => signals,
  });
  keeperRef = keeper;
  const check = await keeper.verifyOwnRecord();
  say(check.ok ? 'record chain verified: trusted issuer → original → certified converter → housekeeper' : `record chain BROKEN: ${check.why}`);

  const app = createHouseServer(card, keeper, desk, approvalsApp());
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
  o: HouseOptions; owner: OwnerSession; actor: string; activity: { at: string; kind: string; text: string; subject?: string; data?: LakeEvent['data'] }[];
  card: AgentCard; desk: () => OwnerDesk; keeper: () => Housekeeper; signals: () => { reputation: Record<string, number> };
  trustFrom: (r: Rules) => Trust; nodes: string[]; relayed: string[] | null;
}): PanelProvider {
  const { owner } = x;
  const money = async () => {
    const files = (await listContainer(owner, 'receipts/')).filter((f) => f.endsWith('.receipt.jwt'));
    const receipts = (await Promise.all(files.map(async (f) => {
      const r = await owner.fetch(owner.podRoot + f);
      const vc = r.ok ? decode(await r.text()) : null;
      const s = vc?.credentialSubject;
      return s ? { file: f, amount: Number(s.amount?.value ?? 0), currency: s.amount?.currency ?? 'USD', agreement: String(s.agreement ?? ''), from: String(vc!.issuer), at: String(vc!.validFrom), settlement: String(s.settlement ?? '') } : null;
    }))).filter(Boolean) as { amount: number; at: string }[];
    receipts.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: receipts.reduce((n, r) => n + r.amount, 0), receipts };
  };
  return {
    async overview() {
      const today = new Date().toISOString().slice(0, 10);
      const claims = await x.keeper().allClaims();
      const chain = await x.keeper().verifyOwnRecord();
      const view = x.desk().view();
      return {
        name: x.o.name, webId: owner.webId, podRoot: owner.podRoot,
        reachedAt: x.card.supportedInterfaces.map((i) => i.url), relayed: !!x.relayed, nodes: x.nodes,
        holds: [...new Set(claims.map((c) => c.field))], claims: claims.length,
        record: chain.ok ? { ok: true } : { ok: false, why: chain.why },
        knocksToday: x.activity.filter((a) => a.kind === 'knock' && a.at.startsWith(today)).length,
        blockedToday: x.activity.filter((a) => a.kind === 'attack.blocked' && a.at.startsWith(today)).length,
        pending: view.requests.length, keys: view.keys.length,
        earned: (await money()).total,
        rulesOwner: x.keeper().rules.owner,
      };
    },
    async rules() {
      return { text: x.keeper().rulesText, rules: x.keeper().rules };
    },
    async setRules(text: string) {
      let rules: Rules;
      try {
        rules = parseRules(text);
      } catch (e) {
        return { ok: false as const, error: (e as Error).message };
      }
      await put(owner, 'settings/rules.yaml', text, 'text/yaml');
      x.keeper().setRules(rules, text, x.trustFrom(rules));
      x.o.say('the owner changed their rules in the control panel');
      return { ok: true as const };
    },
    activity: () => x.activity.slice(0, 100),
    agents() {
      const by = new Map<string, { agent: string; knocks: number; last: string; lastDecision?: string; blocked: number }>();
      for (const a of [...x.activity].reverse()) {
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
      const issuer = await owner.fetch(owner.podRoot + RECORD.issuer).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { card?: AgentCard } | null;
      const cert = await owner.fetch(owner.podRoot + RECORD.converterCert).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { card?: AgentCard } | null;
      const folders: Record<string, number> = {};
      for (const f of ['health/', 'agreements/', 'receipts/', 'audit/', 'wallet/', 'settings/']) folders[f] = (await listContainer(owner, f)).length;
      return {
        claims, record: chain.ok ? { ok: true } : { ok: false, why: chain.why },
        provenance: { issuer: issuer?.card?.name ?? null, converter: '@thelakeprotocol/convert-fhir@0.1.0', certifiedBy: cert?.card?.name ?? null },
        folders,
      };
    },
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
