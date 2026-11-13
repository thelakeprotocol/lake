import { describe, expect, it } from 'vitest';
import { kept, podEnv, sentAgain, type OwnerSession } from './pod.js';

describe('a pod that isn\'t reached at once (13 Nov: a duty grant answered 500)', () => {
  const flaky = (fails: number) => { const calls: string[] = []; const f = (async (_u: unknown, init?: RequestInit) => { calls.push(init?.method ?? 'GET'); if (calls.length <= fails) throw new TypeError('fetch failed'); return new Response('ok'); }) as typeof fetch; return { f, calls }; };

  it('sends a write that is safe to send twice again, and gives the answer', async () => {
    const { f, calls } = flaky(2);
    const res = await sentAgain(f, [1, 1])('https://pod.example/x', { method: 'PUT', body: 'a' });
    expect(await res.text()).toBe('ok');
    expect(calls).toEqual(['PUT', 'PUT', 'PUT']);
  });

  it('gives up after its tries, with the error it got', async () => {
    const { f, calls } = flaky(9);
    await expect(sentAgain(f, [1, 1])('https://pod.example/x')).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(3);
  });

  it('never sends a POST or a PATCH twice', async () => {
    for (const method of ['POST', 'PATCH']) {
      const { f, calls } = flaky(1);
      await expect(sentAgain(f, [1, 1])('https://pod.example/x', { method })).rejects.toThrow('fetch failed');
      expect(calls).toEqual([method]);
    }
  });
});

describe('the pod server has a heap limit of its own (12 Nov: it inherited the house\'s and was killed at the container\'s)', () => {
  it('drops the house\'s limit, keeps its other options, and runs as production', () => {
    const env = podEnv({ NODE_OPTIONS: '--max-old-space-size=448 --enable-source-maps', NODE_ENV: 'test', HOME: '/x' });
    expect(env.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=256');
    expect(env.NODE_ENV).toBe('production');
    expect(env.HOME).toBe('/x');
  });

  it('takes LAKE_POD_HEAP, and its own default for anything that isn\'t a size', () => {
    expect(podEnv({ LAKE_POD_HEAP: '384' }).NODE_OPTIONS).toBe('--max-old-space-size=384');
    expect(podEnv({ LAKE_POD_HEAP: 'lots', NODE_OPTIONS: '--max_old_space_size=64' }).NODE_OPTIONS).toBe('--max-old-space-size=256');
  });
});

describe('what the house keeps in its pod is never taken for missing (a pod that stumbled at start read as a new house)', () => {
  const pod = (answers: (number | 'down')[]) => {
    let n = 0;
    const fetch = (async () => { const a = answers[Math.min(n++, answers.length - 1)]; if (a === 'down') throw new TypeError('fetch failed'); return new Response(a === 200 ? '{"kid":"k1"}' : '', { status: a }); }) as typeof globalThis.fetch;
    return { session: { podRoot: 'https://pod.example/h/', fetch } as unknown as OwnerSession, asked: () => n };
  };

  it('gives the file, and nothing for "not found"', async () => {
    expect(await (await kept(pod([200]).session, 'wallet/identity.json'))!.json()).toEqual({ kid: 'k1' });
    expect(await kept(pod([404]).session, 'wallet/identity.json')).toBeNull();
  });

  it('asks again when the pod stumbles, and takes the answer that comes', async () => {
    const p = pod([500, 'down', 401, 200]);
    expect((await kept(p.session, 'settings/rules.yaml', [1, 1, 1]))?.ok).toBe(true);
    expect(p.asked()).toBe(4);
    const gone = pod(['down', 404]);
    expect(await kept(gone.session, 'wallet/owner.jwk.json', [1])).toBeNull();
  });

  it('stops with the reason when the pod never answers properly, and doesn\'t say "none"', async () => {
    await expect(kept(pod([503]).session, 'wallet/identity.json', [1, 1])).rejects.toThrow('could not read wallet/identity.json from the pod (503)');
    await expect(kept(pod(['down']).session, 'wallet/assistants.json', [1])).rejects.toThrow('no answer');
  });
});
