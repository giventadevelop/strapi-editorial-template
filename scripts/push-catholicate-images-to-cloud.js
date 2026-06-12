'use strict';

/**
 * Push Catholicate images from local Strapi to Strapi Cloud.
 *
 * Strategy (in order):
 *   1. POST /api/upload (multipart) — works when Cloud S3 env vars are valid.
 *   2. Upload to shared S3 prod prefix + POST /api/migration/register-s3-media + link
 *      (requires valid AWS creds locally and migration endpoints deployed on Cloud).
 *
 * Usage (local Strapi stopped):
 *   node scripts/push-catholicate-images-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/push-catholicate-images-to-cloud.js --tenant-id=tenant_demo_002 --skip-s3
 *   node scripts/push-catholicate-images-to-cloud.js --tenant-id=tenant_demo_002 --link-existing
 *
 * Env: STRAPI_CLOUD_URL, STRAPI_CLOUD_API_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *      AWS_REGION, AWS_S3_BUCKET_NAME
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const { getTenantId } = require('./lib/liturgy-cli');

const SKIP_S3 = process.argv.includes('--skip-s3');
const LINK_EXISTING = process.argv.includes('--link-existing');

const projectRoot = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.resolve(projectRoot, process.env.REST_PUSH_UPLOADS_DIR || path.join('public', 'uploads'));
const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UID = 'api::catholicate-entry.catholicate-entry';
const PLURAL = 'catholicate-entries';
const S3_PREFIX = (process.env.S3_UPLOAD_PREFIX || 'strapi-editorial-media/prod').replace(/\/+$/, '');

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
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

async function cloudFetch(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${CLOUD_URL}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function uploadViaApi(localPath, imageMeta = {}) {
  const ext = path.extname(localPath).toLowerCase();
  const mime =
    imageMeta.mime ||
    ({
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    }[ext] ||
      'application/octet-stream');
  const baseName = imageMeta.name || path.basename(localPath, ext) || path.basename(localPath);
  const uploadName = ext && !baseName.toLowerCase().endsWith(ext) ? `${baseName}${ext}` : baseName;
  const form = new FormData();
  form.append('files', fs.createReadStream(localPath), { filename: uploadName, contentType: mime });
  const res = await fetch(`${CLOUD_URL}/api/upload`, {
    method: 'POST',
    body: form,
    headers: { Authorization: `Bearer ${API_TOKEN}`, ...form.getHeaders() },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upload ${res.status}: ${text.slice(0, 200)}`);
  const uploadJson = text ? JSON.parse(text) : null;
  const raw = Array.isArray(uploadJson) ? uploadJson[0] : uploadJson;
  const created = raw?.data ?? raw;
  return { id: created?.id ?? raw?.id ?? null };
}

async function findCloudFile(imageMeta) {
  const name = imageMeta?.name;
  const hash = imageMeta?.hash;
  if (name) {
    const res = await fetch(
      `${CLOUD_URL}/api/upload/files?filters[name][$eq]=${encodeURIComponent(name)}&pagination[pageSize]=5`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } }
    );
    if (res.ok) {
      const list = await res.json();
      const files = Array.isArray(list) ? list : list?.data ?? [];
      if (files[0]?.id) return files[0];
    }
  }
  if (hash) {
    const res = await fetch(
      `${CLOUD_URL}/api/upload/files?filters[hash][$eq]=${encodeURIComponent(hash)}&pagination[pageSize]=5`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } }
    );
    if (res.ok) {
      const list = await res.json();
      const files = Array.isArray(list) ? list : list?.data ?? [];
      if (files[0]?.id) return files[0];
    }
  }
  return null;
}

function getS3Client() {
  const region = process.env.AWS_REGION || 'us-east-2';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function uploadToS3(localPath, imageMeta) {
  const client = getS3Client();
  if (!client) throw new Error('AWS credentials missing in .env');
  const bucket = process.env.AWS_S3_BUCKET_NAME || 'eventapp-media-bucket';
  const hash = imageMeta.hash;
  const ext = imageMeta.ext?.startsWith('.') ? imageMeta.ext : `.${imageMeta.ext || path.extname(localPath)}`;
  const relativePath = `${hash}${ext}`;
  const key = `${S3_PREFIX}/${relativePath}`;
  const body = fs.readFileSync(localPath);
  const mime = imageMeta.mime || 'application/octet-stream';
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mime }));
  return { relativePath, key };
}

async function registerS3OnCloud(filePayloads) {
  return cloudFetch('/api/migration/register-s3-media', {
    method: 'POST',
    body: JSON.stringify({ files: filePayloads, prefix: S3_PREFIX }),
  });
}

async function linkImageOnCloud(cloudDocId, fileId) {
  await cloudFetch(`/api/${PLURAL}/${cloudDocId}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { image: fileId } }),
  });
}

async function getCloudCatholicateMap(tenantIdFilter) {
  const map = new Map();
  let page = 1;
  while (true) {
    const url = `/api/${PLURAL}?pagination[page]=${page}&pagination[pageSize]=100&populate[tenant]=*&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
    const data = await cloudFetch(url);
    const list = Array.isArray(data?.data) ? data.data : data?.results ?? [];
    if (list.length === 0) break;
    for (const row of list) {
      const slug = row.slug ?? row.attributes?.slug;
      const docId = row.documentId ?? row.document_id ?? row.id;
      if (slug && docId) map.set(slug, docId);
    }
    if (list.length < 100) break;
    page++;
  }
  return map;
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantIdFilter = getTenantId({ defaultValue: 'tenant_demo_002' });
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId: tenantIdFilter },
    select: ['id', 'documentId'],
  });
  if (!tenant) {
    console.error('Local tenant not found:', tenantIdFilter);
    await app.destroy();
    process.exit(1);
  }
  const docId = tenant.documentId ?? tenant.document_id;
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
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  await app.destroy();

  if (list.length === 0) {
    console.log('No local catholicate entries found.');
    process.exit(0);
  }

  console.log('Push Catholicate images to Cloud');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Entries:', list.length);
  console.log('  Mode:', LINK_EXISTING ? 'link-existing' : SKIP_S3 ? 'upload-api-only' : 'upload-api then s3-register');

  const cloudBySlug = await getCloudCatholicateMap(tenantIdFilter);
  let linked = 0;
  let failed = 0;
  const registerBatch = [];

  for (const doc of list) {
    const cloudDocId = cloudBySlug.get(doc.slug);
    if (!cloudDocId) {
      console.warn('Skip (no cloud entry):', doc.slug);
      failed++;
      continue;
    }
    if (!doc.image) {
      console.warn('Skip (no local image):', doc.slug);
      failed++;
      continue;
    }

    const imagePath = resolveLocalUploadPath(doc.image);
    if (!imagePath) {
      console.warn('Skip (file missing):', doc.slug, doc.image?.url);
      failed++;
      continue;
    }

    let fileId = null;

    if (LINK_EXISTING) {
      const existing = await findCloudFile(doc.image);
      if (existing?.id) {
        fileId = existing.id;
        console.log('Found existing media:', doc.slug, '←', existing.name);
      }
    }

    if (!fileId) {
      try {
        const uploaded = await uploadViaApi(imagePath, doc.image);
        fileId = uploaded?.id;
        if (fileId) console.log('Uploaded via API:', doc.slug);
      } catch (e) {
        console.warn('  API upload failed:', doc.slug, e.message);
      }
    }

    if (!fileId && !SKIP_S3 && !LINK_EXISTING) {
      try {
        const { relativePath } = await uploadToS3(imagePath, doc.image);
        registerBatch.push({
          name: doc.image.name,
          hash: doc.image.hash,
          ext: doc.image.ext,
          mime: doc.image.mime,
          size: doc.image.size,
          width: doc.image.width ?? null,
          height: doc.image.height ?? null,
          relativePath,
          slug: doc.slug,
          cloudDocId,
        });
        console.log('  Staged for S3 register:', doc.slug, relativePath);
      } catch (e) {
        console.warn('  S3 upload failed:', doc.slug, e.message);
      }
    }

    if (fileId) {
      try {
        await linkImageOnCloud(cloudDocId, fileId);
        console.log('  Linked:', doc.slug);
        linked++;
      } catch (e) {
        console.warn('  Link failed:', doc.slug, e.message);
        failed++;
      }
    }
  }

  if (registerBatch.length > 0) {
    try {
      const payloads = registerBatch.map(({ slug, cloudDocId, ...file }) => file);
      const reg = await registerS3OnCloud(payloads);
      if (reg?.errors?.length) {
        for (const err of reg.errors) console.warn('  Register error:', err.name, err.error);
      }
      const created = reg?.created ?? [];
      for (let i = 0; i < registerBatch.length; i++) {
        const item = registerBatch[i];
        const match =
          created.find((c) => c.name === item.name && c.hash === item.hash) || created[i];
        if (!match?.id) continue;
        try {
          await linkImageOnCloud(item.cloudDocId, match.id);
          console.log('  Linked (S3 register):', item.slug);
          linked++;
        } catch (e) {
          console.warn('  Link failed:', item.slug, e.message);
          failed++;
        }
      }
    } catch (e) {
      if (/404|405/.test(e.message)) {
        console.error(
          '\nMigration endpoint not on Cloud yet. Run: npx strapi login && npx strapi deploy --force'
        );
      } else {
        console.error('Register S3 on Cloud failed:', e.message);
      }
      failed += registerBatch.length;
    }
  }

  console.log('\nDone. Linked:', linked, 'Failed:', failed);
  console.log('Verify: node scripts/verify-catholicate-cloud.js');
  process.exit(failed > 0 && linked === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
