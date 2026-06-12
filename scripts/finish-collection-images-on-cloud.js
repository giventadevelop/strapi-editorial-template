'use strict';

/**
 * Finish Cloud image upload for a directory collection type (probe + push + verify).
 *
 * Usage:
 *   node scripts/finish-collection-images-on-cloud.js --collection=catholicate
 *   npm run finish:collection-images-on-cloud -- --collection=ecumenical --tenant-id=tenant_demo_002
 */

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  override: true,
});

const {
  getCollectionKey,
  getCollectionConfig,
  listCollectionKeys,
} = require('./lib/cloud-image-migration-config');
const { getTenantId } = require('./lib/liturgy-cli');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';

async function probeMigrationEndpoint() {
  const res = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadMedia: [] }),
  });
  return { status: res.status, text: await res.text() };
}

async function verify(config, tenantId) {
  const url =
    `${CLOUD_URL}/api/${config.restPlural}?pagination[pageSize]=100` +
    `&populate[0]=${config.mediaField || 'image'}&populate[1]=tenant` +
    `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}&sort=order:asc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  const json = await res.json();
  const rows = json.data || [];
  const urls = new Set();
  let missing = 0;
  for (const row of rows) {
    const img = row[config.mediaField || 'image']?.url;
    if (!img) missing++;
    else urls.add(img);
  }
  return { count: rows.length, missing, distinctImages: urls.size, rows };
}

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
  console.log('Cloud:', CLOUD_URL);
  console.log('Collection:', config.label, `(${collectionKey})`);
  console.log('Tenant:', tenantId);

  const probe = await probeMigrationEndpoint();
  const supportsUploadMedia =
    probe.text.includes('uploadMedia') || probe.text.includes('name, hash, ext');
  if (!supportsUploadMedia) {
    console.error('\nMigration uploadMedia is not deployed on Cloud yet.');
    console.error('Deploy first: git push origin main  OR  npx strapi login && npx strapi deploy --force');
    console.error('\nProbe response:', probe.status, probe.text.slice(0, 200));
    process.exit(1);
  }

  console.log('Migration endpoint OK. Pushing images...');
  const push = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'push-collection-images-migration.js'),
      `--collection=${collectionKey}`,
      `--tenant-id=${tenantId}`,
    ],
    { stdio: 'inherit', env: process.env }
  );
  if (push.status !== 0) process.exit(push.status || 1);

  const v = await verify(config, tenantId);
  console.log('\nVerification:', v.count, 'entries |', v.distinctImages, 'distinct images |', v.missing, 'missing');
  for (const row of v.rows) {
    const img = row[config.mediaField || 'image']?.url;
    console.log(' ', row.slug, img ? 'OK' : 'MISSING');
  }
  process.exit(v.missing === 0 && v.count > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
