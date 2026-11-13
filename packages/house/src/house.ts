import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { houseRunner } from './duty-runner.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  allFields, cartHash, cartTerms, type CartMandate, countContext, readConsentRecord, withdrawConsent, type ConsentSummary, fetchPasses, ownerKeyCredential, assistantKeyCredential, pledgeReceiptPath, cartReceiptPath, signPaymentMandate, cardUrlFor, verifyLakeCard, issueCredential, keyThumbprint, revealBlind, signBlind, withdrawBlind, type BlindSignature, lakeProfile, presentSdJwtVc, readSdJwtVc, PURPOSES, buildCard, describe, exportIdentity, fieldSpec, generateIdentity, identifyingFields, importIdentity, LakeLinks, makeEvent, packId, parseRules, sendLake, signCard, signMessage, verifyLakeData,
  type AgentCard, type PostalAddress, type Identity, type LakeData, type LakeEvent, type LakePack, type Rules,
} from '@thelakeprotocol/core';
import type express from 'express';
import { Housekeeper } from './housekeeper.js';
import { leftWindow, OwnerDesk, type PanelProvider } from './owner.js';
import { openWants, type Wants } from './wants.js';
import { Parser } from 'n3';
import { parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { createPodMcpServer } from './pod-mcp.js';
import { kept, pool, type OwnerSession } from './pod.js';
import { filedIndex, type Filed } from './filed.js';
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
  /** The Lake's MCP connector, where an AI on duty the house runs lives (default: this site's /mcp). */
  connector?: string;
  /** A model this house offers its owner to run their AI on duty with ("stub", "anthropic", "anthropic:<model>"); none by default. */
  dutyModel?: string;
  /** Where people add the Lake to their AI chat (its MCP connector), for the door page. A hosted house uses its Lake's /mcp. */
  connectorUrl?: string;
  /** Where the door page sends people to build their own house. */
  joinUrl?: string;
  ownerUrl?: string;
  /** This machine's address on its own network, when the caller knows it: a phone can't open a link to localhost. */
  lanHost?: string;
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
  /** A hosted Lake's invites: the owner makes a one-time link that gives someone a house of their own. */
  invite?: () => Promise<{ link: string; left: number } | { error: string }>;
  domain?: string;
  /** The demo domain(s) the deployment's demo specialists are named under (default lake.local), its own first. */
  demoDomains?: string[];
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
// The demo specialists are named under the deployment's demo domain(s) (LAKE_DEMO_DOMAIN; lake.local by default), so two
// Lakes on one network don't both claim payments.lake.local. Rules written for the default (the personas) name them under
// lake.local: a sandbox house reads those as the demo specialists of each demo domain its operator lists.
const DEMO_AGENTS = { auditors: 'audit', ethics: 'ethics', payments: 'payments' } as const;
const demoTrust = (demo: string[]) => Object.fromEntries(Object.entries(DEMO_AGENTS).map(([k, agent]) => [k, demo.map((d) => `${agent}.${d}`)])) as Record<keyof typeof DEMO_AGENTS, string[]>;

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
  const { say } = o;
  // What this house files in the pod's growing folders is noted on the way, so they are listed once (filed.ts).
  const filed = await filedIndex(o.owner, join(o.dataDir, 'pod-index.json'), ['agreements/', 'receipts/', 'audit/']);
  const owner = filed.session;
  const actor = `house:${o.name}`;
  const demoIssuers = o.packs.map((p) => p.source?.issuer.domain).filter((d): d is string => !!d);
  const demoRegulators = o.packs.map((p) => p.authority?.domain).filter((d): d is string => !!d);
  const demo = o.demoDomains?.length ? o.demoDomains : ['lake.local'];
  const DEMO_TRUST = demoTrust(demo);
  const asDemo = (xs: string[]) => (o.sandbox ? [...new Set(xs.flatMap((x) => {
    const agent = /^(audit|ethics|payments)\.lake\.local$/i.exec(x)?.[1]?.toLowerCase();
    return agent ? demo.map((d) => `${agent}.${d}`) : [x];
  }))] : xs);
  const trustFrom = (rules: Rules): Trust => {
    const t = rules.trust;
    return {
      issuers: t?.issuers ?? (o.sandbox ? demoIssuers : []), auditors: t?.auditors ? asDemo(t.auditors) : o.sandbox ? DEMO_TRUST.auditors : [],
      ethics: t?.ethics ? asDemo(t.ethics) : o.sandbox ? DEMO_TRUST.ethics : [], payments: t?.payments ? asDemo(t.payments) : o.sandbox ? DEMO_TRUST.payments : [],
      regulators: t?.regulators ?? (o.sandbox ? demoRegulators : []),
      // On a sandbox nobody proves a domain, so a teller is trusted by the address its operator gave, never by the name it claims.
      tellers: t?.tellers ?? (o.sandbox ? o.tellerUrls ?? [] : []),
    };
  };
  let link: LakeLinks | null = null;
  // What happened at this door, for the owner's control panel. Kept in memory; the pod keeps the agreements and audit log.
  // Each entry numbered, so an assistant polling for news asks only for what came after the last one it saw.
  const activity: { seq: number; at: string; kind: string; text: string; subject?: string; data?: LakeEvent['data'] }[] = [];
  let seq = 0;
  const emit = (e: LakeEvent) => {
    o.emit(e);
    link?.report(e);
    note(e.kind, describe(e), e.subject, e.data);
  };
  // In the owner's own activity only: what the owner did that nobody else is told of (a pledge signed, blind or not).
  const note = (kind: string, text: string, subject?: string, data?: LakeEvent['data']) => {
    activity.unshift({ seq: ++seq, at: new Date().toISOString(), kind, text, ...(subject ? { subject } : {}), ...(data ? { data } : {}) });
    activity.length = Math.min(activity.length, 300);
    touchPanel();
  };
  // The owner's open panels hear of it at once (set once the desk exists).
  let touchPanel = () => {};

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
  // Only "not found" means there are none: a pod that stumbled at start read as a house with no owner and no rules, and
  // the start file was written over the owner's (kept, in pod.ts).
  const saved = o.leaseHours && !(await kept(owner, 'wallet/owner.jwk.json')) ? null : await kept(owner, 'settings/rules.yaml');
  if (saved) {
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

  // What the owner is looking for (SPEC §6.8), kept in their pod; the open ones go on the card, for shops to find.
  const wants = await openWants({
    load: async () => { const r = await owner.fetch(`${owner.podRoot}wallet/wants.json`).catch(() => null); return r?.ok ? r.json() : []; },
    save: (list) => put(owner, 'wallet/wants.json', JSON.stringify(list), 'application/json'),
  });
  // Where to send what the owner buys: in /wallet/ (only the owner's key reads it), given to a seller only with a purchase.
  const deliveryAddress = async (): Promise<PostalAddress | null> => { const r = await owner.fetch(`${owner.podRoot}wallet/delivery-address.json`).catch(() => null); return r?.ok ? ((await r.json().catch(() => null)) as PostalAddress | null) : null; };
  // The card is the house's public face, so the owner's rules decide what it says: its interest tags, and whether it names
  // the kinds of data it holds (privacy.show_packs). Hidden, agents searching by kind of data won't find it; that is the trade.
  const cardFor = async (r: Rules) => {
    const show = r.privacy?.show_packs !== false;
    return signCard(
      buildCard(
        {
          // An open door: the owner gives out this address; a name only if they add one.
          name: r.door?.name ? `${r.door.name} (house)` : `House ${o.name}`,
          // Whether its door is open, and its line, are on the page at its address, not on the card every search returns
          // (run 48: the one house tagged "door" was Mia's, and a broker's agent listed it). A name only if the owner gives one.
          description: `${r.door?.name ? `${r.door.name}'s house` : `Housekeeper for ${o.name}`}. Knock with a signed purpose, or leave a note; it answers by its owner's rules, and data never leaves.`,
          url: relayed?.[0] ?? `${o.publicUrl}/a2a`,
          alsoAt: relayed?.slice(1),
          // One skill per pack (`health-study`, `mortgage-study`), so agents find the houses that can answer them.
          skills: show
            ? o.packs.map((p) => ({ id: `${p.id}-study`, name: p.title, description: `Considers ${p.title.toLowerCase()} offers by its owner's rules`, tags: r.tags ?? [] }))
            : [{ id: 'offers', name: 'Offers', description: 'Considers offers by its owner\'s rules', tags: r.tags ?? [] }],
          profile: { role: 'house', webId: owner.webId, ownerDomain: o.domain ?? new URL(o.publicUrl).hostname, tags: r.tags ?? [], packs: show ? o.packs.map(packId) : [], ...(r.door?.handle ? { handle: r.door.handle } : {}), ...(wants.open().length ? { wants: wants.open() } : {}) },
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
  // Consent records that are settled (withdrawn, or past their date), so the panel doesn't re-read them on every refresh.
  // The consent records, kept in the house's own data folder as an index of the pod's (the pod stays the record).
  const indexFile = join(o.dataDir, 'consent-index.json');
  const consentCache = new Map<string, Record<string, unknown>>(Object.entries(await readFile(indexFile, 'utf8').then((t) => JSON.parse(t), () => ({})).catch(() => ({})) as Record<string, Record<string, unknown>>));
  let indexSaving: ReturnType<typeof setTimeout> | undefined;
  const saveIndex = () => { clearTimeout(indexSaving); indexSaving = setTimeout(() => void writeFile(indexFile, JSON.stringify(Object.fromEntries(consentCache))).catch(() => {}), 2000); };
  const consentIndex = {
    listedAt: 0, saidAt: 0, listing: null as Promise<void> | null,
    /** Reads the consent records the index lacks, a dozen at a time; one look at a time. */
    relist() {
      return (this.listing ??= (async () => {
        const files = (await filed.list('agreements/')).filter((f) => f.endsWith('.consent.jsonld'));
        // A listing that fails is no listing: the index isn't marked fresh, and a later look tries again (11 Nov: a failed
        // listing read as an empty folder, and the demo house showed nobody with access for ten minutes).
        const listed = filed.listed('agreements/');
        if (!listed && Date.now() - this.saidAt > 10 * 60_000) { this.saidAt = Date.now(); say('consent index: listing agreements/ failed; keeping what it has'); }
        const missing = files.filter((f) => !consentCache.has(f));
        for (let i = 0; i < missing.length; i += 12) await Promise.all(missing.slice(i, i + 12).map(async (f) => {
          const r = await owner.fetch(owner.podRoot + f).catch(() => null);
          const rec = r?.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
          if (rec) consentCache.set(f, rec);
        }));
        if (missing.length) saveIndex();
        if (listed) this.listedAt = Date.now();
      })().finally(() => { this.listing = null; }));
    },
  };
  // A record written again (withdrawn, or by a study that ran) is read again at the next look.
  filed.onChange((path) => { if (path.endsWith('.consent.jsonld')) consentCache.delete(path); });
  const panel = panelFor({ o, owner, filed, id, actor, activity, note, card, recard, desk: () => desk, keeper: () => keeperRef!, signals: () => signals, trustFrom, nodes, relayed, records, consentCache, consentIndex, wants, deliveryAddress });
  // Looked at a little after start, so the first look at Who has access has a fresh index.
  setTimeout(() => void consentIndex.relist().catch(() => {}), 20_000).unref();
  // The owner's AI on duty, run here when they choose (duty-runner.ts): as awake as the house.
  const dutyRunner = houseRunner({ dataDir: o.dataDir, connector: o.connector ?? new URL('/mcp', o.publicUrl).href, house: o.publicUrl, operatorModel: o.dutyModel, log: say });
  // Back on duty if it was; off duty, back for any task its owner gave it that still waits.
  setTimeout(() => void dutyRunner.resume().then(() => desk.wakeForTasks()), 30_000).unref();
  const desk = new OwnerDesk({
    panel, dutyRunner,
    dataDir: o.dataDir, webId: owner.webId, actor, openPairing: !!o.openPairing && o.sandbox, emit, publicUrl: o.publicUrl, ownerUrl: o.ownerUrl,
    readOwnerKey: async () => (await kept(owner, 'wallet/owner.jwk.json'))?.json() ?? null,
    saveOwnerKey: (jwk) => put(owner, 'wallet/owner.jwk.json', JSON.stringify(jwk), 'application/json'),
    writeGrant: (gid, jws) => put(owner, `agreements/${gid}.grant.jwt`, jws, 'text/plain'),
    writeConsent: async (gid, record) => { await put(owner, `agreements/${gid}.consent.jsonld`, JSON.stringify(record, null, 1), 'application/ld+json'); consentCache.set(`agreements/${gid}.consent.jsonld`, record as Record<string, unknown>); saveIndex(); },
    withdrawConsent: async (gid, at) => {
      const r = await owner.fetch(`${owner.podRoot}agreements/${gid}.consent.jsonld`).catch(() => null);
      if (!r?.ok) return;
      const record = withdrawConsent(await r.json(), at);
      await put(owner, `agreements/${gid}.consent.jsonld`, JSON.stringify(record, null, 1), 'application/ld+json');
      consentCache.set(`agreements/${gid}.consent.jsonld`, record);
      saveIndex();
    },
    saveRevoked: (ids) => put(owner, 'agreements/revoked.json', JSON.stringify(ids), 'application/json'),
    loadRevoked: async () => (await kept(owner, 'agreements/revoked.json'))?.json() ?? [],
    saveStatus: (indexes) => put(owner, 'agreements/status-indexes.json', JSON.stringify(indexes), 'application/json'),
    loadStatus: async () => (await kept(owner, 'agreements/status-indexes.json'))?.json() ?? {},
    leaseHours: o.leaseHours,
    clearOwnerKey: async () => { await owner.fetch(`${owner.podRoot}wallet/owner.jwk.json`, { method: 'DELETE' }); },
    saveAssistants: (keys) => put(owner, 'wallet/assistants.json', JSON.stringify(keys), 'application/json'),
    saveAllowances: (a) => put(owner, 'wallet/allowances.json', JSON.stringify(a), 'application/json'),
    loadAllowances: async () => (await kept(owner, 'wallet/allowances.json'))?.json() ?? [],
    // The house vouches for its owner's key (for a payments agent checking an allowance); it never signs money itself.
    vouchOwner: (ownerJwk) => ownerKeyCredential(id, owner.webId, ownerJwk, 1),
    vouchAssistant: async (a, status) => assistantKeyCredential(id, owner.webId, { webId: a.webId, jkt: await keyThumbprint(a.jwk) }, status),
    card: () => card,
    statusUrl: () => keeperRef!.statusUrl,
    loadAssistants: async () => (await kept(owner, 'wallet/assistants.json'))?.json() ?? [],
    // News for the owner's assistants: a signed message from this house into their Lake inbox (the reply is just "received").
    tell: async (url, payload) => {
      const envelope = await signMessage(payload, id, { iss: owner.webId });
      await sendLake(url.replace(/\/?$/, '').replace(/(\/a2a)?$/, '/a2a'), { lake: '0.1', card, envelope: envelope as LakeData['envelope'] }, { me: id, timeoutMs: 15_000 });
    },
    offerIds: () => [...(keeperRef?.market.offers.keys() ?? [])],
    spent: (receipt, digest, payer) => keeperRef!.market.spent(receipt, digest, payer),
    // The next person gets the house as it started: its original rules.
    onRelease: async () => {
      await put(owner, 'settings/rules.yaml', o.rulesText, 'text/yaml');
      // The stamp said who owned it: the next person to claim the house gets their own, or none.
      await owner.fetch(`${owner.podRoot}wallet/personhood.json`, { method: 'DELETE' }).catch(() => {});
      const fresh = parseRules(o.rulesText);
      keeperRef?.setRules(fresh, o.rulesText, trustFrom(fresh));
      // The next owner starts with an empty door: the last owner's visitors and decisions were theirs.
      activity.length = 0;
      // And with no shopping list open or offers waiting: those were the last owner's too.
      await keeperRef?.market.reset();
      say('the lease ended: keys revoked, owner forgotten, rules reset. Anyone can claim this house now.');
    },
  });
  touchPanel = () => desk.touch();
  const pairing = await desk.init();
  const ownerUrl = `${(o.ownerUrl ?? o.publicUrl).replace(/\/$/, '')}/owner/`;
  if (pairing.paired) say(`owner paired. Approvals app: ${ownerUrl}`);
  else if (!o.quiet) {
    const pairLink = `${ownerUrl}#pair=${pairing.token}`, first = o.openPairing && o.sandbox ? ' (sandbox: the first device to open it becomes the owner)' : '';
    // A link to localhost opens on this machine only (a house started with --join printed one "for your phone", with
    // a code a phone couldn't use): a phone gets this machine's address on its network, when that is known.
    const at = new URL(ownerUrl), local = ['localhost', '127.0.0.1', '[::1]'].includes(at.hostname);
    if (local && o.lanHost) at.hostname = o.lanHost;
    const phoneLink = local && !o.lanHost ? null : `${at.href}#pair=${pairing.token}`;
    if (!local) say(`no owner yet. On your phone, open ${pairLink}${first}`);
    else if (phoneLink) say(`no owner yet. On this machine, open ${pairLink}${first}. On your phone, on the same Wi-Fi: ${phoneLink}`);
    else say(`no owner yet. On this machine, open ${pairLink}${first}. On your phone, on the same Wi-Fi, put this machine's address where the link says localhost; started with --owner-url http://<that address>:${at.port || 80}, the house prints the link and a code to scan`);
    if (phoneLink) {
      const { default: qrcode } = await import('qrcode-terminal');
      qrcode.generate(phoneLink, { small: true }, (q: string) => console.log(q));
    }
  }

  const keeper = new Housekeeper({
    name: o.name, webId: owner.webId, id, card, rules, rulesText, trust, pod: podClient, records, sandbox: o.sandbox, say, nodes, links: () => link, seed: o.seed, emit, desk, note: (kind, text) => note(kind, text),
    fileFavour: async (jws, side) => { await put(owner, `wallet/favours/${side}-${createHash('sha256').update(jws).digest('hex').slice(0, 16)}.jwt`, jws, 'text/plain').catch(() => {}); },
    holdsFavour: async (digest, side) => /^[0-9a-f]{64}$/.test(digest) && !!(await owner.fetch(`${owner.podRoot}wallet/favours/${side}-${digest.slice(0, 16)}.jwt`, { method: 'HEAD' }).catch(() => null))?.ok,
    inCircle: async (tally, id) => { const r = await owner.fetch(`${owner.podRoot}wallet/circles.json`).catch(() => null); return r?.ok ? ((await r.json().catch(() => [])) as { tally: string; id: string }[]).some((x) => x.tally === tally && x.id === id) : false; },
    answeredQuorum: async (tally, id) => { const r = await owner.fetch(`${owner.podRoot}wallet/quorums.json`).catch(() => null); return r?.ok ? ((await r.json().catch(() => [])) as { tally: string; id: string }[]).some((x) => x.tally === tally && x.id === id) : false; },
    signals: () => signals,
    // A shop's offer for something the owner is looking for, or word that it sent what was bought (SPEC §6.8).
    wantIn: async (p, profile, from) => {
      if (p.kind === 'want.offer') {
        const r = await wants.offerIn(p, profile, from, owner.webId);
        if (!r.ok) return { kind: 'refused', problems: [r.why] };
        note('want.offer', `${r.offer.seller.name} offered ${r.offer.total.currency} ${r.offer.total.value.toFixed(2)} for "${r.want.name}"`);
        desk.touch();
        if (!r.replaced && !r.offer.over) desk.notifyOwner('want', `A shop made an offer for "${r.want.name.slice(0, 60)}".`, `./#want=${r.want.id}`);
        return { kind: 'want.received', want: r.want.id, offer: r.offer.id, cart: r.offer.cart.contents.id, ...(r.replaced ? { replaced: r.replaced } : {}), ...(r.dropped ? { matched_dropped: r.dropped } : {}),
          note: `the owner sees it on their phone and decides; if they buy, a receipt comes with where to send it (keep the cart id for shipped).${r.replaced ? ' One open offer per shop: this replaces your earlier one.' : ''}${r.dropped ? ` Not shown as matched (not properties of this want): ${r.dropped.join(', ')}.` : ''}` };
      }
      if (p.kind === 'want.status') return wants.statusFor(String(p.want ?? ''), profile.webId);
      const r = await wants.shippedIn(p, profile);
      if (!r.ok) return { kind: 'refused', problems: [r.why] };
      if ('same' in r) return { kind: 'want.noted', want: r.want.id };
      note('want.shipped', `${r.offer.seller.name} ${r.newer ? 'wrote more about' : 'sent'} "${r.want.name}"${r.again ? ' again' : ''}: ${r.offer.shipped?.note ?? ''}`);
      if (!r.newer) desk.notifyOwner('want', `${r.offer.seller.name.slice(0, 40)} sent your "${r.want.name.slice(0, 50)}"${r.again ? ' again' : ''}.`, `./#want=${r.want.id}`);
      desk.touch();
      return { kind: 'want.noted', want: r.want.id };
    },
    // Run 58 and 59: a release replaced the held receipt in the pod, but Money kept its five-minute copy of the held one,
    // so Earned missed it.
    onReceiptFiled: (path) => panel.forgetReceipt?.(path),
    // How something the house bought ended, when it wasn't the owner's own "it arrived": the owner reads it, and a refund
    // puts the want back on the card while its date holds.
    async onCartSettled(e) {
      const r = await wants.settled(e.hold, e.to, e.why);
      if (!r) return;
      const sum = `${e.currency} ${e.amount.toFixed(2)}`, shop = r.offer.seller.name;
      if (e.to === 'voided') {
        await recard(keeperRef!.rules).catch(() => {});
        note('want.refunded', `Your ${sum} for "${r.want.name}" came back from ${shop}${e.why ? ` (${e.why})` : ''}${r.open ? ': it is open for offers again' : ''}`);
        desk.notifyOwner('want', `Your ${sum} for "${r.want.name.slice(0, 50)}" came back${r.open ? ': it\'s open for offers again' : ''}.`, `./#want=${r.want.id}`);
      } else if (e.how !== 'accepted') note('want.arrived', `${shop} is paid ${sum} for "${r.want.name}"${e.why ? ` (${e.why})` : ''}`);
      desk.touch();
    },
  });
  keeperRef = keeper;
  const check = await keeper.verifyOwnRecord();
  say(check.ok ? 'record chain verified: trusted issuer → original → certified converter → housekeeper' : `record chain BROKEN: ${check.why}`);

  // Its door page: the Lake's connector is at the Lake's own address (a hosted house is one of its tenants), or as configured.
  const connector = o.connectorUrl ?? (o.publicUrl.includes('/t/') ? `${o.publicUrl.split('/t/')[0]}/mcp` : undefined);
  const app = createHouseServer(card, id, keeper, desk, approvalsApp(), { door: () => keeper.rules.door, a2a: () => card.supportedInterfaces?.[0]?.url ?? `${o.publicUrl}/a2a`, connector, joinUrl: o.joinUrl ?? 'https://lake.doneinfifty.com/docs/join' });
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
      // "Joined" only when some node was told (round 6: a house with no --lake said it had joined).
      if (nodes.length) emit(makeEvent('house.joined', actor, undefined, { tags: (rules.tags ?? []).join(',') }));
      else say('not announced to any Lake node, so nobody can find it: pass --lake <node url> (or LAKE_NODE_URL), or --join a Lake');
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
  // 412 (If-None-Match) and 409 ("existing containers cannot be updated via PUT", CSS) both say it is already there: a
  // HEAD that failed on a busy pod server must not stop the house (sandbox, 31 Oct: the houses restarted in a loop).
  if (!res.ok && res.status !== 412 && res.status !== 409) throw new Error(`could not create ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
}

async function put(o: OwnerSession, path: string, body: string, contentType: string) {
  // A pod server just started can refuse an owner it has only just logged in (403), or stumble (5xx): a PUT is safe to
  // send again, so a few tries a moment apart before giving up (sandbox, 5 Nov: the houses crashed once on start-up).
  let res = await o.fetch(o.podRoot + path, { method: 'PUT', headers: { 'content-type': contentType }, body });
  for (let wait = 500; !res.ok && (res.status === 401 || res.status === 403 || res.status >= 500) && wait <= 4000; wait *= 2) {
    await new Promise((r) => setTimeout(r, wait));
    res = await o.fetch(o.podRoot + path, { method: 'PUT', headers: { 'content-type': contentType }, body });
  }
  if (!res.ok) throw new Error(`could not write ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
}

/** The housekeeper's signing key lives in the owner's pod, in /wallet/, readable only by the owner. */
async function walletIdentity(o: OwnerSession): Promise<Identity> {
  const res = await kept(o, 'wallet/identity.json');
  if (res) return importIdentity(await res.json());
  const fresh = await generateIdentity();
  await put(o, 'wallet/identity.json', JSON.stringify(await exportIdentity(fresh)), 'application/json');
  return fresh;
}

const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';

/** One thing that left the house, from its /audit/ entry: who got it and what, in codes the panel puts into words. */
function leftRow(e: Record<string, unknown>, domains: Map<string | undefined, string>) {
  const at = String(e.at ?? '');
  if (e.study) {
    const who = String(e.requester ?? '');
    return { at, kind: 'study' as const, to: String(e.requesterDomain ?? domains.get(who) ?? hostOf(who)), fields: ((e.fieldsRead as string[] | undefined) ?? []).map((f) => fieldSpec(f)?.label ?? f.replace(/_/g, ' ')), ...(e.question ? { question: String(e.question) } : {}), ...(Array.isArray(e.counted) && e.counted.length ? { counts: (e.counted as unknown[]).map(String) } : {}), ...(Number(e.minimum) > 0 ? { table: { min: Number(e.minimum), noise: !!e.noise } } : {}) };
  }
  const released = ((e.released as string[] | undefined) ?? []).map(String);
  const facts = released.filter((r) => r.startsWith('claims: ')).flatMap((r) => r.slice(8).split(', ')).map((f) => fieldSpec(f)?.label ?? f.replace(/_/g, ' '));
  const files = released.filter((r) => !r.startsWith('claims: ') && r !== 'delivery address').map((r) => r.split('/').pop()!);
  return { at, kind: e.want ? 'address' as const : 'offer' as const, to: String(e.toName ?? e.toDomain ?? hostOf(String(e.to ?? ''))), ...(e.title ? { title: String(e.title) } : {}), released: { ...(facts.length ? { facts } : {}), ...(files.length ? { files } : {}), ...(released.includes('delivery address') ? { address: true } : {}) } };
}

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
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function panelFor(x: {
  o: HouseOptions; owner: OwnerSession; filed: Filed; id: Identity; actor: string; activity: { seq: number; at: string; kind: string; text: string; subject?: string; data?: LakeEvent['data'] }[];
  note: (kind: string, text: string) => void;
  card: AgentCard; recard: (r: Rules) => Promise<void>; desk: () => OwnerDesk; keeper: () => Housekeeper; signals: () => { reputation: Record<string, number> };
  records: { pack: LakePack; paths: RecordPaths }[];
  trustFrom: (r: Rules) => Trust; nodes: string[]; relayed: string[] | null;
  consentCache: Map<string, Record<string, unknown>>;
  consentIndex: { listedAt: number; relist: () => Promise<void> };
  wants: Wants;
  deliveryAddress: () => Promise<PostalAddress | null>;
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
  // The payments agent to pay a cart through: one of this Lake's that the shop named, or this Lake's own if it named none.
  const paymentsFor = async (cart: CartMandate) => {
    const ours = (await Promise.all(x.nodes.map((n) => fetch(`${n}/cards?skill=payments`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ card: AgentCard; via?: string }[]>).catch(() => [])))).flat().filter((c) => !c.via).map((c) => String(c.card.supportedInterfaces?.[0]?.url ?? ''));
    const named = cartTerms(cart.contents).payments.map((p) => p.url);
    return named.length ? named.find((u) => ours.includes(u)) : ours[0];
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
  // Receipts are read a few at a time and once each: run 32's assistant got "fetch failed" six times from a busy pod read
  // receipt by receipt, all at once, on every look, and a house with 1,400 receipts read them all again every five
  // minutes. One that can't be read now is left out, and read next time; one filed again (held, then released) is read
  // again; a listing that fails falls back on what the house filed itself.
  const receiptCache = new Map<string, { vc: Record<string, any>; at: number }>();
  const leftCache = new Map<string, ReturnType<typeof leftRow>>();
  x.filed.onChange((path) => { receiptCache.delete(path); leftCache.delete(path); });
  const readReceipts = async (files: string[]) => {
    const now = Date.now();
    await pool(files.filter((f) => !receiptCache.has(f)), 8, async (f) => {
      const r = await owner.fetch(owner.podRoot + f).catch(() => null);
      const vc = r?.ok ? decode(await r.text().catch(() => '')) : null;
      if (vc?.credentialSubject) receiptCache.set(f, { vc, at: now });
    });
  };
  // Read once when complete (both files never change); looked at again after ten minutes while a study's question may
  // still be on its way (it is filed when the study runs, after the consent).
  const aboutCache = new Map<string, { at: number; about: { question?: string; purpose: string; fields: string[]; to: string } | null }>();
  const money = async () => {
    const all = (await x.filed.list('receipts/')).filter((f) => f.endsWith('.receipt.jwt'));
    await readReceipts(all);
    // What the owner's assistant paid under their allowance is filed as spent-…; everything else was paid to this house.
    const files = all.filter((f) => !/(^|\/)spent-/.test(f));
    const spentFiles = all.filter((f) => /(^|\/)spent-/.test(f));
    const receipts = files.map((f) => {
      const vc = receiptCache.get(f)?.vc;
      const s = vc?.credentialSubject;
      // Sold by the owner's assistant for this house (SPEC §6.5): the receipt names it as seller.
      // With what it was for and the names the signed cards gave, where the receipt says (older ones don't).
      return s ? { file: f, amount: Number(s.amount?.value ?? 0), currency: s.amount?.currency ?? 'USD', agreement: String(s.agreement ?? ''), from: String(vc!.issuer), payer: s.payer ? String(s.payer) : undefined, at: String(vc!.validFrom), settlement: String(s.settlement ?? ''), ...(s.seller && s.seller !== owner.webId ? { via: String(s.seller) } : {}),
        ...(Array.isArray(s.items) ? { items: s.items } : {}), ...(s.payer_name ? { payerName: String(s.payer_name) } : {}), ...(s.seller_name ? { viaName: String(s.seller_name) } : {}), ...(s.heldUntil ? { heldUntil: String(s.heldUntil) } : {}) } : null;
    }).filter(Boolean) as { amount: number; at: string; settlement: string }[];
    // On a leased house, money is counted from this owner's claim: the last owner's earnings were never theirs.
    const since = x.desk().claimedAt();
    if (since) receipts.splice(0, receipts.length, ...receipts.filter((r) => Date.parse(r.at) >= since));
    receipts.sort((a, b) => (a.at < b.at ? 1 : -1));
    // What went out: to whom by name where the receipt says, and, for money that came back, from which shop (a refund is
    // made out to the house itself).
    const spent = spentFiles.map((f) => {
      const vc = receiptCache.get(f)?.vc;
      const s = vc?.credentialSubject;
      return s ? { file: f, amount: Number(s.amount?.value ?? 0), currency: s.amount?.currency ?? 'USD', agreement: String(s.agreement ?? ''), to: String((s.settlement === 'voided' ? s.seller : undefined) ?? s.id ?? ''), at: String(vc!.validFrom), settlement: String(s.settlement ?? ''), ...(s.how ? { how: String(s.how) } : {}), ...(s.seller_name ? { toName: String(s.seller_name) } : {}), ...(Array.isArray(s.items) ? { items: s.items } : {}) } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x && (!since || Date.parse(x.at) >= since)).sort((a, b) => (a.at < b.at ? 1 : -1));
    // What a payment for an agreement (a study, a key to some fields) was for: its consent record (who, which fields, what
    // for) and, for a study, its question, filed beside it when it ran. The owner saw only "urn:lake:agreement:d4ed…".
    await Promise.all((receipts as { agreement?: string; about?: unknown }[]).filter((r) => r.agreement?.startsWith('urn:lake:agreement:')).map(async (r) => {
      const offer = r.agreement!.split(':')[3] ?? '';
      if (!/^[\w-]+$/.test(offer)) return;
      const known = aboutCache.get(offer);
      if (!known || (!known.about?.question && Date.now() - known.at > 600_000)) {
        const json = async (path: string) => { const res = await owner.fetch(owner.podRoot + path).catch(() => null); return res?.ok ? ((await res.json().catch(() => null)) as Record<string, any> | null) : null; };
        const [rec, study] = await Promise.all([json(`agreements/${offer}.consent.jsonld`), json(`agreements/${offer}.study.json`)]);
        const c = rec ? readConsentRecord(rec) : null;
        aboutCache.set(offer, { at: Date.now(), about: c ? {
          ...(study?.question ? { question: String(study.question) } : {}),
          purpose: c.purposes.map((x) => PURPOSES[x]?.label ?? x.replace(/-/g, ' ')).join(' or ') || 'unstated',
          fields: c.fields.map((f) => fieldSpec(f)?.label ?? f.replace(/_/g, ' ')),
          to: c.visitor.domain || c.visitor.webId,
        } : null });
      }
      const about = aboutCache.get(offer)?.about;
      if (about) r.about = about;
    }));
    // Money held until delivery isn't the owner's yet: its release receipt replaces it when it comes.
    return { total: receipts.filter((r) => r.settlement !== 'held').reduce((n, r) => n + r.amount, 0), held: receipts.filter((r) => r.settlement === 'held').reduce((n, r) => n + r.amount, 0), receipts, spent };
  };
  // A person stamp for one context: its own person number, so counts can't link this owner's houses. The checker, shown
  // the stamp's hidden number, makes it; whoever counts is shown it, bound to this house's key.
  const stampFor = async (s: Awaited<ReturnType<typeof stamp>>, context: string, aud: string, nonce: string) => {
    if (!s) return undefined;
    const checker = lakeProfile(s.card)!.webId;
    const { payload, card } = await send(s.card.supportedInterfaces[0]!.url, { kind: 'personhood.context', context, stamp: await presentSdJwtVc(s.credential, ['person'], x.id, { aud: checker, nonce: context }) });
    if (payload.kind !== 'stamped') throw new Error(`the person checker: ${((payload.problems as string[]) ?? [String(payload.kind)]).join('; ')}`);
    return { credential: await presentSdJwtVc(String(payload.credential), [], x.id, { aud, nonce }), card };
  };
  // The promise circles this owner joined (SPEC §11.4c), by the tally's WebID: only those may send them calls.
  // One write at a time: joining two circles at once had the second write lose the first (the 300-house run).
  let circlesWrite = Promise.resolve();
  const rememberCircle = (counter: string, url: string, id: string) => (circlesWrite = circlesWrite.then(async () => {
    const known = await owner.fetch(`${owner.podRoot}wallet/circles.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []) as { tally: string; id: string }[];
    if (!known.some((c) => c.tally === counter && c.id === id)) await put(owner, 'wallet/circles.json', JSON.stringify([...known.slice(-99), { tally: counter, url: url.replace(/\/a2a\/?$/, ''), id, at: new Date().toISOString() }]), 'application/json').catch(() => {});
  }));
  const signPledgeAt = async (tally: string, id: string, contribution?: { credential: string; owner: string }): Promise<Record<string, any>> => {
    const s = await stamp();
    const { payload: before, card: tallyCard } = await send(tally, { kind: 'tally.count', id });
    const counter = lakeProfile(tallyCard)!.webId;
    if (before.kind === 'refused') return before;
    // It counts people, and this owner has no stamp yet: say what to do, not the tally's refusal (a reader's first tap).
    if (before.people_only && !s) return { kind: 'refused', problems: ['This pledge counts people, once each. Get a person stamp first: You, This phone, then About this house. Then sign again.'] };
    // Still finding its quorum: nothing to sign yet (and a blind pass fetched now would be spent for nothing).
    if (before.state === 'gathering') return { kind: 'refused', problems: [`it opens for signing only if enough people privately say they'd join, when its quorum closes (${(before.quorum as { closes?: string } | undefined)?.closes ?? 'soon'}); answer its question first`] };
    // A pledge with money (SPEC §11.4a): the contribution the owner signed on their device for this pledge is paid, held for
    // the tally, through the payments agent of this house's own Lake; then the signature names that hold.
    let hold: string | undefined;
    const m = before.money as { contribution: { amount: number; currency: string }; payee: { webId: string; url: string; name?: string }; agreement: string; payments?: string } | undefined;
    if (m) {
      if (!contribution) return { kind: 'refused', problems: [`this pledge holds ${m.contribution.currency} ${m.contribution.amount.toFixed(2)} from each signer until its deadline: the owner puts it in and signs in their control panel, on their device (an assistant can't)`] };
      if (before.state !== 'open' && before.state !== 'triggered') return { kind: 'refused', problems: [`it has ${before.state}`] };
      const payments = (await Promise.all(x.nodes.map((n) => fetch(`${n}/cards?skill=payments`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ card: AgentCard }[]>).catch(() => [])))).flat().map((c) => c.card.supportedInterfaces?.[0]?.url);
      if (!m.payments || !payments.includes(m.payments)) return { kind: 'refused', problems: [`its money is held by ${m.payments ?? 'nobody named'}, not a payments agent of this house's Lake: nothing was paid`] };
      const payment = await signPaymentMandate(x.id, owner.webId, { payee: m.payee.webId, amount: m.contribution.amount, currency: m.contribution.currency, intentMandate: contribution.credential, agreement: m.agreement });
      const until = new Date(Date.parse(String(before.deadline)) + 86_400_000).toISOString();
      const { payload: paid } = await send(m.payments, { kind: 'settle', intent: { credential: contribution.credential, card: x.card, owner: contribution.owner }, payments: [payment], hold: true, pledge: { tally: counter, id, until, payee_url: m.payee.url } });
      if (paid.kind !== 'settled' || typeof paid.hold !== 'string') return { kind: 'refused', problems: [`the payments agent: ${((paid.problems as string[]) ?? [String(paid.kind)]).join('; ')}`] };
      hold = paid.hold;
      const receipt = (paid.receipts as { credential: string }[] | undefined)?.[0]?.credential;
      if (receipt) await put(owner, pledgeReceiptPath(m.agreement), receipt, 'text/plain').catch(() => {});
    }
    if (before.blind) {
      // A blind pledge: passes for every open one at once, signed from a throwaway identity; the salt and secret stay
      // in the owner's wallet, to reveal the house once it fills.
      const issuer = (await Promise.all(x.nodes.map((n) => fetch(`${n}/cards?skill=passes`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<{ card: AgentCard }[]>).catch(() => [])))).flat()[0]?.card;
      if (!issuer) return { kind: 'refused', problems: ['no pass issuer on this Lake'] };
      const issuerWebId = lakeProfile(issuer)!.webId;
      const ask = async (url: string, payload: Record<string, unknown>) => (await send(url, payload)).payload as Record<string, any>;
      const person = before.people_only ? await stampFor(s, countContext(issuerWebId, 'passes'), issuerWebId, 'passes') : undefined;
      const pass = (await fetchPasses(issuer.supportedInterfaces[0]!.url, ask, person)).find((p) => p.tally === counter && p.id === id);
      if (!pass) return { kind: 'refused', problems: ['no pass for this pledge: this house may have one already, or it counts people and the house has no person stamp'] };
      const signed = await signBlind(tally, pass, owner.webId, { sandbox: x.o.sandbox, me: { identity: x.id, card: x.card } });
      if (before.circle && (signed.reply.kind === 'tally.signed' || signed.reply.kind === 'tally.triggered')) await rememberCircle(counter, tally, id);
      if (signed.reply.kind === 'tally.signed' || signed.reply.kind === 'tally.triggered') await put(owner, 'wallet/pledges.json', JSON.stringify([...(await blindPledges()), { ...signed, tally, reply: undefined }]), 'application/json');
      return signed.reply;
    }
    const person = before.people_only ? await stampFor(s, countContext(counter, id), counter, id) : undefined;
    const { payload } = await send(tally, { kind: 'tally.sign', id, ...(person ? { person } : {}), ...(hold ? { hold } : {}) });
    if (before.circle && (payload.kind === 'tally.signed' || payload.kind === 'tally.triggered')) await rememberCircle(counter, tally, id);
    // Refused after paying: the money stays held for the tally, which never counted it, and comes back by itself when its
    // hold runs out (a day after the deadline).
    if (hold && payload.kind === 'refused') return { ...payload, note: 'your contribution was held but not counted: it comes back a day after the deadline' };
    return payload;
  };
  const standingRules = () => {
      const uses = x.desk().standingUses;
      return x.keeper().rules.rules.filter((r) => typeof r.match.requester_key === 'string').map((r) => ({
        jkt: String(r.match.requester_key), domain: r.standing?.domain ?? '', purpose: String(r.match.purpose ?? ''), fields: (r.match.fields_within as string[] | undefined) ?? r.allow_fields ?? [],
        retention: String(r.match.retention_at_most ?? r.retention ?? 'none'), ...(r.min_price ? { floor: r.min_price } : r.min_price_usd !== undefined ? { floor: { amount: r.min_price_usd, currency: 'USD' } } : {}),
        added: r.standing?.added ?? '', until: r.until ?? '', uses: uses.get(`${String(r.match.requester_key)}|${String(r.match.purpose ?? '')}`) ?? 0,
      }));
  };
  const agents = () => {
      const by = new Map<string, { agent: string; knocks: number; last: string; lastDecision?: string; lastReason?: string; blocked: number; asks: { at: string; decision: string; reason: string }[] }>();
      for (const a of [...mine()].reverse()) {
        // A block is reported by key; once the sender's card verified, it lands on the row it knocked under (run 32's
        // injector showed "blocked: 0" there, its blocks on a separate "unverified key" row).
        const who = a.kind === 'attack.blocked' && a.data?.verified && (a.data.from ?? a.data.claimed) ? `agent:${a.data.from ?? a.data.claimed}` : a.subject;
        if (!who) continue;
        const e = by.get(who) ?? { agent: who, knocks: 0, last: a.at, blocked: 0, asks: [] };
        if (a.kind === 'knock') e.knocks++;
        // What the house said, and why, in the engine's own words ("your rule 3 declines marketing requests").
        if (a.kind === 'decision') { e.lastDecision = String(a.data?.decision ?? ''); e.lastReason = String(a.data?.reason ?? ''); e.asks = [{ at: a.at, decision: e.lastDecision, reason: e.lastReason }, ...e.asks].slice(0, 10); }
        if (a.kind === 'attack.blocked') e.blocked++;
        e.last = a.at;
        by.set(who, e);
      }
      const rep = x.signals().reputation;
      return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : -1)).map((e) => ({ ...e, reputation: e.agent.startsWith('agent:') ? rep[e.agent.slice(6)] ?? null : null }));
  };
  const consents = async () => {
      // An index of the records, kept by the house (it writes and withdraws them, so it knows). Once there is one, a look
      // waits a moment for what it lacks (a study that just ran) and no longer: the rest is read in the background.
      // (11 Nov: the demo house's 821 records: listing the folder took 6 s, reading them all 81 s, and the page waited.)
      if (!x.consentIndex.listedAt) await x.consentIndex.relist();
      else await Promise.race([x.consentIndex.relist().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      const read = [...x.consentCache.values()].map((rec) => readConsentRecord(rec));
      // On a leased house, the list starts at this owner's claim: the last owner's consents were theirs, not this one's.
      const since = x.desk().claimedAt();
      const desk = x.desk();
      return read.filter((c): c is ConsentSummary => !!c && (!since || Date.parse(c.given) >= since))
        .sort((a, b) => (a.given < b.given ? 1 : -1))
        .map((c) => {
          const g = desk.grants.get(c.id);
          // Two Lake purposes can share a DPV term; the key in memory says which one it was, else both are named.
          const purposes = c.purposes.length > 1 && g && c.purposes.includes(g.purpose) ? [g.purpose] : c.purposes;
          // Taken back by the owner (the record says when), used up (a study key is good for one run), past its date, or live.
          const status = c.withdrawn ? 'withdrawn' : desk.isRevoked(c.id) ? (g && !g.spent ? 'withdrawn' : 'used') : Date.parse(c.until) <= Date.now() ? 'ended' : 'active';
          return {
            id: c.id, visitor: c.visitor.domain || c.visitor.webId, visitorWebId: c.visitor.webId,
            fields: c.fields.map((f) => ({ name: f, label: fieldSpec(f)?.label ?? f.replace(/_/g, ' ') })),
            purpose: purposes.join(' or '), purposeLabel: purposes.map((p) => PURPOSES[p]?.label ?? p.replace(/-/g, ' ')).join(' or ') || 'unstated',
            given: c.given, until: c.until, retention: c.retention,
            how: c.method && 'live' in c.method ? { live: true } : { rule: c.method?.standingRule ?? null },
            status, ...(c.withdrawn ? { withdrawnAt: c.withdrawn } : {}),
          };
        });
  };
  let recordCheck: { at: number; claims: Awaited<ReturnType<ReturnType<typeof x.keeper>['allClaims']>>; chain: Awaited<ReturnType<ReturnType<typeof x.keeper>['verifyOwnRecord']>> } | null = null;
  return {
    forgetReceipt: (path: string) => void receiptCache.delete(path),
    async overview(tzOffset?: number) {
      // "Today" is the owner's day: the panel says how far its clock is from UTC (minutes, as the browser counts them).
      const offset = Number.isFinite(tzOffset) ? Number(tzOffset) : 0;
      const midnight = (() => { const d = new Date(Date.now() - offset * 60_000); d.setUTCHours(0, 0, 0, 0); return d.getTime() + offset * 60_000; })();
      // The record and its check change only when a new record is filed: checked at most once a minute (the panel's Home
      // waited the better part of a second for it on every look).
      if (!recordCheck || Date.now() - recordCheck.at > 60_000) recordCheck = { at: Date.now(), claims: await x.keeper().allClaims(), chain: await x.keeper().verifyOwnRecord() };
      const { claims, chain } = recordCheck;
      const view = x.desk().view();
      return {
        name: x.o.name, ...(x.keeper().rules.door?.handle ? { handle: x.keeper().rules.door!.handle } : {}), ...(x.keeper().rules.door?.name ? { shown: x.keeper().rules.door!.name } : {}), webId: owner.webId, podRoot: owner.podRoot,
        reachedAt: x.card.supportedInterfaces.map((i) => i.url), relayed: !!x.relayed, nodes: x.nodes,
        holds: [...new Set(claims.map((c) => c.field))], claims: claims.length,
        record: chain.ok ? { ok: true } : { ok: false, why: chain.why },
        knocksToday: mine().filter((a) => a.kind === 'knock' && Date.parse(a.at) >= midnight).length,
        blockedToday: mine().filter((a) => a.kind === 'attack.blocked' && Date.parse(a.at) >= midnight).length,
        // Who can see something now, from the consent records in the pod (the same source as Who has access): the keys in
        // memory are gone after a restart, which showed "0 live keys" beside 101 open consents.
        pending: view.requests.length, keys: (await consents()).filter((c) => c.status === 'active').length,
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
    door() {
      const d = x.keeper().rules.door;
      return { open: !!d, ...(d?.about ? { about: d.about } : {}), ...(d?.name ? { name: d.name } : {}), ...(d?.handle ? { handle: d.handle } : {}), ...(d?.note ? { note: d.note } : {}), address: x.o.publicUrl, a2a: x.card.supportedInterfaces?.[0]?.url ?? `${x.o.publicUrl}/a2a` };
    },
    // Written into the owner's rules (comments and all kept): the door is one of their settings, saved in their pod.
    // When the owner is free to meet, in their rules like the door (null takes it out).
    async setAvailability(av) {
      const doc = parseDocument(x.keeper().rulesText);
      if (!av) doc.delete('availability');
      else doc.set('availability', av);
      return this.setRules(String(doc));
    },
    availability() {
      return x.keeper().rules.availability ?? null;
    },
    // A standing yes, written into the owner's rules (comments kept) below their own declines, so it never outranks one:
    // for this key and purpose, these fields or fewer, this long or shorter, at least this price, for 90 days.
    async addStanding(st) {
      const doc = parseDocument(x.keeper().rulesText);
      let seq = doc.get('rules') as YAMLSeq | undefined;
      if (!seq) { doc.set('rules', doc.createNode([])); seq = doc.get('rules') as YAMLSeq; }
      // An earlier one for the same key and purpose is replaced, not stacked.
      seq.items = seq.items.filter((it) => { const m = (it as YAMLMap).toJSON?.()?.match ?? {}; return !(m.requester_key === st.jkt && m.purpose === st.purpose); });
      const declines = seq.items.findIndex((it) => (it as YAMLMap).toJSON?.()?.decision !== 'decline');
      const at = declines === -1 ? seq.items.length : declines;
      const today = new Date().toISOString().slice(0, 10), until = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
      const node = doc.createNode({
        match: { requester_key: st.jkt, purpose: st.purpose, fields_within: st.fields, retention_at_most: st.retention },
        allow_fields: st.fields, ...(st.floor.currency === 'USD' ? { min_price_usd: st.floor.amount } : { min_price: st.floor }), retention: st.retention,
        until, standing: { domain: st.domain, added: today }, decision: 'join',
      }) as YAMLMap;
      node.commentBefore = ` Added from your panel on ${today}: always allow ${st.domain} for ${st.purpose} (these fields or fewer), until ${until}.`;
      seq.items.splice(at, 0, node);
      return this.setRules(String(doc));
    },
    async removeStanding(jkt, purpose) {
      const doc = parseDocument(x.keeper().rulesText);
      const seq = doc.get('rules') as YAMLSeq | undefined;
      if (!seq) return { ok: true as const, removed: 0 };
      const before = seq.items.length;
      seq.items = seq.items.filter((it) => { const m = (it as YAMLMap).toJSON?.()?.match ?? {}; return !(m.requester_key === jkt && (!purpose || m.purpose === purpose)); });
      const removed = before - seq.items.length;
      if (!removed) return { ok: true as const, removed: 0 };
      const r = await this.setRules(String(doc));
      return r.ok ? { ok: true as const, removed } : r;
    },
    standing: standingRules,
    async setDoor(d) {
      const doc = parseDocument(x.keeper().rulesText);
      // The door note is kept unless this call sets it ("" takes it out): saving the handle mustn't drop it.
      d = { ...d, note: d.note ?? x.keeper().rules.door?.note };
      if (!d.open) doc.delete('door');
      else doc.set('door', { ...(d.about?.trim() ? { about: d.about.trim() } : {}), ...(d.name?.trim() ? { name: d.name.trim() } : {}), ...(d.handle?.trim() ? { handle: d.handle.trim().toLowerCase() } : {}), ...(d.note?.trim() ? { note: d.note.trim() } : {}) });
      if (d.open && !d.about?.trim() && !d.name?.trim() && !d.handle?.trim() && !d.note?.trim()) doc.set('door', true);
      // A handle is one house's on its Lake: ask the node first, so the owner hears now that it's taken, not never.
      if (d.open && d.handle?.trim()) {
        const h = d.handle.trim().toLowerCase();
        for (const n of x.nodes) {
          const r = await fetch(`${n.replace(/\/$/, '')}/handles/${encodeURIComponent(h)}`, { signal: AbortSignal.timeout(5000) }).then((x) => (x.ok ? x.json() as Promise<{ url?: string; lake?: string }> : null)).catch(() => null);
          if (r && !r.lake && r.url !== x.card.supportedInterfaces?.[0]?.url) return { ok: false as const, error: `the handle "${h}" is taken on this Lake; choose another` };
        }
      }
      return this.setRules(String(doc));
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
      if (JSON.stringify([before.tags, before.privacy, before.door]) !== JSON.stringify([rules.tags, rules.privacy, rules.door])) await x.recard(rules).catch((e: Error) => x.o.say(`card: ${e.message}`));
      x.o.say('the owner changed their rules in the control panel');
      return { ok: true as const };
    },
    // `since`: the seq of the newest entry already seen (or a time): only what came after it (run 31's assistant reread
    // everything on every poll). Activity is kept in memory, so a seq ahead of this house's own means it restarted, and
    // all of it is new.
    activity(since?: number | string) {
      if (since === undefined || since === '') return mine().slice(0, 100);
      const n = typeof since === 'number' ? since : /^\d+$/.test(since) ? Number(since) : NaN, t = Date.parse(String(since));
      if (Number.isNaN(n) && Number.isNaN(t)) throw new Error('since: the seq of the newest entry you saw, or a time');
      const after = !Number.isNaN(n) ? (n > (x.activity[0]?.seq ?? 0) ? mine() : mine().filter((a) => a.seq > n)) : mine().filter((a) => Date.parse(a.at) > t);
      return after.slice(0, 100);
    },
    agents,
    money,
    /**
     * Who has access (one page, one source per number): every agent that can see something now (from the consent records
     * in the pod, the truth), its always-yes rules, and what it asked lately and what the house said, joined by agent.
     */
    async access(tzOffset?: number) {
      const offset = Number.isFinite(tzOffset) ? Number(tzOffset) : 0;
      const midnight = (() => { const d = new Date(Date.now() - offset * 60_000); d.setUTCHours(0, 0, 0, 0); return d.getTime() + offset * 60_000; })();
      const yes = await consents();
      const standing = standingRules();
      const asked = agents();
      type Row = { id: string; domain?: string; webId?: string; reputation: number | null; yeses: typeof yes; standing: typeof standing; asked: number; blocked: number; lastAsked?: string; last?: { decision: string; reason: string; at: string }; asks: { at: string; decision: string; reason: string }[] };
      const rows = new Map<string, Row>();
      const row = (id: string) => rows.get(id) ?? (rows.set(id, { id, reputation: null, yeses: [], standing: [], asked: 0, blocked: 0, asks: [] }), rows.get(id)!);
      for (const c of yes) { const r = row(c.visitor); r.domain = c.visitor.includes('://') ? undefined : c.visitor; r.webId = c.visitorWebId; r.yeses.push(c); }
      for (const s of standing) row(s.domain || s.jkt).standing.push(s);
      for (const a of asked) {
        const r = row(a.agent.replace(/^agent:/, ''));
        if (a.agent.startsWith('agent:')) r.domain ??= a.agent.slice(6);
        r.reputation = a.reputation; r.asked = a.knocks; r.blocked = a.blocked; r.lastAsked = a.last; r.asks = a.asks;
        if (a.lastDecision) r.last = { decision: a.lastDecision, reason: a.lastReason ?? '', at: a.last };
      }
      const all = [...rows.values()].map((r) => ({ ...r, canSee: r.yeses.some((c) => c.status === 'active') }))
        .sort((a, b) => Number(b.canSee) - Number(a.canSee) || String(b.lastAsked ?? b.yeses[0]?.given ?? '').localeCompare(String(a.lastAsked ?? a.yeses[0]?.given ?? '')));
      return {
        now: all.filter((r) => r.canSee).length,
        askedToday: mine().filter((a) => a.kind === 'knock' && Date.parse(a.at) >= midnight).length,
        blockedToday: mine().filter((a) => a.kind === 'attack.blocked' && Date.parse(a.at) >= midnight).length,
        agents: all,
      };
    },
    consents,
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
      for (const f of [...x.records.map((r) => r.paths.folder), 'wallet/', 'settings/']) folders[f] = (await listContainer(owner, f)).length;
      for (const f of ['agreements/', 'receipts/', 'audit/']) folders[f] = (await x.filed.list(f)).length;
      return {
        claims: claims.map((c) => ({ ...c, label: fieldSpec(c.field)?.label ?? c.field })), record: chain.ok ? { ok: true } : { ok: false, why: chain.why },
        sources, folders,
      };
    },
    // What left this house, newest first, from the pod's /audit/ log: each study answered (as shares), what an accepted
    // offer sent, an address that went with a payment. An entry never changes, so each is read once.
    async left() {
      const files = (await x.filed.list('audit/')).filter((f) => f.endsWith('.json'));
      const domains = new Map((await consents()).map((c) => [c.visitorWebId, c.visitor] as const));
      const recent = leftWindow(files);
      await pool(recent.filter((f) => !leftCache.has(f)), 8, async (f) => {
        const e = await owner.fetch(owner.podRoot + f).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Record<string, unknown> | null;
        if (e) leftCache.set(f, leftRow(e, domains));
      });
      return { total: files.length, left: recent.map((f) => leftCache.get(f)).filter(Boolean) };
    },
    async market() {
      const m = x.keeper().market;
      return {
        // Each with why it has no offers yet, if it hasn't: who was told, who was turned away, a record that can't price it.
        intents: await Promise.all([...m.intents.values()].map(async (i) => ({ ...i, ...(await m.status(i.pack)) }))),
        // Each with where its maker answers (one grocer's name on two Lakes is two offers: run 40 paid the other one), and
        // whether the owner's assistant may pay it under an allowance in its currency.
        offers: [...m.offers.values()].sort((a, b) => Number(b.result.eligible) - Number(a.result.eligible) || (a.result.outputs.rate ?? 99) - (b.result.outputs.rate ?? 99)).map((o) => {
          const price = m.priceOf(o.id);
          const caps = [...x.desk().allowances.values()].filter((a) => a.currency === price?.currency && Date.parse(a.until) > Date.now()).map((a) => a.amount);
          return { ...o, quoter: { ...o.quoter, at: hostOf(o.quoter.url) }, ...(price && caps.length ? { payable_by_assistant: caps.some((c) => c >= price.amount) } : {}) };
        }),
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
    async circles() {
      // The circles this owner joined, each with where it stands (the tally's own view): what to call on.
      const known = await owner.fetch(`${owner.podRoot}wallet/circles.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []) as { tally: string; url: string; id: string }[];
      return Promise.all(known.map(async (c) => ({ ...c, view: await send(c.url, { kind: 'circle.record', id: c.id }).then((r) => r.payload).catch((e: Error) => ({ kind: 'refused', problems: [e.message] })) })));
    },
    async favourNote(c) {
      // What the owner owes for help received: signed by this house, sent to the circle, kept in the owner's wallet.
      const jws = await issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeFavour'], issuer: owner.webId, validFrom: new Date().toISOString(), credentialSubject: { id: c.helper, call: c.call, circle: { id: c.id, tally: c.tally }, need: c.need.slice(0, 300), ...(c.help ? { help: c.help } : {}), favours: 1 } } as never, x.id);
      await put(owner, `wallet/favours/owe-${createHash('sha256').update(jws).digest('hex').slice(0, 16)}.jwt`, jws, 'text/plain').catch(() => {});
      return jws;
    },
    // A favour owed to the owner, passed on to settle one they owe (SPEC §11.4c): the house finds a pair in the owner's
    // wallet, endorses the one to whom the other is owed, and offers it; they agree on their phone.
    // A cart priced in favours (SPEC §6.7), paid with one owed to the owner: endorsed to the cart's seller for that cart, at
    // the tally that holds the note, on the owner's tap.
    async payWithFavour(cart, sellerUrl) {
      const sellerCard = (await (await fetch(cardUrlFor(sellerUrl))).json()) as AgentCard;
      const seller = await verifyLakeCard(sellerCard);
      const contents = (cart as CartMandate).contents;
      const dir = `${owner.podRoot}wallet/favours/`;
      const listing = await owner.fetch(dir, { headers: { accept: 'text/turtle' } }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      const names = [...new Set([...listing.matchAll(/owed-[0-9a-f]{16}\.jwt/g)].map((m) => m[0]))].slice(0, 100);
      let last: Record<string, any> = { kind: 'refused', problems: ['no favour owed to you to pay with: help someone in one of your circles first'] };
      for (const name of names) {
        const jws = await owner.fetch(`${dir}${name}`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        let sub: { id?: string; circle?: { id?: string; tally?: string } };
        try { sub = (JSON.parse(Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString()) as { credentialSubject?: typeof sub }).credentialSubject ?? {}; } catch { continue; }
        if (sub.id !== owner.webId || !sub.circle?.id || !sub.circle.tally) continue;
        const endorsement = await issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeFavourEndorsement'], issuer: owner.webId, validFrom: new Date().toISOString(), credentialSubject: { id: seller.webId, note: createHash('sha256').update(jws).digest('hex'), settles: `urn:ap2:cart:${contents.id}`, cart_hash: cartHash(contents) } } as never, x.id);
        last = (await send(sub.circle.tally, { kind: 'circle.pay', id: sub.circle.id, note: jws, endorsement, cart, seller_card: sellerCard }).catch((e: Error) => ({ payload: { kind: 'refused', problems: [e.message] } }))).payload as Record<string, any>;
        if (last.kind === 'circle.paid') { x.note('favour.paid', `You paid ${sellerCard.name} with a favour owed to you: the one who owed it owes them now`); return last; }
      }
      return last;
    },
    // What the owner is looking for (SPEC §6.8): post, close, and buy one offer with their signature for its cart.
    wantsList: () => x.wants.all(),
    async postWant(input, limit, by) { const w = await x.wants.post(input, limit, by); await x.recard(x.keeper().rules); x.note('want.posted', `You're looking for "${w.name}": shops can offer until ${new Date(w.availabilityEnds).toLocaleDateString()}`); return w; },
    async closeWant(id) { const ok = await x.wants.close(id); if (ok) await x.recard(x.keeper().rules); return ok; },
    wantOffer: (wantId, offerId) => x.wants.find(wantId)?.offers.find((o) => o.id === offerId),
    deliveryAddress: () => x.deliveryAddress(),
    async setDeliveryAddress(a) { if (a) await put(owner, 'wallet/delivery-address.json', JSON.stringify(a), 'application/json'); else await owner.fetch(`${owner.podRoot}wallet/delivery-address.json`, { method: 'DELETE' }).catch(() => null); },
    async buyWant(wantId, offerId, signed) {
      const offer = x.wants.find(wantId)?.offers.find((o) => o.id === offerId);
      if (!offer) return { error: 'no such offer' };
      const deliverTo = await x.deliveryAddress();
      if (!deliverTo) return { error: 'add your delivery address first (You, Money, then Delivery address): the shop needs to know where to send it. Nothing was paid' };
      const payments = await paymentsFor(offer.cart);
      if (!payments) return { error: 'no payments agent on this Lake that the shop takes: nothing was paid' };
      const r = await x.wants.buy(wantId, offerId, signed, { id: x.id, webId: owner.webId, card: x.card, payments, deliverTo, send });
      if ('error' in r) return r;
      if (r.receipt) await put(owner, cartReceiptPath(offer.cart.contents.id), r.receipt, 'text/plain').catch(() => {});
      // The address went to that one shop with the payment: written down like everything else that leaves (SPEC §6.1).
      await put(owner, `audit/${Date.now()}-address.json`, JSON.stringify({ at: new Date().toISOString(), want: r.want.id, to: offer.seller.webId, toName: offer.seller.name, toDomain: offer.seller.domain, released: ['delivery address'], consent: 'owner, live' }), 'application/json').catch(() => {});
      await x.recard(x.keeper().rules);
      x.note('want.bought', `You bought "${r.want.name}" from ${offer.seller.name} for ${offer.total.currency} ${offer.total.value.toFixed(2)}: paid, held until you say it arrived`);
      return { ok: true, want: r.want.id, offer: offer.id };
    },
    async wantArrived(wantId) {
      const r = x.wants.find(wantId), offer = r?.offers.find((o) => o.id === r.bought);
      if (!offer) return { error: 'nothing bought for that want' };
      const payments = await paymentsFor(offer.cart);
      if (!payments) return { error: 'no payments agent on this Lake' };
      const out = await x.wants.arrived(wantId, { payments, send });
      if (!('error' in out)) x.note('want.arrived', `"${r!.want.name}" arrived: ${offer.seller.name} is paid`);
      return out;
    },
    async wantProblem(wantId, code) {
      const r = x.wants.find(wantId), offer = r?.offers.find((o) => o.id === r.bought);
      if (!offer) return { error: 'nothing bought for that want' };
      const payments = await paymentsFor(offer.cart);
      if (!payments) return { error: 'no payments agent on this Lake' };
      const out = await x.wants.problem(wantId, code, { payments, send });
      if ('error' in out) return out;
      x.note('want.problem', `You told ${offer.seller.name} that "${r!.want.name}" ${code === 'not_arrived' ? 'hasn\'t arrived' : 'came damaged or wrong'}${out.offer.problem?.held ? ': your money stays held until it sends it again or refunds you' : ''}`);
      return { ok: true, want: r!.want.id, held: !!out.offer.problem?.held };
    },
    async passFavour() {
      const dir = `${owner.podRoot}wallet/favours/`;
      const listing = await owner.fetch(dir, { headers: { accept: 'text/turtle' } }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      const names = [...new Set([...listing.matchAll(/owed?-[0-9a-f]{16}\.jwt/g)].map((m) => m[0]))].slice(0, 100);
      const notes = (await Promise.all(names.map(async (name) => {
        const jws = await owner.fetch(`${dir}${name}`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        try { const vc = JSON.parse(Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString()) as { issuer?: string; credentialSubject?: { id?: string; circle?: { id?: string; tally?: string } } }; return { name, jws, digest: createHash('sha256').update(jws).digest('hex'), issuer: vc.issuer ?? '', sub: vc.credentialSubject ?? {} }; } catch { return null; }
      }))).filter((n): n is NonNullable<typeof n> => !!n?.sub.circle?.id && !!n.sub.circle.tally);
      const owed = notes.filter((n) => n.name.startsWith('owed-') && n.sub.id === owner.webId), owe = notes.filter((n) => n.name.startsWith('owe-') && n.issuer === owner.webId);
      let last: Record<string, any> = { kind: 'refused', problems: ['nothing to pass on: you need a favour owed to you and one you owe, to someone else'] };
      for (const n of owed) for (const m of owe) {
        if (m.sub.id === n.issuer) continue;
        const endorsement = await issueCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'LakeFavourEndorsement'], issuer: owner.webId, validFrom: new Date().toISOString(), credentialSubject: { id: m.sub.id, note: n.digest, settles: m.digest } } as never, x.id);
        last = (await send(n.sub.circle!.tally!, { kind: 'circle.pass', id: n.sub.circle!.id, note: n.jws, endorsement, settles: { url: m.sub.circle!.tally, circle: m.sub.circle!.id, digest: m.digest } }).catch((e: Error) => ({ payload: { kind: 'refused', problems: [e.message] } }))).payload as Record<string, any>;
        if (last.kind === 'circle.pass.offered') return last;
      }
      return last;
    },
    // A circle's vote on its own rules (SPEC §11.4c): the owner's yes or no, sent by this house as two unreadable shares
    // to the tellers the tally names, if this house trusts them; the tally learns only that this member answered.
    async voteCircle(tally, id, vote, yes) {
      const { payload: j } = await send(tally, { kind: 'circle.vote.join', id, vote });
      if (j.kind !== 'circle.vote.joined') return j;
      const sent = await x.keeper().answerCount(String(j.count), j.tellers as { url: string; domain: string }[], 2, yes ? 0 : 1);
      if (sent !== true) return { kind: 'refused', problems: [sent] };
      x.note('circle.voted', `You answered your circle's vote privately: it left your house only as two unreadable shares`);
      return { kind: 'circle.vote.answered', id, vote };
    },
    async fileFavour(jws, side) { await put(owner, `wallet/favours/${side}-${createHash('sha256').update(jws).digest('hex').slice(0, 16)}.jwt`, jws, 'text/plain').catch(() => {}); },
    async invite() {
      return x.o.invite ? x.o.invite() : { error: 'this house is run by its owner, not hosted: point people at the docs to run their own (lake.doneinfifty.com/docs/join)' };
    },
    async replyAgent(url, payload) {
      return (await send(url, payload)).payload as Record<string, any>;
    },
    // A message one of the owner's AIs received and passes on as signed: checked like one at the door, as of when it
    // arrived, but for replay (the AI's own connector took it once already).
    async verifySigned(signed, arrived) {
      const v = await verifyLakeData<Record<string, unknown>>(signed as LakeData<Record<string, unknown>>, { sandbox: x.o.sandbox, now: arrived });
      if (!v.ok) return { error: v.rejection.why };
      const c = (signed as LakeData).card, p = v.payload as Record<string, unknown>;
      const url = c.supportedInterfaces?.[0]?.url;
      return { from: { name: c.name, domain: v.profile.ownerDomain, webId: v.profile.webId, ...(url ? { url } : {}), key: await keyThumbprint(v.profile.publicJwk), checked: v.domainVia !== 'sandbox' }, text: typeof p.text === 'string' ? p.text : typeof p.body === 'string' ? p.body : '' };
    },
    async circleSend(tally, payload) {
      return (await send(tally, payload)).payload as Record<string, any>;
    },
    async recordCode(field) {
      const c = (await x.keeper().allClaims()).find((k) => k.field === field);
      return c ? String(c.code ?? c.value) : undefined;
    },
    async answerFromRecord(count) {
      // Which answer it is comes from the owner's record (SPEC §11.5), and goes only to tellers this house trusts.
      const c = (await x.keeper().allClaims()).find((k) => k.field === count.field);
      const mine = c ? String(c.code ?? c.value) : undefined;
      const cell = mine === undefined ? -1 : count.options.indexOf(mine);
      if (cell < 0) return { kind: 'refused', problems: [mine === undefined ? `your record holds no ${count.label}` : `what your record says isn't one of this count's answers`] };
      const tellers = await Promise.all([count.leader, count.helper].map(async (url) => ({ url, domain: (await verifyLakeCard((await (await fetch(cardUrlFor(url), { signal: AbortSignal.timeout(8000) })).json()) as AgentCard)).ownerDomain })));
      const sent = await x.keeper().answerCount(count.id, tellers, count.options.length, cell);
      if (sent !== true) return { kind: 'refused', problems: [sent] };
      x.note('count.answered', `You counted your ${count.label} into the secret count "${count.id}": it left your house only as two unreadable shares`);
      return { kind: 'count.answered', id: count.id };
    },
    async answerQuorum(tally, id, choice) {
      // A pledge's quorum (SPEC §11.4b): the owner's own answer ("I'm in if at least N are"), sent by this house as two
      // unreadable shares to the tellers the tally names, if this house trusts them; the tally learns only that this
      // person answered (one answer per person), and only the totals come out.
      const { payload: t, card } = await send(tally, { kind: 'tally.count', id });
      const q = t.quorum as { options: string[]; count: string; tellers: { url: string; domain: string }[] } | undefined;
      if (!q || t.state !== 'gathering') return { kind: 'refused', problems: [q ? `its quorum has closed (it is ${t.state})` : 'this pledge asks no quorum question'] };
      const cell = q.options.indexOf(choice);
      if (cell < 0) return { kind: 'refused', problems: [`choice: one of ${q.options.join(' | ')}`] };
      const counter = lakeProfile(card)!.webId;
      const person = await stampFor(await stamp(), countContext(counter, id), counter, id);
      if (!person) return { kind: 'refused', problems: ['This counts people, once each. Get a person stamp first: You, This phone, then About this house.'] };
      const { payload: joined } = await send(tally, { kind: 'tally.quorum', id, person });
      if (joined.kind !== 'tally.joined') return joined;
      const sent = await x.keeper().answerCount(q.count, q.tellers, q.options.length, cell);
      if (sent !== true) return { kind: 'refused', problems: [sent] };
      // Kept in the owner's wallet: the tally's word on how it went is taken only for a pledge they answered.
      const known = await owner.fetch(`${owner.podRoot}wallet/quorums.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []) as { tally: string; id: string }[];
      await put(owner, 'wallet/quorums.json', JSON.stringify([...known.slice(-199), { tally: counter, id, at: new Date().toISOString() }]), 'application/json').catch(() => {});
      x.note('pledge.quorum', `You answered the quorum question of the pledge "${id}" (${tally}) privately: it left your house only as two unreadable shares`);
      return { kind: 'quorum.answered', id, answered: joined.answered, closes: (t.quorum as { closes?: string }).closes };
    },
    async pledgeTerms(tally, id) {
      const { payload, card } = await send(tally, { kind: 'tally.count', id });
      return { ...payload, tally: lakeProfile(card)!.webId };
    },
    async signPledge(tally, id, contribution) {
      // Signed in the owner's own record, and the assistants told (run 39: Tom's assistant found no trace of his signature).
      const reply = await signPledgeAt(tally, id, contribution);
      if (reply.kind === 'tally.signed' || reply.kind === 'tally.triggered') {
        x.note('pledge.signed', `You signed the pledge "${id}" (${tally})${reply.kind === 'tally.triggered' ? ': it filled' : ''}`);
        x.desk().news({ about: 'pledge.signed', pledge: id, tally, at: new Date().toISOString(), ...(reply.kind === 'tally.triggered' ? { filled: true } : {}) });
      }
      return reply;
    },
    async withdrawPledge(tally, id) {
      // A blind signature is taken back with the secret only its signer holds (from a throwaway identity, so taking it back
      // says no more than signing did); a plain one, as the house. Either way, only before the pledge fills.
      const all = await blindPledges();
      const s = all.find((p) => p.tally === tally && p.id === id);
      const reply = s ? await withdrawBlind(tally, s, { sandbox: x.o.sandbox }) : (await send(tally, { kind: 'tally.withdraw', id })).payload as Record<string, any>;
      if (reply.kind === 'tally.withdrawn') {
        if (s) await put(owner, 'wallet/pledges.json', JSON.stringify(all.filter((p) => p !== s)), 'application/json');
        x.note('pledge.withdrawn', `You took your signature back from the pledge "${id}" (${tally})`);
        x.desk().news({ about: 'pledge.withdrawn', pledge: id, tally, at: new Date().toISOString() });
      }
      return reply;
    },
    async revealPledge(tally, id) {
      const s = (await blindPledges()).find((p) => p.tally === tally && p.id === id);
      if (!s) return { kind: 'refused', problems: ['this house has no blind signature on that pledge'] };
      return revealBlind(tally, async (url, payload) => (await send(url, payload)).payload as Record<string, any>, s);
    },
    async closeIntent(pack) { await x.keeper().market.close(pack); return { ok: true }; },
    acceptOffer: (id) => x.keeper().market.accept(id),
    offerPrice: (id) => x.keeper().market.priceOf(id),
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
