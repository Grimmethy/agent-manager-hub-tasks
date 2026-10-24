'use strict';

// Decompose-only pass (2026-09-02). A single model call -- NO tool loop, so it cannot run
// out of turns -- that decides whether an adhoc task is one focused implementation pass or
// a set of independent pieces, and if the latter, produces the sub-task JSON the
// coordinator machinery already consumes (parseSubTaskProposals -> queueSubTasks ->
// queue/coordinating/ -> coordinator-sweep.js).
//
// Producer 1 (adhoc decompose), moved from agent-manager core's src/decompose-pass.js (S4b
// of the hub-tasks extraction, 2026-09-25). See Docs/hub-tasks-extraction-plan.md
// (agent-manager repo). queueSubTasks/coordinator-sweep.js (the hub kernel) stay in core
// until S5; this module only proposes sub-tasks, it never files a hub itself.
//
// Three callers, all in core, reached through decompose-pass-route.js's swap point
// (register() below installs this as core's decompose-pass runner):
//   - the PRELIMINARY check (local-draft.js draftAdhocBranch), run after the blind plan
//     and BEFORE any agentic tier -- catches "this is 5 endpoints + a UI + tests" up front
//     instead of burning a 35-turn tier-3 pass on it.
//   - the SCOPE-COMPLEXITY gate (local-agentic-write-draft.js), also preliminary mode, for
//     a task judged structurally too broad before the first model call.
//   - the POST-EXHAUSTION / REPEATED-DECOMPOSE backstop (local-agentic-write-draft.js's
//     runGiveUpSplit) -- a rare safety net for a task that blew its whole tier-3 budget
//     without a single edit, or answered RESOLUTION: decompose twice without usable JSON.

const { parseSubTaskProposals } = require('agent-manager/src/agentic-draft-common.js');
const { rawSubtaskItems, attachFiles, normalizeFiles } = require('./piece-files.js');
const { resolveContradictions } = require('./piece-lint.js');
const { annotateWithImpact, gitGrep } = require('./impact-files.js');
const { validContract, withContract, gitRepoHas, annotateUnverifiedNames } = require('./contract-block.js');
const { findCrossHubPrerequisites, annotateWithPrerequisites, buildRealContext } = require('./cross-hub-prereqs.js');

// The size/shape rule the local model needs spelled out -- its whole failure mode is
// "many edits scattered through a 6000-line file", which a new self-contained module
// sidesteps.
const ONE_FILE_RULE = 'Each piece must touch ONE file. Strongly prefer a NEW self-contained file/module over pieces that need edits scattered through a large existing file -- a fresh file written in one pass is what the local model can actually land; broad surgery in a big file is what it fails at.';

// Asked for in both prompts: the declared scope the diff-sanity gate reads (piece-files.js). 2026-10-23: pieces without it were judged by a keyword scan.
// Asked for in the preliminary prompt (the object form can carry a top-level key; the bare-array form of the other prompt cannot, so it is not asked there).
const CONTRACT_HINT = 'Optionally add a top-level "contract": a short string (at most 2000 characters) listing the exact names (functions, JSON fields, file formats, environment variables) that MORE THAN ONE subtask relies on, each with where it is defined or "DEFINED BY SUBTASK n". Pieces are drafted separately; this is how they agree on names.';

const FILES_HINT = 'Add "files": [exact repo-relative paths the piece creates or edits] to EVERY subtask. A docs-only piece lists only its doc paths. Any file the piece text names as something to change or add to MUST be in its files.';

function preliminaryPrompt(task) {
  const ctx = (task && task.promptContext) || {};
  return [
    'You are assessing whether a task should be split BEFORE anyone tries to implement it.',
    '',
    'TASK:',
    (ctx.rawText || task.title || '').trim(),
    '',
    'A plan for it:',
    (task.planResponse || '(none)').trim(),
    '',
    ...(task && typeof task._decomposeHint === 'string' && task._decomposeHint.trim()
      ? ['A plan reviewer suspected this is too large to land in one pass:', task._decomposeHint.trim(), '']
      : []),
    'Decide: is this ONE atomic change that a single focused implementation pass can land,',
    'or does it span multiple INDEPENDENT files / subsystems / deliverables that should',
    'each be their own piece? Touching 2-3 spots in ONE file is still ONE pass -- only split',
    'when it is genuinely multi-part.',
    '',
    ONE_FILE_RULE,
    '',
    'Answer with ONLY a JSON object, nothing else:',
    '{"one_pass": true}',
    'OR',
    // 2026-09-08, same length-bound fix as local-agentic-write-draft.js's identical
    // instruction -- see its own header for the real incident (a decompose response cut
    // off mid-JSON writing an over-long rawText, blocking the task) this closes.
    '{"one_pass": false, "subtasks": [{"title": "short imperative title", "rawText": "a 2-4 sentence description of just this piece -- someone implementing only this should not need the original task open, but keep it brief"}, ...]}',
    'Optionally add "after": N to a subtask (N = 0-based index of an EARLIER subtask it cannot start until that one is merged, e.g. it edits a file the earlier one creates).',
    FILES_HINT,
    CONTRACT_HINT,
    'Give 2 to 6 subtasks when splitting.',
  ].join('\n');
}

