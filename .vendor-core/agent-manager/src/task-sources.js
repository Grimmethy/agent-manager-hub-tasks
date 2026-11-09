'use strict';

// Vendored reconstruction of agent-manager core's src/task-sources.js (HUB0002 1/5,
// 2026-10-26): the node_modules/agent-manager symlink was dangling (../../agent-manager
// absent) and the core repo is not registered on this machine, so this file restores the
// one core export this repo actually consumes, grounded in its real callers:
//   - src/hub-restack.test.js:  isDependencySatisfied(dir, 'p0') === true for a stacked
//     predecessor that reached done/ WITHOUT a merge.
//   - src/coordinator-sweep.js: isDependencySatisfied gates dependsOn release during the
//     coordinator sweep; nestedHubBuilt reports whether a task's nested hub has finished
//     building all of its stacked pieces (HUB0003 nested-hub shape).
// Kept dependency-free (fs/path only) so it loads in both the hub-tasks process and any
// core-side caller.

const fs = require('fs');
const path = require('path');

// Queue states a dependency record may live in, checked most-authoritative first: a
// record that reached done/ wins over a stale copy still sitting in an earlier state.
const QUEUE_STATES = [
  'done',
  'review',
  'approved',
  'pending',
  'blocked',
  'needs-clarification',
  'awaiting-confirm',
  'coordinating',
  'adhoc',
];

// Locate the first on-disk record for a task id across the queue states. Returns
// { file, state, task } or null when the id has aged out entirely.
function findRecord(pipelineDir, id) {
  if (!pipelineDir || !id) return null;
  for (const state of QUEUE_STATES) {
    const file = path.join(pipelineDir, 'queue', state, `${id}.json`);
    if (fs.existsSync(file)) {
      let task = null;
      try {
        task = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return { file, state, task: null }; // record exists but is malformed: satisfied by location only
      }
      return { file, state, task };
    }
  }
  return null;
}

// A nested hub (the task's decomposedFrom parent, itself coordinating with its own
// subTasks) counts as BUILT when every one of its pieces has reached a terminal-good
// state: on disk in done/, or carrying a done/merged status. Any piece missing, aged
// out, or still in flight means the hub is not built yet.
function nestedHubBuilt(pipelineDir, task) {
  if (!task || !task.promptContext || typeof task.promptContext.decomposedFrom !== 'string') {
    return false;
  }
  const parent = findRecord(pipelineDir, task.promptContext.decomposedFrom);
  if (!parent || !parent.task || !Array.isArray(parent.task.subTasks) || parent.task.subTasks.length === 0) {
    return false;
  }
  return parent.task.subTasks.every((sub) => {
    const rec = findRecord(pipelineDir, sub && sub.id);
    if (!rec) return false;
    if (rec.state === 'done') return true;
    const status = rec.task && rec.task.status;
    return status === 'done' || status === 'merged';
  });
}

// A dependency on task `id` is satisfied when the record has reached a terminal-good
// state. A stacked predecessor that reached done/ is satisfied WITHOUT a merge
// (2026-09-20 PF HUB0003: waiting on an unmerged branch is exactly what released the
// nested-hub chain in hub-restack.test.js); a record in an in-flight state is instead
// satisfied when its nested hub has fully built out (nestedHubBuilt above).
function isDependencySatisfied(pipelineDir, id) {
  const rec = findRecord(pipelineDir, id);
  if (!rec) return false;
  if (rec.state === 'done') return true;
  const status = rec.task && rec.task.status;
  if (status === 'done' || status === 'merged') return true;
  return nestedHubBuilt(pipelineDir, rec.task);
}

module.exports = { QUEUE_STATES, findRecord, nestedHubBuilt, isDependencySatisfied };
