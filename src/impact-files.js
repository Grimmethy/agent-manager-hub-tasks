'use strict';

// Callers and tests of the symbols a piece changes.
//
// 2026-10-23, chat plugin HUB0002-01: the piece changed list_sessions to return a dict, but the existing test_agent_client.test_lists_sessions still expected
// the old shape, so the executed-verification gate failed the piece after a full draft. When a piece says it changes, renames or re-shapes a named symbol,
// the files that already use that symbol (tests first) are listed in the piece so the drafter updates them in the same pass. Pure over an injected `grep`
// (name -> paths); fails open (any problem leaves a piece as it was).

const { execFileSync } = require('child_process');
const { extractPaths } = require('./cross-hub-prereqs.js');

const CHANGE_VERB_RE = /\b(?:chang\w+|return\w*|renam\w+|signature|replac\w+|updat\w+)\b/i;
const CREATES_RE = /\b(?:create|creates|new file|add a new file|write a new)\b/i;
const COMMON = new Set(['get', 'set', 'id', 'name', 'data', 'list', 'type', 'path', 'file', 'text', 'json', 'self', 'this', 'true', 'false', 'null', 'none', 'args', 'test', 'tests']);
const MAX_NAMES = 8;
const MAX_FILES = 10;

const sentences = (t) => String(t || '').split(/(?<=[.!?])\s+(?=[A-Z`"'(])|\n+/).map((s) => s.trim()).filter(Boolean);
const isTestPath = (p) => /(^|\/)(tests?|__tests__)\/|[._-]test[._]|(^|\/)test_/i.test(p);

// Names a piece changes: backticked identifiers (4+ chars, not common words) in a sentence that has a change verb and does not create files.
function changedNames(subTask) {
  const out = [];
  for (const sen of sentences(`${subTask.title || ''}\n${subTask.rawText || ''}`)) {
    if (!CHANGE_VERB_RE.test(sen) || CREATES_RE.test(sen)) continue;
    for (const m of sen.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`/g)) {
      const n = m[1];
      if (n.length >= 4 && !COMMON.has(n.toLowerCase()) && !out.includes(n)) out.push(n);
    }
  }
  return out.slice(0, MAX_NAMES);
}

// -> the ALSO CHECK paragraph for one piece, or null. Files the piece already names are left out; test files come first; at most 10 files per name.
function impactNote(subTask, ctx) {
  const own = extractPaths(`${subTask.title || ''}\n${subTask.rawText || ''}`);
  const lines = [];
  for (const name of changedNames(subTask)) {
    let paths = [];
    try { paths = (ctx.grep(name) || []).filter((p) => typeof p === 'string' && !own.some((o) => p === o || p.endsWith(`/${o}`))); } catch { paths = []; }
    if (!paths.length) continue;
    paths = [...paths.filter(isTestPath), ...paths.filter((p) => !isTestPath(p))].slice(0, MAX_FILES);
    lines.push(`${name}: ${paths.join(', ')}`);
  }
  return lines.length
    ? `ALSO CHECK (callers and tests of the symbols you change): ${lines.join('; ')}. If your change alters a return shape or a signature, update these in the same piece.`
    : null;
}

// -> new subTasks; a piece with a note gets it appended and `impactNotes`; others are returned as the same object.
function annotateWithImpact(subTasks, ctx) {
  if (!ctx || typeof ctx.grep !== 'function') return subTasks;
  return subTasks.map((s) => {
    const note = impactNote(s, ctx); // impactNote already treats a failing lookup as no result
    return note ? { ...s, rawText: `${s.rawText}\n\n${note}`, impactNotes: [note] } : s;
  });
}

// Default grep: `git grep -lw` in the repo root. Exit 1 = no match; any other failure = no result (fail open).
function gitGrep(repoRoot) {
  return (name) => {
    try { return execFileSync('git', ['grep', '-lw', '--', name], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).split('\n').filter(Boolean); } catch { return []; }
  };
}

module.exports = { MAX_NAMES, MAX_FILES, changedNames, impactNote, annotateWithImpact, gitGrep };
