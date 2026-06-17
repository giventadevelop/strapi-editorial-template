'use strict';

/**
 * Push directory collection images to Strapi Cloud via S3 + register-s3-media.
 *
 * Strategy:
 *   1. POST /api/upload (when Cloud has valid AWS env + UPLOAD_PROVIDER=aws-s3)
 *   2. Upload to shared S3 prod prefix from local .env AWS creds +
 *      POST /api/migration/register-s3-media + link entry
 *
 * Usage (local Strapi stopped):
 *   node scripts/push-collection-images-s3-to-cloud.js --collection=training --tenant-id=tenant_demo_002
 *   node scripts/push-collection-images-s3-to-cloud.js --collection=catholicate --skip-api
 *   node scripts/push-collection-images-s3-to-cloud.js --collection=catholicate --link-existing
 *
 * Env: STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *      AWS_REGION, AWS_S3_BUCKET_NAME
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const {
  getCollectionKey,
  getCollectionConfig,
  listCollectionKeys,
} = require('./lib/cloud-image-migration-config');
const { getTenantId } = require('./lib/liturgy-cli');
const { pushCollectionImagesS3, CLOUD_URL, API_TOKEN } = require('./lib/push-collection-images-s3');

const SKIP_API = process.argv.includes('--skip-api');
const SKIP_S3 = process.argv.includes('--skip-s3');
const LINK_EXISTING = process.argv.includes('--link-existing');

async function main() {
  const collectionKey = getCollectionKey();
  const config = getCollectionConfig(collectionKey);
  if (!config) {
    console.error('Pass --collection=<key>. Available:', listCollectionKeys().join(', '));
    process.exit(1);
  }
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });
  console.log('Push', config.label, 'images to Cloud (S3 path)');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant:', tenantId);
  console.log(
    '  Mode:',
    LINK_EXISTING ? 'link-existing' : SKIP_S3 ? 'api-only' : SKIP_API ? 's3-register-only' : 'api then s3-register'
  );

  const result = await pushCollectionImagesS3(config, tenantId, {
    skipS3: SKIP_S3,
    linkExisting: LINK_EXISTING,
    tryApiFirst: !SKIP_API && !LINK_EXISTING,
  });

  console.log('\nDone.', config.label);
  console.log('  Entries:', result.entries);
  console.log('  Linked:', result.linked);
  console.log('  Skipped (no media):', result.skipped);
  console.log('  Failed:', result.failed);
  if (config.verifyScript) console.log('  Verify:', config.verifyScript);

  process.exit(result.failed > 0 && result.linked === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
