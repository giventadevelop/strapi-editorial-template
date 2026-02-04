'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function run(ctx, fn) {
  return storage.run(ctx, fn);
}

function get() {
  return storage.getStore();
}

module.exports = { run, get };
