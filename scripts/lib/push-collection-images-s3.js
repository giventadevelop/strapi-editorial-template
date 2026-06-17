'use strict';

/**
 * Push collection images to Strapi Cloud via S3 + register-s3-media.
 * Shared logic for push-collection-images-s3-to-cloud.js and batch runner.
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const projectRoot = path.resolve(__dirname, '..', '..');
const UPLOADS_DIR = path.resolve(projectRoot, process.env.REST_PUSH_UPLOADS_DIR || path.join('public', 'uploads'));
const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
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

async function getCloudEntryMap(restPlural, tenantIdFilter) {
  const map = new Map();
  let page = 1;
  while (true) {
    const url = `/api/${restPlural}?pagination[page]=${page}&pagination[pageSize]=100&populate[tenant]=*&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
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

async function pushCollectionImagesS3(config, tenantIdFilter, options = {}) {
  const { skipS3 = false, linkExisting = false, tryApiFirst = true } = options;
  const mediaField = config.mediaField || 'image';
  const UID = config.uid;
  const restPlural = config.restPlural;

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId: tenantIdFilter },
    select: ['id', 'documentId'],
  });
  if (!tenant) {
    await app.destroy();
    throw new Error(`Local tenant not found: ${tenantIdFilter}`);
  }
  const docId = tenant.documentId ?? tenant.document_id;
  const filters =
    docId != null
      ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
      : { tenant: tenant.id };
  const result = await app.documents(UID).findMany({
    filters,
    limit: 500,
    populate: { [mediaField]: true },
    sort: 'order:asc',
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  await app.destroy();

  if (list.length === 0) {
    return { linked: 0, failed: 0, skipped: 0, entries: 0, mode: 'empty' };
  }

  const cloudBySlug = await getCloudEntryMap(restPlural, tenantIdFilter);
  let linked = 0;
  let failed = 0;
  let skipped = 0;
  const registerBatch = [];

  async function linkMediaOnCloud(cloudDocId, fileId) {
    await cloudFetch(`/api/${restPlural}/${cloudDocId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { [mediaField]: fileId } }),
    });
  }

  for (const doc of list) {
    const cloudDocId = cloudBySlug.get(doc.slug);
    if (!cloudDocId) {
      console.warn('Skip (no cloud entry):', doc.slug);
      failed++;
      continue;
    }
    const media = doc[mediaField];
    if (!media) {
      console.warn('Skip (no local media):', doc.slug);
      skipped++;
      continue;
    }

    const mediaPath = resolveLocalUploadPath(media);
    if (!mediaPath) {
      console.warn('Skip (file missing):', doc.slug, media?.url);
      failed++;
      continue;
    }

    let fileId = null;

    if (linkExisting) {
      const existing = await findCloudFile(media);
      if (existing?.id) {
        fileId = existing.id;
        console.log('Found existing media:', doc.slug, '←', existing.name);
      }
    }

    if (!fileId && tryApiFirst) {
      try {
        const uploaded = await uploadViaApi(mediaPath, media);
        fileId = uploaded?.id;
        if (fileId) console.log('Uploaded via API:', doc.slug);
      } catch (e) {
        console.warn('  API upload failed:', doc.slug, e.message);
      }
    }

    if (!fileId && !skipS3 && !linkExisting) {
      try {
        const { relativePath } = await uploadToS3(mediaPath, media);
        registerBatch.push({
          name: media.name,
          hash: media.hash,
          ext: media.ext,
          mime: media.mime,
          size: media.size,
          width: media.width ?? null,
          height: media.height ?? null,
          relativePath,
          slug: doc.slug,
          cloudDocId,
        });
        console.log('  Staged for S3 register:', doc.slug, relativePath);
      } catch (e) {
        console.warn('  S3 upload failed:', doc.slug, e.message);
        failed++;
      }
    }

    if (fileId) {
      try {
        await linkMediaOnCloud(cloudDocId, fileId);
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
          created.find((c) => c.name === item.name && (c.hash === item.hash || c.reused)) || created[i];
        if (!match?.id) {
          failed++;
          continue;
        }
        try {
          await linkMediaOnCloud(item.cloudDocId, match.id);
          console.log('  Linked (S3 register):', item.slug, match.reused ? '(reused)' : '');
          linked++;
        } catch (e) {
          console.warn('  Link failed:', item.slug, e.message);
          failed++;
        }
      }
    } catch (e) {
      if (/404|405/.test(e.message)) {
        throw new Error(
          'Migration endpoint not on Cloud. Deploy first: npx strapi login && npx strapi deploy --force'
        );
      }
      throw e;
    }
  }

  return { linked, failed, skipped, entries: list.length, staged: registerBatch.length };
}

module.exports = {
  pushCollectionImagesS3,
  resolveLocalUploadPath,
  uploadViaApi,
  registerS3OnCloud,
  getCloudEntryMap,
  CLOUD_URL,
  API_TOKEN,
};
