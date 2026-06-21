'use strict';

/**
 * Inventory tenant-scoped content counts (read-only).
 *
 * Usage:
 *   node scripts/inventory-tenant-records.js --tenant-id=tenant_demo_002
 *   npm run inventory:tenant -- --tenant-id=tenant_demo_002
 */

try {
  require('dotenv').config();
} catch (_) {}

const { loadStrapiApp } = require('./lib/load-strapi-app');
const {
  parseCloneArgs,
  resolveTenant,
  countDocumentsForTenant,
  CLONE_ORDER,
  SINGLE_TYPE_UIDS,
  pluralFromUid,
} = require('./lib/tenant-clone-helpers');

async function main() {
  const args = parseCloneArgs();
  const tenantId =
    process.argv.find((a) => a.startsWith('--tenant-id='))?.split('=')[1]?.trim() ||
    args.sourceTenantId;
  if (!tenantId) {
    console.error('Missing --tenant-id or --source-tenant-id');
    process.exit(1);
  }
  const app = await loadStrapiApp();

  try {
    const tenant = await resolveTenant(app, tenantId);
    if (!tenant) {
      console.error('Tenant not found:', tenantId);
      process.exit(1);
    }

    console.log('Tenant inventory for:', tenantId);
    console.log('Name:', tenant.name, '| Domain:', tenant.domain);
    console.log('');
    console.log('UID'.padEnd(48), 'Plural'.padEnd(28), 'Count');
    console.log('-'.repeat(90));

    let total = 0;
    for (const uid of CLONE_ORDER) {
      if (!app.contentTypes[uid]) continue;
      const info = await countDocumentsForTenant(app, uid, tenant);
      const count = info.count ?? 0;
      total += count;
      const extra =
        info.draft != null ? ` (draft:${info.draft} pub:${info.published})` : '';
      console.log(uid.padEnd(48), pluralFromUid(uid).padEnd(28), String(count) + extra);
    }

    console.log('-'.repeat(90));
    console.log('Collection types total rows (draft count for D&P types):', total);

    console.log('\nSingle types (not cloneable per-tenant on same instance):');
    for (const uid of SINGLE_TYPE_UIDS) {
      console.log(' ', uid);
    }
  } finally {
    await app.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
