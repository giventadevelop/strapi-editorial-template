'use strict';

/**
 * Push catholicate images via POST /api/migration/fix-published (uploadMedia + linkCatholicateImages).
 * Reads local file metadata via DB (files_related_mph) — avoids Documents API quirks in scripts.
 *
 * Usage: node scripts/push-catholicate-images-migration.js --tenant-id=tenant_demo_002
 */

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true,
  });
} catch (_) {}
const { getTenantId } = require('./lib/liturgy-cli');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UPLOADS_DIR = path.resolve(__dirname, '..', 'public', 'uploads');
const CONTENT_UID = 'api::catholicate-entry.catholicate-entry';

function resolveDiskPath(file) {
  if (!file) return null;
  const candidates = [];
  if (file.hash && file.ext) {
    candidates.push(path.join(UPLOADS_DIR, `${file.hash}${file.ext}`));
  }
  if (file.url) {
    const relative = String(file.url).replace(/^\//, '').replace(/^uploads\/?/i, '');
    candidates.push(path.join(UPLOADS_DIR, relative), path.join(UPLOADS_DIR, path.basename(file.url)));
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

async function loadLocalCatholicateImages(app, tenantId) {
  const knex = app.db.connection;
  const tenantRow = await knex('tenants').where({ tenant_id: tenantId }).select('id').first();
  if (!tenantRow) throw new Error(`Local tenant not found: ${tenantId}`);

  const rows = await knex('catholicate_entries as e')
    .join('catholicate_entries_tenant_lnk as tl', 'tl.catholicate_entry_id', 'e.id')
    .leftJoin('files_related_mph as m', function joinMorph() {
      this.on('m.related_id', 'e.id').andOn('m.related_type', knex.raw('?', [CONTENT_UID])).andOn(
        'm.field',
        knex.raw('?', ['image'])
      );
    })
    .leftJoin('files as f', 'f.id', 'm.file_id')
    .where('tl.tenant_id', tenantRow.id)
    .select(
      'e.slug',
      'f.id as file_id',
      'f.name',
      'f.hash',
      'f.ext',
      'f.mime',
      'f.size',
      'f.width',
      'f.height',
      'f.url'
    )
    .orderBy('e.id', 'asc');

  const filtered = rows.filter((r) => r.hash && r.slug);
  const bySlug = new Map();
  const score = (name = '') => {
    if (/^Catholicos[-_]/i.test(name)) return 100;
    if (/MOSC_Logo/i.test(name)) return 90;
    return 0;
  };
  for (const row of filtered) {
    const prev = bySlug.get(row.slug);
    if (!prev || score(row.name) > score(prev.name)) bySlug.set(row.slug, row);
  }
  return [...bySlug.values()];
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }

  const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = process.env.STRAPI_IMPORT_NODE_ENV || 'staging';

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let rows = [];
  try {
    rows = await loadLocalCatholicateImages(app, tenantId);
  } finally {
    await app.destroy();
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
  }

  const uploadMedia = [];
  const linkCatholicateImages = [];

  for (const row of rows) {
    const diskPath = resolveDiskPath(row);
    if (!diskPath) {
      console.warn('Missing disk file for', row.slug, row.hash);
      continue;
    }
    const buf = fs.readFileSync(diskPath);
    uploadMedia.push({
      name: row.name,
      hash: row.hash,
      ext: row.ext,
      mime: row.mime,
      size: row.size || buf.length,
      width: row.width,
      height: row.height,
      base64: buf.toString('base64'),
    });
    linkCatholicateImages.push({ slug: row.slug, hash: row.hash });
  }

  if (uploadMedia.length === 0) {
    console.error('No images to upload.');
    process.exit(1);
  }

  console.log('Uploading', uploadMedia.length, 'images via migration endpoint...');
  const res = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uploadMedia, linkCatholicateImages, tenantId }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('Migration failed:', res.status, text.slice(0, 500));
    process.exit(1);
  }

  const json = JSON.parse(text);
  console.log('Created:', json.created?.length ?? 0, '| Linked:', json.linkResults?.linked ?? 0);
  if (json.errors?.length) console.warn('Errors:', json.errors);
  if (json.linkResults?.errors?.length) console.warn('Link errors:', json.linkResults.errors);
  process.exit(json.linkResults?.linked === uploadMedia.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
