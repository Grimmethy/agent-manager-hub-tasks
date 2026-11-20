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

const { CARRY_MAX_MS, applyCarryHold, holdPiece, releasePiece, takePiece } = require('./carry-hold.js');
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

test('sweep: a record-less piece without a marker is gone, so the hub completes (unchanged behaviour)', async () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-a', [{ id: 'a-1', title: 'one', status: 'pending' }]));
  const summary = await coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 1);
});

test('sweep: a marked record-less piece reads carried, stays open and keeps the hub from completing', async () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-b', [
    { id: 'b-1', title: 'one', status: 'pending', carriedBy: { who: 'op', at: new Date().toISOString() } },
    { id: 'b-2', title: 'two', status: 'pending' },
  ]));
  write(dir, 'adhoc', { id: 'b-2', dependsOn: ['b-1'] });
  const summary = await coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 0);
  const hub = readHub(dir, 'hub-b');
  assert.deepEqual(hub.subTasks.map((s) => s.status), ['carried', 'in-progress']);
  assert.equal(hub.subTasks[0].phase, 'open');
  assert.ok(hub.subTasks[0].carriedBy, 'the marker survives the sweep rewrite');
});

test('sweep: once the carried record is placed back the status follows the record and the marker is gone', async () => {
  const dir = makePipeline();
  write(dir, 'coordinating', hubWith('hub-c', [
    { id: 'c-1', title: 'one', status: 'carried', carriedBy: { who: 'op', at: new Date().toISOString() } },
    { id: 'c-2', title: 'two', status: 'pending' },
  ]));
  write(dir, 'adhoc', { id: 'c-2' });
  write(dir, 'done', { id: 'c-1', mergedAt: '2026-10-23T00:00:00Z' });
  await coordinatorSweep({ pipelineDir: dir });
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

test('holdPiece / releasePiece: a missing coordinating dir still reads as no hub', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-hold-nodir-'));
  assert.throws(() => holdPiece(dir, 'x-1', 'op'), /no hub in .* lists a piece 'x-1'/);
  assert.throws(() => releasePiece(dir, 'x-1'), /no hub in .* lists a piece 'x-1'/);
});

test('holdPiece / releasePiece: an unreadable coordinating dir surfaces the fs error, not "no hub"', () => {
  const dir = makePipeline();
  const orig = fs.readdirSync;
  fs.readdirSync = () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
  try {
    for (const fn of [() => holdPiece(dir, 'x-1', 'op'), () => releasePiece(dir, 'x-1')]) {
      assert.throws(fn, (e) => /EACCES/.test(e.message) && e.message.includes(path.join(dir, 'queue', 'coordinating')) && !/no hub in/.test(e.message));
    }
  } finally {
    fs.readdirSync = orig;
  }
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

const ensureState = (dir, state) => fs.mkdirSync(path.join(dir, 'queue', state), { recursive: true });
const recordPath = (dir, state, id) => path.join(dir, 'queue', state, `${id}.json`);
const tmpDest = () => fs.mkdtempSync(path.join(os.tmpdir(), 'take-'));

test('takePiece: moves the record to destDir and marks the hub piece carried', () => {
  const dir = makePipeline();
  ensureState(dir, 'pending');
  const destDir = tmpDest();
  try {
    write(dir, 'coordinating', hubWith('hub-t1', [{ id: 't-1', title: 'one', status: 'pending' }, { id: 't-2', title: 'two', status: 'pending' }]));
    write(dir, 'pending', { id: 't-1' });
    const out = takePiece(dir, 't-1', 'op', destDir, NOW);
    assert.equal(out, path.join(destDir, 't-1.json'));
    assert.ok(fs.existsSync(out), 'record is in destDir');
    assert.equal(fs.existsSync(recordPath(dir, 'pending', 't-1')), false, 'record left the queue');
    assert.deepEqual(readHub(dir, 'hub-t1').subTasks[0].carriedBy, { who: 'op', at: new Date(NOW).toISOString() });
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('takePiece: refuses a drafting record, leaving it in place with no mark', () => {
  const dir = makePipeline();
  ensureState(dir, 'drafting');
  const destDir = tmpDest();
  try {
    write(dir, 'coordinating', hubWith('hub-t2', [{ id: 't-1', title: 'one', status: 'pending' }]));
    write(dir, 'drafting', { id: 't-1' });
    assert.throws(() => takePiece(dir, 't-1', 'op', destDir, NOW), /drafting/);
    assert.equal(fs.existsSync(recordPath(dir, 'drafting', 't-1')), true, 'record stays in place');
    assert.equal(fs.readdirSync(destDir).length, 0, 'nothing moved');
    assert.equal(readHub(dir, 'hub-t2').subTasks[0].carriedBy, undefined, 'no mark written');
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('takePiece: refuses a missing record and writes no mark', () => {
  const dir = makePipeline();
  const destDir = tmpDest();
  try {
    write(dir, 'coordinating', hubWith('hub-t3', [{ id: 't-1', title: 'one', status: 'pending' }]));
    assert.throws(() => takePiece(dir, 't-1', 'op', destDir, NOW), /no record/);
    assert.equal(readHub(dir, 'hub-t3').subTasks[0].carriedBy, undefined, 'no mark written');
    assert.equal(fs.readdirSync(destDir).length, 0, 'nothing moved');
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('takePiece: refuses a missing hub and writes nothing', () => {
  const dir = makePipeline();
  ensureState(dir, 'pending');
  const destDir = tmpDest();
  try {
    write(dir, 'pending', { id: 't-1' });
    const before = fs.readdirSync(path.join(dir, 'queue', 'coordinating'));
    assert.throws(() => takePiece(dir, 't-1', 'op', destDir, NOW), /no hub/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'queue', 'coordinating')), before, 'no hub file written');
    assert.equal(fs.existsSync(recordPath(dir, 'pending', 't-1')), true, 'record stays in place');
    assert.equal(fs.readdirSync(destDir).length, 0, 'nothing moved');
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('takePiece: a missing destDir is refused before any write', () => {
  const dir = makePipeline();
  ensureState(dir, 'pending');
  const missing = path.join(os.tmpdir(), `no-such-take-dir-${process.pid}-${Date.now()}`);
  write(dir, 'coordinating', hubWith('hub-t4', [{ id: 't-1', title: 'one', status: 'pending' }]));
  write(dir, 'pending', { id: 't-1' });
  assert.throws(() => takePiece(dir, 't-1', 'op', missing, NOW), /not an existing directory/);
  assert.equal(readHub(dir, 'hub-t4').subTasks[0].carriedBy, undefined, 'no mark written');
  assert.equal(fs.existsSync(recordPath(dir, 'pending', 't-1')), true, 'record stays in place');
});

test('takePiece: a failed move restores the prior carriedBy mark', () => {
  const dir = makePipeline();
  ensureState(dir, 'pending');
  const destDir = tmpDest();
  try {
    const prev = { who: 'old', at: new Date(NOW - 3600e3).toISOString() };
    write(dir, 'coordinating', hubWith('hub-t5', [{ id: 't-1', title: 'one', status: 'pending', carriedBy: prev }]));
    write(dir, 'pending', { id: 't-1' });
    // A directory where the record should land makes the rename fail (EISDIR on Linux).
    fs.mkdirSync(path.join(destDir, 't-1.json'));
    assert.throws(() => takePiece(dir, 't-1', 'op', destDir, NOW));
    assert.deepEqual(readHub(dir, 'hub-t5').subTasks[0].carriedBy, prev, 'prior mark restored');
    assert.equal(fs.existsSync(recordPath(dir, 'pending', 't-1')), true, 'record stays in the queue');
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});
