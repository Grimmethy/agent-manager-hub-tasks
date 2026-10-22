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
