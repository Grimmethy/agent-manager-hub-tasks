'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// coordinator-sweep.js registers itself at load time and reads the repo config (see coordinator-sweep.test.js).
process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const { CARRY_MAX_MS, applyCarryHold, holdPiece, releasePiece } = require('./carry-hold.js');
const { coordinatorSweep, TERMINAL_GOOD } = require('./coordinator-sweep.js');
const { hubHasUnmergedEarlierSibling } = require('agent-manager/src/hub-priority.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-hold-test-'));
  for (const s of ['coordinating', 'adhoc', 'done']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const write = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const readHub = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', `${id}.json`), 'utf8'));
const NOW = Date.parse('2026-10-23T12:00:00Z');
const hubWith = (id, subs) => ({ id, status: 'coordinating', history: [], subTasks: subs });

test('applyCarryHold: no marker leaves the status alone', () => {
  assert.deepEqual(applyCarryHold({ id: 'p1' }, 'gone', NOW), { status: 'gone' });
  assert.deepEqual(applyCarryHold({ id: 'p1' }, 'in-progress', NOW), { status: 'in-progress' });
});

test('applyCarryHold: a marked piece with no record reads carried, and carried is neither terminal-good nor sibling-resolved', () => {
  const dir = makePipeline();
  const hubOf = (status) => ({ id: 'hub-x', subTasks: [{ id: 'x-1', status }, { id: 'x-2', status: 'in-progress' }] });
  const next = { id: 'x-2', parentHub: 'hub-x' };
  assert.equal(hubHasUnmergedEarlierSibling(dir, next, hubOf('gone')).blocked, false, 'gone releases the next piece (the bug)');
  assert.deepEqual(hubHasUnmergedEarlierSibling(dir, next, hubOf('carried')), { blocked: true, blockingSiblingId: 'x-1', blockingSiblingStatus: 'carried' });
  const st = { id: 'p1', carriedBy: { who: 'op', at: new Date(NOW - 3600e3).toISOString() } };
  assert.deepEqual(applyCarryHold(st, 'gone', NOW), { status: 'carried' });
  assert.ok(st.carriedBy, 'the marker stays while the hold is live');
  assert.equal(TERMINAL_GOOD.has('carried'), false);
});

test('applyCarryHold: a marker older than 24h expires and the piece reads gone again', () => {
  const st = { id: 'p1', carriedBy: { who: 'op', at: new Date(NOW - CARRY_MAX_MS - 1000).toISOString() } };
  const r = applyCarryHold(st, 'gone', NOW);
  assert.equal(r.status, 'gone');
  assert.match(r.event, /expired after 24h/);
  assert.equal(st.carriedBy, undefined);
});

test('applyCarryHold: the marker clears itself once the record is back in a queue', () => {
  const st = { id: 'p1', carriedBy: { who: 'op', at: new Date(NOW).toISOString() } };
  const r = applyCarryHold(st, 'in-progress', NOW);
  assert.equal(r.status, 'in-progress');
  assert.match(r.event, /cleared/);
  assert.equal(st.carriedBy, undefined);
});

test('sweep: a record-less piece without a marker is gone, so the hub completes (unchanged behaviour)', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-a', [{ id: 'a-1', title: 'one', status: 'pending' }]));
  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 1);
});

test('sweep: a marked record-less piece reads carried, stays open and keeps the hub from completing', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-b', [
    { id: 'b-1', title: 'one', status: 'pending', carriedBy: { who: 'op', at: new Date().toISOString() } },
    { id: 'b-2', title: 'two', status: 'pending' },
  ]));
  write(dir, 'adhoc', { id: 'b-2', dependsOn: ['b-1'] });
  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 0);
  const hub = readHub(dir, 'hub-b');
  assert.deepEqual(hub.subTasks.map((s) => s.status), ['carried', 'in-progress']);
  assert.equal(hub.subTasks[0].phase, 'open');
  assert.ok(hub.subTasks[0].carriedBy, 'the marker survives the sweep rewrite');
});

test('sweep: once the carried record is placed back the status follows the record and the marker is gone', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-c', [
    { id: 'c-1', title: 'one', status: 'carried', carriedBy: { who: 'op', at: new Date().toISOString() } },
    { id: 'c-2', title: 'two', status: 'pending' },
  ]));
  write(dir, 'adhoc', { id: 'c-2' });
  write(dir, 'done', { id: 'c-1', mergedAt: '2026-10-23T00:00:00Z' });
  coordinatorSweep({ pipelineDir: dir });
  const hub = readHub(dir, 'hub-c');
  assert.equal(hub.subTasks[0].status, 'merged');
  assert.equal(hub.subTasks[0].carriedBy, undefined);
  assert.ok(hub.history.some((h) => /carry hold on c-1 cleared/.test(h.detail)));
});

test('holdPiece / releasePiece edit the hub record that lists the piece, atomically', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-d', [{ id: 'd-1', title: 'one', status: 'pending' }, { id: 'd-2', title: 'two', status: 'pending' }]));
  const r = holdPiece(dir, 'd-2', 'op', NOW);
  assert.deepEqual(r, { hub: 'hub-d', taskId: 'd-2' });
  const hub = readHub(dir, 'hub-d');
  assert.equal(hub.subTasks[1].carriedBy.who, 'op');
  assert.equal(hub.subTasks[1].carriedBy.at, new Date(NOW).toISOString());
  assert.equal(hub.subTasks[0].carriedBy, undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'queue', 'coordinating')), ['hub-d.json'], 'no temp file left behind');
  releasePiece(dir, 'd-2');
  assert.equal(readHub(dir, 'hub-d').subTasks[1].carriedBy, undefined);
});

test('holdPiece refuses an unknown task id and a missing who', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-e', [{ id: 'e-1', title: 'one', status: 'pending' }]));
  assert.throws(() => holdPiece(dir, 'nope', 'op'), /lists a piece 'nope'/);
  assert.throws(() => holdPiece(dir, 'e-1', ''), /needs a who/);
  assert.throws(() => releasePiece(dir, 'nope'), /lists a piece 'nope'/);
});

test('scripts/carry-hold.js: hold and release through the CLI, exit 1 on an unknown id', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-f', [{ id: 'f-1', title: 'one', status: 'pending' }]));
  const script = path.join(__dirname, '..', 'scripts', 'carry-hold.js');
  const env = { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir };
  assert.match(execFileSync('node', [script, 'hold', 'f-1', 'op'], { env, encoding: 'utf8' }), /hub-f/);
  assert.ok(readHub(dir, 'hub-f').subTasks[0].carriedBy);
  execFileSync('node', [script, 'release', 'f-1'], { env, encoding: 'utf8' });
  assert.equal(readHub(dir, 'hub-f').subTasks[0].carriedBy, undefined);
  assert.throws(() => execFileSync('node', [script, 'hold', 'zzz', 'op'], { env, stdio: 'pipe' }), (e) => e.status === 1);
});
