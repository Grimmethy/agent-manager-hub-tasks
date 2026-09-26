'use strict';

// A candidate-fulfillment task too big for one pass (function_length_fix, pipeline_forensics_fix, a Split-Depth 1 sub-candidate) is
// routed to the coordinator-hub system agent-manager already has for oversized adhoc work, instead of blocking for a human.
// See candidate-split-hub.js's applyCandidateSplitAsHub and core's local-draft.js's finalizeCandidateFulfillment.
// Moved here from agent-manager core's src/candidate-split-hub.test.js (S4b of the hub-tasks extraction, 2026-09-25).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { candidateSplitToSubTasks, applyCandidateSplitAsHub } = require('./candidate-split-hub.js');
const { applyAdhocDiff } = require('agent-manager/src/apply-adhoc-diff.js');
const { writeArtifact } = require('agent-manager/src/lib/apply-core.js');
const { setCandidateSplitHubFiler } = require('agent-manager/src/candidate-split-hub-route.js');

test.before(() => { require('../register.js'); });
test.after(() => { setCandidateSplitHubFiler(null); });

const pipeline = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cand-hub-'));
const adhocFiles = (pipe) => {
  const dir = path.join(pipe, 'queue', 'adhoc');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
};

const parent = (over = {}) => ({
  id: 'function-length-fix-ac-2', domain: 'default', source: 'function_length_fix', title: 'AC-2 · Extract pure geometry from PropertyAerialView',
  promptContext: { candidateId: 'AC-2', title: 'Extract pure geometry from PropertyAerialView', files: ['src/components/PropertyAerialView.tsx'] },
  candidateSplitRoute: 'hub',
  candidateSplitProposals: [
    { title: 'Extract the tile-grid builder into src/lib/tileGrid.ts', files: 'src/lib/tileGrid.ts, src/components/PropertyAerialView.tsx', problem: 'The tile grid is built inline.', solution: 'Move it into buildTileGrid().', benefits: 'Testable.', splitDepth: 1 },
    { title: 'Extract parcel bounding-box math into src/lib/parcel.ts', files: 'src/lib/parcel.ts, src/components/PropertyAerialView.tsx', problem: 'The parcel box is computed inline.', solution: 'Move it into computeParcelBox().', benefits: 'Testable.', splitDepth: 1 },
    { title: 'Extract boundary projection into src/lib/boundary.ts', files: 'src/lib/boundary.ts, src/components/PropertyAerialView.tsx', problem: 'Rings are projected inline.', solution: 'Move it into projectBoundary().', benefits: '', splitDepth: 1 },
  ],
  ...over,
});

test('candidateSplitToSubTasks: one bounded piece per proposal, each scoped to itself, chained after the previous', () => {
  const subs = candidateSplitToSubTasks(parent());
  assert.equal(subs.length, 3);
  assert.deepEqual(subs.map((s) => s.after), [undefined, 0, 1], 'a linear chain -- the pieces edit the same function/file, so they must not run in parallel');
  assert.match(subs[1].rawText, /^Part 2 of 3 of a fix that was too large for one pass: AC-2 -- Extract pure geometry/);
  assert.match(subs[1].rawText, /THIS PART: Extract parcel bounding-box math/);
  assert.match(subs[1].rawText, /Files: src\/lib\/parcel\.ts, src\/components\/PropertyAerialView\.tsx/);
  assert.match(subs[1].rawText, /Problem: The parcel box is computed inline\./);
  assert.match(subs[1].rawText, /Solution: Move it into computeParcelBox\(\)\./);
  assert.match(subs[1].rawText, /implement ONLY this part\. Do not do the other parts \(Extract the tile-grid builder[^)]*; Extract boundary projection[^)]*\)/);
  assert.match(subs[1].rawText, /earlier part\(s\) are already in the code you are editing/);
  assert.doesNotMatch(subs[0].rawText, /earlier part/, 'the first piece has nothing before it');
  assert.doesNotMatch(subs[2].rawText, /Benefits:/, 'an empty benefits line is omitted');
});

