'use strict';

/**
 * Push all tenant-scoped records from local Strapi to Strapi Cloud (REST upsert).
 *
 * Prerequisites (.env):
 *   STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN (Full Access)
 *
 * Usage (stop local Strapi dev server first):
 *   npm run push:tenant-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --dry-run
 *   npm run push:tenant-to-cloud -- --tenant-id=mosc_malankara_orthodox_2
 *   npm run push:tenant-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --force
 *
 * Options:
 *   --tenant-id=XXX   Tenant to push (required)
 *   --dry-run         Count/plan only
 *   --force           Update existing cloud rows (default: skip existing)
 *   --types=dioceses,parishes   Subset only
 *   --delay-ms=100    Delay between HTTP writes
 */

try {
  require('dotenv').config();
} catch (_) {}

const { loadStrapiApp } = require('./lib/load-strapi-app');
const { resolveTenant, SINGLE_TYPE_UIDS } = require('./lib/tenant-clone-helpers');
const {
  parsePushArgs,
  createCloudClient,
  fetchCloudTenants,
  fetchGlobalSlugMaps,
  filterCloneOrder,
  pushCollectionType,
  printPushReport,
} = require('./lib/push-tenant-cloud-helpers');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

async function main() {
  const args = parsePushArgs();

  if (!args.tenantId) {
    console.error('Missing --tenant-id');
    console.error('Example: npm run push:tenant-to-cloud -- --tenant-id=mosc_malankara_orthodox_2 --dry-run');
    process.exit(1);
  }

  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const { cloudFetch } = createCloudClient(CLOUD_URL, API_TOKEN);

  const app = await loadStrapiApp();
  try {
    const tenant = await resolveTenant(app, args.tenantId);
    if (!tenant) {
      console.error('Local tenant not found:', args.tenantId);
      process.exit(1);
    }

    const cloudTenants = await fetchCloudTenants(cloudFetch);
    let cloudTenant = cloudTenants.get(args.tenantId);
    if (!cloudTenant) {
      console.error('Cloud tenant not found:', args.tenantId);
      console.error('Create it on Cloud first or verify deploy completed.');
      process.exit(1);
    }

    const order = filterCloneOrder(app, args.types);
    if (!order.length) {
      console.error('No content types matched --types filter.');
      process.exit(1);
    }

    console.log('Push tenant to Cloud');
    console.log('  Local tenant:', args.tenantId, `(${tenant.name})`);
    console.log('  Cloud:', CLOUD_URL);
    console.log('  Types:', order.length);
    console.log('  Dry run:', args.dryRun);
    console.log('  Force:', args.force);
    console.log('\nSkipped single types:', [...SINGLE_TYPE_UIDS].join(', '));

    const globalSlugMaps = args.dryRun ? {} : await fetchGlobalSlugMaps(cloudFetch, app);

    const idMap = new Map();
    const stats = { created: [], updated: [], skipped: [], failed: [], empty: [] };
    const ctx = {
      tenant,
      cloudTenant,
      cloudFetch,
      args,
      idMap,
      globalSlugMaps,
      stats,
      delayMs: args.delayMs,
    };

    for (const uid of order) {
      await pushCollectionType(app, uid, ctx);
    }

    printPushReport(stats, args, CLOUD_URL);

    if (stats.failed.length > 0) process.exit(2);
  } finally {
    await app.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
