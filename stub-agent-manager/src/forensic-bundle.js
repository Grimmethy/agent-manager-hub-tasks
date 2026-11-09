'use strict';

function findTaskRecordById(pipelineDir, taskId) {
  const fs = require('fs');
  const path = require('path');
  const states = ['coordinating', 'adhoc', 'blocked', 'needs-clarification', 'done', 'review', 'approved', 'awaiting-confirm'];
  for (const state of states) {
    const file = path.join(pipelineDir, 'queue', state, `${taskId}.json`);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

module.exports = { findTaskRecordById };
