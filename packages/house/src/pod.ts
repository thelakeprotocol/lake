import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { Session } from '@inrupt/solid-client-authn-node';

export interface PodOptions {
  /** Where the pod's files and the house's local secrets live. */
  dataDir: string;
  port: number;
  /** Public base URL of the pod server, with trailing slash. */
  baseUrl: string;
  /** Pod name: the owner's handle. */
  owner: string;
  log?: (msg: string) => void;
}

export interface OwnerSession {
  webId: string;
  podRoot: string;
  fetch: typeof fetch;
}

interface Secrets {
  /** The pod URL this house was created under; WebIDs bake it in. */
  baseUrl: string;
  email: string;
  password: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Runs a Community Solid Server (file backend) as a child process, with the owner's account
 * and pod seeded on first start. Any Solid server would do; this one is open source and local.
 */
export async function startPod(o: PodOptions): Promise<{ proc: ChildProcess; stop: () => void }> {
  const secrets = await loadSecrets(o);
  return startPodServer({ ...o, seed: [{ email: secrets.email, password: secrets.password, pods: [{ name: o.owner }] }] });
}

/** Runs the pod server with these accounts and pods seeded on first start. */
async function startPodServer(o: { dataDir: string; port: number; baseUrl: string; seed: { email: string; password: string; pods: { name: string }[] }[] }) {
  await assertPortFree(o.port);
  await mkdir(o.dataDir, { recursive: true });
  const seed = join(o.dataDir, 'seed.json');
  await writeFile(seed, JSON.stringify(o.seed), { mode: 0o600 });
  const bin = join(dirname(createRequire(import.meta.url).resolve('@solid/community-server/package.json')), 'bin', 'server.js');
  const proc = spawn(process.execPath, [bin, '-c', '@css:config/file.json', '-f', join(o.dataDir, 'pod'), '-p', String(o.port), '-b', o.baseUrl, '--seedConfig', seed, '-l', 'warn'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // CSS's OIDC provider fails discovery under NODE_ENV=test; the pod server always runs as production.
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const tail: string[] = [];
  const keep = (b: Buffer) => { tail.push(b.toString()); if (tail.length > 40) tail.shift(); };
  proc.stdout!.on('data', keep);
  proc.stderr!.on('data', keep);
  // The pod server must never outlive its house, even when the house crashes.
  const reap = () => proc.kill('SIGTERM');
  process.once('exit', reap);
  for (const sig of ['uncaughtException', 'unhandledRejection'] as const) {
    process.once(sig, (e) => { reap(); console.error(e); process.exit(1); });
  }
  const died = new Promise<never>((_, reject) => proc.once('exit', (code) => reject(new Error(`pod server exited (${code}):\n${tail.join('')}`))));
  // Seeding takes longer with more pods, and much longer on a busy machine.
  const pods = o.seed.reduce((n, a) => n + a.pods.length, 0);
  await Promise.race([waitFor(`${o.baseUrl}.account/`, 90_000 + pods * 2_000), died]);
  return { proc, stop: () => proc.kill('SIGTERM') };
}

/**
 * Hosting mode: one pod server, one administering account, many pods, like a pod provider. Each pod
 * still has its own WebID and its own client credentials; only the process and the account are shared.
 */
export async function startProvider(o: { dataDir: string; port: number; baseUrl: string; names: string[] }) {
  const s = await loadProviderSecrets(o);
  return startPodServer({ ...o, seed: [{ email: s.email, password: s.password, pods: o.names.map((name) => ({ name })) }] });
}

interface ProviderSecrets { baseUrl: string; email: string; password: string; clients: Record<string, { id: string; secret: string }> }

/** Logs every hosted house in as its own WebID. One password login for the batch; then one token login each. */
export async function tenantSessions(o: { dataDir: string; baseUrl: string; names: string[]; concurrency?: number }): Promise<Map<string, OwnerSession>> {
  const s = await loadProviderSecrets(o);
  const need = o.names.filter((n) => !s.clients[n]);
  if (need.length) {
    const { auth, controls } = await accountLogin(o.baseUrl, s);
    // The pod server makes pods from its seed only the first time it starts; houses added later get theirs here.
    const pods = Object.keys((await json(await fetch(controls.account.pod, { headers: { authorization: auth } }))).pods ?? {});
    for (const name of need.filter((n) => !pods.includes(`${o.baseUrl}${n}/`))) {
      await json(await fetch(controls.account.pod, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ name }) }));
    }
    await pool(need, o.concurrency ?? 16, async (name) => {
      const c = await createClient(controls, auth, `${o.baseUrl}${name}/profile/card#me`, `housekeeper-${name}`);
      s.clients[name] = { id: c.id, secret: c.secret };
    });
    await writeFile(join(o.dataDir, 'provider-secrets.json'), JSON.stringify(s), { mode: 0o600 });
  }
  const out = new Map<string, OwnerSession>();
  await pool(o.names, o.concurrency ?? 16, async (name) => {
    const fetch = await sessionFetch(o.baseUrl, { clientId: s.clients[name]!.id, clientSecret: s.clients[name]!.secret });
    out.set(name, { webId: `${o.baseUrl}${name}/profile/card#me`, podRoot: `${o.baseUrl}${name}/`, fetch });
  });
  return out;
}

