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
