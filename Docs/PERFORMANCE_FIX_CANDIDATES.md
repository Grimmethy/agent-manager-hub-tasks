# Performance Fix Candidates

### AC-1 · Batch Parallel File Reads to Avoid Event Loop Blocking
Strength: Strong
Files: src/coordinator-sweep.js
Snippet:
```
    return summary;
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
```

Problem:  
The current loop iterates over each file in `names`, performing a synchronous `fs.readFileSync` per iteration. With 100+ files, this blocks the Node.js event loop for the duration of each read — potentially hundreds of milliseconds total — and prevents concurrent work (like HTTP requests or event handlers) from progressing. This is a hot-path bottleneck in a coordinator service that likely runs frequently, making the system unresponsive during sweeps.

Solution:  
Replace the synchronous loop with a parallel batch using `fs.promises.readFile` and `Promise.all`. Map each file path to a read promise, then await all of them concurrently. This eliminates the blocking nature of synchronous I/O while using only core Node.js primitives already available in the project.

Benefits:  
The event loop remains free to handle other operations during the read phase, drastically reducing sweep latency. With parallel reads, the total time scales logarithmically with the number of files (assuming disk I/O is the bottleneck), making the coordinator responsive even under heavy file loads. No external libraries or metrics are required — the fix uses only `fs.promises` and `Promise.all`.

### AC-2 · Fix Sync I/O Loop with Async Parallel Reads
Strength: Strong
Files: src/hub-rename.js
Snippet:
```
  }

  // unstarted tasks that wait on this hub (decompose-loop rescue: dependsOn:[<hub>])
  for (const state of ['adhoc', 'derived', 'blocked', 'needs-clarification']) {
    const dir = path.join(pipelineDir, 'queue', state);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
```

Problem:
The current loop runs four synchronous `fs.readdirSync` calls — one per state directory — each blocking the event loop. Even though each directory is read only once per invocation, the loop runs multiple times per second during task reconciliation, causing cumulative event loop starvation. This is not a one-time startup cost but a repeated, high-frequency I/O bottleneck that degrades responsiveness under load.

Solution:
Replace the synchronous loop with `fs.promises.readdir` and `Promise.all` to run all four directory reads concurrently. Map each result to filtered `.json` files, then flatten into a single array. This eliminates blocking I/O per iteration and allows the event loop to remain responsive.

Benefits:
The fix reduces total I/O wait time by parallelizing reads, avoids event loop blocking during frequent invocations, and preserves output semantics without adding new dependencies or logging/metrics. The change is minimal, safe, and uses only primitives already available in the project.