function postExhaustionPrompt(task, priorInvestigation, priorAttempt, opener) {
  const ctx = (task && task.promptContext) || {};
  return [
    opener || 'A full implementation attempt just exhausted its entire turn budget without making a single edit. This task IS too large for one pass -- do not second-guess that. Your job is to split it well.',
    '',
    'TASK:',
    (ctx.rawText || task.title || '').trim(),
    '',
    'A rough (unverified, blind) plan for it:',
    (task.planResponse || '(none)').trim(),
    priorInvestigation ? `\nWhat a read-only investigation pass already found:\n${priorInvestigation}` : '',
    priorAttempt ? `\nWhat the failed implementation pass explored:\n${priorAttempt}` : '',
    '',
    ONE_FILE_RULE,
    '',
    'Answer with ONLY a JSON array, nothing else:',
    '[{"title": "short imperative title", "rawText": "a 2-4 sentence description of just this piece"}, ...]',
    FILES_HINT,
    'Optionally add "after": N (0-based index of an EARLIER piece it depends on). Give 2 to 6 pieces that together cover the whole task with nothing dropped. Keep each rawText to 2-4 sentences -- with up to 6 pieces, a verbose description per piece risks the whole array getting cut off before it finishes.',
  ].filter(Boolean).join('\n');
}

// Strip a qwen3-style reasoning block. Native Ollama `think` is supposed to keep it out of
// message.content, but confirmed live 2026-09-02 (second-brain note-graph decompose): with
// think:true the 27B leaked a `<think> ... [lists] ... </think>` prefix into the response,
// and parseSubTaskProposals' greedy `/\[[\s\S]*\]/` then matched from the first `[` INSIDE
// the reasoning to the last `]` of the real array -> unparseable -> null every time, while
// the exact same prompt with think:false produced a clean, valid 3-subtask array. Belt and
// braces alongside the think:false switch in runDecomposePass below.
function stripReasoningBlock(text) {
  let out = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  // An unclosed <think> (ran out of budget mid-reasoning) -- drop everything up to it.
  const openIdx = out.search(/<think>/i);
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out.trim();
}

// Pull the JSON object OR array out of the model's answer and hand the subtask list to
// the existing parser. Returns { subTasks } (>= 2) or null.
function extractSubTasks(text) {
  const raw = stripReasoningBlock(text);
  // Try an object with a `subtasks` key first (preliminary mode).
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      if (obj && obj.one_pass === true) return null;
      if (obj && Array.isArray(obj.subtasks)) {
        const subs = parseSubTaskProposals(JSON.stringify(obj.subtasks));
        if (subs && subs.length >= 2) {
          const contract = validContract(obj.contract);
          return { subTasks: attachFiles(subs, obj.subtasks), ...(contract ? { contract } : {}) };
        }
        return null;
      }
    } catch { /* fall through to array parse */ }
  }
  // Bare array (post-exhaustion mode, or a model that skipped the wrapper).
  const subs = parseSubTaskProposals(raw);
  if (subs && subs.length >= 2) return { subTasks: attachFiles(subs, rawSubtaskItems(raw)) };
  return null;
}

const REPEATED_DECOMPOSE_OPENER = 'Two separate full implementation attempts on this task both concluded it should be split (they answered RESOLUTION: decompose) but neither produced a usable list of pieces. Take that as settled: this task IS too large / too multi-part for one pass. Your only job now is to split it well.';

