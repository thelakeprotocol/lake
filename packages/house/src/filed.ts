import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { Parser } from 'n3';
import type { OwnerSession } from './pod.js';

const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
// One listing at a time in this process. Hosted houses share one pod server, and right after the deploy that brought
// this index (none written yet) ten houses listed at once and took it past its heap, again at each restart (13 Nov).
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T>(fn: () => Promise<T>): Promise<T> => { const p = turn.then(fn, fn); turn = p.catch(() => {}); return p; };

/**
 * The names in the pod's folders that only grow (agreements, receipts, the log), kept beside the house so those folders
 * aren't listed again and again. A Solid server builds a listing from every file in the folder: at ten thousand
 * agreements one listing took the pod server three seconds and 150 MB, and the sandbox's was killed at its memory limit
 * four times in a week (12 Nov). The house files these itself, through the session this returns, so it notes each name
 * as it is written or deleted. A folder is listed once, the first time it's asked for; the pod stays the record, and
 * removing the index file makes the house list again.
 */
export async function filedIndex(pod: OwnerSession, file: string, folders: string[], o: { retryMs?: number } = {}) {
  // A file cut short (the power went) is no index: the house lists again.
  const saved = await readFile(file, 'utf8').then((t) => JSON.parse(t), () => ({})).catch(() => ({})) as Record<string, { listed?: boolean; names?: string[] }>;
  const known = new Map(folders.map((f) => [f, { listed: !!saved[f]?.listed, names: new Set(saved[f]?.names ?? []), listing: null as Promise<void> | null, failedAt: 0 }]));
  const changed: ((path: string) => void)[] = [];
  let saving: ReturnType<typeof setTimeout> | undefined;
  const write = async () => {
    // Written whole and renamed into place, so a crash mid-write never leaves half a file.
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries([...known].map(([f, k]) => [f, { listed: k.listed, names: [...k.names] }])))).then(() => rename(tmp, file)).catch(() => rm(tmp, { force: true }).catch(() => {}));
  };
  const save = () => { clearTimeout(saving); saving = setTimeout(() => void write(), 2000); saving.unref?.(); };
  /** The folder a path is filed in, when it's one of ours and the path is a file right in it. */
  const folderOf = (path: string) => folders.find((f) => path.startsWith(f) && path.length > f.length && !path.slice(f.length).includes('/'));
  const fetchNoting = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await pod.fetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (res.ok && (method === 'PUT' || method === 'DELETE') && url.startsWith(pod.podRoot)) {
      const path = url.slice(pod.podRoot.length).split(/[?#]/)[0]!;
      const k = known.get(folderOf(path) ?? '');
      if (k) {
        const had = k.names.has(path);
        if (method === 'PUT') k.names.add(path); else k.names.delete(path);
        if (had !== k.names.has(path)) save();
        for (const fn of changed) fn(path);
      }
    }
    return res;
  }) as typeof fetch;
  return {
    /** The same pod, with what is filed in these folders noted on the way. */
    session: { ...pod, fetch: fetchNoting } as OwnerSession,
    /** A folder's files, as paths from the pod's root. Listed from the pod once; a listing that fails gives what is known and is tried again later. */
    async list(folder: string): Promise<string[]> {
      const k = known.get(folder);
      if (!k) throw new Error(`${folder} isn't indexed`);
      if (!k.listed && Date.now() - k.failedAt >= (o.retryMs ?? 10 * 60_000)) {
        await (k.listing ??= inTurn(async () => {
          const res = await pod.fetch(pod.podRoot + folder, { headers: { accept: 'text/turtle' } }).catch(() => null);
          if (!res?.ok) { k.failedAt = Date.now(); return; }
          for (const q of new Parser({ baseIRI: pod.podRoot + folder }).parse(await res.text())) {
            if (q.predicate.value === LDP_CONTAINS && !q.object.value.endsWith('/')) k.names.add(q.object.value.slice(pod.podRoot.length));
          }
          k.listed = true;
          save();
        }).finally(() => { k.listing = null; }));
      }
      return [...k.names];
    },
    /** Whether the folder has been listed from the pod (before that, `list` gives only what this house filed since). */
    listed: (folder: string) => !!known.get(folder)?.listed,
    /** Called with the path of each file written or deleted in these folders (what was read of it is stale). */
    onChange(fn: (path: string) => void) { changed.push(fn); },
    /** Writes the index now (tests, and a house that's stopping). */
    flush: async () => { clearTimeout(saving); await write(); },
  };
}

export type Filed = Awaited<ReturnType<typeof filedIndex>>;
