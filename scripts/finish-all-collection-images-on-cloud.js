'use strict';

/**
 * Re-link Cloud images for every collection in cloud-image-migration-config.js.
 * Run after Strapi Cloud deploy when frontend-imported directory images are broken.
 *
 * Usage:
 *   npm run finish:all-collection-images-on-cloud -- --tenant-id=tenant_demo_002
 *   npm run finish:all-collection-images-on-cloud -- --tenant-id=tenant_demo_002 --only=training,holy-synod
 *
 * Prerequisites: local Strapi stopped; .env STRAPI_CLOUD_URL + STRAPI_CLOUD_API_TOKEN;
 * local images in public/uploads/ from phase-A import.
 */

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  override: false,
});

const { listCollectionKeys } = require('./lib/cloud-image-migration-config');
const { getTenantId } = require('./lib/liturgy-cli');

function parseOnly(argv) {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (arg) return arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  const idx = argv.indexOf('--only');
  if (idx >= 0 && argv[idx + 1]) {
    return argv[idx + 1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

async function main() {
  const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });
  const only = parseOnly(process.argv);
  const keys = (only && only.length > 0 ? only : listCollectionKeys()).filter((key) =>
    listCollectionKeys().includes(key)
  );

  if (keys.length === 0) {
    console.error('No valid collection keys. Available:', listCollectionKeys().join(', '));
    process.exit(1);
  }

  console.log('Tenant:', tenantId);
  console.log('Collections:', keys.join(', '));
  console.log('Stop local Strapi before continuing.\n');

  const results = [];
  for (const key of keys) {
    console.log('\n==========', key, '==========');
    const run = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'finish-collection-images-on-cloud.js'),
        `--collection=${key}`,
        `--tenant-id=${tenantId}`,
      ],
      { stdio: 'inherit', env: process.env }
    );
    results.push({ key, ok: run.status === 0, status: run.status ?? 1 });
  }

  console.log('\n========== Summary ==========');
  for (const { key, ok, status } of results) {
    console.log(ok ? 'OK  ' : 'FAIL', key, ok ? '' : `(exit ${status})`);
  }

  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
