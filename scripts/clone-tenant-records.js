'use strict';

/**
 * Clone all tenant-scoped records from source tenant to target tenant (same Strapi instance).
 *
 * Usage:
 *   node scripts/clone-tenant-records.js --source-tenant-id=tenant_demo_002 --target-tenant-id=tenant_demo_003 --create-target --slug-suffix=-demo003 --dry-run
 *   npm run clone:tenant -- --source-tenant-id=tenant_demo_002 --target-tenant-id=tenant_demo_003 --create-target --slug-suffix=-demo003
 *
 * Options:
 *   --source-tenant-id   Source tenantId (default: tenant_demo_002)
 *   --target-tenant-id   Target tenantId (required)
 *   --create-target      Create target Tenant if missing
 *   --target-name        Name for new tenant
 *   --target-domain      Domain for new tenant
 *   --slug-suffix        Append to slug fields (required when cloning on same instance)
 *   --dry-run            Count/plan only; no writes
 *   --types=articles,dioceses   Clone subset only
 *   --force              Re-clone even if target slug exists
 *   --batch-size=50      Log progress every N creates
 *
 * Stop Strapi dev server before running (embedded Strapi loads local DB).
 */

try {
  require('dotenv').config();
} catch (_) {}

const { loadStrapiApp } = require('./lib/load-strapi-app');
const {
  parseCloneArgs,
  resolveTenant,
  filterCloneOrder,
  ensureTargetTenant,
  cleanTargetTenantRecords,
  cloneCollectionType,
  printStatsReport,
  SINGLE_TYPE_UIDS,
} = require('./lib/tenant-clone-helpers');

async function main() {
  const args = parseCloneArgs();

  if (!args.targetTenantId) {
    console.error('Missing --target-tenant-id');
    console.error('Example: npm run clone:tenant -- --source-tenant-id=tenant_demo_002 --target-tenant-id=tenant_demo_003 --create-target --slug-suffix=-demo003 --dry-run');
    process.exit(1);
  }

  if (args.sourceTenantId === args.targetTenantId) {
    console.error('Source and target tenant IDs must differ.');
    process.exit(1);
  }

  if (!args.slugSuffix && !args.dryRun) {
    console.warn('Warning: --slug-suffix not set. Slug collisions may fail on the same instance.');
  }

  const app = await loadStrapiApp();

  try {
    const sourceTenant = await resolveTenant(app, args.sourceTenantId);
    if (!sourceTenant) {
      console.error('Source tenant not found:', args.sourceTenantId);
      process.exit(1);
    }

    const targetTenant = await ensureTargetTenant(app, args, sourceTenant);
    const order = filterCloneOrder(app, args.types);

    if (args.cleanTarget && !args.dryRun) {
      console.log('\nCleaning existing records for target tenant...');
      await cleanTargetTenantRecords(app, targetTenant, order, args.slugSuffix);
    }

    if (order.length === 0) {
      console.error('No content types matched --types filter.');
      process.exit(1);
    }

    console.log('Clone tenant records');
    console.log('  Source:', args.sourceTenantId);
    console.log('  Target:', args.targetTenantId);
    console.log('  Types:', order.length);
    console.log('  Dry run:', args.dryRun);
    console.log('  Slug suffix:', args.slugSuffix || '(none)');

    console.log('\nSkipped single types:', [...SINGLE_TYPE_UIDS].join(', '));

    const idMap = new Map();
    const stats = { created: [], skipped: [], failed: [], empty: [] };
    const ctx = { sourceTenant, targetTenant, args, idMap, stats };

    for (const uid of order) {
      await cloneCollectionType(app, uid, ctx);
    }

    printStatsReport(stats, args);

    if (stats.failed.length > 0) process.exit(2);
  } finally {
    await app.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
