'use strict';

const requestContext = require('../../../../utils/request-context');

async function getTenantForAdminUser(strapi, adminUserId) {
  if (!adminUserId) return null;
  const adminUser = await strapi.db.query('admin::user').findOne({
    where: { id: adminUserId },
    select: ['email'],
  });
  if (!adminUser?.email) return null;
  return getTenantForEmail(strapi, adminUser.email);
}

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

module.exports = {
  async beforeCreate(event) {
    if (!event.params?.data) return;
    const ctx = requestContext.get();
    const user = ctx?.state?.user || ctx?.state?.admin;
    const email = user?.email;
    const tenant = email ? await getTenantForEmail(strapi, email) : null;
    const relationId = tenant?.id ?? tenant?.documentId;
    if (relationId != null) {
      event.params.data.tenant = relationId;
    } else {
      delete event.params.data.tenant;
    }
  },
  async afterCreate(event) {
    const { result } = event;
    if (!result || result.tenant) return;
    const createdById = typeof result.createdBy === 'object' ? result.createdBy?.id : result.createdBy;
    const tenant = await getTenantForAdminUser(strapi, createdById);
    const relationId = tenant?.id ?? tenant?.documentId;
    if (relationId == null || !result.documentId) return;
    try {
      await strapi.documents('api::directory-entry.directory-entry').update({
        documentId: result.documentId,
        data: { tenant: { connect: [relationId] } },
      });
    } catch (err) {
      strapi.log.warn('Could not auto-assign tenant to directory-entry:', err.message);
    }
  },
  async afterUpdate(event) {
    const { result } = event;
    if (!result || result.tenant) return;
    const updatedBy = result.updatedBy ?? result.createdBy;
    const updatedById = typeof updatedBy === 'object' ? updatedBy?.id : updatedBy;
    const tenant = await getTenantForAdminUser(strapi, updatedById);
    const relationId = tenant?.id ?? tenant?.documentId;
    if (relationId == null || !result.documentId) return;
    try {
      await strapi.documents('api::directory-entry.directory-entry').update({
        documentId: result.documentId,
        data: { tenant: { connect: [relationId] } },
      });
    } catch (err) {
      strapi.log.warn('Could not auto-assign tenant to directory-entry:', err.message);
    }
  },
};
