import { Parser } from 'n3';
import type { LakePack } from '@thelakeprotocol/core';
import type { OwnerSession } from './pod.js';

const SOLID = 'http://www.w3.org/ns/solid/terms#';

/**
 * Where each pack's data lives in this pod, the Solid way: the owner's private Type Index (linked from
 * their WebID profile) maps a class to a container. Any Solid app can find the data the same way. A pack
 * not registered yet gets its default folder, registered. If the profile can't be changed (it lives on
 * another server), the index still sits in the pod, at settings/privateTypeIndex.ttl.
 */
export async function packFolders(owner: OwnerSession, list: LakePack[], log?: (msg: string) => void): Promise<Map<string, string>> {
  const out = new Map<string, string>(list.map((p) => [p.id, p.folder]));
  try {
    const index = await findIndex(owner) ?? await createIndex(owner, log);
    const quads = await readTurtle(owner, index);
    const registered = new Map<string, string>();
    const byNode = new Map<string, { forClass?: string; container?: string }>();
    for (const q of quads) {
      const n = byNode.get(q.subject.value) ?? {};
      if (q.predicate.value === `${SOLID}forClass`) n.forClass = q.object.value;
      if (q.predicate.value === `${SOLID}instanceContainer`) n.container = q.object.value;
      byNode.set(q.subject.value, n);
    }
    for (const n of byNode.values()) if (n.forClass && n.container?.startsWith(owner.podRoot)) registered.set(n.forClass, n.container.slice(owner.podRoot.length));
    const missing: LakePack[] = [];
    for (const p of list) {
      const at = registered.get(p.recordClass);
      if (at) out.set(p.id, at.endsWith('/') ? at : `${at}/`);
      else missing.push(p);
    }
    if (missing.length) {
      const triples = missing.map((p) => `<#${p.id}> a solid:TypeRegistration; solid:forClass <${p.recordClass}>; solid:instanceContainer <${owner.podRoot}${p.folder}>.`).join('\n');
      await patch(owner, index, triples);
    }
  } catch (e) {
    log?.(`type index unavailable (${(e as Error).message}); using each pack's default folder`);
  }
  return out;
}

async function findIndex(owner: OwnerSession): Promise<string | null> {
  const profile = owner.webId.split('#')[0]!;
  for (const q of await readTurtle(owner, profile).catch(() => [])) {
    if (q.subject.value === owner.webId && q.predicate.value === `${SOLID}privateTypeIndex`) return q.object.value;
  }
  return null;
}

async function createIndex(owner: OwnerSession, log?: (msg: string) => void): Promise<string> {
  const index = `${owner.podRoot}settings/privateTypeIndex.ttl`;
  const res = await owner.fetch(index, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: `@prefix solid: <${SOLID}>.\n<> a solid:TypeIndex, solid:UnlistedDocument.\n` });
  if (!res.ok) throw new Error(`could not create ${index}: ${res.status}`);
  // Link it from the profile, so other Solid apps find it too.
  try {
    await patch(owner, owner.webId.split('#')[0]!, `<${owner.webId}> solid:privateTypeIndex <${index}>.`);
  } catch (e) {
    log?.(`could not link the type index from the profile (${(e as Error).message}); it stays at settings/privateTypeIndex.ttl`);
  }
  return index;
}

/** Solid N3 Patch: insert triples into a document. */
async function patch(owner: OwnerSession, url: string, triples: string) {
  const body = `@prefix solid: <${SOLID}>.\n_:patch a solid:InsertDeletePatch; solid:inserts { ${triples} }.`;
  const res = await owner.fetch(url, { method: 'PATCH', headers: { 'content-type': 'text/n3' }, body });
  if (!res.ok) throw new Error(`PATCH ${url}: ${res.status}`);
}

async function readTurtle(owner: OwnerSession, url: string) {
  const res = await owner.fetch(url, { headers: { accept: 'text/turtle' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Parser({ baseIRI: url }).parse(await res.text());
}
