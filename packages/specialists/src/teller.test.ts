import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCard, generateIdentity, sendLake, shardAnswer, signCard, signMessage, studyId, unshardCounts, verifyLakeData, type AgentCard, type Identity, type LakeData, type Study } from '@thelakeprotocol/core';
import { createTeller } from './teller.js';

type Agent = { id: Identity; card: AgentCard; webId: string };
const agent = async (domain: string): Promise<Agent> => {
  const id = await generateIdentity();
  const webId = `https://${domain}/#agent`;
  return { id, webId, card: await signCard(buildCard({ name: domain, description: 'x', url: `https://${domain}/a2a`, skills: [], profile: { role: 'visitor', webId, ownerDomain: domain, tags: [] } }, id), id) };
};
const listen = (app: express.Express) => new Promise<{ server: Server; url: string }>((ok) => { const server = app.listen(0, () => ok({ server, url: `http://localhost:${(server.address() as { port: number }).port}` })); });
const ask = async (url: string, from: Agent, payload: Record<string, unknown>) => {
  const reply = await sendLake(url, { lake: '0.1', card: from.card, envelope: (await signMessage(payload, from.id, { iss: from.webId })) as LakeData['envelope'] }, { me: from.id });
  const v = await verifyLakeData<Record<string, any>>(reply as LakeData<Record<string, any>>, { sandbox: true });
  if (!v.ok) throw new Error(v.rejection.why);
  return v.payload;
};

let dir: string;
const servers: Server[] = [];
let a: string, b: string;
let researcher: Agent;
let houses: Agent[];
// A study as a teller reads it: how many yes/no parts, the two tellers, the fewest houses, the noise. It loads no pack.
const study = (over: Partial<Study['privacy']> = {}, question = 'Do walkers sleep better?'): Study => ({
  v: 1, question, kind: 'contingency',
  predicates: [{ name: 'walks', field: 'steps', op: 'at_least', value: 8000 }, { name: 'sleeps', field: 'sleep', op: 'present' }],
  privacy: { mechanism: 'dap-prio3', tellers: [{ url: a, domain: 'teller-a.example' }, { url: b, domain: 'teller-b.example' }], min: 4, ...over },
  minTier: 'issuer-signed',
});
const deadline = () => new Date(Date.now() + 3_600_000).toISOString();
// One house's answer, as it sends it: a share for each teller, naming the study when it answers one.
const report = async (count: string, house: Agent, cell: number, named?: string) => {
  const r = await shardAnswer(4, cell);
  return Promise.all([a, b].map((url, i) => ask(url, house, { kind: 'count.report', id: count, ...(named ? { study: named } : {}), reportId: r.reportId, publicShare: r.publicShare, share: r.shares[i] })));
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lake-teller-'));
  for (const name of ['A', 'B']) {
    const app = express();
    const l = await listen(app);
    servers.push(l.server);
    const teller = await createTeller({ id: await generateIdentity(), url: l.url, domain: `teller-${name.toLowerCase()}.example`, sandbox: true, dataDir: dir, name: `Teller ${name}` });
    app.use(teller.app);
    if (name === 'A') a = `${l.url}/a2a`; else b = `${l.url}/a2a`;
  }
  researcher = await agent('uni.example');
  houses = await Promise.all([1, 2, 3, 4, 5].map((i) => agent(`house-${i}.example`)));
});

afterAll(async () => {
  servers.forEach((s) => s.close());
  await rm(dir, { recursive: true, force: true });
});

