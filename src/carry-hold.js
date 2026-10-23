'use strict';

// Hold marker for a hub piece an operator is carrying by hand.
//
// Taking a piece's record out of the queue to work on it makes findTaskRecordById return nothing, classifyChildStatus reports 'gone' (= completed and aged
// out), and 'gone' is resolved in both TERMINAL_GOOD and hub-priority.js's SIBLING_RESOLVED_STATUSES, so the next piece was released before the carried
// one had landed (2026-10-22, scrapers HUB0001-02). A piece marked `carriedBy` on its hub's subTasks entry reports 'carried' while its record is missing:
// not terminal-good, not sibling-resolved, so the hold stays. The marker clears itself when the record is back, and a marker older than 24 hours is
// treated as forgotten (the piece reads 'gone' again) so a hold can never freeze a hub for good.

const fs = require('fs');
const path = require('path');

const CARRY_MAX_MS = 24 * 3600 * 1000;

// -> { status, event? }: the status to store for this checklist entry, and a history line when the marker was cleared or expired.
function applyCarryHold(st, status, nowMs) {
  if (!st || !st.carriedBy) return { status };
  if (status !== 'gone') {
    delete st.carriedBy; // the record is back in a queue: the carrying is over
    return { status, event: `carry hold on ${st.id} cleared: its record is back in the queue` };
  }
  const since = Date.parse(st.carriedBy.at);
  if (Number.isFinite(since) && nowMs - since <= CARRY_MAX_MS) return { status: 'carried' };
  const who = st.carriedBy.who || 'unknown';
  delete st.carriedBy;
  return { status: 'gone', event: `carry hold on ${st.id} by ${who} expired after 24h: treating the piece as gone` };
}

function findHubFile(pipelineDir, taskId) {
  const dir = path.join(pipelineDir, 'queue', 'coordinating');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { /* no coordinating dir */ }
  for (const name of names) {
    const file = path.join(dir, name);
    let hub;
    try { hub = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const st = Array.isArray(hub.subTasks) ? hub.subTasks.find((s) => s && s.id === taskId) : null;
    if (st) return { file, hub, st };
  }
  return null;
}

function writeAtomic(file, data) {
  const tmp = `${file}.carry-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function holdPiece(pipelineDir, taskId, who, nowMs = Date.now()) {
  if (!who) throw new Error('hold needs a who (a name for whoever is carrying the piece)');
  const found = findHubFile(pipelineDir, taskId);
  if (!found) throw new Error(`no hub in ${pipelineDir}/queue/coordinating lists a piece '${taskId}'`);
  found.st.carriedBy = { who, at: new Date(nowMs).toISOString() };
  writeAtomic(found.file, found.hub);
  return { hub: found.hub.id, taskId };
}

function releasePiece(pipelineDir, taskId) {
  const found = findHubFile(pipelineDir, taskId);
  if (!found) throw new Error(`no hub in ${pipelineDir}/queue/coordinating lists a piece '${taskId}'`);
  delete found.st.carriedBy;
  writeAtomic(found.file, found.hub);
  return { hub: found.hub.id, taskId };
}

module.exports = { CARRY_MAX_MS, applyCarryHold, holdPiece, releasePiece };
