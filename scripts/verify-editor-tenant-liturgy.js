'use strict';

/**
 * Verify Editor Tenant Assignment and liturgy-day counts so editors see data in Content Manager.
 * Run (with Strapi stopped): node scripts/verify-editor-tenant-liturgy.js [editor-email]
 *
 * With no args: list all editor→tenant mappings and liturgy-day count per tenant.
 * With email: show which tenant that editor is assigned to and how many liturgy days that tenant has.
 */

try {
  require('dotenv').config();
} catch (_) {}

const checkEmail = process.argv[2] ? String(process.argv[2]).trim().toLowerCase() : null;

async function main() {
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  try {
    const mappings = await app.db.query('api::editor-tenant.editor-tenant').findMany({
      where: {},
      populate: { tenant: true },
    });

    // Unique tenants from mappings (same filter shape as content-manager for list view)
    const seenTenantIds = new Set();
    const tenantsWithMeta = mappings.map((m) => m.tenant).filter(Boolean).filter((t) => {
      if (seenTenantIds.has(t.id)) return false;
      seenTenantIds.add(t.id);
      return true;
    });
    const liturgyCountByTenantId = {};
    const liturgyAll = await app.documents('api::liturgy-day.liturgy-day').findMany({ limit: 50000 });
    const totalLiturgy = (liturgyAll?.results ?? liturgyAll?.data ?? (Array.isArray(liturgyAll) ? liturgyAll : [])).length;
    for (const tenant of tenantsWithMeta) {
      const docId = tenant.documentId ?? tenant.document_id;
      const filters =
        docId != null
          ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
          : { tenant: tenant.id };
      const result = await app.documents('api::liturgy-day.liturgy-day').findMany({
        filters,
        limit: 50000,
      });
      const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
      liturgyCountByTenantId[tenant.id] = list.length;
    }

    if (checkEmail) {
      const allUsers = await app.db.query('admin::user').findMany({
        where: {},
        populate: { roles: true },
        select: ['id', 'email'],
      });
      const user = allUsers.find((u) => (u.email || '').toLowerCase() === checkEmail);
      if (user) {
        const roleCodes = (user.roles || []).map((r) => r.code || r.name).filter(Boolean);
        const hasEditorRole = roleCodes.includes('strapi-editor');
        console.log('Admin user:', user.email);
        console.log('  Role(s):', roleCodes.join(', ') || '(none)');
        if (!hasEditorRole) {
          console.log('  WARNING: Content Manager tenant filter only applies to role code "strapi-editor".');
          console.log('  If this user has a custom Editor role, set its code to strapi-editor in Settings -> Roles.');
        }
        console.log('');
      } else {
        console.log('No admin user found with email:', checkEmail);
        console.log('');
      }

      const mapping = mappings.find(
        (m) => (m.adminUserEmail || '').toLowerCase() === checkEmail
      );
      if (!mapping) {
        console.log('No Editor Tenant Assignment found for:', checkEmail);
        console.log('Create one with: node scripts/assign-editor-to-directory-tenant.js', checkEmail, 'tenant_demo_002');
        await app.destroy();
        process.exit(1);
      }
      const tenant = mapping.tenant;
      const tenantIdStr = tenant?.tenantId ?? tenant?.id ?? '?';
      const count = tenant ? (liturgyCountByTenantId[tenant.id] ?? 0) : 0;
      console.log('Editor Tenant Assignment:');
      console.log('  Assigned tenant:', tenantIdStr, '(id:', tenant?.id + ')');
      console.log('  Liturgy days for this tenant:', count);
      console.log('  Total liturgy days in DB (all tenants):', totalLiturgy);
      if (count === 0) {
        console.log('');
        if (totalLiturgy > 0) {
          console.log('Other tenants have liturgy days; this tenant has none. Re-import for this tenant:');
        } else {
          console.log('No liturgy days in the database. Import with:');
        }
        console.log('  node scripts/import-liturgy-days-from-pdf.js --tenant-id=' + tenantIdStr + ' --year=2026');
      } else {
        console.log('');
        console.log('If the editor still sees 0 in Content Manager:');
        console.log('  1. Ensure the user has role with code "strapi-editor" (see above).');
        console.log('  2. Have the editor log out and log back in.');
      }
      await app.destroy();
      process.exit(0);
    }

    console.log('Editor Tenant Assignments:');
    console.log('  (Editor role must have code "strapi-editor" to be tenant-scoped.)');
    for (const m of mappings) {
      const t = m.tenant;
      const tidStr = t?.tenantId ?? t?.id ?? '?';
      const count = t ? (liturgyCountByTenantId[t.id] ?? 0) : 0;
      console.log('  ', (m.adminUserEmail || '').padEnd(40), '->', tidStr, '  (liturgy days:', count + ')');
    }
    console.log('');
    console.log('Total liturgy days (all tenants):', totalLiturgy);
    await app.destroy();
  } catch (err) {
    console.error(err);
    await app.destroy();
    process.exit(1);
  }
  process.exit(0);
}

main();
