'use strict';

// Producer 4 (candidate oversize / split), moved from agent-manager core's
// apply-adhoc-diff.js (S4b of the hub-tasks extraction, 2026-09-25). See
// Docs/hub-tasks-extraction-plan.md (agent-manager repo) sections 3-4.
//
// A candidate-fulfillment task (function_length_fix, pipeline_forensics_fix, ...) whose
// implement pass judged the fix too big for one pass proposes `{"mode":"split"}`
// sub-candidates. The candidate-doc split only files MORE candidates, and is disabled for
// sources whose candidates are already decompositions (noCandidateSplit) or already one
// level deep (Split-Depth >= 1): those used to BLOCK "for a human to narrow the fix"
// (PropertyForager function-length-fix-ac-2, arch-review-ac-6). Adhoc tasks that are too
// big already have a full system for this -- sub-tasks with ordering, a coordinator hub
// with a checklist, stacked branches -- so a hub-routed split
// (task.candidateSplitRoute === 'hub') is converted into exactly that.
//
// Every piece is chained after the previous one: a candidate names ONE function/file, so
// its pieces edit the same code, and pieces running in parallel on separate branches would
// conflict at merge. The chain (queueSubTasks' `after` -> dependsOn + one shared stacked
// branch) serialises them onto a single branch. Each child is an ordinary adhoc task
// carrying `decomposedFrom`, which core's draft passes read as "a confirmed-atomic leaf --
// do not split again".
function candidateSplitToSubTasks(task) {
  const proposals = Array.isArray(task.candidateSplitProposals) ? task.candidateSplitProposals : [];
  const pc = task.promptContext || {};
  const total = proposals.length;
  const parentLabel = [pc.candidateId, pc.title || task.title].filter(Boolean).join(' -- ');
  return proposals.map((c, i) => {
    const others = proposals.filter((_, j) => j !== i).map((o) => o.title).filter(Boolean);
    const rawText = [
      `Part ${i + 1} of ${total} of a fix that was too large for one pass${parentLabel ? `: ${parentLabel}` : ''}.`,
      c.files ? `Files: ${c.files}` : null,
      '',
      `THIS PART: ${c.title}`,
      '',
      `Problem: ${c.problem}`,
      '',
      `Solution: ${c.solution}`,
      c.benefits ? `\nBenefits: ${c.benefits}` : null,
      '',
      `Scope: implement ONLY this part. Do not do the other part${others.length === 1 ? '' : 's'} (${others.join('; ')}) -- ${others.length === 1 ? 'it is a separate task' : 'they are separate tasks'}${i > 0 ? ', and the earlier part(s) are already in the code you are editing' : ''}. Leave everything else unchanged.`,
    ].filter((l) => l !== null).join('\n');
    const sub = { title: c.title, rawText };
    if (i > 0) sub.after = i - 1;
    return sub;
  });
}

// queueSubTasks (the hub kernel primitive -- files each piece, wires the stacked branch,
// mints the hub serial) stays in agent-manager core until S5.
const { queueSubTasks } = require('agent-manager/src/apply-adhoc-diff.js');

function applyCandidateSplitAsHub(task, pipelineDir) {
  const subTasks = candidateSplitToSubTasks(task);
  if (subTasks.length < 2) {
    throw new Error(`task ${task.id}: a hub-routed candidate split needs at least 2 sub-candidates (got ${subTasks.length})`);
  }
  const queued = queueSubTasks(subTasks, pipelineDir, task.id, task);
  return {
    coordinating: true,
    reason: `Candidate too large for one pass -- decomposed into ${queued.length} chained sub-task(s), now coordinating: ${queued.map((t) => t.title).join('; ')}`,
    subTasks: queued.map((t) => ({ id: t.id, title: t.title, status: 'pending' })),
    hubSerial: queued.hubSerial,
    hubLabel: queued.hubLabel,
  };
}

function register() {
  const { setCandidateSplitHubFiler } = require('agent-manager/src/candidate-split-hub-route.js');
  setCandidateSplitHubFiler({ applyCandidateSplitAsHub });
}

module.exports = { candidateSplitToSubTasks, applyCandidateSplitAsHub, register };
