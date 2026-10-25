import { describe, expect, it } from 'vitest';
import { generateIdentity } from './crypto.js';
import { b64, consistencyProof, followCheckpoint, inclusionProof, leafHash, signCheckpoint, treeRoot, verifyCheckpoint, verifyConsistency, verifyInclusion } from './tlog.js';

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

  it('watches a log: takes a later checkpoint only with proof it extends the last one, and says plainly when not', async () => {
    const id = await generateIdentity();
    const o = 'lake.example/log';
    const ls = leaves(12);
    const at = (n: number, l = ls) => signCheckpoint(o, n, treeRoot(l.slice(0, n)), id);
    // First sight: taken on its signature.
    const first = followCheckpoint(undefined, await at(5), id.publicJwk);
    expect(first).toEqual({ origin: o, size: 5, root: b64(treeRoot(ls.slice(0, 5))) });
    // Grown, with its consistency proof (as base64, the way the log sends it): the newer one is remembered.
    const later = followCheckpoint(first, await at(12), id.publicJwk, consistencyProof(5, ls).map(b64));
    expect(later.size).toBe(12);
    // The same size again, same tree: nothing changes.
    const twelve = await at(12);
    expect(followCheckpoint(later, twelve, id.publicJwk)).toBe(later);
    // Grown, but no proof: refused.
    expect(() => followCheckpoint(first, twelve, id.publicJwk)).toThrow(/no consistency proof/);
    // History rewritten: entry 2 replaced, the tree grown. The proof from the new tree can't reach the old root.
    const rewritten = [...ls.slice(0, 2), leafHash('rewritten'), ...ls.slice(3)];
    const forked = await at(12, rewritten);
    expect(() => followCheckpoint(first, forked, id.publicJwk, consistencyProof(5, rewritten).map(b64))).toThrow(/rewritten or forked/);
    // Two different trees of the same size: a fork.
    expect(() => followCheckpoint(later, forked, id.publicJwk)).toThrow(/forked/);
    // Fewer entries than it signed before: rolled back.
    const seven = await at(7);
    expect(() => followCheckpoint(later, seven, id.publicJwk)).toThrow(/rolled back/);
    // Another log's checkpoint, or one signed by another key, is not this log's.
    const elsewhere = await signCheckpoint('other.example/log', 12, treeRoot(ls), id);
    expect(() => followCheckpoint(first, elsewhere, id.publicJwk, consistencyProof(5, ls).map(b64))).toThrow(/not lake\.example\/log/);
    const stranger = (await generateIdentity()).publicJwk;
    expect(() => followCheckpoint(first, twelve, stranger, consistencyProof(5, ls).map(b64))).toThrow(/another key/);
  });
});

// Computed with Python's hashlib from RFC 9162's definitions.
const ROOT_ABCDE = '/hSlQm+9cMD6c/UjQq/tDaC9I8SDhmLM9riKMHDq2Xs=';
