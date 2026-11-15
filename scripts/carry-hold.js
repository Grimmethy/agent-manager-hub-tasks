#!/usr/bin/env node
'use strict';

// node scripts/carry-hold.js hold <taskId> <who>   -- mark a hub piece as carried by hand (run BEFORE taking its record out of the queue)
// node scripts/carry-hold.js release <taskId>      -- clear the mark
// node scripts/carry-hold.js take <taskId> <who> <destDir> -- mark the piece carried AND move its record into destDir in one step; replaces the separate hold-then-take sequence
// The pipeline dir is AGENT_MANAGER_PIPELINE_DIR. See src/carry-hold.js for what the mark does.

const { holdPiece, releasePiece, takePiece } = require('../src/carry-hold.js');

const [cmd, taskId, who, destDir] = process.argv.slice(2);
const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
try {
  if (!cmd || !taskId) throw new Error('usage: carry-hold.js hold <taskId> <who> | release <taskId> | take <taskId> <who> <destDir>');
  if (!pipelineDir) throw new Error('AGENT_MANAGER_PIPELINE_DIR is not set');
  if (cmd === 'hold') console.log(JSON.stringify(holdPiece(pipelineDir, taskId, who)));
  else if (cmd === 'release') console.log(JSON.stringify(releasePiece(pipelineDir, taskId)));
  else if (cmd === 'take') console.log(takePiece(pipelineDir, taskId, who, destDir));
  else throw new Error(`unknown command '${cmd}' (hold | release | take)`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
