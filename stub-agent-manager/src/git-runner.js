'use strict';

// Stub for git-runner.js
// Exports createRealGitRunner

function createRealGitRunner(repoRoot) {
  // Stub: return a mock git runner with default mainBranch
  return {
    mainBranch: 'master',
  };
}

module.exports = {
  createRealGitRunner,
};
