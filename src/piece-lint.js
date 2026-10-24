'use strict';

// Contradiction lint for decompose pieces: a piece whose text forbids a file ("do not touch X") and also makes it an edit target ("add tests to X").
// 2026-10-23, chat plugin HUB0011-02: the piece said not to touch test/sessions-view.test.mjs while its whole job was to add tests there, and the
// forbidden-path gate (adhoc-diff-sanity.js) blocked the correct diff. The fix here is at decompose time: the piece text gets one clarifying sentence.
// Pure over the proposals; fails open (any problem leaves a piece as it was).

const { extractPaths } = require('./cross-hub-prereqs.js');

const RESTRICT_RE = /\b(?:do ?n(?:'?o?)?t|don['’]t|never|must not|should not|shall not|nothing else|no other|avoid)\b/i;
const EXCEPT_RE = /\b(?:other than|except|apart from|aside from)\b/i;
const EDIT_VERB_RE = /\b(?:add|adds|adding|create|creates|edit|edits|update|updates|modify|modifies|write|writes|extend|extends|append|appends|change|changes|fix|fixes|implement|implements|put|extract)\b/i;

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+(?=[A-Z`"'(])|\n+/).map((s) => s.trim()).filter(Boolean);
}

// -> [{ path, forbiddenBy, requiredBy }]
function findContradictions(subTask) {
  const text = `${subTask.title || ''}\n${subTask.rawText || ''}`;
  const forbidden = new Map(); // path -> sentence
  const required = new Map();
  for (const sen of sentences(text)) {
    const paths = extractPaths(sen);
    if (!paths.length) continue;
    if (/^Files:/i.test(sen)) { for (const p of paths) if (!required.has(p)) required.set(p, sen); continue; }
    if (RESTRICT_RE.test(sen)) {
      if (EXCEPT_RE.test(sen)) continue; // "change nothing other than X": X is the allowed set, not a ban
      for (const p of paths) if (!forbidden.has(p)) forbidden.set(p, sen);
    } else if (EDIT_VERB_RE.test(sen)) {
      for (const p of paths) if (!required.has(p)) required.set(p, sen);
    }
  }
  for (const p of Array.isArray(subTask.files) ? subTask.files : []) if (!required.has(p)) required.set(p, `files: ${p}`);
  const out = [];
  for (const [p, by] of forbidden) {
    const hit = [...required.keys()].find((r) => r === p || r.endsWith(`/${p}`) || p.endsWith(`/${r}`));
    if (hit) out.push({ path: p, forbiddenBy: by, requiredBy: required.get(hit) });
  }
  return out;
}

// -> new subTasks; a contradictory piece gets a NOTE sentence and `lintNotes`; clean pieces are returned unchanged.
function resolveContradictions(subTasks) {
  return subTasks.map((sub) => {
    let found;
    try { found = findContradictions(sub); } catch { return sub; }
    if (!found.length) return sub;
    const paths = [...new Set(found.map((f) => f.path))];
    const note = `NOTE: ${paths.join(', ')} ${paths.length > 1 ? 'are' : 'is'} an edit target of this piece; the restriction above applies to every other file.`;
    return { ...sub, rawText: `${sub.rawText}\n\n${note}`, lintNotes: found.map((f) => `forbidden-and-required: ${f.path}`) };
  });
}

module.exports = { findContradictions, resolveContradictions };
