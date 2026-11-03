# Function Length Decomposition Candidates

### AC-1 · Decompose Integration Gate Logic
Strength: Strong
Files: src/decompose-integration-gate.js
Symbol: runIntegrationGate
Snippet:
```
// -- only for a setup failure it genuinely can't proceed past (e.g. cannot create the
// worktree), which the caller treats as an errored (not failed) gate and retries later.
function runIntegrationGate({ repoRoot, branch, mainBranch = 'master', sourceFile, routes = [], exec = realExec } = {}) {
  const checks = [];
  const srcDir = path.dirname(sourceFile);
  const srcModule = path.basename(sourceFile).replace(/\.py$/, '');
  const isPy = /\.py$/.test(sourceFile);
  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-gate-'));
  const branchWt = path.join(wtBase, 'branch');
  const mainWt = path.join(wtBase, 'main');
  // The hub branch + main only exist on origin (apply runs in a separate clone since
  // 2026-09-07 -- see this file's header). Fetch both into throwaway local refs and point
  // every git op at those instead of the bare names, which no longer resolve here.
  const branchRef = 'refs/decompose-gate/branch';
  const mainRef = 'refs/decompose-gate/main';
  const cleanup = [];

  const record = (name, status, detail) => checks.push({ name, status, detail: String(detail || '').slice(0, 2000) });
  const done = () => {
    for (const wt of cleanup) {
      try { exec('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot }); } catch { /* best-effort */ }
    }
    for (const ref of [branchRef, mainRef]) {
      try { exec('git', ['update-ref', '-d', ref], { cwd: repoRoot }); } catch { /* best-effort */ }
    }
    try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch { /* best-effort */ }
    const failed = checks.filter((c) => c.status === 'fail');
    return { ok: failed.length === 0, checks, branch };
  };

  try {
    exec('git', ['fetch', '--no-tags', '--force', 'origin',
      `${branch}:${branchRef}`, `${mainBranch}:${mainRef}`], { cwd: repoRoot });
  } catch (e) {
    record('setup', 'fail', `could not fetch ${branch} / ${mainBranch} from origin: ${e.message}`);
    return { ...done(), errored: true };
  }

  try {
    exec('git', ['worktree', 'add', '--detach', branchWt, branchRef], { cwd: repoRoot });
    cleanup.push(branchWt);
  } catch (e) {
    record('setup', 'fail', `could not create worktree for ${branch}: ${e.message}`);
    return { ...done(), errored: true };
  }

  if (!isPy) {
    record('language', 'skip', `integration gate only covers Python decompositions; ${sourceFile} left to review`);
    return done();
  }

  // 1. py_compile every changed / new .py file on the branch.
  let changed = [];
  try {
    const out = exec('git', ['diff', '--name-only', `${mainRef}...${branchRef}`], { cwd: repoRoot });
    changed = out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.py'));
  } catch (e) {
    record('py_compile', 'skip', `could not list changed files: ${e.message}`);
  }
  const toCompile = Array.from(new Set([sourceFile, ...changed])).filter((f) => fs.existsSync(path.join(branchWt, f)));
  if (toCompile.length) {
    try {
      exec('python3', ['-m', 'py_compile', ...toCompile], { cwd: branchWt });
      record('py_compile', 'pass', `${toCompile.length} file(s): ${toCompile.join(', ')}`);
    } catch (e) {
      record('py_compile', 'fail', `${(e.stderr || e.stdout || e.message)}`);
      return done();
    }
  }

  // 2. import the source module -- catches the circular import the isolated compile can't.
  try {
    exec('python3', ['-c', `import ${srcModule}`], { cwd: path.join(branchWt, srcDir), timeout: 30_000 });
    record('import', 'pass', `import ${srcModule} from ${srcDir} exits 0`);
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    // A bare ModuleNotFoundError for a third-party dep means this environment can't import
    // the app at all -- not the branch's fault. A circular import / NameError / ImportError
    // for a first-party name IS the branch's fault.
    if (/ModuleNotFoundError: No module named '(flask|werkzeug|jinja2)'/.test(msg) && !/circular|partially initialized/.test(msg)) {
      record('import', 'skip', `app dependencies not installed here: ${msg.split('\n').pop()}`);
      return done();
    }
    record('import', 'fail', msg);
    return done();
  }

  // 2b. entrypoint smoke: exec the source file's body as __main__ (how it is launched).
  // Catches the circular import that `import <srcModule>` above cannot -- the one that
  // only fires when sys.modules has no <srcModule> entry during the module body. Kill
  // switch AGENT_MANAGER_DECOMPOSE_ENTRYPOINT_SMOKE=false.
  if (process.env.AGENT_MANAGER_DECOMPOSE_ENTRYPOINT_SMOKE !== 'false') {
    const smokePath = path.join(branchWt, srcDir, '.decompose_entrypoint_smoke.py');
    try {
      fs.mkdirSync(path.dirname(smokePath), { recursive: true });
      fs.writeFileSync(smokePath, ENTRYPOINT_SMOKE);
    } catch { /* fall through -- exec will just fail to find it and we skip */ }
    let out = '';
    let smokeErr = null;
    try {
      out = String(exec('python3', ['.decompose_entrypoint_smoke.py', path.basename(sourceFile)],
        { cwd: path.join(branchWt, srcDir), timeout: 30_000 }) || '');
    } catch (e) {
      smokeErr = e;
      out = String(e.stdout || '');
    }
    try { fs.unlinkSync(smokePath); } catch { /* ignore */ }
    const smokeMsg = smokeErr ? String(smokeErr.stderr || smokeErr.stdout || smokeErr.message) : out;
    if (/IMPORT_ERROR:|ModuleNotFoundError: No module named '(flask|werkzeug|jinja2)'/.test(smokeMsg)
        && !/circular|partially initialized/.test(smokeMsg)) {
      record('entrypoint', 'skip', `app dependencies not installed here: ${smokeMsg.split('\n').filter(Boolean).pop()}`);
    } else if (smokeErr) {
      record('entrypoint', 'fail', `${srcModule} fails to execute as an entrypoint (circular import / import-time error):\n${smokeMsg}`);
      return done();
    } else {
      record('entrypoint', 'pass', `${srcModule} module body executes clean with sys.modules[${srcModule}] unset (the __main__ path)`);
    }
  }

  // 3. url_map invariant: identical route table on main and on the branch.
  try {
    exec('git', ['worktree', 'add', '--detach', mainWt, mainRef], { cwd: repoRoot });
    cleanup.push(mainWt);
  } catch (e) {
    record('url_map', 'skip', `could not create ${mainBranch} worktree: ${e.message}`);
    return done();
  }
  const dump = (wt) => {
    const p = path.join(wt, srcDir, '.decompose_url_dump.py');
    fs.writeFileSync(p, URL_MAP_DUMP);
    try { return exec('python3', ['.decompose_url_dump.py'], { cwd: path.join(wt, srcDir), timeout: 30_000 }); }
    finally { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  };
  let mainRules; let branchRules;
  try { mainRules = dump(mainWt).trim(); branchRules = dump(branchWt).trim(); } catch (e) {
    record('url_map', 'skip', `route dump failed: ${String(e.stderr || e.message).split('\n').pop()}`);
    return done();
  }
  if (mainRules.startsWith('IMPORT_ERROR') || branchRules.startsWith('IMPORT_ERROR')) {
    record('url_map', 'fail', `route dump import error -- main: ${mainRules.slice(0, 300)} | branch: ${branchRules.slice(0, 300)}`);
    return done();
  }
  let cmp;
  try { cmp = diffRouteTables(mainRules, branchRules); } catch {
    record('url_map', 'skip', 'route dump was not JSON'); return done();
  }
  if (!cmp.ok) {
    record('url_map', 'fail',
      `route table changed -- a pure relocation must not. Dropped: ${cmp.droppedRules.join(' | ') || 'none'}. Added: ${cmp.addedRules.join(' | ') || 'none'}.`);
    return done();
  }
  record('url_map', 'pass', `${cmp.count} routes, rule table unchanged (endpoints re-homed as expected)`);

  // 4. boot smoke -- opt-in (needs a runnable app + a free port).
  if (process.env.AGENT_MANAGER_DECOMPOSE_BOOT_SMOKE === 'true' && routes.length) {
    record('boot', 'skip', 'boot smoke requested but not implemented in this build -- import + url_map cover the crash modes');
  }

  return done();
}
```

