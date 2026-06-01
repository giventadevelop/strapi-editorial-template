'use strict';

const {
  getTenantForAdminUser,
  getTenantForEmail,
  resolveTenantFromRequestContext,
  applyTenantToEventData,
} = require('../../../../utils/tenant-assignment');
const requestContext = require('../../../../utils/request-context');
const { applyKebabSlugToEvent } = require('../../../../utils/normalize-slug');

module.exports = {
  async beforeCreate(event) {
    applyKebabSlugToEvent(event);
    if (!event.params?.data) return;
    const ctx = requestContext.get();
    const user = ctx?.state?.user || ctx?.state?.admin;
    const email = user?.email;
    const tenant = email ? await getTenantForEmail(strapi, email) : await resolveTenantFromRequestContext(strapi);
    applyTenantToEventData(event, tenant);
  },

  async beforeUpdate(event) {
    applyKebabSlugToEvent(event);
    if (!event.params?.data) return;
    const ctx = requestContext.get();
    const user = ctx?.state?.user || ctx?.state?.admin;
    const email = user?.email;
    const tenant = email ? await getTenantForEmail(strapi, email) : await resolveTenantFromRequestContext(strapi);
    if (tenant && (event.params.data.tenant == null || event.params.data.tenant === '')) {
      applyTenantToEventData(event, tenant);
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
      await strapi.documents('api::article.article').update({
        documentId: result.documentId,
        data: { tenant: { connect: [relationId] } },
      });
    } catch (err) {
      strapi.log.warn('Could not auto-assign tenant to article:', err.message);
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
      await strapi.documents('api::article.article').update({
        documentId: result.documentId,
        data: { tenant: { connect: [relationId] } },
      });
    } catch (err) {
      strapi.log.warn('Could not auto-assign tenant to article:', err.message);
    }
  },
};
