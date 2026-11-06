import { describe, expect, it } from 'vitest';
import { quorumBinds, quorumSize } from './tally.js';

describe('a quorum found from private thresholds (SPEC §11.4b)', () => {
  it('is the largest group whose every member said they would join a group that size', () => {
    const atLeast = [1, 25, 50, 100, 150, 200, 250, null];
    // 12 would go alone; cumulatively 30, 60, 115, 165, 205 hold together at 25, 50, 100, 150, 200; 230 is short of 250.
    expect(quorumSize([12, 18, 30, 55, 50, 40, 25, 70], atLeast)).toBe(205);
    // Nobody would go first and nobody at 25: everyone waits, nothing holds.
    expect(quorumSize([0, 0, 10, 10, 10, 0, 0, 5], atLeast)).toBe(0);
    // "Never" counts for nothing, however many say it.
    expect(quorumSize([3, 0, 0, 0, 0, 0, 0, 300], atLeast)).toBe(3);
  });

  it('cascades: those who would go alone make a group that brings in the next', () => {
    expect(quorumSize([1, 1, 1], [0, 2, 3])).toBe(3);
    expect(quorumSize([1, 0, 1], [0, 2, 3])).toBe(1);
  });

  it('binds once as many sign as the most any member of the group asked for', () => {
    const atLeast = [1, 25, 50, 100, 150, 200, 250, null];
    // A group of 205, the highest threshold in it 200: five can come late, or not at all.
    expect(quorumBinds(205, atLeast)).toBe(200);
    expect(quorumBinds(3, [0, 2, 3])).toBe(3);
    expect(quorumBinds(0, atLeast)).toBe(0);
  });
});
