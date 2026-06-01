'use strict';

const requestContext = require('./request-context');

/**
 * Resolve tenant for an admin user. Returns { id, documentId }.
 */
async function getTenantForAdminUser(strapi, adminUserId) {
  if (!adminUserId) return null;
  const adminUser = await strapi.db.query('admin::user').findOne({
    where: { id: adminUserId },
    select: ['email'],
  });
  if (!adminUser?.email) return null;
  return getTenantForEmail(strapi, adminUser.email);
}

/** Case-insensitive lookup by admin email. Returns { id, documentId } or null. */
async function getTenantForEmail(strapi, email) {
  if (!email) return null;
  const emailLower = String(email).toLowerCase();
  const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
    where: {},
    populate: { tenant: true },
  });
  const mapping = mappings.find((m) => (m.adminUserEmail || '').toLowerCase() === emailLower);
  const tenant = mapping?.tenant;
  if (!tenant) return null;
  const id = tenant.id;
  const documentId = tenant.documentId ?? tenant.document_id;
  if (id == null && documentId == null) return null;
  return { id: id ?? undefined, documentId: documentId ?? undefined };
}

async function getAdminUserIdFromContext(strapi) {
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

async function resolveTenantFromRequestContext(strapi) {
  const ctx = requestContext.get();
  const user = ctx?.state?.user || ctx?.state?.admin;
  if (user?.email) {
    const t = await getTenantForEmail(strapi, user.email);
    if (t) return t;
  }
  const adminUserId = await getAdminUserIdFromContext(strapi);
  if (adminUserId != null) {
    return getTenantForAdminUser(strapi, adminUserId);
  }
  return null;
}

function getTenantJoinTable(strapi, uid) {
  try {
    const meta = strapi.db.metadata.get(uid);
    const attrs = meta?.attributes;
    const tenantAttr = attrs instanceof Map ? attrs.get('tenant') : attrs?.tenant;
    const jt = tenantAttr?.joinTable;
    if (!jt?.name || !jt?.joinColumn?.name || !jt?.inverseJoinColumn?.name) return null;
    return {
      table: jt.name,
      srcCol: jt.joinColumn.name,
      tgtCol: jt.inverseJoinColumn.name,
      ordCol: jt.orderColumnName || null,
    };
  } catch {
    return null;
  }
}

/**
 * Ensure a content row has a tenant link. Returns tenant numeric id if linked/updated.
 */
async function ensureTenantLinkOnRow(strapi, uid, rowId, tenantNumericId, joinTable) {
  if (!rowId || tenantNumericId == null || !joinTable) return false;
  const knex = strapi.db.connection;
  const existing = await knex(joinTable.table).where({ [joinTable.srcCol]: rowId }).first();
  if (existing) {
    if (existing[joinTable.tgtCol] !== tenantNumericId) {
      await knex(joinTable.table)
        .where({ [joinTable.srcCol]: rowId })
        .update({ [joinTable.tgtCol]: tenantNumericId });
      return true;
    }
    return false;
  }
  const ins = {
    [joinTable.srcCol]: rowId,
    [joinTable.tgtCol]: tenantNumericId,
  };
  if (joinTable.ordCol) ins[joinTable.ordCol] = 1;
  await knex(joinTable.table).insert(ins);
  return true;
}

/**
 * Before publish: ensure draft row has tenant (from editor mapping or existing published link).
 */
async function ensureDraftTenantBeforePublish(strapi, uid, documentId, locale) {
  const ct = strapi.contentType(uid);
  const joinTable = getTenantJoinTable(strapi, uid);
  if (!ct?.collectionName || !joinTable) return;

  const knex = strapi.db.connection;
  const tableName = ct.collectionName;

  const draftQuery = knex(tableName)
    .where({ document_id: documentId })
    .whereNull('published_at')
    .select('id');
  if (locale) draftQuery.andWhere({ locale });
  const draftRow = await draftQuery.first();
  if (!draftRow) return;

  const draftLink = await knex(joinTable.table)
    .where({ [joinTable.srcCol]: draftRow.id })
    .first();
  if (draftLink?.[joinTable.tgtCol]) return;

  const pubQuery = knex(tableName)
    .where({ document_id: documentId })
    .whereNotNull('published_at')
    .select('id');
  if (locale) pubQuery.andWhere({ locale });
  const publishedRow = await pubQuery.first();
  if (publishedRow) {
    const pubLink = await knex(joinTable.table)
      .where({ [joinTable.srcCol]: publishedRow.id })
      .first();
    if (pubLink?.[joinTable.tgtCol]) {
      await ensureTenantLinkOnRow(strapi, uid, draftRow.id, pubLink[joinTable.tgtCol], joinTable);
      return;
    }
  }

  const tenant = await resolveTenantFromRequestContext(strapi);
  const tenantNumericId = tenant?.id;
  if (tenantNumericId == null) return;

  await ensureTenantLinkOnRow(strapi, uid, draftRow.id, tenantNumericId, joinTable);
}

/**
 * After publish: copy draft tenant link to published row (Strapi 5 does not always copy relations).
 */
async function copyTenantDraftToPublished(strapi, uid, documentId, locale) {
  const ct = strapi.contentType(uid);
  const joinTable = getTenantJoinTable(strapi, uid);
  if (!ct?.collectionName || !joinTable) return;

  const knex = strapi.db.connection;
  const tableName = ct.collectionName;

  const draftQuery = knex(tableName)
    .where({ document_id: documentId })
    .whereNull('published_at')
    .select('id');
  if (locale) draftQuery.andWhere({ locale });
  const draftRow = await draftQuery.first();

  const pubQuery = knex(tableName)
    .where({ document_id: documentId })
    .whereNotNull('published_at')
    .select('id');
  if (locale) pubQuery.andWhere({ locale });
  const publishedRow = await pubQuery.first();

  if (!draftRow || !publishedRow) return;

  const draftLink = await knex(joinTable.table)
    .where({ [joinTable.srcCol]: draftRow.id })
    .first();
  if (!draftLink?.[joinTable.tgtCol]) return;

  const pubLink = await knex(joinTable.table)
    .where({ [joinTable.srcCol]: publishedRow.id })
    .first();

  if (pubLink) {
    if (pubLink[joinTable.tgtCol] !== draftLink[joinTable.tgtCol]) {
      await knex(joinTable.table)
        .where({ [joinTable.srcCol]: publishedRow.id })
        .update({ [joinTable.tgtCol]: draftLink[joinTable.tgtCol] });
      strapi.log.info(`Tenant updated on published ${uid} (${documentId})`);
    }
  } else {
    const ins = {
      [joinTable.srcCol]: publishedRow.id,
      [joinTable.tgtCol]: draftLink[joinTable.tgtCol],
    };
    if (joinTable.ordCol && draftLink[joinTable.ordCol] != null) {
      ins[joinTable.ordCol] = draftLink[joinTable.ordCol];
    }
    await knex(joinTable.table).insert(ins);
    strapi.log.info(`Tenant copied to published ${uid} (${documentId})`);
  }
}

function applyTenantToEventData(event, tenant) {
  if (!event.params?.data) return;
  const relationId = tenant?.id ?? tenant?.documentId;
  if (relationId != null) {
    event.params.data.tenant = relationId;
  } else {
    delete event.params.data.tenant;
  }
}

module.exports = {
  getTenantForAdminUser,
  getTenantForEmail,
  resolveTenantFromRequestContext,
  getTenantJoinTable,
  ensureTenantLinkOnRow,
  ensureDraftTenantBeforePublish,
  copyTenantDraftToPublished,
  applyTenantToEventData,
};
