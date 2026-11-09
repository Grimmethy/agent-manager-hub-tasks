'use strict';

function appendHistoryEvent(task, stage, detail) {
  if (!task.history) task.history = [];
  task.history.push({
    stage,
    at: new Date().toISOString(),
    detail: detail || '',
  });
  return task;
}

module.exports = { appendHistoryEvent };
