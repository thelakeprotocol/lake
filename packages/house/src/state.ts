/**
 * The house's own state files (its notes, agenda, tasks, who it has met). Each was written in place and read strictly:
 * a power cut or a kill mid-write left half a file, and the house then stopped at every start on the same line. A file
 * is now written beside itself and moved into place, so what is on disk is always a whole one, the old or the new; and
 * one that still doesn't read is set aside under another name, said in the log, and the house starts without it.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const writing = new Map<string, { next?: { text: string; mode?: number }; done: Promise<void> }>();

/** Saves `text` as the whole of `file`. Saves of one file go one after another; of those waiting, only the latest is written. */
export function saveWhole(file: string, text: string, mode?: number): Promise<void> {
  const w = writing.get(file);
  if (w) { w.next = { text, mode }; return w.done; }
  const now: { next?: { text: string; mode?: number }; done: Promise<void> } = { next: { text, mode }, done: Promise.resolve() };
  writing.set(file, now);
  now.done = (async () => {
    const tmp = `${file}.tmp`;
    // Whatever was asked for while a write ran is written next, the latest only.
    for (let n = now.next; n; n = now.next) {
      now.next = undefined;
      await writeFile(tmp, n.text, n.mode ? { mode: n.mode } : {}).then(() => rename(tmp, file)).catch(() => rm(tmp, { force: true }).catch(() => {}));
    }
    writing.delete(file);
  })();
  return now.done;
}

/** Reads a state file: `fallback` when there is none; one that doesn't parse is set aside as `<file>.unreadable`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadJson<T = any>(file: string, fallback: unknown, say: (msg: string) => void = (m) => console.error(m)): Promise<T> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return fallback as T;
  try { return JSON.parse(text) as T; } catch (e) {
    await rename(file, `${file}.unreadable`).catch(() => {});
    say(`WARNING: ${file} couldn't be read (${(e as Error).message}); it is kept as ${file}.unreadable and the house starts without it`);
    return fallback as T;
  }
}
