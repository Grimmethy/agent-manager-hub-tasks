'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runIntegrationGate } = require('./decompose-integration-gate.js');

// Fake exec: records every call; throws the paired Error when the joined command
// contains the pattern, otherwise returns ''.
function fakeExec(handlers = []) {
  const calls = [];
  return {
    calls,
    exec: (file, args) => {
      const cmd = `${file} ${args.join(' ')}`;
      calls.push(cmd);
      for (const [pattern, resp] of handlers) {
        if (cmd.includes(pattern)) {
          if (resp instanceof Error) throw resp;
          return resp;
        }
      }
      return '';
    },
  };
}

// A non-Python source makes the gate stop right after setup (language skip), so the
// only exec calls are fetch, worktree add, then the cleanup commands.
function run(f) {
  return runIntegrationGate({
    repoRoot: '/repo', branch: 'agent/decompose-x', mainBranch: 'master',
    sourceFile: 'templates/index.html', exec: f.exec,
  });
}

test('failing worktree remove: does not throw, warns with path and error message', () => {
  const f = fakeExec([['worktree remove', new Error('boom-worktree')]]);
  let res;
  assert.doesNotThrow(() => { res = run(f); });
  assert.ok(f.calls.some((c) => c.includes('worktree remove')), 'worktree remove was attempted');
  assert.ok(Array.isArray(res.cleanupWarnings));
  const wtPath = f.calls.find((c) => c.startsWith('git worktree add')).split(' ')[4];
  const warning = res.cleanupWarnings.find((w) => w.includes('boom-worktree'));
  assert.ok(warning, 'a warning carries the error message');
  assert.match(warning, /worktree cleanup failed/);
  assert.ok(warning.includes(wtPath), 'warning names the worktree path');
});

test('failing ref delete: does not throw, warns with ref and error message', () => {
  const f = fakeExec([['update-ref -d refs/decompose-gate/branch', new Error('boom-ref')]]);
  let res;
  assert.doesNotThrow(() => { res = run(f); });
  assert.ok(f.calls.some((c) => c.includes('update-ref -d refs/decompose-gate/branch')));
  assert.ok(Array.isArray(res.cleanupWarnings));
  const warning = res.cleanupWarnings.find((w) => w.includes('boom-ref'));
  assert.ok(warning, 'a warning carries the error message');
  assert.match(warning, /worktree cleanup failed/);
  assert.ok(warning.includes('refs/decompose-gate/branch'), 'warning names the ref');
  assert.equal(res.ok, true);
});

test('successful cleanup: no cleanupWarnings property on the result', () => {
  const f = fakeExec();
  const res = run(f);
  assert.ok(f.calls.some((c) => c.includes('worktree remove')));
  assert.ok(f.calls.some((c) => c.includes('update-ref -d')));
  assert.equal(res.cleanupWarnings, undefined);
  assert.ok(!('cleanupWarnings' in res));
  assert.equal(res.ok, true);
});
