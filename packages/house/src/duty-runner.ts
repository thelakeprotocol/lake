/**
 * The owner's AI on duty, run by the house itself (SPEC §6.1): the same runner as `lake duty` on a laptop, here in the
 * house's process, so it is as awake as the house. It signs in to the Lake's connector with the one-time code the owner's
 * signed grant made, like any AI on duty; the connector and this house hold it to the grant. What changes is only who holds
 * the model and who pays: the owner's own key, or the operator's model if the house offers one.
 */
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelDriver, runDuty, DEFAULT_MODEL, type ModelSpec } from '@thelakeprotocol/agent';

export interface HouseRunnerOptions {
  dataDir: string;
  /** The Lake's MCP connector (where the AI on duty lives). */
  connector: string;
  /** This house's public address (the runner connects its AI to it). */
  house: string;
  /** A model the operator offers every house it hosts ("stub", "anthropic", "anthropic:<model id>"); none by default. */
  operatorModel?: string;
  /** How often it looks, in ms (default 5 minutes). */
  every?: number;
  log: (line: string) => void;
}

/** What the owner sees: whose model, which, and whether it's running. Never the key. */
export interface RunnerStatus { can: boolean; model: { provider: string; model?: string; whose: 'yours' | 'house' } | null; running: boolean; since?: string; lastError?: string }

const parse = (s: string): ModelSpec | null => {
  const [provider, model] = s.split(':');
  return provider === 'stub' || provider === 'anthropic' ? { provider, ...(model ? { model } : {}) } : null;
};

export function houseRunner(o: HouseRunnerOptions) {
  const dir = join(o.dataDir, 'duty-house');
  const modelFile = join(o.dataDir, 'model.json'); // the owner's own model key: this house's data folder, mode 0600
  const onFile = join(dir, 'on.json');
  // The day's runs and tokens, one set for every start (round 8: each restart had reset the caps), saved beside on.json.
  const counters: { runs: number[]; spent: [number, number][] } = { runs: [], spent: [] };
  let stop: AbortController | null = null, loop: Promise<void> | null = null, since: string | undefined, lastError: string | undefined;
  const owners = async (): Promise<ModelSpec | null> => JSON.parse(await readFile(modelFile, 'utf8').catch(() => 'null')) as ModelSpec | null;
  const spec = async (): Promise<{ spec: ModelSpec; whose: 'yours' | 'house' } | null> => {
    const mine = await owners();
    if (mine) return { spec: mine, whose: 'yours' };
    const theirs = o.operatorModel ? parse(o.operatorModel) : null;
    return theirs ? { spec: theirs, whose: 'house' } : null;
  };
  const day = () => Date.now() - 24 * 3_600_000;
  const saveOn = () => writeFile(onFile, JSON.stringify({ since, runs: counters.runs.filter((t) => t > day()), spent: counters.spent.filter(([t]) => t > day()) })).catch(() => {});
  /** Stops the loop and waits for it (an in-flight model run stops at its next step), so two never share a sign-in. */
  const halt = async () => {
    stop?.abort();
    stop = null;
    const was = loop;
    loop = null;
    if (was) await Promise.race([was, new Promise((r) => setTimeout(r, 30_000))]);
  };
  /** Starts it, and answers once it has signed in and connected (or with why it couldn't). */
  const start = async (code?: string) => {
    const s = await spec();
    if (!s) throw new Error('no model connected: add your own, or this house offers none');
    await halt();
    await mkdir(dir, { recursive: true });
    // A new grant starts a new sign-in (its code pairs a fresh agent); a restart resumes the one it has.
    if (code) for (const f of await readdir(dir)) if (f.startsWith('duty-') && f.endsWith('.json')) await rm(join(dir, f), { force: true });
    const saved = JSON.parse(await readFile(onFile, 'utf8').catch(() => '{}')) as { runs?: number[]; spent?: [number, number][] };
    if (!counters.runs.length && saved.runs) counters.runs.push(...saved.runs);
    if (!counters.spent.length && saved.spent) counters.spent.push(...saved.spent);
    const ctl = new AbortController();
    stop = ctl;
    since = new Date().toISOString();
    lastError = undefined;
    let ok!: () => void, fail!: (e: Error) => void;
    const signedIn = new Promise<void>((y, n) => { ok = y; fail = n; });
    loop = runDuty({ lake: o.connector, house: o.house, code, agent: modelDriver(s.spec), state: dir, host: 'house', every: o.every ?? (Number(process.env.LAKE_DUTY_EVERY_MS) || 5 * 60_000), signal: ctl.signal, counters, ready: () => ok(), log: (l) => { o.log(`AI on duty: ${l.startsWith('run done') ? l.replace(/\):.*$/s, ')') : l}`); if (/^run done|^run \d/.test(l)) void saveOn(); } })
      .catch((e: Error) => { lastError = e.message; o.log(`AI on duty stopped: ${e.message}`); fail(e); })
      .finally(() => { if (stop === ctl) stop = null; });
    await Promise.race([signedIn, new Promise<void>((_, n) => setTimeout(() => n(new Error('the AI on duty did not sign in within 30 seconds')), 30_000))])
      .catch(async (e: Error) => { await halt(); throw e; });
    await saveOn();
  };
  return {
    async status(): Promise<RunnerStatus> {
      const s = await spec();
      return { can: !!s, model: s ? { provider: s.spec.provider, model: s.spec.provider === 'stub' ? undefined : (s.spec.model ?? DEFAULT_MODEL), whose: s.whose } : null, running: !!stop, ...(stop && since ? { since } : {}), ...(lastError ? { lastError } : {}) };
    },
    /** The owner's own model (a key kept in this house's data folder), or null to remove it. */
    async setModel(m: ModelSpec | null) {
      if (!m) await rm(modelFile, { force: true });
      else { await writeFile(modelFile, JSON.stringify(m), { mode: 0o600 }); await chmod(modelFile, 0o600); }
      // The running AI picks up the change at its next start; with no model left, it stops.
      if (stop) { if (await spec()) await start(); else await this.stop(); }
    },
    start,
    async stop() { await halt(); await rm(onFile, { force: true }); },
    /** A house handed back (a sandbox lease ending): the next owner gets none of this one's key, sign-in or counts. */
    async forget() { await halt(); await rm(modelFile, { force: true }); await rm(dir, { recursive: true, force: true }); counters.runs.length = 0; counters.spent.length = 0; },
    /** After a restart: back on duty if it was, with the sign-in it kept. */
    async resume() { if (await readFile(onFile, 'utf8').then(() => true, () => false) && (await spec())) await start().catch((e: Error) => o.log(`AI on duty didn't resume: ${e.message}`)); },
  };
}
export type HouseRunner = ReturnType<typeof houseRunner>;