Problem:
The function orchestrates six distinct, independently failing phases — worktree setup, Python compilation, import validation, entrypoint smoke, route table diff, and optional boot smoke — each with unique state, error handling, and side effects. These are not linear or conditional logic; they are semantically separate workflows that force readers to mentally track state across 158 lines, obscure failure modes (e.g., route diff errors buried under cleanup), and make unit testing or incremental modification nearly impossible without full rewrite.

Solution:
Extract each phase into its own named function: `setupWorktreesAndRefs`, `compilePythonFiles`, `validateImport`, `runEntrypointSmoke`, `compareRouteTables`, and `runBootSmoke`. Each should return a status object or throw early on failure, with the main `runIntegrationGate` orchestrating them sequentially, aggregating results via `checks` and `done()`. No shared mutable state between functions; inputs passed explicitly.

Benefits:
Readers can focus on one logical unit at a time. Unit tests can be written per phase. Changes to one phase (e.g., route diff logic) won’t require re-reviewing the entire 158-line function. Failure modes become explicit and testable — e.g., a route diff error won’t be hidden under a cleanup block.

VERDICT CONSTRAINT (mandatory for this task):
- The function snippet IS provided above in this prompt; you do not need to request it or assume it is missing.
- You MUST render exactly one verdict: GENUINE or FALSE POSITIVE.
- Refusals, hedging, or a third outcome (including "Uncertain", "I cannot determine", or any other qualifier) are NOT acceptable. Pick the one verdict that best fits the evidence in the snippet and commit to it.

