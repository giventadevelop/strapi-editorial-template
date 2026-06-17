'use strict';

/**
 * Upgrade Cloud plugin::upload.file rows from /uploads/ (local) to S3 URLs.
 * Reads media metadata from Strapi Cloud (not local DB). Files must exist in S3.
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
  registerS3OnCloud,
  resolveLocalUploadPath,
  CLOUD_URL,
  API_TOKEN,
} = require('./lib/push-collection-images-s3');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const S3_PREFIX = (process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/prod').replace(/\/+$/, '');

function parseOnly(argv) {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (arg) return arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  const idx = argv.indexOf('--only');
  if (idx >= 0 && argv[idx + 1]) {
    return argv[idx + 1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
}

function needsS3Upgrade(media) {
  if (!media?.hash || !media?.ext) return false;
  const url = media.url || '';
  return (
    url.startsWith('/uploads/') ||
    media.provider === 'local' ||
    !url.includes('amazonaws.com')
  );
}

async function cloudFetch(pathname) {
  const res = await fetch(`${CLOUD_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
  return res.json();
}

async function collectMediaFromCloud(config, tenantIdFilter) {
  const mediaField = config.mediaField || 'image';
  const payloads = [];
  const seen = new Set();
  let page = 1;

  while (true) {
    const url =
      `/api/${config.restPlural}?pagination[page]=${page}&pagination[pageSize]=100` +
      `&populate[0]=${mediaField}&populate[1]=tenant` +
      `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
    const data = await cloudFetch(url);
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length === 0) break;

    for (const row of list) {
      const media = row[mediaField];
      if (!needsS3Upgrade(media)) continue;
      if (seen.has(media.hash)) continue;
      seen.add(media.hash);
      payloads.push({ media, slug: row.slug });
    }

    if (list.length < 100) break;
    page++;
  }

  return payloads;
}

function getS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION || 'us-east-2',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function ensureS3(media) {
  const ext = media.ext?.startsWith('.') ? media.ext : `.${media.ext}`;
  const relativePath = `${media.hash}${ext}`;
  const key = `${S3_PREFIX}/${relativePath}`;
  const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
  const client = getS3Client();

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return relativePath;
  } catch (_) {}

  const mediaPath = resolveLocalUploadPath(media);
  if (!mediaPath) {
    throw new Error(`Not in S3 and no local file for ${media.hash}`);
  }
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

  const fixRes = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ upgradeS3Media: files, prefix: S3_PREFIX }),
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
  let totalSkipped = 0;

  for (const key of keys) {
    const config = getCollectionConfig(key);
    if (!config) continue;
    console.log('\n---', config.label, '---');
    const items = await collectMediaFromCloud(config, tenantId);
    if (items.length === 0) {
      console.log('No Cloud media needing S3 upgrade.');
      continue;
    }
    console.log('Local-path media to upgrade:', items.length);

    const staged = [];
    for (const item of items) {
      try {
        const relativePath = await ensureS3(item.media);
        staged.push({ ...item, relativePath });
      } catch (e) {
        console.warn('Skip:', item.slug, e.message);
        totalSkipped++;
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
          `Batch ${Math.floor(i / 25) + 1}: ${created.length} files | upgraded ${upgraded} | already S3 ${reused}`
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
  console.log('Skipped (missing S3/local file):', totalSkipped);
  console.log('Errors:', totalErrors);
  console.log('Verify: node scripts/verify-cloud-image-urls.js');
  process.exit(totalErrors > 0 && totalUpgraded === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
