import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A house as big as a real one that has been on the sandbox a while (18 Nov: the owner kept finding pages that loaded
// for ever on theirs, while every test ran on a small house). Its pod is filled on disk, the way the pod server keeps it,
// from one real file of each kind (fixtures/big-house, taken from the sandbox's demo house: synthetic data) with new ids,
// dates spread over four months, and a few requesters and amounts. The house's own caches are left empty, so its first
// look costs what it costs on a real house.

const dir = new URL('./fixtures/big-house/', import.meta.url).pathname;
const REQUESTERS = ['open-science.example', 'gp.example', 'clinic.example', 'uni.example', 'health-survey.example'];
const QUESTIONS = ['Do over-60s on drug X get readmitted less?', 'Are people with heart failure on drug Y readmitted more?', 'Do over-50s on drug Z end up back in hospital?', 'Diabetes and drug X: more readmissions?'];
const DAY = 86_400_000;

/** The pod's folder on disk: the one holding receipts/, agreements/ and audit/ under the house's data folder. */
export async function podFolder(houseData: string): Promise<string> {
  for (const e of await readdir(houseData, { recursive: true, withFileTypes: true })) if (e.isDirectory() && e.name === 'receipts') return e.parentPath ?? (e as unknown as { path: string }).path;
  throw new Error(`no pod with a receipts folder under ${houseData}`);
}

export async function seedBigHouse(o: { pod: string; owner: string; house: string; payments: string; consents: number; receipts: number; audits: number; today?: number }) {
  const tpl = Object.fromEntries(await Promise.all(['agreement', 'consent', 'receipt', 'study', 'audit'].map(async (k) => [k, await readFile(join(dir, `${k}.json`), 'utf8')] as const)));
  const fill = (t: string, v: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => v[k] ?? '');
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  for (const f of ['agreements', 'receipts', 'audit']) await mkdir(join(o.pod, f), { recursive: true });
  const files: [string, string][] = [];
  const now = Date.now();
  // Today's few fall after midnight (20 Nov: run at 00:30, the newest were spread over three hours, all of them yesterday).
  const today = Math.max(120_000, Math.min(3 * 3_600_000, now - new Date(now).setHours(0, 0, 0, 0) - 60_000));
  for (let i = 0; i < o.consents; i++) {
    const offer = randomUUID(), domain = REQUESTERS[i % REQUESTERS.length]!;
    // The newest few today (what Today and Money's "today" count), the rest over four months.
    const at = i < (o.today ?? 20) ? now - randomInt(60_000, today) : now - randomInt(DAY, 120 * DAY);
    const v = { OFFER: offer, OWNER: o.owner, HOUSE: o.house, PAYMENTS: o.payments, N: String(i), SUFFIX: 'WLSHPizOwjIA', DOMAIN: domain, VALID: `${new Date(at).toISOString()}/${new Date(at + 2 * DAY).toISOString()}`, AT: new Date(at + 60_000).toISOString(), AMOUNT: String(randomInt(1, 10)), PAYER: `https://${domain}/#agent`, PAYER_NAME: `Research agent (${domain})` };
    files.push([`agreements/${offer}.consent.jsonld$.json`, fill(tpl.consent!, v)], [`agreements/${offer}.agreement.json`, fill(tpl.agreement!, v)]);
    if (i < o.receipts) {
      files.push([`agreements/${offer}.study.json`, fill(tpl.study!, v).replace(QUESTIONS[0]!, QUESTIONS[i % QUESTIONS.length]!)]);
      // Signed by the payments agent in a real run; the house reads a receipt's payload and checks it when it arrives,
      // not when it reads the folder, so a placeholder signature costs the same to read.
      const payload = JSON.stringify(JSON.parse(fill(tpl.receipt!, v)));
      files.push([`receipts/${offer}-WLSHPizOwjIA.receipt.jwt$.txt`, `${b64(JSON.stringify({ alg: 'EdDSA', typ: 'vc+jwt' }))}.${b64(payload)}.${randomBytes(64).toString('base64url')}`]);
    }
  }
  for (let i = 0; i < o.audits; i++) {
    const at = now - randomInt(60_000, 120 * DAY), domain = REQUESTERS[i % REQUESTERS.length]!;
    files.push([`audit/${at}-${randomBytes(8).toString('base64url')}.json`, fill(tpl.audit!, { AT: new Date(at).toISOString(), DOMAIN: domain }).replace(QUESTIONS[0]!, QUESTIONS[i % QUESTIONS.length]!)]);
  }
  for (let i = 0; i < files.length; i += 64) await Promise.all(files.slice(i, i + 64).map(([f, body]) => writeFile(join(o.pod, f), body)));
  return files.length;
}
