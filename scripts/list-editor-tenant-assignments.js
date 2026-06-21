'use strict';

/**
 * List Editor Tenant Assignment rows (optionally filtered by email).
 *
 * Usage:
 *   node scripts/list-editor-tenant-assignments.js
 *   node scripts/list-editor-tenant-assignments.js editor@example.com
 */

try {
  require('dotenv').config();
} catch (_) {}

const { loadStrapiApp } = require('./lib/load-strapi-app');

async function main() {
  const emailFilter = process.argv[2] ? String(process.argv[2]).trim().toLowerCase() : null;
  const app = await loadStrapiApp();

  try {
    const rows = await app.db.query('api::editor-tenant.editor-tenant').findMany({
      populate: { tenant: true },
      orderBy: { adminUserEmail: 'asc' },
    });

    const filtered = emailFilter
      ? rows.filter((r) => (r.adminUserEmail || '').toLowerCase() === emailFilter)
      : rows;

    console.log('Editor Tenant Assignments:', filtered.length);
    for (const row of filtered) {
      const tid = row.tenant?.tenantId ?? row.tenant?.tenant_id ?? '?';
      const name = row.tenant?.name ?? '';
      console.log(`  ${row.adminUserEmail} -> ${tid}${name ? ` (${name})` : ''} [${row.assignmentKey || 'no-key'}]`);
    }
  } finally {
    await app.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
