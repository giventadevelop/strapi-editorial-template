'use strict';

/**
 * Push catholicate images via POST /api/migration/fix-published (uploadMedia + linkCatholicateImages).
 * Requires the extended fix-published handler deployed on Strapi Cloud.
 *
 * Usage: node scripts/push-catholicate-images-migration.js --tenant-id=tenant_demo_002
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const { getTenantId } = require('./lib/liturgy-cli');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UPLOADS_DIR = path.resolve(__dirname, '..', 'public', 'uploads');
const UID = 'api::catholicate-entry.catholicate-entry';

function resolveLocalUploadPath(image) {
  if (!image) return null;
  const url = image.url ?? image.attributes?.url;
  if (!url || typeof url !== 'string') return null;
  const relative = url.replace(/^\//, '').replace(/^uploads\//, '');
  const candidates = [
    path.join(UPLOADS_DIR, relative),
    path.join(UPLOADS_DIR, path.basename(url)),
  ];
  if (image.hash && image.ext) {
    candidates.unshift(path.join(UPLOADS_DIR, `${image.hash}${image.ext}`));
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }

  const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  process.env.NODE_ENV = 'development';
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId },
    select: ['id', 'documentId'],
  });
  const docId = tenant?.documentId ?? tenant?.document_id;
  const filters =
    docId != null
      ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
      : { tenant: tenant.id };
  const result = await app.documents(UID).findMany({
    filters,
    limit: 50,
    populate: { image: true },
    sort: 'order:asc',
  });
  const list = result?.results ?? result?.data ?? [];
  await app.destroy();

  const uploadMedia = [];
  const linkCatholicateImages = [];

  for (const doc of list) {
    if (!doc.image) continue;
    const localPath = resolveLocalUploadPath(doc.image);
    if (!localPath) {
      console.warn('Missing file for', doc.slug);
      continue;
    }
    const buf = fs.readFileSync(localPath);
    uploadMedia.push({
      name: doc.image.name,
      hash: doc.image.hash,
      ext: doc.image.ext,
      mime: doc.image.mime,
      size: doc.image.size || buf.length,
      width: doc.image.width,
      height: doc.image.height,
      base64: buf.toString('base64'),
    });
    linkCatholicateImages.push({ slug: doc.slug, hash: doc.image.hash });
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
    if (res.status === 400 && text.includes('articles array is required')) {
      console.error('Deploy the latest src/index.js to Cloud first (git push or npx strapi deploy).');
    }
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
