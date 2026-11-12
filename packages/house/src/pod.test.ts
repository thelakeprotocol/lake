import { describe, expect, it } from 'vitest';
import { sentAgain } from './pod.js';

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
