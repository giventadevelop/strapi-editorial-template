"use strict";

const requestContext = require("../utils/request-context");

/** Resolve Editor's tenant id (numeric) from admin user id. Same logic as bootstrap document middleware. */
async function resolveEditorTenantIdFromUserId(userId) {
  if (!userId) return null;
  const adminUser = await strapi.db.query("admin::user").findOne({
    where: { id: userId },
    populate: { roles: true },
    select: ["email"],
  });
  if (!adminUser?.email) return null;
  const isEditor = (adminUser.roles || []).some((r) => r.code === "strapi-editor");
  if (!isEditor) return null;
  const mappings = await strapi.db.query("api::editor-tenant.editor-tenant").findMany({
    where: {},
    populate: { tenant: true },
  });
  const mapping = mappings.find(
    (m) => (m.adminUserEmail || "").toLowerCase() === String(adminUser.email).toLowerCase()
  );
  const tenant = mapping?.tenant;
  return tenant?.id ?? null;
}

/**
 * Get admin user id for this request. Admin auth runs in route policy (after global middlewares),
 * so ctx.state.user is not set when we run. We resolve the user from the Bearer token here.
 */
async function getAdminUserIdFromRequest(ctx) {
  const ctxStore = requestContext.get();
  const fromState = ctxStore?.state?.user || ctxStore?.state?.admin;
  if (fromState?.id) return fromState.id;

  const authz = ctx.request?.header?.authorization || ctx.request?.headers?.authorization;
  if (!authz || typeof authz !== "string") return null;
  const parts = authz.trim().split(/\s+/);
  if (parts[0].toLowerCase() !== "bearer" || !parts[1]) return null;

  const token = parts[1];
  const manager = strapi.sessionManager;
  if (!manager) return null;
  try {
    const result = manager("admin").validateAccessToken(token);
    if (!result?.isValid || !result?.payload?.userId) return null;
    const raw = result.payload.userId;
    const num = Number(raw);
    return Number.isFinite(num) && String(num) === String(raw) ? num : raw;
  } catch {
    return null;
  }
}

/**
 * Mutate the query object so content-manager relations controller sees our filters and pageSize.
 * It reads from ctx.request.query.
 */
function applyRelationPickerQuery(ctx, tenantId, pageSize) {
  const q = ctx.request.query || ctx.query || {};
  if (tenantId != null) {
    q.filters = q.filters || {};
    q.filters.tenant = { id: tenantId };
  }
  if (pageSize != null) {
    q.pageSize = pageSize;
  }
  ctx.request.query = q;
  ctx.query = q;
}

/**
 * For Editor users:
 * 1) Relation picker for "article" uses strapi.db.query (not documents), so we inject tenant filter here.
 * 2) Request a larger pageSize so the picker shows more than 2 items (search/pagination in UI).
 * Admin auth runs after global middlewares, so we resolve the user from the Bearer token when needed.
 */
module.exports = (_config, _opts) => {
  return async (ctx, next) => {
    if (ctx.method !== "GET") return next();
    if (!ctx.path.startsWith("/content-manager/")) return next();

    const pathSegments = ctx.path.split("/").filter(Boolean);
    const lastSegment = pathSegments[pathSegments.length - 1];
    const isRelationsFindAvailable =
      ctx.path.includes("/relations/") && lastSegment === "article";

    if (isRelationsFindAvailable) {
      const userId = await getAdminUserIdFromRequest(ctx);
      const tenantId = userId != null ? await resolveEditorTenantIdFromUserId(userId) : null;
      const requested = parseInt(ctx.request?.query?.pageSize || ctx.query?.pageSize, 10);
      const pageSize = !requested || requested < 50 ? 50 : requested;
      applyRelationPickerQuery(ctx, tenantId, pageSize);
    } else {
      // Article list view: request more entries per page (only for Editors; optional)
      const isArticleList =
        ctx.path.includes("api::article.article") && ctx.path.includes("/collection-types/");
      if (isArticleList) {
        const userId = await getAdminUserIdFromRequest(ctx);
        const tenantId = userId != null ? await resolveEditorTenantIdFromUserId(userId) : null;
        if (tenantId != null) {
          const q = ctx.request?.query || ctx.query || {};
          const requested = parseInt(q.pageSize || q["pagination[pageSize]"], 10);
          if (!requested || requested < 50) {
            const nextQ = { ...q, pageSize: 50 };
            ctx.request.query = nextQ;
            ctx.query = nextQ;
          }
        }
      }
    }

    return next();
  };
};
