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
