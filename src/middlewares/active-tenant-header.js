'use strict';

const { ACTIVE_TENANT_HEADER } = require('../utils/active-tenant-context');

/** Parse X-Active-Tenant-Id header into ctx.state for editor tenant switching. */
module.exports = (_config, _opts) => {
  return async (context, next) => {
    const headers = context.request?.header || context.request?.headers || {};
    const raw =
      headers[ACTIVE_TENANT_HEADER] ||
      headers[ACTIVE_TENANT_HEADER.toUpperCase()] ||
      headers['X-Active-Tenant-Id'];
    if (raw) {
      context.state = context.state || {};
      context.state.activeTenantId = String(raw).trim();
    }
    return next();
  };
};

module.exports.ACTIVE_TENANT_HEADER = ACTIVE_TENANT_HEADER;
