'use strict';
/**
 * Repair Cloud advertisement-slot media: copy working S3 objects from
 * strapi-editorial-media/dev/ → prod/ (public-read) when Cloud URLs 403.
 *
 * Root cause: register-s3 used prod/ keys while local ads live under dev/.
 *
 * Usage:
 *   node scripts/repair-cloud-ad-s3-from-dev.js
 *   node scripts/repair-cloud-ad-s3-from-dev.js --dry-run
 */
try {
  require('dotenv').config();
} catch (_) {}

const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const BUCKET = process.env.AWS_S3_BUCKET_NAME || process.env.AWS_BUCKET_NAME || 'eventapp-media-bucket';
const REGION = process.env.AWS_REGION || 'us-east-2';
const DEV_PREFIX = (process.env.S3_DEV_PREFIX || 'strapi-editorial-media/dev').replace(/\/+$/, '');
const PROD_PREFIX = (process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/prod').replace(/\/+$/, '');
const DRY_RUN = process.argv.includes('--dry-run');

function publicUrl(key) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

async function cloudFetch(pathname, options = {}) {
  const res = await fetch(`${CLOUD_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function probe(url) {
  try {
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-8' } });
    return r.status;
  } catch {
    return 0;
  }
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
    process.exit(1);
  }

  const s3 = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  const qs = new URLSearchParams({
    'pagination[pageSize]': '50',
    'populate[media]': 'true',
    'populate[tenant]': 'true',
  });
  const data = await cloudFetch(`/api/advertisement-slots?${qs}`);
  const slots = data.data || [];
  console.log('Cloud advertisement-slots:', slots.length);

  const seenHashes = new Set();
  let copied = 0;
  let okAlready = 0;
  let failed = 0;

  for (const slot of slots) {
    const media = slot.media;
    const list = Array.isArray(media) ? media : media ? [media] : [];
    for (const m of list) {
      const url = m?.url;
      if (!url) continue;
      const hash = m.hash;
      const ext = m.ext?.startsWith('.') ? m.ext : m.ext ? `.${m.ext}` : '';
      if (!hash || !ext) {
        console.warn('Skip media without hash/ext', m.id, url);
        continue;
      }
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      const prodKey = `${PROD_PREFIX}/${hash}${ext}`;
      const devKey = `${DEV_PREFIX}/${hash}${ext}`;
      const prodUrl = publicUrl(prodKey);
      const devUrl = publicUrl(devKey);

      const prodStatus = await probe(prodUrl);
      if (prodStatus === 200 || prodStatus === 206) {
        console.log('OK already', prodKey, prodStatus);
        okAlready++;
        continue;
      }

      const devStatus = await probe(devUrl);
      console.log('Need copy', hash + ext, 'prod=', prodStatus, 'dev=', devStatus);
      if (!(devStatus === 200 || devStatus === 206)) {
        // try Cloud URL as-is / filename from url
        console.warn('  No public source for', hash + ext);
        failed++;
        continue;
      }

      if (DRY_RUN) {
        console.log('  [dry-run] would copy', devKey, '→', prodKey);
        copied++;
        continue;
      }

      const srcRes = await fetch(devUrl);
      if (!srcRes.ok) {
        console.warn('  Failed download', devUrl, srcRes.status);
        failed++;
        continue;
      }
      const buf = Buffer.from(await srcRes.arrayBuffer());
      const mime = m.mime || srcRes.headers.get('content-type') || 'image/jpeg';

      // Bucket has ACLs disabled; public access relies on bucket policy for this prefix.
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: prodKey,
          Body: buf,
          ContentType: mime,
          CacheControl: 'public, max-age=31536000, immutable',
        })
      );

      const after = await probe(prodUrl);
      console.log('  Copied', prodKey, 'bytes=', buf.length, 'probe=', after);
      if (after === 200 || after === 206) copied++;
      else {
        console.warn('  Still not public after put', after);
        failed++;
      }
    }
  }

  console.log(JSON.stringify({ okAlready, copied, failed, dryRun: DRY_RUN }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
