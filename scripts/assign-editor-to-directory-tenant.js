'use strict';

/**
 * Assign an Editor (admin user) to a tenant.
 *
 * Default (--add): add assignment if email+tenant not already mapped (multi-tenant editors).
 * --replace: replace all assignments for this email with the single tenant (legacy behavior).
 *
 * Usage:
 *   node scripts/assign-editor-to-directory-tenant.js editor@example.com tenant_demo_002
 *   node scripts/assign-editor-to-directory-tenant.js editor@example.com tenant_demo_002 --add
 *   node scripts/assign-editor-to-directory-tenant.js editor@example.com tenant_demo_002 --replace
 */

try {
  require('dotenv').config();
} catch (_) {}

function getTenantId() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args[1] && String(args[1]).trim()) return args[1].trim();
  if (process.env.TENANT_ID) return process.env.TENANT_ID.trim();
  return 'directory_mosc_001';
}

function buildAssignmentKey(email, tenantId) {
  return `${String(email).trim().toLowerCase()}__${tenantId}`;
}

const replaceMode = process.argv.includes('--replace');
const addMode = process.argv.includes('--add') || !replaceMode;
const tenantId = getTenantId();

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const email = args[0] || process.env.EDITOR_EMAIL;
  if (!email || !String(email).trim()) {
    console.error('Usage: node scripts/assign-editor-to-directory-tenant.js <editor-email> [tenant-id] [--add|--replace]');
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
      process.exit(1);
    }

    const mappings = await strapi.db.query('api::editor-tenant.editor-tenant').findMany({
      where: {},
      populate: { tenant: true },
    });
    const forEmail = mappings.filter(
      (m) => (m.adminUserEmail || '').toLowerCase() === editorEmail
    );

    const existingForPair = forEmail.find(
      (m) => (m.tenant?.tenantId ?? m.tenant?.tenant_id) === tenant.tenantId
    );

    if (existingForPair) {
      console.log('Editor', editorEmail, 'is already assigned to tenant', tenantId);
      await app.destroy();
      process.exit(0);
    }

    if (replaceMode && forEmail.length > 0) {
      for (const row of forEmail) {
        await strapi.db.query('api::editor-tenant.editor-tenant').delete({ where: { id: row.id } });
      }
      console.log('Removed', forEmail.length, 'previous assignment(s) for', editorEmail);
    }

    const assignmentKey = buildAssignmentKey(editorEmail, tenant.tenantId);
    await strapi.db.query('api::editor-tenant.editor-tenant').create({
      data: {
        adminUserEmail: editorEmail,
        assignmentKey,
        tenant: tenant.id,
      },
    });

    console.log(
      addMode ? 'Added' : 'Created',
      'Editor Tenant:',
      editorEmail,
      '-> tenant',
      tenantId
    );
    console.log('Have the editor log out and log back in. Use the Active tenant switcher if multiple tenants are assigned.');
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