VERDICT: GENUINE

### AC-2 · Coordinator Sweep Decomposition
Strength: Strong
Files: src/coordinator-sweep.js
Symbol: coordinatorSweep
Snippet:
```
}

function coordinatorSweep({ pipelineDir, repoRoot, runGate = runStackedGate, runWiring = runStackedWiring, runAutoMerge = autoMergeVerifiedMoveChild } = {}) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  // Label every hub that has no HUB#### yet (oldest first), before the loop below reads them.
  try { const labelled = assignMissingHubSerials(pipelineDir); if (labelled) summary.hubsLabelled = labelled; } catch (e) { console.warn(`[coordinator-sweep] hub serial backfill failed (advisory): ${e.message}`); }

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') { console.warn(`[coordinator-sweep] ${coordDir} does not exist yet -- nothing to sweep`); return summary; }
    summary.errors += 1;
    console.error(`[coordinator-sweep] readdirSync failed for ${coordDir}: ${err.code || 'UNKNOWN'} -- ${err.message}`);
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
      parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue; // a malformed coordinating file is not this sweep's problem to fix
    }
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      // A coordinating parent with no checklist is a bug upstream -- complete it out so it
      // does not sit here forever.
      //
      // 2026-09-14, screaminggoatclubmt: "fix the mislabeling" -- a hub that carries
      // `coordinatorBlocked` from the moment it was filed (file-decompose-to-hub.js's
      // fileBlockedHub(): validatePlan() found a hard problem, subTasks was `[]` from
      // creation, ZERO children were ever attempted) was being routed through
      // stampHubMerged() exactly like a hub whose children ALL genuinely shipped, so its
      // history read "created -> merged -> done" and the dashboard reported it as a
      // successful merge. Confirmed live: 33 `Decompose <file> -- plan needs revision`
      // records in queue/done/ carry this exact false "merged" disposition. Route the
      // rejected-at-creation case through `noop` instead (task-disposition.js's own
      // definition: "the apply produced no change... no code change") -- still stamps
      // mergedAt so any (unlikely, since no children ever existed) dependsOn sibling isn't
      // blocked forever, per stampHubMerged's own reasoning, just without the false
      // "merged" label.
      const rejectedAtCreation = !!parent.coordinatorBlocked;
      parent.status = 'done';
      parent.doneMarker = rejectedAtCreation
        ? 'coordinator hub rejected at creation -- no sub-tasks were ever filed'
        : 'coordinator had no sub-tasks -- completed';
      stampHubMerged(parent, rejectedAtCreation ? {
        disposition: 'noop',
        detail: 'coordinator hub: plan rejected at creation, no sub-tasks were ever filed',
      } : undefined);
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      // 2026-09-14, screaminggoatclubmt: "fold it into the watchdog sweep" -- file
      // straight into done/_archived_no_action/ instead of done/'s top level for the
      // rejected-at-creation case: it produced zero real work, so there is nothing for a
      // human to review or a dependent to wait on, the exact "no action" meaning this
      // folder already carries elsewhere (staleness-auto-archive.js's own DENY-vote and
      // archive-recommendation paths file directly here the same way, with no human
      // click in between -- established precedent for an automated sweep to use this
      // folder, not only the dashboard's own Archive button). Otherwise these hubs would
      // just sit in done/'s top level for up to done-archive.js's 30-day retention window
      // before its generic time-based pass finally moved them. The genuine
      // all-children-succeeded case is unaffected -- it still lands in done/ normally.
      const destDir = rejectedAtCreation ? path.join(doneDir, '_archived_no_action') : doneDir;
      if (rejectedAtCreation) {
        appendHistoryEvent(parent, 'archived', 'Auto-archived: coordinator hub rejected at creation, no sub-tasks were ever filed -- nothing to review or wait on');
      }
      moveToDone(file, destDir, name, parent);
      summary.checked += 1;
      summary.completed += 1;
      continue;
    }

    summary.checked += 1;
    const recById = new Map();
    for (const st of parent.subTasks) {
      const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
      recById.set(st && st.id, rec);
      const carried = applyCarryHold(st, classifyChildStatus(rec), Date.now());
      st.status = carried.status;
      if (carried.event) appendHistoryEvent(parent, 'advisory', carried.event);
    }
    // A hub built before "one hub = one stacked chain" may be mixed (some pieces stacked, some independent and stuck behind a merge):
    // put its not-yet-started pieces onto the chain (hub-restack.js). Before the held-marker below, which reads the fresh fields.
    try {
      const restacked = restackHubChain(parent, recById);
      if (restacked.length) { summary.restacked = (summary.restacked || 0) + restacked.length; appendHistoryEvent(parent, 'advisory', `restacked ${restacked.length} piece(s) onto the hub's shared branch`); }
    } catch { /* repair is best-effort */ }
    // Members lead with their hub's label (hub-serial.js): queueSubTasks does it for the hubs it builds, this covers older hubs and the
    // producers that mint their own child ids. The checklist titles always follow; a member's record is only rewritten while it is idle.
    try { const n = retitleHubMembers(parent, recById); if (n) summary.membersRetitled = (summary.membersRetitled || 0) + n; } catch { /* cosmetic */ }
    // A hub renamed to its HUB#### id (hub-rename.js) may have a member a worker was mid-way through: point its decomposedFrom at the new id once idle.
    try { const n = repairStaleHubRefs(parent, recById); if (n) summary.staleHubRefsRepaired = (summary.staleHubRefsRepaired || 0) + n; } catch { /* cosmetic */ }
    // A piece that is only waiting for an earlier sibling to land (hub-priority.js hubHasUnmergedEarlierSibling) reads 'in-progress' and
    // looks stuck; say what it is waiting for so the checklist is honest. Computed after every status above is fresh (the check reads
    // sibling statuses off `parent`), and cleared as soon as the piece is released.
    for (const st of parent.subTasks) {
      const rec = st && st.id ? recById.get(st.id) : null;
      let held = null;
      if (st && st.status === 'in-progress' && rec && rec.task) {
        try { const h = hubHasUnmergedEarlierSibling(pipelineDir, rec.task, parent); if (h.blocked) held = { id: h.blockingSiblingId, status: h.blockingSiblingStatus }; } catch { /* advisory */ }
      }
      if (st && held) st.heldFor = held; else if (st) delete st.heldFor;
    }

    // A non-stacked decompose hub: its move children carry no dependsOn, so nothing else
    // reconciles their merge. Confirm each `done` child against origin/<main>'s commit
    // trailer and flip it to `merged` -- then the hub only completes on all-MERGED, so its
    // mergedAt stamp is honest and dependents don't unblock against a pre-split main.
    const strictMergeHub = parent.decomposeHub === true && parent.mode !== 'stacked';
    if (strictMergeHub) {
      reconcileDecomposeChildMerges(pipelineDir, resolvedRepoRoot, parent.subTasks, recById, parent, runAutoMerge);
    }

    let doneCount = 0;
    let builtCount = 0;
    for (const st of parent.subTasks) {
      st.phase = childPhase(st.status, strictMergeHub); // bare `done` is NOT enough to complete a strict-merge hub
      if (st.phase === 'merged') { doneCount += 1; builtCount += 1; } else if (st.phase === 'built') builtCount += 1;
    }
    // done = merged/closed (completion, unchanged); built = done + finished-but-awaiting-merge (what the UI shows as progress).
    parent.progress = { done: doneCount, built: builtCount, total: parent.subTasks.length };
    parent.lastReconciledAt = new Date().toISOString();

    // Stuck-chain detection: surface a hub that can never complete on its own instead of
    // leaving it frozen at partial progress. The hub STAYS in coordinating/ so the sweep
    // keeps reconciling it (and auto-clears / auto-completes if the children get unstuck);
    // what changes is a `coordinatorBlocked` marker + a `blockedReason` the dashboard
    // renders, and after a grace period an `escalated` flag + a louder history event.
    if (doneCount < parent.subTasks.length) {
      const stuck = findStuckChildren(parent.subTasks, recById);
      const now = new Date().toISOString();
      if (stuck.length > 0) {
        const signature = stuck.map((s) => `${s.id}:${s.why}`).sort().join(' | ');
        if (!parent.coordinatorBlocked || parent.coordinatorBlocked.signature !== signature) {
          parent.coordinatorBlocked = { signature, since: now, children: stuck, escalated: false };
          appendHistoryEvent(parent, 'blocked', `coordinator stuck: ${stuck.map((s) => `${s.id} -- ${s.why}`).join('; ')}`.slice(0, 500));
          summary.blocked = (summary.blocked || 0) + 1;
        }
        parent.blockedReason = `${stuck.length} sub-task(s) can't proceed: ${stuck.map((s) => `${s.id.replace(/^adhoc-/, '')} (${s.why})`).join('; ')}`.slice(0, 400);
        const escalateMs = stuckEscalateMs(parent);
        const stuckForMs = Date.now() - Date.parse(parent.coordinatorBlocked.since || now);
        if (escalateMs > 0 && stuckForMs >= escalateMs && !parent.coordinatorBlocked.escalated) {
          parent.coordinatorBlocked.escalated = true;
          parent.coordinatorBlocked.escalatedAt = now;
          appendHistoryEvent(parent, 'advisory',
            `coordinator hub stuck ${stuckForMs >= 86400000 ? `${Math.floor(stuckForMs / 86400000)}d` : `${Math.floor(stuckForMs / 3600000)}h`} -- needs a human: resolve/requeue/archive ${stuck.map((s) => s.id).join(', ')}, or archive this hub`);
          summary.escalated = (summary.escalated || 0) + 1;
        }
      } else if (parent.coordinatorBlocked) {
        delete parent.coordinatorBlocked;
        delete parent.blockedReason;
        appendHistoryEvent(parent, 'advisory', 'coordinator unblocked -- sub-tasks progressing again');
        summary.unblocked = (summary.unblocked || 0) + 1;
      }
    }

    const allChildrenDone = doneCount === parent.subTasks.length;

    // A child went back to work (e.g. a human requeued the wiring step after a gate
    // failure) -- re-arm the gate so the next all-done transition re-checks the branch.
    if (!allChildrenDone && parent.integrationGate
        && ['failed', 'errored'].includes(parent.integrationGate.status)) {
      parent.integrationGate = { status: 'pending', reArmedAt: new Date().toISOString() };
      delete parent.blockedReason;
      delete parent.coordinatorBlocked;
    }

    // Stacked all-blueprint decompose hub: every move child committed its Blueprint module
    // to the branch, but nothing registered them yet. Do the `register_blueprint` splice
    // deterministically now, before the gate. On failure the hub stays in coordinating/
    // with a blockedReason; on success wiringPending clears and the next tick runs the gate
    // against the wired branch.
    if (allChildrenDone && parent.mode === 'stacked' && parent.wiringPending
        && (!parent.integrationGate || parent.integrationGate.status === 'pending')) {
      const res = runWiring(parent, resolvedRepoRoot);
      const now = new Date().toISOString();
      if (res && res.ok) {
        parent.wiringPending = false;
        appendHistoryEvent(parent, 'advisory', res.skipped
          ? `blueprint wiring already present on ${parent.branch}`
          : `wired ${res.registered} blueprint(s) onto ${parent.branch}${res.sha ? ` @ ${res.sha.slice(0, 10)}` : ''}`);
        summary.wired = (summary.wired || 0) + 1;
      } else {
        parent.blockedReason = `deterministic blueprint wiring failed on ${parent.branch}: ${res && res.detail ? res.detail : 'unknown'}`.slice(0, 600);
        parent.coordinatorBlocked = {
          signature: 'blueprint-wiring:failed', since: now, escalated: false,
          children: [{ id: parent.subTasks[parent.subTasks.length - 1].id, why: (res && res.detail) || 'wiring failed' }],
        };
        appendHistoryEvent(parent, 'blocked', parent.blockedReason);
        summary.wiringFailed = (summary.wiringFailed || 0) + 1;
      }
      try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); summary.updated += 1; }
      catch (err) { console.error(`coordinator-sweep: failed to write ${file}: ${err.message}`); summary.errors += 1; }
      continue;
    }
