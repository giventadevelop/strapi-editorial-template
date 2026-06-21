'use strict';

function buildAssignmentKey(email, tenantId) {
  const e = String(email || '').trim().toLowerCase();
  const t = String(tenantId || '').trim();
  return `${e}__${t}`;
}

module.exports = {
  async beforeCreate(event) {
    const data = event.params?.data;
    if (!data) return;

    let email = data.adminUserEmail;
    let tenantId = data.tenant;

    if (typeof tenantId === 'object' && tenantId !== null) {
      tenantId = tenantId.tenantId ?? tenantId.tenant_id ?? tenantId.documentId ?? tenantId.id;
    }

    if (email && tenantId && !data.assignmentKey) {
      if (typeof tenantId === 'number' || String(tenantId).match(/^\d+$/)) {
        const tenant = await strapi.db.query('api::tenant.tenant').findOne({
          where: { id: Number(tenantId) },
          select: ['tenantId'],
        });
        tenantId = tenant?.tenantId ?? tenantId;
      }
      data.assignmentKey = buildAssignmentKey(email, tenantId);
      data.adminUserEmail = String(email).trim().toLowerCase();
    }
  },

  async beforeUpdate(event) {
    const data = event.params?.data;
    if (!data) return;

    const existing = await strapi.db.query('api::editor-tenant.editor-tenant').findOne({
      where: { id: event.params.where.id },
      populate: { tenant: true },
    });
    if (!existing) return;

    const email = (data.adminUserEmail ?? existing.adminUserEmail ?? '').trim().toLowerCase();
    let tenantId = data.tenant;
    if (tenantId == null && existing.tenant) {
      tenantId = existing.tenant.tenantId ?? existing.tenant.id;
    }
    if (typeof tenantId === 'object' && tenantId !== null) {
      tenantId = tenantId.tenantId ?? tenantId.tenant_id ?? tenantId.id;
    }
    if (typeof tenantId === 'number' || (tenantId && String(tenantId).match(/^\d+$/))) {
      const tenant = await strapi.db.query('api::tenant.tenant').findOne({
        where: { id: Number(tenantId) },
        select: ['tenantId'],
      });
      tenantId = tenant?.tenantId ?? tenantId;
    }

    if (email && tenantId) {
      data.assignmentKey = buildAssignmentKey(email, tenantId);
      data.adminUserEmail = email;
    }
  },
};
