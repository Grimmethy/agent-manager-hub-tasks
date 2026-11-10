'use strict';

// The record the coordinator sweep reads for one hub piece. core's findTaskRecordById returns the FIRST queue state that holds the id, in its fixed order (pending and adhoc before
// done). A piece that was carried by hand (act-as-local-agent) leaves its ORIGINAL in pending/ or adhoc/ while the applied copy sits in done/: the original masked the delivered
// work, the piece read 'in-progress' for ever and its hub could never complete (2026-11-10, HUB0364 and HUB0365: seven pieces applied, both hubs stuck). An applied copy in done/ now
// wins over a copy of the same id that is still waiting in a live queue; every other case is exactly what findTaskRecordById answers.

const fs = require('node:fs');
const path = require('node:path');

const LIVE_STATES = ['pending', 'adhoc', 'approved', 'review', 'blocked', 'needs-clarification', 'awaiting-confirm', 'coordinating'];

function readJson(file, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; }
}

// -> { task, state, file } | null. `find` is core's findTaskRecordById (injectable).
function findChildRecord(pipelineDir, id, find, fsImpl = fs) {
  const found = find(pipelineDir, id);
  if (!found || !LIVE_STATES.includes(found.state)) return found;
  const file = path.join(pipelineDir, 'queue', 'done', `${id}.json`);
  const done = readJson(file, fsImpl);
  if (done && done.id === id && done.status === 'done') return { task: done, state: 'done', file };
  return found;
}

module.exports = { findChildRecord, LIVE_STATES };
