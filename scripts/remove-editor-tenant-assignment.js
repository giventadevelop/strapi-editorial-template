'use strict';

/**
 * Remove an Editor Tenant Assignment for email + tenantId.
 *
 * Usage:
 *   node scripts/remove-editor-tenant-assignment.js editor@example.com tenant_demo_002
 */

try {
  require('dotenv').config();
} catch (_) {}

const { loadStrapiApp } = require('./lib/load-strapi-app');

async function main() {
  const email = process.argv[2];
  const tenantId = process.argv[3] || process.env.TENANT_ID;
  if (!email || !tenantId) {
    console.error('Usage: node scripts/remove-editor-tenant-assignment.js <editor-email> <tenant-id>');
    process.exit(1);
  }
  const editorEmail = String(email).trim().toLowerCase();

  const app = await loadStrapiApp();
  try {
    const tenant = await app.db.query('api::tenant.tenant').findOne({ where: { tenantId } });
    if (!tenant) {
      console.error('Tenant not found:', tenantId);
      process.exit(1);
    }

    const rows = await app.db.query('api::editor-tenant.editor-tenant').findMany({
      where: {},
      populate: { tenant: true },
    });

    const match = rows.find(
      (r) =>
        (r.adminUserEmail || '').toLowerCase() === editorEmail &&
        (r.tenant?.tenantId ?? r.tenant?.tenant_id) === tenant.tenantId
    );

    if (!match) {
      console.log('No assignment found for', editorEmail, 'on', tenantId);
      process.exit(0);
    }

    await app.db.query('api::editor-tenant.editor-tenant').delete({ where: { id: match.id } });
    console.log('Removed assignment:', editorEmail, '->', tenantId);
  } finally {
    await app.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
