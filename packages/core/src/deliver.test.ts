import { describe, expect, it } from 'vitest';
import { deliverWithRetries } from './agent.js';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('deliverWithRetries', () => {
  it('tries again after a failure, and stops once it lands', async () => {
    let tries = 0;
    deliverWithRetries(async () => { if (++tries < 3) throw new Error('house restarting'); }, [10, 10, 10, 10]);
    await settle(100);
    expect(tries).toBe(3);
  });

  it('gives up after its last try', async () => {
    let tries = 0;
    deliverWithRetries(async () => { tries++; throw new Error('gone'); }, [5, 5]);
    await settle(80);
    expect(tries).toBe(3);
  });

  it('takes any answer as the end, a refusal too', async () => {
    let tries = 0;
    deliverWithRetries(async () => { tries++; return { kind: 'rejected' }; }, [5, 5]);
    await settle(50);
    expect(tries).toBe(1);
  });
});
