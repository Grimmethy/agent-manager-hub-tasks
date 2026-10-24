'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findContradictions, resolveContradictions } = require('./piece-lint.js');
const { runDecomposePass } = require('./decompose-pass.js');

const piece = (rawText, extra = {}) => ({ title: 'Add host-aware tests', rawText, ...extra });
const HUB11 = 'Add host-aware tests to test/sessions-view.test.mjs. Do NOT touch test/sessions-view.test.mjs or static/sessions-view.js beyond the tests you add.';

test('the HUB0011-02 shape: a restriction sentence and an edit sentence naming the same file is a contradiction', () => {
  const found = findContradictions(piece(HUB11));
  assert.deepEqual(found.map((f) => f.path), ['test/sessions-view.test.mjs', 'static/sessions-view.js'].filter((p) => p === 'test/sessions-view.test.mjs'));
  assert.match(found[0].forbiddenBy, /Do NOT touch/);
  assert.match(found[0].requiredBy, /Add host-aware tests/);
});

test('a clean piece has no contradiction', () => {
  assert.deepEqual(findContradictions(piece('Add tests to test/a.test.js. Do not touch static/b.js.')), []);
});

test('a file that is only forbidden, never edited, is not a contradiction', () => {
  assert.deepEqual(findContradictions(piece('Create src/x.js. Never modify src/legacy.js.')), []);
});

test('"change nothing other than X" names the allowed set, not a ban', () => {
  assert.deepEqual(findContradictions(piece('Edit src/a.js. Do not change anything other than src/a.js.')), []);
});

test('a declared Files: line or files array counts as an edit target', () => {
  assert.equal(findContradictions(piece('Do not touch docs/x.md.\nFiles: docs/x.md')).length, 1);
  assert.equal(findContradictions(piece('Do not touch docs/x.md.', { files: ['docs/x.md'] })).length, 1);
});

test('several contradictory paths are all reported, matching by path suffix', () => {
  const found = findContradictions(piece('Update a.js and b/c.js. Do not edit a.js or src/b/c.js.'));
  assert.deepEqual(found.map((f) => f.path).sort(), ['a.js', 'src/b/c.js']);
});

test('resolveContradictions appends one NOTE sentence and lintNotes; clean pieces are returned as the same object', () => {
  const clean = piece('Create src/x.js.');
  const out = resolveContradictions([piece(HUB11), clean]);
  assert.match(out[0].rawText, /\n\nNOTE: test\/sessions-view\.test\.mjs is an edit target of this piece; the restriction above applies to every other file\.$/);
  assert.deepEqual(out[0].lintNotes, ['forbidden-and-required: test/sessions-view.test.mjs']);
  assert.equal(out[1], clean);
});

test('resolveContradictions fails open on malformed input', () => {
  const weird = { title: null, rawText: { not: 'a string' } };
  assert.doesNotThrow(() => resolveContradictions([weird, null].filter(Boolean)));
  assert.equal(resolveContradictions([weird])[0], weird);
});

test('runDecomposePass annotates a contradictory piece', async () => {
  const response = JSON.stringify({ one_pass: false, subtasks: [{ title: 'Tests', rawText: HUB11 }, { title: 'Other', rawText: 'Create src/y.js.' }] });
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: async () => ({ response }), crossHubContext: null });
  assert.match(out.subTasks[0].rawText, /NOTE: test\/sessions-view\.test\.mjs is an edit target/);
  assert.equal(out.subTasks[1].rawText, 'Create src/y.js.');
});

test('a path that is only mentioned (no edit verb) does not make a banned path a contradiction', () => {
  assert.deepEqual(findContradictions(piece('Read src/a.js for context. Do not touch src/a.js.')), []);
});

test('resolveContradictions leaves a piece untouched when the check itself throws', () => {
  const bad = { title: 't', rawText: 'Do not touch src/a.js. Edit src/a.js.', get files() { throw new Error('boom'); } };
  assert.equal(resolveContradictions([bad])[0], bad);
});

test('runDecomposePass lints against the declared files: a banned path that is in the piece\'s files array is a contradiction', async () => {
  const response = JSON.stringify({ one_pass: false, subtasks: [
    { title: 'Tests', rawText: 'Cover the new helper. Do not touch test/helper.test.mjs.', files: ['test/helper.test.mjs'] },
    { title: 'Other', rawText: 'Create src/y.js.' },
  ] });
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: async () => ({ response }), crossHubContext: null });
  assert.match(out.subTasks[0].rawText, /NOTE: test\/helper\.test\.mjs is an edit target/);
  assert.deepEqual(out.subTasks[0].files, ['test/helper.test.mjs']);
});
