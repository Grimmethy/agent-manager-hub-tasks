# agent-manager-hub-tasks

The hub-task kernel and task-level producers (adhoc decompose, candidate split) for the
[agent-manager](https://github.com/Grimmethy/agent-manager) pipeline, extracted out of core
per `Docs/hub-tasks-extraction-plan.md` (agent-manager repo).

**Status: scaffold only (S4b in progress).** `register.js` is currently a no-op. No hub-task
code has moved here yet. See the extraction plan and `Docs/hub-tasks-extraction-map.md` (also
in the agent-manager repo) for the full picture of what will land here and in what order.

## Layering

```
agent-manager (core)        the platform: queue, workers, dashboard shell, plugin registry, hooks
agent-manager-hub-tasks     (this repo) the hub KERNEL + task-level producers (adhoc decompose,
                             candidate split); product-spec producer location undecided
agent-manager-hygiene       the code size-reduction cycle (function/file/repo); already owns the
                             file-decompose producer family (moved 2026-09-24, S4a)
```

## What lands here, and when

- **S4b**: the task-level producers — producer 1 (adhoc decompose: `decompose-pass.js`,
  `draft-context.js`'s `draftAdhocBranch`, `local-agentic-write-draft.js` backstops,
  `agentic-draft-common.js`'s `parseSubTaskProposals`) and producer 4 (candidate oversize:
  `local-draft.js`'s `finalizeCandidateFulfillment`, `apply-adhoc-diff.js`'s
  `candidateSplitToSubTasks`/`applyCandidateSplitAsHub`, `lib/candidate-split-route.js`,
  `prompts.js`'s `candidateSplitInstructions`/`offersCandidateSplit`), moved behind the
  claim-ordering, apply-result-routing, and review/draft hooks S1-S3 already built in core.
- **S5**: the hub kernel itself (`coordinator-sweep.js`, `hub-priority.js`,
  `stacked-grounding.js`, `hub-status-grounding.js`, `decompose-auto-merge.js`,
  `decompose-integration-gate.js`, `rejected-hub-disposition-backfill.js`, `queueSubTasks` /
  the `applyAdhocDiff` decompose branch) and the Hub Tasks dashboard tab (via the manifest tab
  slot built in S0). This is the one deploy window that freezes hub production.
- **S6**: retiring the legacy stacked-hub machinery, after S5 is live.

## Development

```
npm install   # links ../agent-manager via a file: dependency -- must resolve, via realpath,
              # to the exact checkout core itself runs from
npm test
```
