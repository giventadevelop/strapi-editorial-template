'use strict';
/**
 * Finish Catholicate images on Strapi Cloud after migration endpoint is deployed.
 * 1) Probes POST /api/migration/fix-published for uploadMedia support
 * 2) Runs push-catholicate-images-migration.js
 * 3) Verifies tenant filter + distinct images
 *
 * Prerequisite: deploy local main to Cloud (git push or npx strapi login && npx strapi deploy --force)
 */
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const tenantId = process.env.TENANT_ID || 'tenant_demo_002';

async function probeMigrationEndpoint() {
  const res = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadMedia: [] }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function verify() {
  const url = `${CLOUD_URL}/api/catholicate-entries?pagination[pageSize]=20&populate[0]=image&populate[1]=tenant&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  const json = await res.json();
  const rows = json.data || [];
  const urls = new Set();
  let missing = 0;
  for (const row of rows) {
    const img = row.image?.url;
    if (!img) missing++;
    else urls.add(img);
  }
  return { count: rows.length, missing, distinctImages: urls.size, rows };
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  console.log('Cloud:', CLOUD_URL);
  const probe = await probeMigrationEndpoint();
  const supportsUploadMedia =
    probe.text.includes('uploadMedia') || probe.text.includes('name, hash, ext');
  if (!supportsUploadMedia) {
    console.error('\nMigration uploadMedia is not deployed on Cloud yet.');
    console.error('Deploy first:');
    console.error('  git push origin main');
    console.error('  — or —');
    console.error('  npx strapi login && npx strapi deploy --force');
    console.error('\nProbe response:', probe.status, probe.text.slice(0, 200));
    process.exit(1);
  }

  console.log('Migration endpoint OK. Pushing images...');
  const push = spawnSync(
    process.execPath,
    [path.join(__dirname, 'push-catholicate-images-migration.js'), `--tenant-id=${tenantId}`],
    { stdio: 'inherit', env: process.env }
  );
  if (push.status !== 0) process.exit(push.status || 1);

  const v = await verify();
  console.log('\nVerification:', v.count, 'entries |', v.distinctImages, 'distinct images |', v.missing, 'missing');
  for (const row of v.rows) {
    console.log(' ', row.slug, row.image?.url ? 'OK' : 'MISSING');
  }
  process.exit(v.missing === 0 && v.distinctImages >= 2 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
