'use strict';

/**
 * Upgrade Cloud plugin::upload.file rows from /uploads/ (local) to S3 URLs.
 * Files must already exist in S3 (run push:all-collection-images-s3-to-cloud first).
 *
 * Requires deployed register-s3-media with local→S3 upgrade (src/index.js).
 *
 * Usage:
 *   npm run upgrade:cloud-media-urls-to-s3 -- --tenant-id=tenant_demo_002
 *   npm run upgrade:cloud-media-urls-to-s3 -- --collection=training
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const {
  getCollectionKey,
  getCollectionConfig,
  listCollectionKeys,
} = require('./lib/cloud-image-migration-config');
const { getTenantId } = require('./lib/liturgy-cli');
const {
  pushCollectionImagesS3,
  registerS3OnCloud,
  resolveLocalUploadPath,
  CLOUD_URL,
  API_TOKEN,
} = require('./lib/push-collection-images-s3');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const S3_PREFIX = (process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/prod').replace(/\/+$/, '');

function parseOnly(argv) {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (arg) return arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

async function collectMediaFromCollection(config, tenantIdFilter) {
  const mediaField = config.mediaField || 'image';
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';
  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId: tenantIdFilter },
    select: ['id', 'documentId'],
  });
  if (!tenant) {
    await app.destroy();
    return [];
  }
  const docId = tenant.documentId ?? tenant.document_id;
  const filters =
    docId != null
      ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
      : { tenant: tenant.id };
  const result = await app.documents(config.uid).findMany({
    filters,
    limit: 500,
    populate: { [mediaField]: true },
  });
  const list = result?.results ?? result?.data ?? [];
  await app.destroy();

  const payloads = [];
  const seen = new Set();
  for (const doc of list) {
    const media = doc[mediaField];
    if (!media?.hash || !media?.ext) continue;
    if (seen.has(media.hash)) continue;
    const mediaPath = resolveLocalUploadPath(media);
    if (!mediaPath) continue;
    seen.add(media.hash);
    payloads.push({ media, mediaPath, slug: doc.slug });
  }
  return payloads;
}

async function ensureS3(media, mediaPath) {
  const region = process.env.AWS_REGION || 'us-east-2';
  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
  const ext = media.ext?.startsWith('.') ? media.ext : `.${media.ext}`;
  const relativePath = `${media.hash}${ext}`;
  const key = `${S3_PREFIX}/${relativePath}`;
  const body = require('fs').readFileSync(mediaPath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: media.mime || 'application/octet-stream',
    })
  );
  return relativePath;
}

async function registerBatch(items) {
  const files = items.map(({ media, relativePath }) => ({
    name: media.name,
    hash: media.hash,
    ext: media.ext,
    mime: media.mime,
    size: media.size,
    width: media.width ?? null,
    height: media.height ?? null,
    relativePath,
  }));

  const body = JSON.stringify({ upgradeS3Media: files, prefix: S3_PREFIX });
  const fixRes = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  const fixText = await fixRes.text();
  if (fixRes.ok) {
    try {
      const parsed = JSON.parse(fixText);
      if (parsed?.created) return parsed;
    } catch (_) {}
  }

  return registerS3OnCloud(files);
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantId = getTenantId({ defaultValue: 'tenant_demo_002' });
  const collectionKey = getCollectionKey();
  const only = parseOnly(process.argv);
  const keys = collectionKey
    ? [collectionKey]
    : only?.length
      ? only
      : listCollectionKeys();

  let totalUpgraded = 0;
  let totalErrors = 0;

  for (const key of keys) {
    const config = getCollectionConfig(key);
    if (!config) continue;
    console.log('\n---', config.label, '---');
    const items = await collectMediaFromCollection(config, tenantId);
    if (items.length === 0) {
      console.log('No local media to upgrade.');
      continue;
    }

    const staged = [];
    for (const item of items) {
      try {
        const relativePath = await ensureS3(item.media, item.mediaPath);
        staged.push({ ...item, relativePath });
      } catch (e) {
        console.warn('S3 put failed:', item.slug, e.message);
        totalErrors++;
      }
    }

    for (let i = 0; i < staged.length; i += 25) {
      const batch = staged.slice(i, i + 25);
      try {
        const reg = await registerBatch(batch);
        const created = reg?.created ?? [];
        const upgraded = created.filter((c) => c.upgraded).length;
        const reused = created.filter((c) => c.reused && !c.upgraded).length;
        totalUpgraded += upgraded;
        console.log(
          `Batch ${Math.floor(i / 25) + 1}: registered ${created.length} | upgraded ${upgraded} | already S3 ${reused}`
        );
        if (reg?.errors?.length) {
          for (const err of reg.errors) console.warn(' ', err.name, err.error);
          totalErrors += reg.errors.length;
        }
      } catch (e) {
        console.error('Register failed:', e.message);
        if (/404|405/.test(e.message)) {
          console.error('Deploy src/index.js register-s3-media upgrade fix first.');
          process.exit(1);
        }
        totalErrors += batch.length;
      }
    }
  }

  console.log('\nTotal upgraded to S3 URLs:', totalUpgraded);
  console.log('Errors:', totalErrors);
  console.log('Verify: node scripts/verify-cloud-image-urls.js');
  process.exit(totalErrors > 0 && totalUpgraded === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
