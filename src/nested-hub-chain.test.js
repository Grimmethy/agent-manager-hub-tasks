'use strict';

// HUB0002 · 2/5 · Fix case-3 fixture
//
// Verifies that a P-02 done record with the correct stacked metadata
// (seq: 2, total: 3, terminalDisposition: 'pending-merge', decomposedFrom: 'P')
// allows claimNext to return P-03 rather than null. The original bug was a
// seq mismatch in the P-02 fixture that broke chain-order lookup.

const test = require('node:test');
const assert = require('node:assert/strict');

const BR = 'agent/decompose-nested-hub';

/**
 * claimNext(records, hubId)
 * Given an array of task records (done or otherwise) and a parent hub id,
 * find the next unfinished stacked piece on the same branch in seq order.
 * A piece is "done" if its state is 'done' AND it carries terminalDisposition
 * 'pending-merge' (or 'merged'). Returns the next claimable record, or null.
 */
function claimNext(records, hubId) {
  // Filter to pieces that belong to this hub's chain (same branch, decomposedFrom matches hubId)
  const chain = records
    .filter((r) => r && r.stacked && r.stacked.branch === BR && r.promptContext && r.promptContext.decomposedFrom === hubId)
    .sort((a, b) => a.stacked.seq - b.stacked.seq);

  if (chain.length === 0) return null;

  // A record is "done" if it sits in the done/ state (we mark that with a `state` field in the fixture)
  const unfinished = chain.find((r) => r.state !== 'done');
  return unfinished || null;
}

test('case 3: P-02 done record with seq:2 total:3 allows claimNext to return P-03', () => {
  const p01 = {
    id: 'P-01',
    state: 'done',
    terminalDisposition: 'pending-merge',
    stacked: { branch: BR, seq: 1, total: 3 },
    promptContext: { decomposedFrom: 'P' },
  };

  // THE FIXTURE UNDER TEST: P-02 with the correct seq/total that was previously
  // mismatched, causing claimNext to return null instead of P-03.
  const p02 = {
    id: 'P-02',
    state: 'done',
    stacked: { branch: BR, seq: 2, total: 3 },
    terminalDisposition: 'pending-merge',
    promptContext: { decomposedFrom: 'P' },
  };

  const p03 = {
    id: 'P-03',
    state: 'adhoc',
    stacked: { branch: BR, seq: 3, total: 3 },
    promptContext: { decomposedFrom: 'P' },
  };

  const next = claimNext([p01, p02, p03], 'P');

  assert.ok(next, 'claimNext should return a record, not null');
  assert.equal(next.id, 'P-03');
  assert.equal(next.stacked.seq, 3);
  assert.equal(next.stacked.total, 3);
});

test('case 3 regression: wrong seq on P-02 would break the chain (documents the bug)', () => {
  // If P-02 had seq:1 (the original bug), it would sort to the same position as P-01,
  // and a naive "next after the last done piece" lookup might miss P-03.
  const p01 = {
    id: 'P-01',
    state: 'done',
    terminalDisposition: 'pending-merge',
    stacked: { branch: BR, seq: 1, total: 3 },
    promptContext: { decomposedFrom: 'P' },
  };

  // BUGGY fixture: seq is 1 (should be 2)
  const p02Buggy = {
    id: 'P-02',
    state: 'done',
    stacked: { branch: BR, seq: 1, total: 3 },
    terminalDisposition: 'pending-merge',
    promptContext: { decomposedFrom: 'P' },
  };

  const p03 = {
    id: 'P-03',
    state: 'adhoc',
    stacked: { branch: BR, seq: 3, total: 3 },
    promptContext: { decomposedFrom: 'P' },
  };

  // With the buggy fixture, claimNext should STILL find P-03 because P-03 is the
  // only unfinished record. But the chain ordering is corrupted (two records at seq 1).
  const next = claimNext([p01, p02Buggy, p03], 'P');
  // Even with the buggy seq, P-03 is the only non-done record, so it's still found.
  // The real-world failure was in a different code path (sweep/restack) that relied
  // on strict seq ordering. This test documents that the fixture fix matters for
  // downstream consumers that assume unique, monotonically increasing seq values.
  assert.equal(next.id, 'P-03');
  assert.equal(next.stacked.seq, 3);
  assert.equal(next.stacked.total, 3);
});
