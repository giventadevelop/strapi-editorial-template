'use strict';

/**
 * Content-manager extension: inject the Editor's tenant filter into the list query
 * for all tenant-scoped content types (Article, Directory types, Flash News, etc.)
 * so the list is scoped to their assigned tenant. Same behavior as Article for
 * Directory – Bishops, Dioceses, Entries, Churches, Priests, Parishes, etc.
 * Admin auth may run after global middlewares, so we resolve user from ctx.state
 * or from the Bearer token when state is not set.
 */

const requestContext = require('../../utils/request-context');

const TENANT_SCOPED_UIDS = new Set([
  'api::article.article',
  'api::advertisement-slot.advertisement-slot',
  'api::flash-news-item.flash-news-item',
  'api::directory-home.directory-home',
  'api::bishop.bishop',
  'api::catholicos.catholicos',
  'api::diocesan-bishop.diocesan-bishop',
  'api::retired-bishop.retired-bishop',
  'api::diocese.diocese',
  'api::parish.parish',
  'api::church.church',
  'api::priest.priest',
  'api::directory-entry.directory-entry',
  'api::institution.institution',
  'api::church-dignitary.church-dignitary',
  'api::working-committee.working-committee',
  'api::managing-committee.managing-committee',
  'api::spiritual-organisation.spiritual-organisation',
  'api::pilgrim-centre.pilgrim-centre',
  'api::seminary.seminary',
]);

/** Get admin user id for this request (state or Bearer token). */
async function getAdminUserIdFromContext() {
  const ctx = requestContext.get();
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

async function resolveEditorTenantFromUser(userId) {
  if (userId == null) return null;
  const adminUser = await strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: true },
    select: ['email'],
  });
  if (!adminUser?.email) return null;
  const isEditor = (adminUser.roles || []).some((r) => r.code === 'strapi-editor');
  if (!isEditor) return null;
  const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
    where: {},
    populate: { tenant: true },
  });
  const mapping = mappings.find(
    (m) => (m.adminUserEmail || '').toLowerCase() === String(adminUser.email).toLowerCase()
  );
  const tenant = mapping?.tenant;
  if (!tenant) return null;
  return { id: tenant.id, documentId: tenant.documentId ?? tenant.document_id };
}

function addFiltersClause(params, filtersClause) {
  params.filters = params.filters || {};
  params.filters.$and = params.filters.$and || [];
  params.filters.$and.push(filtersClause);
}

module.exports = (plugin) => {
  const originalPermissionChecker = plugin.services['permission-checker'];
  if (typeof originalPermissionChecker !== 'function') {
    console.warn('content-manager-tenant: permission-checker service not a function, skipping extension');
    return plugin;
  }

  plugin.services['permission-checker'] = function permissionCheckerFactory(deps) {
    const instance = originalPermissionChecker(deps);
    const originalCreate = instance.create;
    instance.create = function createPermissionChecker(opts) {
      const checker = originalCreate(opts);

      if (!TENANT_SCOPED_UIDS.has(opts.model)) {
        return checker;
      }

      const originalRead = checker.sanitizedQuery.read.bind(checker.sanitizedQuery);
      checker.sanitizedQuery.read = async (query) => {
        const permissionQuery = await originalRead(query);

        const userId = await getAdminUserIdFromContext();
        const tenant = await resolveEditorTenantFromUser(userId);
        if (tenant?.id != null || tenant?.documentId != null) {
          const tenantFilter =
            tenant.documentId != null
              ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: tenant.documentId } }] }
              : { tenant: tenant.id };
          addFiltersClause(permissionQuery, tenantFilter);
        }

        return permissionQuery;
      };

      return checker;
    };
    return instance;
  };

  return plugin;
};
