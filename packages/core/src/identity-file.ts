import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { exportIdentity, generateIdentity, importIdentity, type Identity } from './crypto.js';

/** Loads a signing identity from disk, or creates one (file mode 0600). */
export async function loadOrCreateIdentity(path: string): Promise<Identity> {
  try {
    return await importIdentity(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    const id = await generateIdentity();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(await exportIdentity(id)), { mode: 0o600 });
    return id;
  }
}
