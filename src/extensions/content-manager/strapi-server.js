'use strict';

/**
 * Content-manager extension: inject the Editor's tenant filter into the list query
 * for all tenant-scoped content types (Article, Directory types, Flash News, etc.)
 * so the list is scoped to their assigned tenant. Same behavior as Article for
 * Directory – Bishops, Dioceses, Entries, Priests, Parishes, etc.
 * Admin auth may run after global middlewares, so we resolve user from ctx.state
 * or from the Bearer token when state is not set.
 *
 * Also patches the configuration response for Article so the list view always
 * receives "publishedAt" in layouts.list (Published at column).
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

const ARTICLE_UID = 'api::article.article';

/**
 * Ensure Article list API response includes publishedAt for each document
 * (sanitizeOutput or list field selection may omit it).
 * Strapi 5 DB uses document_id and published_at; query engine may expose camelCase.
 */
async function ensureArticleListPublishedAt(results) {
  if (!Array.isArray(results) || results.length === 0) return;
  const documentIds = [...new Set(results.map((r) => r.documentId).filter((id) => id != null))];
  if (documentIds.length === 0) return;

  const byDocId = new Map();
  let rows = await strapi.db.query(ARTICLE_UID).findMany({
    where: { documentId: { $in: documentIds } },
    select: ['documentId', 'publishedAt'],
  });
  if (!rows?.length) {
    rows = await strapi.db.query(ARTICLE_UID).findMany({
      where: { document_id: { $in: documentIds } },
      select: ['document_id', 'published_at'],
    }) || [];
  }
  rows.forEach((r) => {
    const id = r.documentId ?? r.document_id;
    const at = r.publishedAt ?? r.published_at;
    if (id == null) return;
    const existing = byDocId.get(id);
    if (at != null || existing === undefined) byDocId.set(id, at);
  });

  let setCount = 0;
  results.forEach((doc) => {
    if (doc.documentId == null) return;
    const val = byDocId.get(doc.documentId);
    if (val !== undefined) {
      doc.publishedAt = val;
      setCount += 1;
    }
  });
  if (setCount > 0) {
    strapi.log.info(`Article list: injected publishedAt for ${setCount}/${results.length} documents`);
  }
}

function sortArticleResultsByPublishedAt(results, sortOrder) {
  if (!Array.isArray(results) || results.length === 0) return;
  const desc = /^publishedAt:DESC$/i.test(sortOrder);
  results.sort((a, b) => {
    const ta = a.publishedAt != null ? new Date(a.publishedAt).getTime() : null;
    const tb = b.publishedAt != null ? new Date(b.publishedAt).getTime() : null;
    if (ta == null && tb == null) return 0;
    if (ta == null) return desc ? -1 : 1;
    if (tb == null) return desc ? 1 : -1;
    return desc ? tb - ta : ta - tb;
  });
}

module.exports = (plugin) => {
  // ----- Article list: ensure find() response includes publishedAt and correct sort -----
  const collectionTypesController = plugin.controllers && plugin.controllers['collection-types'];
  if (collectionTypesController && typeof collectionTypesController.find === 'function') {
    const originalFind = collectionTypesController.find.bind(collectionTypesController);
    collectionTypesController.find = async (ctx) => {
      await originalFind(ctx);
      if (ctx.params?.model !== ARTICLE_UID || !ctx.body?.results) return;
      await ensureArticleListPublishedAt(ctx.body.results);
      const sortParam = ctx.request?.query?.sort;
      if (typeof sortParam === 'string' && /^publishedAt:(ASC|DESC|asc|desc)$/i.test(sortParam)) {
        sortArticleResultsByPublishedAt(ctx.body.results, sortParam);
      }
    };
  }

  // ----- Article list view: always return publishedAt in configuration so "Published at" column appears -----
  const contentTypesController = plugin.controllers && plugin.controllers['content-types'];
  if (contentTypesController && typeof contentTypesController.findContentTypeConfiguration === 'function') {
    const original = contentTypesController.findContentTypeConfiguration.bind(contentTypesController);
    contentTypesController.findContentTypeConfiguration = async (ctx) => {
      await original(ctx);
      const ct = ctx.body && ctx.body.data && ctx.body.data.contentType;
      if (ct && ct.uid === 'api::article.article' && ct.layouts) {
        const list = Array.isArray(ct.layouts.list) ? ct.layouts.list : [];
        if (!list.includes('publishedAt')) {
          ct.layouts.list = [...list, 'publishedAt'];
          ct.metadatas = ct.metadatas || {};
          ct.metadatas.publishedAt = {
            ...ct.metadatas.publishedAt,
            list: {
              label: 'publishedAt',
              searchable: false,
              sortable: true,
              ...(ct.metadatas.publishedAt && ct.metadatas.publishedAt.list),
            },
          };
          strapi.log.info('Article list config: injected publishedAt into layouts.list (extension)');
        }
      }
    };
  }

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

        if (opts.model === ARTICLE_UID && typeof query?.sort === 'string' && /^publishedAt:(ASC|DESC|asc|desc)$/i.test(query.sort)) {
          permissionQuery.sort = query.sort;
        }

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
