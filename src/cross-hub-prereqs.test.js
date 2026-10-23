'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { extractPaths, findCrossHubPrerequisites, annotateWithPrerequisites, buildRealContext } = require('./cross-hub-prereqs.js');
const { runDecomposePass } = require('./decompose-pass.js');

const HUB6 = { label: 'HUB0006', branch: 'agent/decompose-hub6', filesAdded: ['accounts.py', 'routes/accounts.py'] };
const ctxOf = (hubs, onMain = []) => ({ hubs, existsOnMain: (p) => onMain.includes(p) });
const piece = (title, rawText) => ({ title, rawText });

test('extractPaths finds backticked and bare file names, strips ./, ignores URLs, deduplicates', () => {
  const t = 'Read `accounts.py` and ./routes/chat.py then accounts.py again; see https://example.com/x.html and README.md.';
  assert.deepEqual(extractPaths(t), ['accounts.py', 'routes/chat.py', 'README.md']);
  assert.deepEqual(extractPaths(''), []);
});

test('a file only on another hub branch (not on main) is a prerequisite', () => {
  const r = findCrossHubPrerequisites([piece('Swap model', 'Read accounts.py first, then change chat.py.')], ctxOf([HUB6], ['chat.py']));
  assert.deepEqual(r, [[{ hub: 'HUB0006', branch: 'agent/decompose-hub6', files: ['accounts.py'] }]]);
});

test('a file that is on main is not a prerequisite, even if another hub also adds it', () => {
  const r = findCrossHubPrerequisites([piece('t', 'Read accounts.py.')], ctxOf([HUB6], ['accounts.py']));
  assert.deepEqual(r, [[]]);
});

test('no other hubs: nothing found', () => {
  assert.deepEqual(findCrossHubPrerequisites([piece('t', 'Read accounts.py.')], ctxOf([])), [[]]);
  assert.deepEqual(findCrossHubPrerequisites([piece('t', 'Read accounts.py.')], undefined), [[]]);
});

test('a piece that creates the file itself is not given a prerequisite', () => {
  const r = findCrossHubPrerequisites([piece('t', 'Create accounts.py with a registry.')], ctxOf([HUB6]));
  assert.deepEqual(r, [[]]);
});

test('a bare name matches a nested path on the other hub (suffix match), not a longer unrelated name', () => {
  const hubs = [{ label: 'HUB0007', branch: 'b', filesAdded: ['routes/accounts.py', 'old_accounts.py'] }];
  const r = findCrossHubPrerequisites([piece('t', 'Use accounts.py')], ctxOf(hubs));
  assert.deepEqual(r[0].map((x) => x.files), [['routes/accounts.py']]);
});

test('if main cannot be read for a path, that path is skipped (fail open)', () => {
  const ctx = { hubs: [HUB6], existsOnMain: () => { throw new Error('boom'); } };
  assert.deepEqual(findCrossHubPrerequisites([piece('t', 'Read accounts.py')], ctx), [[]]);
});

test('annotateWithPrerequisites adds prerequisiteHubs and a PREREQUISITE CHECK, leaving other pieces untouched', () => {
  const subs = [piece('a', 'Read accounts.py'), piece('b', 'Nothing special')];
  const prereqs = findCrossHubPrerequisites(subs, ctxOf([HUB6]));
  const out = annotateWithPrerequisites(subs, prereqs);
  assert.deepEqual(out[0].prerequisiteHubs, ['HUB0006']);
  assert.match(out[0].rawText, /PREREQUISITE CHECK/);
  assert.match(out[0].rawText, /accounts\.py exists only on the unmerged branch of HUB0006/);
  assert.match(out[0].rawText, /raise needs-clarification/);
  assert.deepEqual(out[1], subs[1]);
});

const THREE = JSON.stringify({ one_pass: false, subtasks: [
  { title: 'Add routes', rawText: 'Read accounts.py then add a route in chat.py.' },
  { title: 'Add view', rawText: 'Create view.js with pure functions.', after: 0 },
] });
const stub = async () => ({ response: THREE });

test('runDecomposePass annotates pieces when a crossHubContext finds a prerequisite', async () => {
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: stub, crossHubContext: ctxOf([HUB6], ['chat.py']) });
  assert.deepEqual(out.subTasks.map((s) => s.prerequisiteHubs), [['HUB0006'], undefined]);
  assert.match(out.subTasks[0].rawText, /PREREQUISITE CHECK/);
});

test('runDecomposePass: crossHubContext null skips the check; a context that throws fails open', async () => {
  const skip = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: stub, crossHubContext: null });
  assert.equal(skip.subTasks[0].prerequisiteHubs, undefined);
  const bad = { get hubs() { throw new Error('x'); }, existsOnMain: () => false };
  const open = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: stub, crossHubContext: bad });
  assert.equal(open.subTasks.length, 2);
});

test('buildRealContext reads another open hub from a real git repo: its branch, the files it adds, and what is on main', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhub-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(work, 'chat.py'), 'x');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'init'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'checkout', '-q', '-b', 'agent/decompose-hub6');
  fs.writeFileSync(path.join(work, 'accounts.py'), 'y');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'accounts'); git(work, 'push', '-q', 'origin', 'agent/decompose-hub6');
  git(work, 'fetch', '-q', 'origin');

  const pipelineDir = path.join(root, 'pipe');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'coordinating'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'coordinating', 'hub6.json'), JSON.stringify({ id: 'hub6', hubLabel: 'HUB0006', subTasks: [{ id: 'h6-1', phase: 'built' }, { id: 'h6-2', phase: 'open' }] }));
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', 'h6-1.json'), JSON.stringify({ id: 'h6-1', stacked: { branch: 'agent/decompose-hub6', seq: 1, total: 2 } }));
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', 'm1.json'), JSON.stringify({ id: 'm1', stacked: { branch: 'agent/decompose-hub6', seq: 1, total: 1 } })); // a fully merged hub must be ignored even though its piece names a branch
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'coordinating', 'merged.json'), JSON.stringify({ id: 'merged', hubLabel: 'HUB0001', subTasks: [{ id: 'm1', phase: 'merged' }] }));

  const { findTaskRecordById } = require('agent-manager/src/forensic-bundle.js');
  const run = (args) => git(work, ...args);
  const ctx = buildRealContext({ pipelineDir, git: run, mainBranch: 'main', findRecord: findTaskRecordById });
  assert.deepEqual(ctx.hubs, [{ label: 'HUB0006', branch: 'agent/decompose-hub6', filesAdded: ['accounts.py'] }]);
  assert.equal(ctx.existsOnMain('chat.py'), true);
  assert.equal(ctx.existsOnMain('accounts.py'), false);
  const r = findCrossHubPrerequisites([piece('t', 'Read accounts.py and chat.py')], ctx);
  assert.deepEqual(r[0].map((x) => x.files), [['accounts.py']]);
  const own = buildRealContext({ pipelineDir, git: run, mainBranch: 'main', ownBranch: 'agent/decompose-hub6', findRecord: findTaskRecordById });
  assert.deepEqual(own.hubs, [], 'the task\'s own chain is skipped');
});

test('buildRealContext with no coordinating dir gives no hubs', () => {
  const ctx = buildRealContext({ pipelineDir: fs.mkdtempSync(path.join(os.tmpdir(), 'xhub-empty-')), git: () => '', mainBranch: 'main', findRecord: () => null });
  assert.deepEqual(ctx.hubs, []);
});
