'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONTRACT_MAX_CHARS, CONTRACT_MARKER, validContract, withContract, candidateNames, annotateUnverifiedNames } = require('./contract-block.js');
const { runDecomposePass, extractSubTasks } = require('./decompose-pass.js');

const piece = (title, rawText) => ({ title, rawText });

test('validContract trims, accepts up to the cap, and drops empty, non-string and over-long values', () => {
  assert.equal(validContract('  usedPercentage: number  '), 'usedPercentage: number');
  assert.equal(validContract('x'.repeat(CONTRACT_MAX_CHARS)).length, CONTRACT_MAX_CHARS);
  assert.equal(validContract('x'.repeat(CONTRACT_MAX_CHARS + 1)), undefined);
  assert.equal(validContract('   '), undefined);
  assert.equal(validContract(['a']), undefined);
  assert.equal(validContract(undefined), undefined);
});

test('withContract prepends the contract to every piece exactly once and leaves pieces alone without a contract', () => {
  const subs = [piece('a', 'do a'), piece('b', 'do b')];
  const out = withContract(subs, 'read_usage returns {fiveHour: {usedPercentage}}');
  assert.ok(out.every((s) => s.rawText.startsWith(`${CONTRACT_MARKER}\nread_usage returns`)));
  assert.ok(out[0].rawText.endsWith('\n\ndo a'));
  assert.deepEqual(withContract(out, 'read_usage returns {fiveHour: {usedPercentage}}'), out, 'idempotent');
  assert.equal(withContract(subs, undefined), subs);
  assert.equal(withContract(subs, 'x'.repeat(CONTRACT_MAX_CHARS + 1)), subs);
});

test('candidateNames finds snake_case, camelCase and upper-case code names and skips paths, file names, short and common words', () => {
  const t = 'Use `read_usage()`, `usedPercentage`, `AM_ACCOUNT_LABEL`, `src/a.js`, `sessions.py`, `list`, `id`, `Capital`, `a_b`, `JSON`, `NULL`, `read_usage`.';
  assert.deepEqual(candidateNames(t), ['read_usage', 'usedPercentage', 'AM_ACCOUNT_LABEL']);
});

test('annotateUnverifiedNames flags a name found nowhere, once per piece, listing it in the note', () => {
  const out = annotateUnverifiedNames([piece('a', 'Read `used_pct` from the file.')], '', () => false);
  assert.match(out[0].rawText, /UNVERIFIED NAMES \(found in no repo file, the shared contract or an earlier piece\): used_pct\./);
  assert.match(out[0].rawText, /needs-clarification/);
  assert.deepEqual(out[0].unverifiedNames, ['used_pct']);
});

test('names present in the repo, the contract or an earlier piece are not flagged', () => {
  const subs = [piece('a', 'Define `shared_name` here.'), piece('b', 'Use `shared_name`, `in_contract`, `in_repo`.')];
  const out = annotateUnverifiedNames(subs, 'in_contract: string', (n) => n === 'in_repo');
  assert.equal(out[1], subs[1]);
  assert.deepEqual(out[0].unverifiedNames, ['shared_name'], 'the first piece defines it: only later pieces get the earlier-piece pass');
});

test('the lookup is capped at 40 names, the list at 8 per piece, and a throwing lookup counts as present', () => {
  const names = Array.from({ length: 50 }, (_, i) => `name_${i}`);
  let calls = 0;
  const out = annotateUnverifiedNames([piece('a', names.map((n) => `\`${n}\``).join(' '))], '', () => { calls += 1; return false; });
  assert.equal(calls, 40);
  assert.equal(out[0].unverifiedNames.length, 8);
  const safe = annotateUnverifiedNames([piece('a', 'Use `risky_name`.')], '', () => { throw new Error('x'); });
  assert.equal(safe[0].unverifiedNames, undefined);
});

test('extractSubTasks returns a valid contract from the object form and none otherwise', () => {
  const body = (c) => JSON.stringify({ one_pass: false, subtasks: [{ title: 'a', rawText: 'x' }, { title: 'b', rawText: 'y' }], ...(c === undefined ? {} : { contract: c }) });
  assert.equal(extractSubTasks(body('usedPercentage: number')).contract, 'usedPercentage: number');
  assert.equal('contract' in extractSubTasks(body()), false);
  assert.equal('contract' in extractSubTasks(body('z'.repeat(CONTRACT_MAX_CHARS + 1))), false);
});

test('the preliminary prompt asks for a contract; runDecomposePass puts it on every piece and flags unverified names', async () => {
  let prompt = '';
  const response = JSON.stringify({ one_pass: false, contract: 'usedPercentage: number, defined by subtask 1', subtasks: [
    { title: 'Writer', rawText: 'Create the writer that stores `usedPercentage`.' },
    { title: 'Reader', rawText: 'Read `usedPercentage` and `reset_after` from the snapshot.' },
  ] });
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, {
    call: async (o) => { prompt = o.prompt; return { response }; }, crossHubContext: null, repoHas: () => false,
  });
  assert.match(prompt, /Optionally add a top-level "contract"/);
  assert.ok(out.subTasks.every((s) => s.rawText.startsWith(CONTRACT_MARKER)));
  assert.equal(out.subTasks[0].unverifiedNames, undefined, 'usedPercentage is in the contract');
  assert.deepEqual(out.subTasks[1].unverifiedNames, ['reset_after']);
});

test('runDecomposePass without a contract and with every name known leaves the pieces as extracted', async () => {
  const response = JSON.stringify({ one_pass: false, subtasks: [{ title: 'a', rawText: 'Use `known_name`.' }, { title: 'b', rawText: 'Do b.' }] });
  const out = await runDecomposePass({ source: 'manual', promptContext: { rawText: 'x' } }, { call: async () => ({ response }), crossHubContext: null, repoHas: () => true });
  assert.equal(out.subTasks[0].rawText, 'Use `known_name`.');
  assert.equal(out.subTasks[1].rawText, 'Do b.');
});
