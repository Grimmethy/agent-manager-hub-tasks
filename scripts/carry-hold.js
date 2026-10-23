#!/usr/bin/env node
'use strict';

// node scripts/carry-hold.js hold <taskId> <who>   -- mark a hub piece as carried by hand (run BEFORE taking its record out of the queue)
// node scripts/carry-hold.js release <taskId>      -- clear the mark
// The pipeline dir is AGENT_MANAGER_PIPELINE_DIR. See src/carry-hold.js for what the mark does.

const { holdPiece, releasePiece } = require('../src/carry-hold.js');

const [cmd, taskId, who] = process.argv.slice(2);
const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
try {
  if (!pipelineDir) throw new Error('AGENT_MANAGER_PIPELINE_DIR is not set');
  if (!taskId) throw new Error('usage: carry-hold.js hold <taskId> <who> | release <taskId>');
  if (cmd === 'hold') console.log(JSON.stringify(holdPiece(pipelineDir, taskId, who)));
  else if (cmd === 'release') console.log(JSON.stringify(releasePiece(pipelineDir, taskId)));
  else throw new Error(`unknown command '${cmd}' (hold | release)`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
