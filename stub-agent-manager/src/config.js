'use strict';

function getConfig() {
  return {
    repoRoot: process.env.AGENT_MANAGER_REPO_ROOT || '/tmp',
    pipelineDir: process.env.AGENT_MANAGER_PIPELINE_DIR || '/tmp',
  };
}

function ensureRegistered() {
  // No-op for tests
}

module.exports = { getConfig, ensureRegistered };
