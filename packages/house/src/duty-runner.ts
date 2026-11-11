/**
 * The owner's AI on duty, run by the house itself (SPEC §6.1): the same runner as `lake duty` on a laptop, here in the
 * house's process, so it is as awake as the house. It signs in to the Lake's connector with the one-time code the owner's
 * signed grant made, like any AI on duty; the connector and this house hold it to the grant. What changes is only who holds
 * the model and who pays: the owner's own key, or the operator's model if the house offers one.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
export interface RunnerStatus { can: boolean; model: { provider: string; model?: string; whose: 'yours' | 'house' } | null; running: boolean; since?: string }

const parse = (s: string): ModelSpec | null => {
  const [provider, model] = s.split(':');
  return provider === 'stub' || provider === 'anthropic' ? { provider, ...(model ? { model } : {}) } : null;
};

export function houseRunner(o: HouseRunnerOptions) {
  const dir = join(o.dataDir, 'duty-house');
  const modelFile = join(o.dataDir, 'model.json'); // the owner's own model key: this house's data folder, mode 0600
  const onFile = join(dir, 'on.json');
  let stop: AbortController | null = null, since: string | undefined;
  const owners = async (): Promise<ModelSpec | null> => JSON.parse(await readFile(modelFile, 'utf8').catch(() => 'null')) as ModelSpec | null;
  const spec = async (): Promise<{ spec: ModelSpec; whose: 'yours' | 'house' } | null> => {
    const mine = await owners();
    if (mine) return { spec: mine, whose: 'yours' };
    const theirs = o.operatorModel ? parse(o.operatorModel) : null;
    return theirs ? { spec: theirs, whose: 'house' } : null;
  };
  const start = async (code?: string) => {
    const s = await spec();
    if (!s) throw new Error('no model connected: add your own, or this house offers none');
    stop?.abort();
    stop = new AbortController();
    since = new Date().toISOString();
    await mkdir(dir, { recursive: true });
    // A new grant starts a new sign-in (its code pairs a fresh agent); a restart resumes the one it has.
    if (code) await rm(dir, { recursive: true, force: true }).then(() => mkdir(dir, { recursive: true }));
    await writeFile(onFile, JSON.stringify({ since }));
    const signal = stop.signal;
    void runDuty({ lake: o.connector, house: o.house, code, agent: modelDriver(s.spec), state: dir, host: 'house', every: o.every ?? (Number(process.env.LAKE_DUTY_EVERY_MS) || 5 * 60_000), signal, log: (l) => o.log(`AI on duty: ${l}`) })
      .catch((e: Error) => o.log(`AI on duty stopped: ${e.message}`))
      .finally(() => { if (stop?.signal === signal) stop = null; });
  };
  return {
    async status(): Promise<RunnerStatus> {
      const s = await spec();
      return { can: !!s, model: s ? { provider: s.spec.provider, model: s.spec.provider === 'stub' ? undefined : (s.spec.model ?? DEFAULT_MODEL), whose: s.whose } : null, running: !!stop, ...(stop && since ? { since } : {}) };
    },
    /** The owner's own model (a key kept in this house's data folder), or null to remove it. */
    async setModel(m: ModelSpec | null) {
      if (!m) await rm(modelFile, { force: true });
      else { await writeFile(modelFile, JSON.stringify(m), { mode: 0o600 }); await chmod(modelFile, 0o600); }
      // The running AI picks up the change at its next start; with no model left, it stops.
      if (stop) { if (await spec()) await start(); else this.stop(); }
    },
    start,
    stop() { stop?.abort(); stop = null; void rm(onFile, { force: true }); },
    /** After a restart: back on duty if it was, with the sign-in it kept. */
    async resume() { if (await readFile(onFile, 'utf8').then(() => true, () => false) && (await spec())) await start().catch((e: Error) => o.log(`AI on duty didn't resume: ${e.message}`)); },
  };
}
export type HouseRunner = ReturnType<typeof houseRunner>;
