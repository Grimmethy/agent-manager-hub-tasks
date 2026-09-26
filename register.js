'use strict';

// Entry point for AGENT_MANAGER_REGISTER_PATH. agent-manager's config.js ensureRegistered()
// require()s this once. See Docs/hub-tasks-extraction-plan.md (agent-manager repo) for the
// full extraction plan; this file is currently a no-op scaffold (S4b in progress) -- landing
// it in plugins.json changes nothing about the live pipeline yet.
//
// Dependency direction is one-way: this plugin imports from agent-manager/src/*; core never
// imports back. The `agent-manager` dependency is a file: link (see package.json) and MUST
// resolve, via realpath, to the exact checkout core itself runs from -- otherwise this file
// would populate a *second*, separate registry object and nothing would fire. `ls -la
// node_modules/agent-manager` must show a symlink; never run node with --preserve-symlinks.

// Producer 4 (candidate oversize / split): applyCandidateSplitAsHub, moved from core's
// apply-adhoc-diff.js (2026-09-25). Installs itself as core's candidate-split-hub filer --
// see src/candidate-split-hub.js and core's candidate-split-hub-route.js.
require('./src/candidate-split-hub.js').register();

// Producer 1 (adhoc decompose): runDecomposePass, moved from core's decompose-pass.js
// (2026-09-25). Installs itself as core's decompose-pass runner -- see
// src/decompose-pass.js and core's decompose-pass-route.js. Unlike producer 4's filer,
// core degrades gracefully (skips the preliminary/backstop decompose check) if this is
// ever unregistered -- it is on the hot path for every adhoc draft, not a rare gated path.
require('./src/decompose-pass.js').register();

// Still to move, as S4b continues:
//   - the rest of producer 1's caller-side logic: draft-context.js's draftAdhocBranch and
//     local-agentic-write-draft.js's give-up backstop / scope-complexity gate decide WHEN
//     to call the decompose pass and what to do with a split verdict -- tightly coupled to
//     core's draft-flow state (history events, task fields, the agentic tier ladder), not
//     producer-specific. They stay in core, calling through decompose-pass-route.js.
//   - the rest of producer 4's detection/routing logic: local-draft.js's
//     finalizeCandidateFulfillment is tightly coupled to core's draft-pass machinery
//     (recordImplement, appendHistoryEvent, concludeDraft) and needs its own producer hook,
//     not yet built -- it still decides candidateSplitRoute='hub' in core for now.
// The hub kernel itself (coordinator-sweep, hub-priority, stacked-grounding, hub-status-
// grounding, decompose-auto-merge, decompose-integration-gate,
// rejected-hub-disposition-backfill, queueSubTasks) stays in core until S5.
