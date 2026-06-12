'use strict';

/**
 * Push Kalpana Page (single type) from local Strapi to Strapi Cloud.
 *
 *   node scripts/push-kalpana-page-to-cloud.js --tenant-id=tenant_demo_002
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true,
  });
} catch (_) {}

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const projectRoot = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.resolve(projectRoot, process.env.REST_PUSH_UPLOADS_DIR || path.join('public', 'uploads'));

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UID = 'api::kalpana-page.kalpana-page';
const PLURAL = 'kalpana-page';

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

function resolveLocalUploadPath(image) {
  if (!image) return null;
  const url = image.url ?? image.attributes?.url;
  if (!url || typeof url !== 'string') return null;
  const relative = url.replace(/^\//, '').replace(/^uploads\//, '');
  const candidates = [path.join(UPLOADS_DIR, relative), path.join(UPLOADS_DIR, path.basename(url))];
  if (image.hash && image.ext) candidates.unshift(path.join(UPLOADS_DIR, `${image.hash}${image.ext}`));
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

async function uploadImageToCloud(localPath, imageMeta = {}) {
  if (!localPath || !fs.existsSync(localPath)) return null;
  const ext = path.extname(localPath).toLowerCase();
  const mime =
    imageMeta.mime ||
    ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] ||
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

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantIdFilter = getTenantId({ defaultValue: 'tenant_demo_002' });

  const probe = await fetch(`${CLOUD_URL}/api/${PLURAL}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (probe.status === 404) {
    console.error(`Cloud API /api/${PLURAL} not found — deploy Kalpana schema first.`);
    process.exit(1);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId: tenantIdFilter },
    select: ['id', 'documentId', 'tenantId'],
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
    limit: 1,
    populate: { heroImage: true, tenant: true },
  });
  const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  const doc = list[0];
  await app.destroy();

  if (!doc) {
    console.log('No local Kalpana page for tenant', tenantIdFilter);
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('Would push Kalpana page for tenant', tenantIdFilter);
    process.exit(0);
  }

  const tenantsData = await cloudFetch('/api/tenants?pagination[pageSize]=500');
  const tenantList = Array.isArray(tenantsData?.data) ? tenantsData.data : (tenantsData?.results ?? []);
  let cloudTenant = tenantList.find((t) => (t.tenantId ?? t.attributes?.tenantId) === tenantIdFilter);
  if (!cloudTenant) {
    const createRes = await cloudFetch('/api/tenants', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          name: 'MOSC Demo',
          tenantId: tenantIdFilter,
          slug: tenantIdFilter,
          domain: 'mosc.in',
        },
      }),
    });
    cloudTenant = createRes?.data ?? createRes;
    console.log('Created tenant on Cloud:', tenantIdFilter);
  }

  const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.document_id ?? cloudTenant.id;

  const payload = {
    introParagraph1: doc.introParagraph1 ?? null,
    introParagraph2: doc.introParagraph2 ?? null,
    aboutTitle: doc.aboutTitle ?? null,
    aboutDescription: doc.aboutDescription ?? null,
    aboutFeatures: doc.aboutFeatures ?? null,
    tenant: cloudTenantDocId,
  };

  let existing;
  try {
    existing = await cloudFetch(`/api/${PLURAL}?populate[tenant]=*`);
  } catch (_) {
    existing = null;
  }

  const existingData = existing?.data ?? existing;
  const hasExisting = existingData && (existingData.documentId || existingData.id);

  if (hasExisting) {
    const docIdCloud = existingData.documentId ?? existingData.document_id ?? existingData.id;
    await cloudFetch(`/api/${PLURAL}`, {
      method: 'PUT',
      body: JSON.stringify({ data: payload }),
    });
    console.log('Updated Kalpana page on Cloud');
  } else {
    await cloudFetch(`/api/${PLURAL}`, {
      method: 'PUT',
      body: JSON.stringify({ data: payload }),
    });
    console.log('Created Kalpana page on Cloud');
  }

  const imagePath = resolveLocalUploadPath(doc.heroImage);
  if (imagePath) {
    try {
      const uploaded = await uploadImageToCloud(imagePath, doc.heroImage || {});
      if (uploaded?.id) {
        await cloudFetch(`/api/${PLURAL}`, {
          method: 'PUT',
          body: JSON.stringify({ data: { heroImage: uploaded.id } }),
        });
        console.log('  heroImage linked ←', path.basename(imagePath));
      }
    } catch (e) {
      console.warn('  heroImage failed:', e.message);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
