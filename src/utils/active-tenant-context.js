'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const ACTIVE_TENANT_HEADER = 'x-active-tenant-id';
const ACTIVE_TENANT_STORAGE_KEY = 'strapi-active-tenant-id';

function run(ctx, fn) {
  return storage.run(ctx, fn);
}

function get() {
  return storage.getStore();
}

function getActiveTenantIdFromRequest(ctx) {
  const store = ctx || get();
  if (!store) return null;
  if (store.state?.activeTenantId) return String(store.state.activeTenantId).trim();
  const headers = store.request?.header || store.request?.headers || {};
  const raw = headers[ACTIVE_TENANT_HEADER] || headers[ACTIVE_TENANT_HEADER.toUpperCase()];
  if (raw) return String(raw).trim();
  return null;
}

module.exports = {
  run,
  get,
  getActiveTenantIdFromRequest,
  ACTIVE_TENANT_HEADER,
  ACTIVE_TENANT_STORAGE_KEY,
};
