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

// Still to move, as S4b's producer-side work continues:
//   - the rest of producer 1's caller-side logic: draft-context.js's draftAdhocBranch and
//     local-agentic-write-draft.js's give-up backstop / scope-complexity gate decide WHEN
//     to call the decompose pass and what to do with a split verdict -- tightly coupled to
//     core's draft-flow state (history events, task fields, the agentic tier ladder), not
//     producer-specific. They stay in core, calling through decompose-pass-route.js.
//   - the rest of producer 4's detection/routing logic: local-draft.js's
//     finalizeCandidateFulfillment is tightly coupled to core's draft-pass machinery
//     (recordImplement, appendHistoryEvent, concludeDraft) and needs its own producer hook,
//     not yet built -- it still decides candidateSplitRoute='hub' in core for now.

// The hub KERNEL (S5e of the hub-tasks extraction, 2026-09-25): coordinator-sweep.js,
// hub-rename.js, hub-restack.js, decompose-auto-merge.js, decompose-integration-gate.js,
// rejected-hub-disposition-backfill.js. None of these register a task source (no
// .register(deps) call) -- coordinator-sweep.js and rejected-hub-disposition-backfill.js
// are invoked directly by agent-manager/scripts/queue-watcher.sh and
// scripts/pool-sweeps.sh as their own `node <file>.js` processes (resolved by name via
// resolve_plugin_root, S5a); the rest are required only by coordinator-sweep.js itself.
// Required here too, same reasoning as agent-manager-hygiene's own register.js: so a
// plain require('agent-manager-hub-tasks') (or a future test harness) sees the whole
// kernel, and so a require-cycle among them never depends on load order.
//
// hub-serial.js, hub-status-grounding.js, and apply-adhoc-diff.js's queueSubTasks stay in
// core permanently, not just "until S5" -- each has a core-side caller that isn't moving
// (apply-adhoc-diff.js / hub-apply-routing.js need hub-serial.js; local-draft.js /
// local-agentic-write-draft.js need hub-status-grounding.js; task-sources.js calls
// applyAdhocDiff directly), so moving them would break the one-way
// plugin-depends-on-core rule. See Docs/hub-tasks-extraction-plan.md (agent-manager repo)
// S5's row for the full correction.
//
// wire-decomposed-blueprints.js briefly moved here too, then moved BACK to core the same
// day: agent-manager-hygiene's decompose-flask-blueprint.js (moved there in S4a) also
// requires it -- a cross-plugin dependency neither plugin should have on the other.
// coordinator-sweep.js now reaches it via agent-manager/src/wire-decomposed-blueprints.js.
require('./src/coordinator-sweep.js');
require('./src/hub-rename.js');
require('./src/hub-restack.js');
require('./src/decompose-auto-merge.js');
require('./src/decompose-integration-gate.js');
require('./src/rejected-hub-disposition-backfill.js');
