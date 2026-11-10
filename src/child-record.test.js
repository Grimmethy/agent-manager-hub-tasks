'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findChildRecord, LIVE_STATES } = require('./child-record.js');

const pipeline = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-record-'));
  for (const s of ['pending', 'adhoc', 'done']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
};
const put = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task));
// core's findTaskRecordById answers the first queue state in this order; the stand-in answers the state given by `order`.
const finder = (order) => (dir, id) => {
  for (const state of order) {
    const file = path.join(dir, 'queue', state, `${id}.json`);
    if (fs.existsSync(file)) return { task: JSON.parse(fs.readFileSync(file, 'utf8')), state, file };
  }
  return null;
};

test('an applied copy in done/ wins over the same id still waiting in a live queue (a hand-carried piece leaves its original behind)', () => {
  for (const live of ['pending', 'adhoc']) {
    const dir = pipeline();
    put(dir, live, { id: 'p-1', status: 'pending' });
    put(dir, 'done', { id: 'p-1', status: 'done', branch: 'agent/hub' });
    const r = findChildRecord(dir, 'p-1', finder([live, 'done']));
    assert.equal(r.state, 'done', live);
    assert.equal(r.task.branch, 'agent/hub');
    assert.equal(r.file, path.join(dir, 'queue', 'done', 'p-1.json'));
  }
});

test('every other case is exactly what the finder answers: no done copy, a done copy that is not done, a different id inside, an unreadable file, or no record at all', () => {
  const dir = pipeline();
  const find = finder(['pending', 'adhoc', 'done']);
  put(dir, 'pending', { id: 'only-live', status: 'pending' });
  assert.equal(findChildRecord(dir, 'only-live', find).state, 'pending');
  put(dir, 'pending', { id: 'half', status: 'pending' });
  put(dir, 'done', { id: 'half', status: 'blocked' });
  assert.equal(findChildRecord(dir, 'half', find).state, 'pending');
  put(dir, 'pending', { id: 'wrong-id', status: 'pending' });
  put(dir, 'done', { id: 'someone-else', status: 'done' });
  fs.renameSync(path.join(dir, 'queue', 'done', 'someone-else.json'), path.join(dir, 'queue', 'done', 'wrong-id.json'));
  assert.equal(findChildRecord(dir, 'wrong-id', find).state, 'pending');
  put(dir, 'pending', { id: 'broken', status: 'pending' });
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'broken.json'), '{not json');
  assert.equal(findChildRecord(dir, 'broken', find).state, 'pending');
  assert.equal(findChildRecord(dir, 'nothing', find), null);
});

test('a record the finder already found in done, or anywhere that is not a live queue, is returned unchanged and done/ is not read', () => {
  const dir = pipeline();
  put(dir, 'done', { id: 'd-1', status: 'done' });
  const seen = [];
  const spy = { readFileSync: (f, e) => { seen.push(f); return fs.readFileSync(f, e); } };
  const r = findChildRecord(dir, 'd-1', finder(['done']), spy);
  assert.equal(r.state, 'done');
  assert.deepEqual(seen, [], 'no second read when the finder already answered done');
  const archived = { task: { id: 'a' }, state: 'archived', file: '/x' };
  assert.equal(findChildRecord(dir, 'a', () => archived), archived);
  assert.equal(findChildRecord(dir, 'a', () => null), null);
});

test('LIVE_STATES lists the queue states a hub piece can wait in, and never done or an archive', () => {
  for (const s of ['pending', 'adhoc', 'approved', 'review', 'blocked', 'needs-clarification', 'awaiting-confirm']) assert.ok(LIVE_STATES.includes(s), s);
  for (const s of ['done', 'archived', 'archived_no_action', 'drafting']) assert.ok(!LIVE_STATES.includes(s), s);
});
