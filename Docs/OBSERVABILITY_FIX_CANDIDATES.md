# Observability Fix Candidates

### AC-1 · Silent Error Swallowing in Coordinator Sweep
Strength: Strong
Files: src/coordinator-sweep.js
Snippet:
```
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let resolvedRepoRoot = repoRoot;
  if (resolvedRepoRoot === undefined) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  // Label every hub that has no HUB#### yet (oldest first), before the loop below reads them.
```

Problem:  
The `catch` block at line 325 (in the `runStackedWiring` invocation) silently returns an object with `ok: false` and a stringified error message, but does not log the error or rethrow it. This means that if `runStackedWiring` fails — which is a critical coordination task — the error is not surfaced to any logging system or monitoring. Since the project has no metrics or telemetry, and the only logging available is `console.error`/`console.warn`, the failure is invisible to operators unless manually inspected. This creates a silent failure mode where critical coordination logic can fail without detection.

Solution:  
Log the error with context using `console.error`, including the error message and stack trace if possible, and return the same `ok: false, detail: ...` structure. This preserves compatibility with downstream consumers while surfacing the error to the console — the only available logging mechanism — so that operators or automated systems can detect and respond to the failure.

Benefits:  
Once fixed, any failure in `runStackedWiring` will be logged to the console with sufficient context to identify the source and cause, making it visible to operators and reducing the risk of undetected failures. Since no metrics system exists, logging is the only viable observability primitive — and this fix ensures it is used correctly.

### AC-2 · Silent Filesystem Error Swallowed Without Human-Visible Logging
Strength: Strong
Files: src/rejected-hub-disposition-backfill.js
Snippet:
```
      try {
        fs.writeFileSync(src, JSON.stringify(task, null, 2));
        result.relabeledInPlace += 1;
      } catch (e) {
        result.errors.push(`relabel-in-place(${src}): ${e.message}`);
      }
      continue;
```

Problem:  
The `try`/`catch` block around `fs.existsSync(dest)` catches an error but only appends it to `result.errors` — a structured container that may be consumed downstream but is not emitted to human operators or logs. Since the project has no metrics or third-party logging, the error is silently swallowed and invisible to operators. If `fs.existsSync` fails (e.g., due to permission issues or broken paths), the program continues with a misleading success state — potentially allowing undetected data integrity failures or misconfigured backfills to proceed.

Solution:  
Log the error to `console.error` with context, so human operators can see it. The fix adds `console.error` to the catch block, using the same error message format as `result.errors`, to ensure visibility without requiring a metrics system or external logging framework.

Benefits:  
Operators can now detect filesystem failures during backfills — preventing silent data misalignment or misconfiguration. The fix is minimal, uses only stdlib logging, and doesn’t require metrics or third-party tools — aligning with the project’s capabilities.

### AC-3 · Silent smoke-test failure in entrypoint gate
Strength: Strong
Files: src/decompose-integration-gate.js
Snippet:
```
    try {
      out = String(exec('python3', ['.decompose_entrypoint_smoke.py', path.basename(sourceFile)],
        { cwd: path.join(branchWt, srcDir), timeout: 30_000 }) || '');
    } catch (e) {
      smokeErr = e;
      out = String(e.stdout || '');
    }
```

Problem:
In the entrypoint smoke-test gate, the `try/catch` around the `exec` call (lines 208-211) correctly captures any exception into `smokeErr`. The preceding `if` branch then handles the expected "dependencies not installed" case by calling `record('entrypoint', 'skip', …)`. However, the subsequent `else if (smokeErr)` conditional branch — which fires precisely when a *genuine* smoke-test failure occurred (a real import error in the module under test, a syntax error, a runtime crash, or the 30-second timeout) — has an empty body. It neither logs the error, calls `record(...)` with a failure outcome, nor rethrows. The result is that the caller never learns the smoke test failed, and the gate proceeds as if the entrypoint were healthy.

Solution:
In the `else if (smokeErr)` branch body, surface the failure before falling through. Extract a one-line detail from `smokeErr.stderr`, `smokeErr.stdout`, or `smokeErr.message`; emit it via `console.error` prefixed with the source file basename for context; call `record('entrypoint', 'fail', …)` with the last non-empty line of the detail to stay consistent with the existing `record('entrypoint', 'skip', …)` convention in the adjacent `if` branch; and rethrow `smokeErr` so a caller can skip or abort the branch. No new dependency or telemetry primitive is introduced — only `console.error` and `record`, both already used in this file.

Benefits:
A genuine smoke-test failure becomes visible in the console log with enough context (source file name plus the error detail) to diagnose it, is recorded as a `fail` outcome consistent with the existing `skip` recording, and is propagated to the caller via the rethrown exception so the gate can skip or abort the branch rather than silently treating a broken entrypoint as healthy.
