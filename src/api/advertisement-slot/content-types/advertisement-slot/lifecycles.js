'use strict';

const {
  getTenantForAdminUser,
  resolveTenantFromRequestContext,
  applyTenantToEventData,
} = require('../../../../utils/tenant-assignment');

module.exports = {
  async beforeCreate(event) {
    if (!event.params?.data) return;
    const tenant = await resolveTenantFromRequestContext(strapi);
    applyTenantToEventData(event, tenant);
  },
  async afterCreate(event) {
    const { result } = event;
    if (!result || result.tenant) return;
    const createdById = typeof result.createdBy === 'object' ? result.createdBy?.id : result.createdBy;
    const tenant =
      (await resolveTenantFromRequestContext(strapi)) ||
      (await getTenantForAdminUser(strapi, createdById));
    const relationId = tenant?.id ?? tenant?.documentId;
    if (relationId == null || !result.documentId) return;
    try {
      await strapi.documents('api::advertisement-slot.advertisement-slot').update({
        documentId: result.documentId,
        data: { tenant: { connect: [relationId] } },
      });
    } catch (err) {
      strapi.log.warn('Could not auto-assign tenant to advertisement-slot:', err.message);
    }
  },
  async afterUpdate(event) {
    const { result } = event;
    if (!result || result.tenant) return;
    const updatedBy = result.updatedBy ?? result.createdBy;
    const updatedById = typeof updatedBy === 'object' ? updatedBy?.id : updatedBy;
    const tenant =
      (await resolveTenantFromRequestContext(strapi)) ||
      (await getTenantForAdminUser(strapi, updatedById));
    const relationId = tenant?.id ?? tenant?.documentId;
    if (relationId == null || !result.documentId) return;
    try {
      await strapi.documents('api::advertisement-slot.advertisement-slot').update({
        documentId: result.documentId,
        data: { tenant: { connect: [relationId] } },
      });
    } catch (err) {
      strapi.log.warn('Could not auto-assign tenant to advertisement-slot:', err.message);
    }
  },
};
