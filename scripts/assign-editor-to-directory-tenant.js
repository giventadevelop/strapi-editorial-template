'use strict';

/**
 * Assign an Editor (admin user) to the directory tenant so they can see
 * Directory – Bishops, Dioceses, Entries, etc. in the Content Manager.
 * Without this, the list shows "31 entries found" but "No content found" because
 * list results are filtered by the editor's assigned tenant.
 *
 * Usage:
 *   node scripts/assign-editor-to-directory-tenant.js editor@example.com
 *   EDITOR_EMAIL=editor@example.com node scripts/assign-editor-to-directory-tenant.js
 *
 * Uses TENANT_ID from .env (same as directory import); default: directory_mosc_001
 */

try {
  require('dotenv').config();
} catch (_) {}

const tenantId = process.env.TENANT_ID || 'directory_mosc_001';

async function main() {
  const email = process.argv[2] || process.env.EDITOR_EMAIL;
  if (!email || !String(email).trim()) {
    console.error('Usage: node scripts/assign-editor-to-directory-tenant.js <editor-email>');
    console.error('   or: EDITOR_EMAIL=editor@example.com node scripts/assign-editor-to-directory-tenant.js');
    process.exit(1);
  }
  const editorEmail = String(email).trim().toLowerCase();

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  console.log('Loading Strapi...');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  const strapi = app;

  try {
    const tenant = await strapi.db.query('api::tenant.tenant').findOne({
      where: { tenantId },
    });
    if (!tenant) {
      console.error('Tenant not found:', tenantId);
      console.error('Run the directory import first (npm run seed:data_import_seed_directory_mosc_in) to create the tenant.');
      await app.destroy();
      process.exit(1);
    }

    const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
      where: {},
      populate: { tenant: true },
    });
    const mapping = mappings.find(
      (m) => (m.adminUserEmail || '').toLowerCase() === editorEmail
    );

    if (mapping) {
      const currentTenantId = mapping.tenant?.tenantId ?? mapping.tenant?.id;
      if (currentTenantId === tenant.id || currentTenantId === tenant.tenantId) {
        console.log('Editor', editorEmail, 'is already assigned to tenant', tenantId);
        await app.destroy();
        process.exit(0);
      }
      await strapi.db.query('api::editor-tenant.editor-tenant').update({
        where: { id: mapping.id },
        data: { tenant: tenant.id },
      });
      console.log('Updated Editor Tenant:', editorEmail, '-> tenant', tenantId);
    } else {
      await strapi.db.query('api::editor-tenant.editor-tenant').create({
        data: {
          adminUserEmail: editorEmail,
          tenant: tenant.id,
        },
      });
      console.log('Created Editor Tenant:', editorEmail, '-> tenant', tenantId);
    }
    console.log('Done. Have the editor log out and log back in; they should now see Directory – Bishops, Dioceses, Entries, etc.');
  } catch (err) {
    console.error('Error:', err.message);
    throw err;
  } finally {
    await app.destroy();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