async function loadProviderSecrets(o: { dataDir: string; baseUrl: string }): Promise<ProviderSecrets> {
  const path = join(o.dataDir, 'provider-secrets.json');
  try {
    const s = JSON.parse(await readFile(path, 'utf8')) as ProviderSecrets;
    if (s.baseUrl !== o.baseUrl) throw new Error(`hosted houses in ${o.dataDir} were created for ${s.baseUrl}, not ${o.baseUrl}`);
    return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const s: ProviderSecrets = { baseUrl: o.baseUrl, email: 'provider@house.lake.local', password: randomBytes(24).toString('base64url'), clients: {} };
    await mkdir(o.dataDir, { recursive: true });
    await writeFile(path, JSON.stringify(s), { mode: 0o600 });
    return s;
  }
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/** Logs in as the owner with client credentials (minted once through the CSS account API). */
export async function ownerSession(o: PodOptions): Promise<OwnerSession> {
  const secrets = await loadSecrets(o);
  const webId = `${o.baseUrl}${o.owner}/profile/card#me`;
  if (!secrets.clientId) {
    const { auth, controls } = await accountLogin(o.baseUrl, secrets);
    const { id, secret } = await createClient(controls, auth, webId, 'housekeeper');
    secrets.clientId = id;
    secrets.clientSecret = secret;
    await saveSecrets(o, secrets);
  }
  return { webId, podRoot: `${o.baseUrl}${o.owner}/`, fetch: await sessionFetch(o.baseUrl, { clientId: secrets.clientId!, clientSecret: secrets.clientSecret! }) };
}

/** An authenticated fetch for one WebID's client credentials (DPoP), logging in again when a token expires. */
async function sessionFetch(baseUrl: string, c: { clientId: string; clientSecret: string }): Promise<typeof fetch> {
  const login = async () => {
    const session = new Session();
    await session.login({ ...c, oidcIssuer: baseUrl, tokenType: 'DPoP' });
    if (!session.info.isLoggedIn) throw new Error('owner login failed');
    return session;
  };
  let session = await login();
  return async (input, init) => {
    let res = await session.fetch(input as string, init);
    if (res.status === 401) {
      session = await login();
      res = await session.fetch(input as string, init);
    }
    return res;
  };
}

const json = async (r: Response) => {
  if (!r.ok) throw new Error(`account API ${r.url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<any>;
};

async function accountLogin(baseUrl: string, s: { email: string; password: string }) {
  const index = await json(await fetch(`${baseUrl}.account/`));
  const { authorization } = await json(
    await fetch(index.controls.password.login, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: s.email, password: s.password }) }),
  );
  const auth = `CSS-Account-Token ${authorization}`;
  const controls = (await json(await fetch(`${baseUrl}.account/`, { headers: { authorization: auth } }))).controls;
  return { auth, controls };
}

async function createClient(controls: any, auth: string, webId: string, name: string): Promise<{ id: string; secret: string }> {
  return json(
    await fetch(controls.account.clientCredentials, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ name, webId }) }),
  );
}

const secretsPath = (o: PodOptions) => join(o.dataDir, 'house-secrets.json');

async function loadSecrets(o: PodOptions): Promise<Secrets> {
  try {
    const s = JSON.parse(await readFile(secretsPath(o), 'utf8')) as Secrets;
    if (s.baseUrl !== o.baseUrl) {
      throw new Error(`this house's data was created for ${s.baseUrl}, not ${o.baseUrl}. WebIDs include the pod URL, so start it with --pod-url ${s.baseUrl} or use a fresh --data folder`);
    }
    return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const s = { baseUrl: o.baseUrl, email: `${o.owner}@house.lake.local`, password: randomBytes(24).toString('base64url') };
    await saveSecrets(o, s);
    return s;
  }
}

async function saveSecrets(o: PodOptions, s: Secrets) {
  await mkdir(o.dataDir, { recursive: true });
  await writeFile(secretsPath(o), JSON.stringify(s), { mode: 0o600 });
}

async function waitFor(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`pod server did not start at ${url}`);
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const srv = createServer()
      .once('error', () => fail(new Error(`port ${port} is already in use; pick another with --pod-port`)))
      .once('listening', () => srv.close(() => ok()))
      .listen(port);
  });
}
