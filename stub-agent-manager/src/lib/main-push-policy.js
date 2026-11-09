'use strict';

// Stub for lib/main-push-policy.js
// Exports ungatedMainPushAllowed

function ungatedMainPushAllowed() {
  // Stub: return false by default (no unattended push to main)
  return false;
}

module.exports = {
  ungatedMainPushAllowed,
};