// task, { mode: 'preliminary' | 'post-exhaustion' | 'repeated-decompose', call?, claudeCall?, priorAttemptBlock? }
// call / claudeCall are injectable for tests; default to the real local / claude clients.
async function runDecomposePass(task, {
  mode = 'preliminary',
  call = require('agent-manager/src/local-client.js').call,
  claudeCall = null,
  priorAttemptBlock = null,
  impactGrep, // undefined = `git grep -lw` in the repo root (impact-files.js); a function(name) -> paths for tests, null skips the step
  repoHas, // undefined = `git grep -qw` in the repo root (contract-block.js); a function(name) -> boolean for tests
  crossHubContext, // undefined = read the real queue and repo; null = skip the check (tests)
} = {}) {
  const useClaude = process.env.AGENT_MANAGER_CLAUDE_DECOMPOSE === 'true';
  const doCall = useClaude
    ? (claudeCall || require('agent-manager/src/claude-client.js').call)
    : call;

  let prompt;
  if (mode === 'post-exhaustion' || mode === 'repeated-decompose') {
    const priorInvestigation = task && typeof task._priorInvestigation === 'string' ? task._priorInvestigation.trim() : '';
    const priorAttempt = typeof priorAttemptBlock === 'string' ? priorAttemptBlock.trim() : '';
    const opener = mode === 'repeated-decompose' ? REPEATED_DECOMPOSE_OPENER : undefined;
    prompt = postExhaustionPrompt(task, priorInvestigation, priorAttempt, opener);
  } else {
    prompt = preliminaryPrompt(task);
  }

  let result;
  try {
    result = useClaude
      ? await doCall({ prompt, maxTurns: 1, permissionMode: 'dontAsk' })
      // think:false, deliberately. Confirmed live 2026-09-02 (second-brain note-graph
      // task, which had been stuck in a decompose loop for 13h): with think:true the 27B
      // spends its generation budget on native reasoning and TRUNCATES the JSON array
      // mid-first-subtask (~670 chars, no closing `]`) -> extractSubTasks null every time.
      // The exact same prompt with think:false returns a complete, valid multi-subtask
      // array in ~30s. This prompt is a bounded format-transformation, not a task that
      // needs chain-of-thought.
      : await doCall({ prompt, think: false, temperature: 0.3, source: (task && task.source) || 'adhoc' });
  } catch {
    return null; // a failed decompose call is non-fatal -- the caller falls back to its normal path
  }

  const split = extractSubTasks(result && result.response);
  return split ? withCrossHubPrerequisites(withImpact(withContractAndNames(withLint(withCleanFiles(split)), repoHas), impactGrep), task, crossHubContext) : split;
}

// Mark pieces that need a file only another open hub's unmerged branch has (cross-hub-prereqs.js). `crossHubContext` is injectable for tests; the default reads the
// real queue and repo. Fails open: any error leaves the split exactly as the model produced it.
// Clean the declared `files` (piece-files.js). repoPaths comes from `git ls-files` in the repo root; any error just means no directory prefixes are known.
function withCleanFiles(split) {
  try {
    let repoPaths = [];
    try {
      const { getConfig } = require('agent-manager/src/config.js');
      repoPaths = require('child_process').execFileSync('git', ['ls-files'], { cwd: getConfig().repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }).split('\n').filter(Boolean);
    } catch { /* no directory prefixes known */ }
    return { ...split, subTasks: normalizeFiles(split.subTasks, repoPaths) };
  } catch { return split; }
}

// Clarify a piece that both forbids and edits the same file (piece-lint.js; it already fails open per piece, and split.subTasks is always an array here).
function withLint(split) {
  return { ...split, subTasks: resolveContradictions(split.subTasks) };
}

// Put the shared contract on every piece and flag names nobody defined (contract-block.js). Fails open.
function withContractAndNames(split, injected) {
  try {
    let repoHas = injected || (() => true);
    if (!injected) { try { repoHas = gitRepoHas(require('agent-manager/src/config.js').getConfig().repoRoot); } catch { /* no repo: nothing can be verified, flag nothing */ } }
    const withC = withContract(split.subTasks, split.contract);
    return { ...split, subTasks: annotateUnverifiedNames(withC, split.contract, repoHas) };
  } catch { return split; }
}

// List callers and tests of the symbols a piece changes (impact-files.js). Fails open.
function withImpact(split, injected) {
  try {
    if (injected === null) return split;
    let grep = injected;
    if (!grep) grep = gitGrep(require('agent-manager/src/config.js').getConfig().repoRoot);
    return { ...split, subTasks: annotateWithImpact(split.subTasks, { grep }) };
  } catch { return split; }
}

function withCrossHubPrerequisites(split, task, crossHubContext) {
  try {
    const ctx = crossHubContext !== undefined ? crossHubContext : realCrossHubContext(task);
    if (!ctx) return split;
    return { ...split, subTasks: annotateWithPrerequisites(split.subTasks, findCrossHubPrerequisites(split.subTasks, ctx)) };
  } catch { return split; }
}

function realCrossHubContext(task) {
  const { getConfig } = require('agent-manager/src/config.js');
  const { findTaskRecordById } = require('agent-manager/src/forensic-bundle.js');
  const { createRealGitRunner } = require('agent-manager/src/git-runner.js');
  const { pipelineDir, repoRoot } = getConfig();
  const { mainBranch } = createRealGitRunner(repoRoot);
  const git = (args) => require('child_process').execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  const ownBranch = task && task.stacked && task.stacked.branch ? task.stacked.branch : null;
  return buildRealContext({ pipelineDir, git, mainBranch, ownBranch, findRecord: findTaskRecordById });
}

function register() {
  const { setDecomposePassRunner } = require('agent-manager/src/decompose-pass-route.js');
  setDecomposePassRunner({ runDecomposePass });
}

module.exports = { runDecomposePass, extractSubTasks, ONE_FILE_RULE, REPEATED_DECOMPOSE_OPENER, register };