test('applyCandidateSplitAsHub: queues ordered adhoc children on ONE stacked branch and returns a coordinating parent', () => {
  const pipe = pipeline();
  const result = applyCandidateSplitAsHub(parent({ premiumPriority: true }), pipe);
  assert.equal(result.coordinating, true);
  assert.match(result.reason, /Candidate too large for one pass -- decomposed into 3 chained sub-task\(s\)/);
  assert.equal(result.subTasks.length, 3);
  assert.ok(result.subTasks.every((t) => t.status === 'pending' && /^HUB0001-0\d-/.test(t.id)));

  const kids = adhocFiles(pipe).sort((a, b) => a.stacked.seq - b.stacked.seq);
  assert.equal(kids.length, 3);
  assert.ok(kids.every((k) => k.domain === 'adhoc' && k.source === 'manual'));
  assert.ok(kids.every((k) => k.promptContext.decomposedFrom === 'function-length-fix-ac-2'), 'decomposedFrom marks a confirmed-atomic leaf: it is never split again');
  assert.ok(kids.every((k) => k.premiumPriority === true), 'a premium parent keeps its priority through decomposition');
  assert.deepEqual(kids.map((k) => k.stacked.seq), [1, 2, 3]);
  assert.equal(new Set(kids.map((k) => k.stacked.branch)).size, 1, 'one shared branch, so no parallel-edit conflicts');
  assert.equal(kids[0].dependsOn, undefined);
  assert.deepEqual(kids[1].dependsOn, [kids[0].id]);
  assert.deepEqual(kids[2].dependsOn, [kids[1].id]);
  assert.match(kids[0].promptContext.rawText, /Part 1 of 3/);
});

test('applyCandidateSplitAsHub returns the same coordinating shape as an adhoc decompose (so the hub sweep treats both alike)', () => {
  const hub = applyCandidateSplitAsHub(parent(), pipeline());
  const adhoc = applyAdhocDiff({
    task: { id: 'adhoc-x', adhocResolution: 'decompose', subTaskProposals: [{ title: 'a', rawText: 'do a' }, { title: 'b', rawText: 'do b', after: 0 }] },
    pipelineDir: pipeline(),
  });
  assert.deepEqual(Object.keys(hub).sort(), Object.keys(adhoc).sort());
  assert.deepEqual(Object.keys(hub.subTasks[0]).sort(), Object.keys(adhoc.subTasks[0]).sort());
});

test('applyCandidateSplitAsHub refuses fewer than 2 pieces (nothing to coordinate)', () => {
  const one = parent({ candidateSplitProposals: [parent().candidateSplitProposals[0]] });
  assert.throws(() => applyCandidateSplitAsHub(one, pipeline()), /needs at least 2 sub-candidates/);
});

test('writeArtifact: a hub-routed split queues sub-tasks; the pipeline never touches a candidate doc for it', () => {
  const pipe = pipeline();
  const result = writeArtifact(parent(), '/nonexistent-repo', pipe);
  assert.equal(result.coordinating, true);
  assert.equal(adhocFiles(pipe).length, 3);
});

test('writeArtifact: a split WITHOUT the hub route still goes to the candidate doc (unchanged behaviour)', () => {
  // A source name nothing registers, on purpose -- unlike a lone `node --test` run of just
  // this file, the full plugin suite now also loads coordinator-sweep.js (S5e), whose own
  // module-load-time ensureRegistered() call really does register agent-manager-hygiene's
  // function_length_fix (this fixture's real `source`) with a candidatesPath in the SAME
  // process. Using the real 'function_length_fix' name here made this test's premise --
  // "no registered source with a candidatesPath" -- depend on ambient, cross-file registry
  // state instead of on this test's own setup. Found running the full S5e-updated suite.
  const t = parent({ source: 'no-such-registered-source-for-this-test' });
  delete t.candidateSplitRoute;
  assert.throws(() => writeArtifact(t, '/nonexistent-repo', pipeline()), /has candidateSplitProposals but its source/);
});

test('writeArtifact: a hub-routed split throws a clear error when no filer is registered (plugin not loaded)', () => {
  setCandidateSplitHubFiler(null);
  const t = parent();
  assert.throws(() => writeArtifact(t, '/nonexistent-repo', pipeline()), /no hub-task filer is registered/);
  require('./candidate-split-hub.js').register(); // re-arm -- register.js itself is require-cached, so it won't re-run
});