// ... [truncated for review: this function continues for 56 more line(s) not shown]
```

Problem:
The function `coordinatorSweep` is not merely long — it is a monolithic orchestrator that bundles at least eight distinct responsibilities: labeling hubs without serials, reading coordinating files, handling rejected-at-creation hubs, processing sub-tasks (status, carry, retitle, repair refs, held-for), strict-merge hub reconciliation, progress tracking, stuck-chain detection, and all-blueprint decompose wiring. These responsibilities are tightly coupled within a single loop over `parent.subTasks`, with nested conditionals, state mutations, and I/O operations (like `fs.writeFileSync`) that are not logically grouped. This violates the Single Responsibility Principle and makes the function untestable as a whole — any change to one responsibility risks breaking others.

Solution:
Extract each responsibility into its own named function: `assignMissingHubSerials()` (keep), `readCoordinatingFiles()`, `handleRejectedAtCreation(parent)`, `processSubTasks(parent, recById)`, `handleStrictMergeHub(parent, recById)`, `updateParentProgress(parent, doneCount, builtCount)`, `detectAndManageStuckChain(parent, recById)`, `handleAllBlueprintDecompose(parent, runWiring)`, and `writeUpdatedFile(file, parent)`. Each function should handle one logical concern, with clear inputs and outputs, and no side effects beyond its own scope. The main loop should simply orchestrate these functions in sequence, passing state cleanly between them.

Benefits:
Decomposing the function improves testability — each unit can be unit-tested in isolation. It also enhances readability, as the logic of each responsibility is self-contained and easier to follow. Reviewers can focus on one concern at a time, reducing cognitive load. Maintenance becomes easier, since changes to one part (e.g., retitle logic) won’t require retesting or refactoring the entire coordinator.

VERDICT CONSTRAINT:
Genuine
