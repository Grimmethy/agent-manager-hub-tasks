'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_FILES, rawSubtaskItems, attachFiles, normalizeFiles } = require('./piece-files.js');
const { runDecomposePass, extractSubTasks } = require('./decompose-pass.js');
const pass = require('./decompose-pass.js');

const piece = (title, files) => ({ title, rawText: `do ${title}`, ...(files ? { files } : {}) });

test('rawSubtaskItems reads the object form and the bare array form, and never throws', () => {
  assert.equal(rawSubtaskItems('{"one_pass": false, "subtasks": [{"title":"a"},{"title":"b"}]}').length, 2);
  assert.equal(rawSubtaskItems('here: [{"title":"a"},{"title":"b"}] done').length, 2);
  assert.deepEqual(rawSubtaskItems('<think>[1]</think> nothing useful'), []);
  assert.deepEqual(rawSubtaskItems(undefined), []);
});

test('attachFiles gives a parsed subtask the files its raw item declared, by title, without overriding existing files', () => {
  const out = attachFiles([piece('a'), piece('b', ['kept.js']), piece('c')], [{ title: 'a', files: ['x.js'] }, { title: 'b', files: ['y.js'] }]);
  assert.deepEqual(out.map((s) => s.files), [['x.js'], ['kept.js'], undefined]);
});

test('normalizeFiles keeps repo-relative paths, drops prose, URLs, absolute and parent paths, deduplicates and caps', () => {
  const many = Array.from({ length: MAX_FILES + 4 }, (_, i) => `src/f${i}.js`);
  const out = normalizeFiles([
    piece('a', ['README.md', ' ./src/a.js ', 'src/a.js', 'the main module', 'https://x.io/a.js', '/etc/passwd', '../up.js', 7, '']),
    piece('b', many),
    piece('c', ['nothing here']),
    piece('d'),
  ]);
  assert.deepEqual(out[0].files, ['README.md', 'src/a.js']);
  assert.equal(out[1].files.length, MAX_FILES);
  assert.equal('files' in out[2], false, 'a piece left with no usable files loses the field');
  assert.equal('files' in out[3], false);
});

test('normalizeFiles accepts a directory only when it is a prefix of a known repo path', () => {
  const known = ['src/lib/x.js'];
  assert.deepEqual(normalizeFiles([piece('a', ['src/lib', 'nodir'])], known)[0].files, ['src/lib']);
});

const WITH_FILES = JSON.stringify({ one_pass: false, subtasks: [
  { title: 'Add module', rawText: 'Create src/m.js.', files: ['src/m.js'] },
  { title: 'Docs', rawText: 'Document it.', files: ['README.md', 'a bad entry'] },
] });

test('the preliminary and post-exhaustion prompts both ask for files on every subtask', async () => {
  const seen = [];
  const call = async ({ prompt }) => { seen.push(prompt); return { response: WITH_FILES }; };
  await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call, crossHubContext: null });
  await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call, mode: 'post-exhaustion', crossHubContext: null });
  assert.equal(seen.length, 2);
  for (const p of seen) assert.match(p, /Add "files": \[exact repo-relative paths the piece creates or edits\] to EVERY subtask/);
});

test('runDecomposePass returns cleaned files per piece (valid kept, prose dropped)', async () => {
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: async () => ({ response: WITH_FILES }), crossHubContext: null });
  assert.deepEqual(out.subTasks.map((s) => s.files), [['src/m.js'], ['README.md']]);
});

test('extractSubTasks without any files leaves pieces exactly as before', () => {
  const out = extractSubTasks(JSON.stringify({ one_pass: false, subtasks: [{ title: 'a', rawText: 'x' }, { title: 'b', rawText: 'y' }] }));
  assert.equal('files' in out.subTasks[0], false);
});

test('extractSubTasks keeps declared files in the bare-array form too (post-exhaustion answers)', () => {
  const out = extractSubTasks('[{"title":"a","rawText":"x","files":["src/a.js"]},{"title":"b","rawText":"y","files":["src/b.js"]}]');
  assert.deepEqual(out.subTasks.map((s) => s.files), [['src/a.js'], ['src/b.js']]);
});
