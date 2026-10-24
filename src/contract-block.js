'use strict';

// A shared contract for every piece of a hub, and a check for names nobody defined.
//
// Pieces of one hub are drafted separately, so the names they rely on drift. 2026-10-23, chat plugin HUB0007-01: the piece was written before the file it
// consumes existed, guessed the key `percent`, and the file really writes `usedPercentage`; the gate caught it only after a full draft. The decompose pass now
// asks the model for one `contract` string (the exact names, shapes and env variables more than one piece relies on); withContract() puts it at the top of
// every piece, and unverifiedNames() flags backticked identifiers that appear in no repo file, in the contract, or in an earlier piece. Both fail open.

const { execFileSync } = require('child_process');

const CONTRACT_MAX_CHARS = 2000;
const CONTRACT_MARKER = 'SHARED CONTRACT (use exactly these names, do not invent others):';
const MAX_NAMES_PER_PIECE = 8;
const MAX_NAMES_CHECKED = 40;
const COMMON = new Set(['true', 'false', 'null', 'none', 'self', 'this', 'name', 'data', 'list', 'type', 'path', 'file', 'text', 'json', 'node', 'test', 'tests', 'args', 'then', 'else']);

// -> trimmed string of 1..2000 chars, else undefined (an over-long contract is dropped, not truncated: half a contract misleads).
function validContract(value) {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s && s.length <= CONTRACT_MAX_CHARS ? s : undefined;
}

// Prepend the contract to every piece, once (a piece that already carries the marker is left alone). No contract = unchanged.
function withContract(subTasks, contract) {
  const c = validContract(contract);
  if (!c) return subTasks;
  return subTasks.map((s) => (String(s.rawText || '').startsWith(CONTRACT_MARKER) ? s : { ...s, rawText: `${CONTRACT_MARKER}\n${c}\n\n${s.rawText}` }));
}

// Backticked identifier-shaped tokens that look like code names: snake_case, camelCase or upper-case with at least 4 characters. Paths and file names never match (the pattern has no dot or slash).
function candidateNames(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/`([A-Za-z_][A-Za-z0-9_]*)(?:\(\))?`/g)) {
    const n = m[1];
    const shaped = /_/.test(n) || /[a-z][A-Z]/.test(n) || /^[A-Z][A-Z0-9]{3,}$/.test(n);
    if (n.length >= 4 && shaped && !COMMON.has(n.toLowerCase()) && !out.includes(n)) out.push(n);
  }
  return out;
}

// repoHas(name) -> boolean. Default: `git grep -qw` in the repo root; exit 1 = absent, any other failure = assume present (fail open).
function gitRepoHas(repoRoot) {
  return (name) => {
    try { execFileSync('git', ['grep', '-qw', '--', name], { cwd: repoRoot, stdio: 'ignore', timeout: 10_000 }); return true; } catch (e) { return e && e.status === 1 ? false : true; }
  };
}

// -> new subTasks; a piece using names found nowhere gets one UNVERIFIED NAMES paragraph and `unverifiedNames`. Names already in the contract or in an
// earlier piece's text are fine; at most 40 distinct names are looked up in total and 8 listed per piece.
function annotateUnverifiedNames(subTasks, contract, repoHas) {
  const cache = new Map();
  let looked = 0;
  const known = (n) => {
    if (cache.has(n)) return cache.get(n);
    if (looked >= MAX_NAMES_CHECKED) return true; // out of budget: assume known
    looked += 1;
    let r = true;
    try { r = !!repoHas(n); } catch { r = true; }
    cache.set(n, r);
    return r;
  };
  const c = String(contract || '');
  return subTasks.map((s, i) => {
    const earlier = subTasks.slice(0, i).map((e) => `${e.title}\n${e.rawText}`).join('\n');
    const body = String(s.rawText || '').replace(new RegExp(`^${CONTRACT_MARKER.replace(/[()]/g, '\\$&')}[\\s\\S]*?\\n\\n`), '');
    const missing = candidateNames(`${s.title}\n${body}`).filter((n) => !c.includes(n) && !earlier.includes(n) && !known(n)).slice(0, MAX_NAMES_PER_PIECE);
    if (!missing.length) return s;
    const note = `UNVERIFIED NAMES (found in no repo file, the shared contract or an earlier piece): ${missing.join(', ')}. If this piece does not create them, confirm each exists in the code before you use it; if you cannot, stop with needs-clarification instead of guessing.`;
    return { ...s, rawText: `${s.rawText}\n\n${note}`, unverifiedNames: missing };
  });
}

module.exports = { CONTRACT_MAX_CHARS, CONTRACT_MARKER, validContract, withContract, candidateNames, gitRepoHas, annotateUnverifiedNames };
