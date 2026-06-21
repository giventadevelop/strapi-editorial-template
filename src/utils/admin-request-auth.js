'use strict';

/**
 * Validate admin Bearer token from request; return admin user id or null.
 */
async function getAdminUserIdFromRequest(strapi, ctx) {
  if (!ctx) return null;
  const fromState = ctx.state?.user?.id ?? ctx.state?.admin?.id;
  if (fromState != null) return fromState;

  const authz = ctx.request?.header?.authorization || ctx.request?.headers?.authorization;
  if (!authz || typeof authz !== 'string') return null;
  const parts = authz.trim().split(/\s+/);
  if (parts[0].toLowerCase() !== 'bearer' || !parts[1]) return null;

  const manager = strapi.sessionManager;
  if (!manager) return null;
  try {
    const result = manager('admin').validateAccessToken(parts[1]);
    if (!result?.isValid || result?.payload?.userId == null) return null;
    const raw = result.payload.userId;
    const num = Number(raw);
    return Number.isFinite(num) && String(num) === String(raw) ? num : raw;
  } catch {
    return null;
  }
}

async function getAdminUserFromRequest(strapi, ctx) {
  const userId = await getAdminUserIdFromRequest(strapi, ctx);
  if (userId == null) return null;
  return strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: true },
    select: ['id', 'email', 'firstname', 'lastname'],
  });
}

function isEditorRole(adminUser) {
  return (adminUser?.roles || []).some((r) => r.code === 'strapi-editor');
}

module.exports = {
  getAdminUserIdFromRequest,
  getAdminUserFromRequest,
  isEditorRole,
};
