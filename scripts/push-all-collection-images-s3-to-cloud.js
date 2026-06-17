'use strict';

/**
 * Bulk push directory collection images to Cloud via S3 + register-s3-media.
 *
 * Usage:
 *   npm run push:all-collection-images-s3-to-cloud -- --tenant-id=tenant_demo_002
 *   npm run push:all-collection-images-s3-to-cloud -- --tenant-id=tenant_demo_002 --only=training,holy-synod
 *   npm run push:all-collection-images-s3-to-cloud -- --skip-api
 *
 * Prerequisites: local Strapi stopped; .env AWS_* + STRAPI_CLOUD_*; images in public/uploads/
 */

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

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

const EXTRA_ARGS = process.argv.filter(
  (a) => a.startsWith('--skip-api') || a.startsWith('--skip-s3') || a.startsWith('--link-existing')
);

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

  console.log('Bulk S3 image push to Cloud');
  console.log('Tenant:', tenantId);
  console.log('Collections:', keys.join(', '));
  console.log('Stop local Strapi before continuing.\n');

  const results = [];
  for (const key of keys) {
    console.log('\n==========', key, '==========');
    const run = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'push-collection-images-s3-to-cloud.js'),
        `--collection=${key}`,
        `--tenant-id=${tenantId}`,
        ...EXTRA_ARGS,
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
