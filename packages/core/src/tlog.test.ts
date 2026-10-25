import { describe, expect, it } from 'vitest';
import { generateIdentity } from './crypto.js';
import { b64, consistencyProof, inclusionProof, leafHash, signCheckpoint, treeRoot, verifyCheckpoint, verifyConsistency, verifyInclusion } from './tlog.js';

describe('transparency log: RFC 9162 trees and C2SP checkpoints', () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => leafHash(`entry ${i}`));

  it('hashes trees as RFC 9162 does (root checked against an independent implementation)', () => {
    expect(b64(treeRoot(['a', 'b', 'c', 'd', 'e'].map((x) => leafHash(x))))).toBe(ROOT_ABCDE);
    expect(b64(treeRoot([]))).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('proves every leaf in every tree up to 33, and nothing false', () => {
    for (let n = 1; n <= 33; n++) {
      const ls = leaves(n), root = treeRoot(ls);
      for (let i = 0; i < n; i++) {
        const proof = inclusionProof(i, ls);
        expect(verifyInclusion(ls[i]!, i, n, proof, root)).toBe(true);
        expect(verifyInclusion(leafHash('forged'), i, n, proof, root)).toBe(false);
        if (n > 1) expect(verifyInclusion(ls[i]!, (i + 1) % n, n, proof, root)).toBe(false);
      }
    }
  });

  it('proves every prefix consistent with every later tree, and catches a rewritten one', () => {
    for (let n = 1; n <= 20; n++) {
      const ls = leaves(n);
      for (let m = 1; m <= n; m++) {
        const proof = consistencyProof(m, ls);
        expect(verifyConsistency(m, n, treeRoot(ls.slice(0, m)), treeRoot(ls), proof)).toBe(true);
        if (m < n) {
          const rewritten = [...ls.slice(0, m - 1), leafHash('rewritten')];
          expect(verifyConsistency(m, n, treeRoot(rewritten), treeRoot(ls), proof)).toBe(false);
        }
      }
    }
  });

  it('signs checkpoints as C2SP signed notes, checked by key and origin', async () => {
    const id = await generateIdentity();
    const note = await signCheckpoint('lake.example/log', 5, treeRoot(leaves(5)), id);
    expect(note).toMatch(/^lake\.example\/log\n5\n[A-Za-z0-9+/=]{44}\n\n— lake\.example\/log [A-Za-z0-9+/=]+\n$/);
    expect(verifyCheckpoint(note, id.publicJwk, 'lake.example/log')).toMatchObject({ origin: 'lake.example/log', size: 5 });
    expect(() => verifyCheckpoint(note.replace('\n5\n', '\n6\n'), id.publicJwk)).toThrow(/does not verify/);
    const other = await generateIdentity();
    expect(() => verifyCheckpoint(note, other.publicJwk)).toThrow(/another key/);
  });
});

// Computed with Python's hashlib from RFC 9162's definitions.
const ROOT_ABCDE = '/hSlQm+9cMD6c/UjQq/tDaC9I8SDhmLM9riKMHDq2Xs=';
