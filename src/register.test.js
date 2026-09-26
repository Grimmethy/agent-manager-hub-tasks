'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('register.js loads without throwing (no-op scaffold, S4b in progress)', () => {
  assert.doesNotThrow(() => require('../register.js'));
});
