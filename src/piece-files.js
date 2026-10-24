'use strict';

// Each decompose piece declares the repo paths it creates or edits (`files`). Core's queueSubTasks turns that into the piece's `Files:` line, which the
// diff-sanity gate (adhoc-diff-sanity.js extractDeclaredFiles) treats as the authoritative scope: a docs-only piece is not flagged "docs-only" and a path
// the piece declares is never "forbidden" (2026-10-23: HUB0008-11 and HUB0011-02 were blocked by those gates). This file reads the declaration off the
// model's answer and cleans it. Fails open: bad input leaves the split as it was.

const MAX_FILES = 12;
const PATHISH_RE = /^[A-Za-z0-9_@.\-/]+$/;

// Pull the raw subtask objects out of the model's text (object mode `{subtasks:[...]}` or a bare array). Never throws.
function rawSubtaskItems(text) {
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const tries = [];
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) tries.push(() => { const o = JSON.parse(obj[0]); return o && o.subtasks; });
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) tries.push(() => JSON.parse(arr[0]));
  for (const t of tries) {
    try { const v = t(); if (Array.isArray(v)) return v; } catch { /* try the next shape */ }
  }
  return [];
}

// Give each parsed subtask the `files` its raw item declared (matched by title), unless it already has some.
function attachFiles(subTasks, rawItems) {
  const byTitle = new Map();
  for (const it of rawItems) if (it && typeof it.title === 'string' && Array.isArray(it.files)) byTitle.set(it.title.trim(), it.files);
  return subTasks.map((s) => (s.files === undefined && byTitle.has(s.title) ? { ...s, files: byTitle.get(s.title) } : s));
}

// A `files` entry is kept when it is a repo-relative path: path characters only, not a URL or absolute path, and either has a file extension or is a
// directory prefix of a known repo path. Duplicates collapse; at most MAX_FILES; a piece left with none loses the field. repoPaths: array of repo paths.
function normalizeFiles(subTasks, repoPaths = []) {
  const known = Array.isArray(repoPaths) ? repoPaths : [];
  return subTasks.map((s) => {
    if (!Array.isArray(s.files)) return s;
    const kept = [];
    for (const raw of s.files) {
      if (typeof raw !== 'string') continue;
      const p = raw.trim().replace(/^\.\//, '');
      if (!p || !PATHISH_RE.test(p) || p.startsWith('/') || p.includes('..')) continue;
      const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(p);
      const isDir = known.some((k) => k.startsWith(`${p.replace(/\/$/, '')}/`));
      if ((hasExt || isDir) && !kept.includes(p)) kept.push(p);
      if (kept.length === MAX_FILES) break;
    }
    const { files, ...rest } = s; // eslint-disable-line no-unused-vars
    return kept.length ? { ...rest, files: kept } : rest;
  });
}

module.exports = { MAX_FILES, rawSubtaskItems, attachFiles, normalizeFiles };
