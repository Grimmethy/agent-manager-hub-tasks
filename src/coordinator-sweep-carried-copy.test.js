'use strict';

// The real coordinator sweep against a hub whose pieces were carried by hand: the original of each piece is still in pending/ or adhoc/, the applied copy is in done/.
// Before the fix the original masked the copy (core's findTaskRecordById answers the first queue state), every piece read in-progress and the hub never completed
// (2026-11-10, HUB0364 and HUB0365).

process.env.AGENT_MANAGER_REPO_ROOT = require('os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { coordinatorSweep } = require('./coordinator-sweep.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-carried-'));
  for (const s of ['coordinating', 'pending', 'adhoc', 'blocked', 'needs-clarification', 'done', 'done/_archived_no_action', 'done/_archived/2026-08']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const write = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const parentOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'coordinating', 'hub-1.json'), 'utf8'));

function hub(dir) {
  write(dir, 'coordinating', { id: 'hub-1', status: 'coordinating', history: [], subTasks: [{ id: 'c-a', title: 'A', status: 'pending' }, { id: 'c-b', title: 'B', status: 'pending' }, { id: 'c-c', title: 'C', status: 'pending' }] });
}

test('applied copies in done/ count even though the originals still sit in pending/ and adhoc/', async () => {
  const dir = makePipeline();
  hub(dir);
  write(dir, 'pending', { id: 'c-a', status: 'pending', title: 'A' });
  write(dir, 'adhoc', { id: 'c-b', status: 'pending', title: 'B' });
  write(dir, 'done', { id: 'c-a', status: 'done', branch: 'agent/x' });
  write(dir, 'done', { id: 'c-b', status: 'done', branch: 'agent/x' });
  write(dir, 'done', { id: 'c-c', status: 'done', mergedAt: '2026-11-10T00:00:00Z' });
  const summary = await coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 1, 'the hub completes: every piece is delivered');
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'hub-1.json')), false);
  const parent = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'hub-1.json'), 'utf8'));
  assert.deepEqual(parent.subTasks.map((s) => s.status), ['done', 'done', 'merged']);
});

test('an original with no applied copy still reads in-progress, and a done copy that is not done does not hide it', async () => {
  const dir = makePipeline();
  hub(dir);
  write(dir, 'pending', { id: 'c-a', status: 'pending', title: 'A' });
  write(dir, 'adhoc', { id: 'c-b', status: 'pending', title: 'B' });
  write(dir, 'done', { id: 'c-b', status: 'blocked' });
  write(dir, 'done', { id: 'c-c', status: 'done' });
  await coordinatorSweep({ pipelineDir: dir });
  assert.deepEqual(parentOf(dir).subTasks.map((s) => s.status), ['in-progress', 'in-progress', 'done']);
});
