import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildCard, exportIdentity, generateIdentity, importIdentity, LakeLinks, makeEvent, parseRules, signCard,
  type AgentCard, type Identity, type LakeEvent,
} from '@thelakeprotocol/core';
import type express from 'express';
import { Housekeeper } from './housekeeper.js';
import { OwnerDesk } from './owner.js';
import { createPodMcpServer } from './pod-mcp.js';
import type { OwnerSession } from './pod.js';
import { convertRecord, fetchConverterCert, fetchRecord, RECORD, type Trust } from './record.js';
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
  domain?: string;
  emit: (e: LakeEvent) => void;
  say: (msg: string) => void;
  /** Hosted houses skip the terminal QR code. */
  quiet?: boolean;
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
  const rules = parseRules(o.rulesText);
  const actor = `house:${o.name}`;
  const t = rules.trust;
  const trust: Trust = {
    issuers: t?.issuers ?? (o.sandbox ? DEMO_TRUST.issuers : []), auditors: t?.auditors ?? (o.sandbox ? DEMO_TRUST.auditors : []),
    ethics: t?.ethics ?? (o.sandbox ? DEMO_TRUST.ethics : []), payments: t?.payments ?? (o.sandbox ? DEMO_TRUST.payments : []),
  };
  let link: LakeLinks | null = null;
  const emit = (e: LakeEvent) => {
    o.emit(e);
    link?.report(e);
  };

  // Folders and wallet. The owner sets these up; after this the housekeeper only goes through MCP.
  for (const f of ['health/', 'health/original/', 'finance/', 'agreements/', 'receipts/', 'wallet/', 'audit/']) await ensureContainer(owner, f);
  const id = await walletIdentity(owner);
  if (!rules.trust && o.sandbox) say(`no trust section in rules.yaml; sandbox default: issuer ${DEMO_TRUST.issuers}, auditor ${DEMO_TRUST.auditors}, ethics ${DEMO_TRUST.ethics}`);

  const card = await signCard(
    buildCard(
      {
        name: `House ${o.name}`,
        description: `Housekeeper for ${o.name}. Answers by its owner's rules. Data never leaves.`,
        url: `${o.publicUrl}/a2a`,
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
  const desk = new OwnerDesk({
    dataDir: o.dataDir, webId: owner.webId, actor, openPairing: !!o.openPairing && o.sandbox, emit,
    readOwnerKey: async () => { const r = await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`); return r.ok ? r.json() : null; },
    saveOwnerKey: (jwk) => put(owner, 'wallet/owner.jwk.json', JSON.stringify(jwk), 'application/json'),
    writeGrant: (gid, jws) => put(owner, `agreements/${gid}.grant.jwt`, jws, 'text/plain'),
    saveRevoked: (ids) => put(owner, 'agreements/revoked.json', JSON.stringify(ids), 'application/json'),
    loadRevoked: async () => { const r = await owner.fetch(`${owner.podRoot}agreements/revoked.json`); return r.ok ? r.json() : []; },
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

  // Signals from the node this house follows: refreshed every 2 s, verified against the node's own card.
  const signals = { blocklist: new Set<string>(), reputation: {} as Record<string, number> };
  const keeper = new Housekeeper({
    name: o.name, webId: owner.webId, id, card, rules, rulesText: o.rulesText, trust, pod: podClient, claimsUrl, sandbox: o.sandbox, seed: o.seed, emit, desk,
    signals: () => signals,
  });
  const check = await keeper.verifyOwnRecord();
  say(check.ok ? 'record chain verified: trusted issuer → original → certified converter → housekeeper' : `record chain BROKEN: ${check.why}`);

  const app = createHouseServer(card, keeper, desk, approvalsApp());
  return {
    name: o.name, card, keeper, desk, app,
    get link() { return link; },
    join: async () => {
      if (o.lakeUrl) {
        const nodes = o.lakeUrl.split(',').map((u) => u.trim()).filter(Boolean);
        link = new LakeLinks({ nodeUrls: nodes, card, identity: id, webId: owner.webId, log: say });
        const ids = await link.register();
        ids.forEach((nodeId, i) => { if (nodeId) say(`registered with the Lake node at ${nodes[i]} as ${nodeId}`); });
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
  const res = await o.fetch(url, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
  if (!res.ok) throw new Error(`could not create ${path}: ${res.status}`);
}

async function put(o: OwnerSession, path: string, body: string, contentType: string) {
  const res = await o.fetch(o.podRoot + path, { method: 'PUT', headers: { 'content-type': contentType }, body });
  if (!res.ok) throw new Error(`could not write ${path}: ${res.status}`);
}

/** The housekeeper's signing key lives in the owner's pod, in /wallet/, readable only by the owner. */
async function walletIdentity(o: OwnerSession): Promise<Identity> {
  const res = await o.fetch(`${o.podRoot}wallet/identity.json`);
  if (res.ok) return importIdentity(await res.json());
  const fresh = await generateIdentity();
  await put(o, 'wallet/identity.json', JSON.stringify(await exportIdentity(fresh)), 'application/json');
  return fresh;
}
