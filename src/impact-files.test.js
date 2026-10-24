'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_NAMES, MAX_FILES, changedNames, impactNote, annotateWithImpact } = require('./impact-files.js');
const { runDecomposePass } = require('./decompose-pass.js');

const piece = (rawText, title = 'Change the listing') => ({ title, rawText });
const grepOf = (map) => ({ grep: (n) => map[n] || [] });

test('changedNames finds backticked names in a sentence with a change verb and skips short, common and creation-sentence names', () => {
  const p = piece('Change `list_sessions` to return a dict. Create `new_helper` in src/h.js. Use `other_name` for logging. Update `get` and `id`.');
  assert.deepEqual(changedNames(p), ['list_sessions']);
});

test('changedNames skips whole creation sentences, names under 4 characters and common words, and deduplicates', () => {
  assert.deepEqual(changedNames(piece('Create `fresh_func` and rename `fresh_func`.')), []);
  assert.deepEqual(changedNames(piece('Change `a_b`, `name`, `data`, `list` and `real_name`.')), ['real_name']);
  assert.deepEqual(changedNames(piece('Rename `dup_name` and `dup_name`.')), ['dup_name']);
});

test('changedNames caps the list at 8', () => {
  const names = Array.from({ length: 12 }, (_, i) => `\`func_${i}\``).join(', ');
  const found = changedNames(piece(`Rename ${names}.`));
  assert.equal(found.length, MAX_NAMES);
});

test('impactNote lists the files that use a changed symbol, tests first, and leaves out files the piece already names', () => {
  const p = piece('Change `list_sessions` so it returns a dict. Edit agent_client.py.');
  const note = impactNote(p, grepOf({ list_sessions: ['agent_client.py', 'routes/chat.py', 'test_agent_client.py', 'tests/test_routes.py'] }));
  assert.match(note, /^ALSO CHECK \(callers and tests of the symbols you change\): list_sessions: test_agent_client\.py, tests\/test_routes\.py, routes\/chat\.py\./);
  assert.doesNotMatch(note, /(?:: |, )agent_client\.py/);
  assert.match(note, /update these in the same piece\.$/);
});

test('impactNote caps files per name at 10 and gives null when nothing uses the symbol or the lookup throws', () => {
  const many = Array.from({ length: 15 }, (_, i) => `src/f${i}.js`);
  const note = impactNote(piece('Change `big_symbol`.'), grepOf({ big_symbol: many }));
  assert.equal(note.match(/src\/f\d+\.js/g).length, MAX_FILES);
  assert.equal(impactNote(piece('Change `lonely_symbol`.'), grepOf({})), null);
  assert.equal(impactNote(piece('Change `risky_symbol`.'), { grep: () => { throw new Error('x'); } }), null);
});

test('annotateWithImpact appends the note and impactNotes to a piece, returns other pieces as the same object, and tolerates no context', () => {
  const a = piece('Change `list_sessions`.');
  const b = piece('Add a docs paragraph.');
  const out = annotateWithImpact([a, b], grepOf({ list_sessions: ['test_x.py'] }));
  assert.match(out[0].rawText, /\n\nALSO CHECK .*list_sessions: test_x\.py/);
  assert.equal(out[0].impactNotes.length, 1);
  assert.equal(out[1], b);
  assert.deepEqual(annotateWithImpact([a], null), [a]);
  assert.deepEqual(annotateWithImpact([a], {}), [a]);
});

const RESPONSE = JSON.stringify({ one_pass: false, subtasks: [
  { title: 'Reshape', rawText: 'Change `list_sessions` to return a dict.' },
  { title: 'Docs', rawText: 'Document it.' },
] });

test('runDecomposePass adds the note when the injected grep finds users, and impactGrep null skips the step', async () => {
  const opts = { call: async () => ({ response: RESPONSE }), crossHubContext: null, repoHas: () => true };
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { ...opts, impactGrep: (n) => (n === 'list_sessions' ? ['test_agent_client.py'] : []) });
  assert.match(out.subTasks[0].rawText, /ALSO CHECK .*list_sessions: test_agent_client\.py/);
  assert.equal(out.subTasks[1].rawText, 'Document it.');
  const skipped = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { ...opts, impactGrep: null });
  assert.equal(skipped.subTasks[0].rawText, 'Change `list_sessions` to return a dict.');
});

test('runDecomposePass fails open when the grep throws', async () => {
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, {
    call: async () => ({ response: RESPONSE }), crossHubContext: null, repoHas: () => true, impactGrep: () => { throw new Error('boom'); },
  });
  assert.equal(out.subTasks.length, 2);
  assert.equal(out.subTasks[0].rawText, 'Change `list_sessions` to return a dict.');
});

test('the default lookup is git grep in the repo root, and impactGrep null skips the step', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'test_users.py'), 'list_sessions()\n'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  const old = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = repo;
  try {
    const opts = { call: async () => ({ response: RESPONSE }), crossHubContext: null, repoHas: () => true };
    const real = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, opts);
    assert.match(real.subTasks[0].rawText, /list_sessions: test_users\.py/);
    const skipped = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { ...opts, impactGrep: null });
    assert.equal(skipped.subTasks[0].rawText, 'Change `list_sessions` to return a dict.');
  } finally { if (old === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = old; }
});
