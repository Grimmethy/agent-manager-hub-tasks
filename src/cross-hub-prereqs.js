'use strict';

// Cross-hub prerequisites at decompose time.
//
// 2026-10-23, chat plugin HUB0008-03 needed accounts.py, which only existed on the held, unmerged branch of ANOTHER hub (HUB0006). Each hub's pieces draft off
// origin/<main> plus their own hub's branch, so the piece could never see the file: it drafted, failed and blocked until the operator merged the other hub by hand.
// Nothing at decompose time looked for this. findCrossHubPrerequisites() does: a file a piece names that is NOT on main but IS newly added on another open hub's
// branch is a prerequisite. annotateWithPrerequisites() records it on the piece (prerequisiteHubs) and appends a PREREQUISITE CHECK to its text so that a lane which
// finds the file missing stops with needs-clarification naming the hub, instead of failing again and again.
//
// Everything that touches git or the queue arrives through an injected `ctx`, so the matching is tested with fixtures. The check FAILS OPEN: any problem reading a
// hub gives no prerequisite (and a note), never a failed decomposition. It does not hold the piece back: a merged-only dependency gate needs a core change
// (isDependencySatisfied treats a fully built stacked hub as satisfied), filed separately.

const fs = require('fs');
const path = require('path');

const PATH_RE = /[A-Za-z0-9_.\-/]+\.(?:py|js|mjs|cjs|ts|tsx|json|html|css|sh|md)\b/g;
const CREATES_RE = /\b(?:create|creates|new file|add a new file|write a new)\b/i;

// File paths a piece's text names (backticked or bare), deduplicated, in order. A bare name with no directory is kept: the caller matches by suffix.
function extractPaths(text) {
  const seen = new Set();
  for (const m of String(text || '').matchAll(PATH_RE)) {
    const p = m[0].replace(/^\.\//, '');
    if (p.length >= 4 && !p.startsWith('/') && !/^https?:/.test(p)) seen.add(p);
  }
  return [...seen];
}

// True when the piece's own text says it CREATES this path (then another hub also having it is a conflict, not a prerequisite).
function pieceCreates(text, p) {
  const re = new RegExp(`(?:${CREATES_RE.source})[^.\\n]{0,60}${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  return re.test(String(text || ''));
}

const matchesAdded = (added, p) => added.find((f) => f === p || f.endsWith(`/${p}`));

// subTasks: [{title, rawText}]. ctx: { hubs: [{label, branch, filesAdded: string[]}], existsOnMain(path) -> bool }.
// -> array parallel to subTasks, each [{ hub, branch, files }] (empty when none).
function findCrossHubPrerequisites(subTasks, ctx) {
  const hubs = (ctx && Array.isArray(ctx.hubs)) ? ctx.hubs : [];
  return subTasks.map((sub) => {
    const text = `${sub.title || ''}\n${sub.rawText || ''}`;
    const byHub = new Map();
    for (const p of extractPaths(text)) {
      if (pieceCreates(text, p)) continue;
      let onMain = false;
      try { onMain = !!ctx.existsOnMain(p); } catch { continue; } // cannot tell: fail open
      if (onMain) continue;
      for (const hub of hubs) {
        const hit = matchesAdded(hub.filesAdded || [], p);
        if (!hit) continue;
        const entry = byHub.get(hub.label) || { hub: hub.label, branch: hub.branch, files: [] };
        entry.files.push(hit);
        byHub.set(hub.label, entry);
      }
    }
    return [...byHub.values()];
  });
}

// -> new subTasks; a piece with prerequisites gets prerequisiteHubs and a PREREQUISITE CHECK paragraph. Pieces without any are returned unchanged.
function annotateWithPrerequisites(subTasks, prereqs) {
  return subTasks.map((sub, i) => {
    const list = prereqs[i] || [];
    if (!list.length) return sub;
    const lines = list.map((p) => `${p.files.join(', ')} exists only on the unmerged branch of ${p.hub} (${p.branch})`);
    const check = `\n\nPREREQUISITE CHECK (found at decompose time): ${lines.join('; ')}. Before you change anything, confirm each of those files exists in your worktree. If one is missing, STOP and raise needs-clarification saying "waiting for ${list.map((p) => p.hub).join(', ')} to be merged"; do not recreate the file and do not work around it.`;
    return { ...sub, rawText: `${sub.rawText}${check}`, prerequisiteHubs: list.map((p) => p.hub) };
  });
}

// The real ctx for a pipeline: every OTHER open hub in queue/coordinating/ (some piece not yet merged) whose shared branch can be found from a piece's
// stacked.branch, with the files its branch ADDS relative to origin/<main>. `git(args) -> string` runs in the repo; ownBranch skips the task's own chain.
function buildRealContext({ pipelineDir, git, mainBranch, ownBranch = null, findRecord }) {
  const dir = path.join(pipelineDir, 'queue', 'coordinating');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return { hubs: [], existsOnMain: () => true, note: 'no coordinating/ dir' }; }
  const hubs = [];
  for (const name of names) {
    let hub;
    try { hub = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const subs = Array.isArray(hub.subTasks) ? hub.subTasks : [];
    if (!hub.hubLabel || !subs.length || subs.every((s) => s && s.phase === 'merged')) continue;
    let branch = null;
    for (const s of subs) {
      const rec = s && s.id ? findRecord(pipelineDir, s.id) : null;
      if (rec && rec.task && rec.task.stacked && rec.task.stacked.branch) { branch = rec.task.stacked.branch; break; }
    }
    if (!branch || branch === ownBranch) continue;
    let out = '';
    try { out = git(['diff', '--name-only', '--diff-filter=A', `origin/${mainBranch}...origin/${branch}`]); } catch { continue; }
    hubs.push({ label: hub.hubLabel, branch, filesAdded: out.split('\n').map((l) => l.trim()).filter(Boolean) });
  }
  let tree = null; // lazily read once: every file on main, for bare names that carry no directory
  const existsOnMain = (p) => {
    try { git(['cat-file', '-e', `origin/${mainBranch}:${p}`]); return true; } catch { /* maybe a bare name or a different directory */ }
    if (!tree) {
      try { tree = git(['ls-tree', '-r', '--name-only', `origin/${mainBranch}`]).split('\n'); } catch { throw new Error('cannot read main'); }
    }
    return tree.some((f) => f === p || f.endsWith(`/${p}`));
  };
  return { hubs, existsOnMain };
}

module.exports = { extractPaths, findCrossHubPrerequisites, annotateWithPrerequisites, buildRealContext };
