'use strict';

// Stub for task-disposition.js
// Exports taskCommitOnMain and STABLE_TERMINAL_STAGES

const STABLE_TERMINAL_STAGES = new Set(['noop', 'dismissed', 'filed', 'superseded', 'applied-direct']);

function taskCommitOnMain(repoRoot, mainBranch, taskId) {
  // Stub: always return false (no trailer found)
  return false;
}

module.exports = {
  taskCommitOnMain,
  STABLE_TERMINAL_STAGES,
};