describe('a count for a study is held to the study (SPEC §7, §11.5)', () => {
  it('takes its size, minimum, noise and Helper from the study, and refuses looser ones from the opener', async () => {
    const s = study({ noise: { epsilon: 1 } });
    // Opened with nothing but the study: the numbers are the study's.
    expect(await ask(a, researcher, { kind: 'count.open', id: 'bound-1', deadline: deadline(), study: s })).toMatchObject({ kind: 'count.opened', study: studyId(s), length: 4, min: 4, noise: { epsilon: 1 }, helper: 'teller-b.example' });
    // The same numbers passed beside it (an older client) are fine; a smaller minimum or no noise is refused.
    expect(await ask(a, researcher, { kind: 'count.open', id: 'bound-2', deadline: deadline(), study: s, length: 4, min: 4, noise: { epsilon: 1 }, helper: s.privacy.tellers[1] })).toMatchObject({ kind: 'count.opened', min: 4 });
    expect((await ask(a, researcher, { kind: 'count.open', id: 'loose-1', deadline: deadline(), study: s, min: 3 })).problems).toEqual(['min: the study says 4']);
    expect((await ask(a, researcher, { kind: 'count.open', id: 'loose-2', deadline: deadline(), study: s, noise: { epsilon: 9 } })).problems).toEqual(['noise: the study says epsilon 1']);
    expect((await ask(a, researcher, { kind: 'count.open', id: 'loose-3', deadline: deadline(), study: study(), noise: { epsilon: 1 } })).problems).toEqual(['noise: the study says none']);
    // The Leader is the first teller the study names, and its Helper the second.
    expect((await ask(b, researcher, { kind: 'count.open', id: 'swapped', deadline: deadline(), study: s })).problems?.[0]).toMatch(/names teller-a.example as its Leader/);
    expect((await ask(a, researcher, { kind: 'count.open', id: 'other-helper', deadline: deadline(), study: s, helper: { url: 'http://localhost:1/a2a', domain: 'elsewhere.example' } })).problems).toEqual(['helper: the study names teller-b.example']);
    // A study that asks for fewer houses than this teller's floor (3 on a sandbox) opens no count.
    expect((await ask(a, researcher, { kind: 'count.open', id: 'small', deadline: deadline(), study: study({ min: 2 }) })).problems?.[0]).toMatch(/the study says 2, and this teller publishes nothing from fewer than 3/);
    // Something that isn't a study opens nothing.
    expect((await ask(a, researcher, { kind: 'count.open', id: 'not-one', deadline: deadline(), study: { question: 'x' } })).kind).toBe('refused');
  });

  it('the Helper reads the study too: a Leader can\'t set the count up looser', async () => {
    const s = study();
    const setup = { kind: 'count.setup', id: 'helper-1', deadline: deadline(), verifyKey: 'k', opener: researcher.webId, study: s, leader: { url: a, domain: 'teller-a.example' } };
    expect((await ask(b, researcher, { ...setup, length: 4, min: 3 })).problems).toEqual(['min: the study says 4']);
    expect((await ask(b, researcher, { ...setup, length: 4, min: 4, leader: { url: 'http://localhost:1/a2a', domain: 'elsewhere.example' } })).problems).toEqual(['study: it names teller-a.example as its Leader']);
    expect((await ask(a, researcher, { ...setup, leader: { url: b, domain: 'teller-b.example' } })).problems?.[0]).toMatch(/names teller-b.example as its Helper/);
  });

  it('an answer to a study goes only into that study\'s count', async () => {
    const s = study();
    const other = study({}, 'Do sleepers walk more?');
    await ask(a, researcher, { kind: 'count.open', id: 'plain', length: 4, min: 3, deadline: deadline(), helper: s.privacy.tellers[1] });
    await ask(a, researcher, { kind: 'count.open', id: 'for-other', deadline: deadline(), study: other });
    await ask(a, researcher, { kind: 'count.open', id: 'for-study', deadline: deadline(), study: s });
    // The house agreed to `s`, with its minimum of 4. A count opened without it (min 3) doesn't get its answer...
    for (const r of await report('plain', houses[0]!, 1, studyId(s))) expect(r.problems).toEqual(['this count was not opened for a study: its minimum and noise are not that study\'s']);
    // ...nor does another study's count, nor does this study's count take an answer that names none.
    for (const r of await report('for-other', houses[0]!, 1, studyId(s))) expect(r.problems).toEqual(['this count was opened for another study']);
    for (const r of await report('for-study', houses[0]!, 1)) expect(r.problems?.[0]).toMatch(/this count is for a study: name it/);
    // Its own count takes it, and each teller says what the count is held to.
    for (const r of await report('for-study', houses[0]!, 1, studyId(s))) expect(r).toMatchObject({ kind: 'count.received', study: studyId(s), min: 4 });
    // A count for anything else (a vote) works as before, and says nothing about a study.
    for (const r of await report('plain', houses[0]!, 1)) { expect(r.kind).toBe('count.received'); expect(r.study).toBeUndefined(); }
  });

  it('publishes only from the study\'s minimum, and each share says what it was held to', async () => {
    const s = study({}, 'Do walkers sleep better, asked again?');
    await ask(a, researcher, { kind: 'count.open', id: 'run', deadline: deadline(), study: s });
    const cells = [0, 1, 1, 3];
    for (const [i, cell] of cells.entries()) await report('run', houses[i]!, cell, studyId(s));
    const members = houses.slice(0, 4).map((h) => h.webId);
    // Three is this teller's floor, and the study said four: three answers publish nothing.
    expect((await ask(a, researcher, { kind: 'count.close', id: 'run', members: members.slice(0, 3) })).problems).toEqual(['too few: 3, and a total needs at least 4']);
    const lead = await ask(a, researcher, { kind: 'count.close', id: 'run', members });
    expect(lead).toMatchObject({ kind: 'count.share', study: studyId(s), min: 4, count: 4, rejected: 0 });
    const help = await ask(b, researcher, { kind: 'count.collect', id: 'run' });
    expect(help).toMatchObject({ kind: 'count.share', study: studyId(s), min: 4, count: 4 });
    expect(unshardCounts(4, [lead.share, help.share], 4)).toEqual([1, 2, 0, 1]);
  });
});
