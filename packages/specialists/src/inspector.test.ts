import { describe, expect, it } from 'vitest';
import { headline } from './inspector.js';

describe('the inspector\'s headline', () => {
  it('counts a warning as a warning, not a pass (run 31 read 10/10 with the domain unproved)', () => {
    const checks = [{ check: 'card', status: 'pass' as const, detail: '' }, { check: 'domain', status: 'warn' as const, detail: '' }, { check: 'endpoint', status: 'pass' as const, detail: '' }];
    expect(headline(checks)).toBe('2/3 passed, 1 warning: the domain doesn\'t vouch for the key');
    expect(headline([...checks, { check: 'refuses a forged card', status: 'fail', detail: '' }])).toBe('2/4 passed, 1 warning: the domain doesn\'t vouch for the key, 1 failed: refuses a forged card');
    expect(headline(checks.filter((c) => c.status === 'pass'))).toBe('2/2 passed');
  });
});
