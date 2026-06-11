'use strict';

/**
 * Push Theological seminaries from local Strapi to Strapi Cloud (production).
 * Upserts by slug + tenant. Uploads linked images from public/uploads when present.
 *
 * Prerequisites (.env):
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com
 *   STRAPI_CLOUD_API_TOKEN=...  (Full Access API token on Cloud)
 *
 * Run (local Strapi server stopped):
 *   DRY_RUN=1 node scripts/push-ecumenical-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/push-ecumenical-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/push-ecumenical-to-cloud.js --tenant-id=tenant_demo_002 --images-only
 *
 * Documentation:
 *   documentation/front_end_based_collection_types_import/production_cloud_data_push/theological-seminaries-production-cloud-push-prd.html
 *
 * Options:
 *   --tenant-id=XXX   Only push entries for this tenant (recommended)
 *   --images-only     Skip entry create/update; retry image upload/link only
 *   DRY_RUN=1         Preview counts; no HTTP writes
 */

try {
  require('dotenv').config();
} catch (_) {}

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const IMAGES_ONLY = process.argv.includes('--images-only');

const projectRoot = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.resolve(projectRoot, process.env.REST_PUSH_UPLOADS_DIR || path.join('public', 'uploads'));

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UID = 'api::theological-seminary.theological-seminary';
const PLURAL = 'theological-seminaries';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function getCloudTenants() {
  const data = await cloudFetch('/api/tenants?pagination[pageSize]=500');
  const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
  const map = new Map();
  for (const t of list) {
    const tenantId = t.tenantId ?? t.attributes?.tenantId ?? t.tenant_id ?? t.attributes?.tenant_id;
    if (tenantId) map.set(tenantId, { documentId: t.documentId ?? t.document_id ?? t.id, id: t.id, ...t });
  }
  return map;
}

async function createTenantOnCloud(localTenant) {
  const payload = {
    name: localTenant.name ?? localTenant.tenantId ?? 'Tenant',
    tenantId: localTenant.tenantId ?? localTenant.tenant_id,
    domain: localTenant.domain ?? localTenant.tenantId ?? 'example.com',
    description: localTenant.description ?? null,
  };
  const res = await cloudFetch('/api/tenants', {
    method: 'POST',
    body: JSON.stringify({ data: payload }),
  });
  const created = res?.data ?? res;
  return { documentId: created.documentId ?? created.document_id ?? created.id, id: created.id };
}

async function getCloudTheologicalSeminaryKeys(tenantIdFilter) {
  const map = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    let url = `/api/${PLURAL}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[tenant]=*`;
    if (tenantIdFilter) {
      url += `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
    }
    const data = await cloudFetch(url);
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    if (list.length === 0) break;
    for (const row of list) {
      const slug = row.slug ?? row.attributes?.slug;
      const tenantId =
        row.tenant?.tenantId ??
        row.tenant?.tenant_id ??
        row.tenant?.attributes?.tenantId ??
        row.tenant?.attributes?.tenant_id;
      if (slug && tenantId) {
        map.set(`${slug}_${tenantId}`, row.documentId ?? row.document_id ?? row.id);
      }
    }
    if (list.length < pageSize) break;
    page++;
  }
  return map;
}

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

async function uploadImageToCloud(localPath, imageMeta = {}) {
  if (!localPath || !fs.existsSync(localPath)) return null;
  const ext = path.extname(localPath).toLowerCase();
  const mime =
    imageMeta.mime ||
    ({
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    }[ext] ||
      'application/octet-stream');
  const baseName = imageMeta.name || path.basename(localPath, ext) || path.basename(localPath);
  const uploadName = ext && !baseName.toLowerCase().endsWith(ext) ? `${baseName}${ext}` : baseName;
  const form = new FormData();
  form.append('files', fs.createReadStream(localPath), {
    filename: uploadName,
    contentType: mime,
  });
  const res = await fetch(`${CLOUD_URL}/api/upload`, {
    method: 'POST',
    body: form,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...form.getHeaders(),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upload ${res.status}: ${text.slice(0, 200)}`);
  const uploadJson = text ? JSON.parse(text) : null;
  const raw = Array.isArray(uploadJson) ? uploadJson[0] : uploadJson;
  const created = raw?.data ?? raw;
  return {
    documentId: created?.documentId ?? raw?.documentId ?? null,
    id: created?.id ?? raw?.id ?? null,
  };
}

async function resolveTenantIdForDoc(doc, localTenantById, tenantIdFilter) {
  if (tenantIdFilter) return tenantIdFilter;
  const localTenant = doc.tenant;
  return (
    (typeof localTenant === 'object' && (localTenant?.tenantId ?? localTenant?.tenant_id)) ??
    (typeof localTenant === 'object' && localTenant?.id != null && localTenantById.get(localTenant.id)?.tenantId) ??
    (typeof localTenant === 'number' && localTenantById.get(localTenant)?.tenantId) ??
    null
  );
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN in .env');
    process.exit(1);
  }

  const tenantIdFilter = getTenantId({ defaultValue: null });

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let list = [];
  if (tenantIdFilter) {
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
      limit: 500,
      populate: { image: true, tenant: true },
      sort: 'order:asc',
    });
    list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  } else {
    const result = await app.documents(UID).findMany({
      limit: 500,
      populate: { image: true, tenant: true },
      sort: 'order:asc',
    });
    list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
  }

  const localTenants = await app.db.query('api::tenant.tenant').findMany({
    where: {},
    select: ['id', 'documentId', 'tenantId', 'name', 'domain', 'description'],
  });
  const localTenantById = new Map();
  const localTenantByTenantId = new Map();
  for (const t of localTenants || []) {
    if (t.id != null) localTenantById.set(t.id, t);
    const tid = t.tenantId ?? t.tenant_id;
    if (tid) localTenantByTenantId.set(tid, t);
  }

  await app.destroy();

  if (list.length === 0) {
    console.log('No theological seminaries found locally' + (tenantIdFilter ? ` for tenant ${tenantIdFilter}` : '') + '.');
    process.exit(0);
  }

  console.log('Push Theological seminaries to Cloud');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant filter:', tenantIdFilter || '(all tenants)');
  console.log('  Local entries:', list.length);
  if (IMAGES_ONLY) console.log('  Mode: --images-only (skip entry create/update)');
  if (DRY_RUN) console.log('  DRY_RUN=1');

  if (DRY_RUN) {
    for (const doc of list) {
      const tenantId = await resolveTenantIdForDoc(doc, localTenantById, tenantIdFilter);
      const imagePath = resolveLocalUploadPath(doc.image);
      console.log('Would push:', doc.slug, '| tenant:', tenantId, '| image:', imagePath ? path.basename(imagePath) : 'none');
    }
    process.exit(0);
  }

  let cloudTenants = await getCloudTenants();
  const cloudKeys = await getCloudTheologicalSeminaryKeys(tenantIdFilter);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let imagesLinked = 0;

  for (const doc of list) {
    const tenantId = await resolveTenantIdForDoc(doc, localTenantById, tenantIdFilter);
    if (!tenantId) {
      console.warn('Skip', doc.slug, ': could not resolve tenantId');
      skipped++;
      continue;
    }

    let cloudTenant = cloudTenants.get(tenantId);
    if (!cloudTenant) {
      const localTenant = localTenantByTenantId.get(tenantId);
      if (!localTenant) {
        console.warn('Skip', doc.slug, ': tenant', tenantId, 'not in local DB');
        skipped++;
        continue;
      }
      try {
        cloudTenant = await createTenantOnCloud(localTenant);
        cloudTenants.set(tenantId, cloudTenant);
        console.log('Created tenant on Cloud:', tenantId);
      } catch (e) {
        console.warn('Skip', doc.slug, ': failed to create tenant', tenantId, e.message);
        skipped++;
        continue;
      }
      await sleep(200);
    }

    const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.id;
    const key = `${doc.slug}_${tenantId}`;
    const existingCloudDocId = cloudKeys.get(key);

    const payload = {
      name: doc.name,
      slug: doc.slug,
      excerpt: doc.excerpt ?? null,
      body: doc.body ?? null,
      order: doc.order ?? 0,
      tenant: cloudTenantDocId,
    };

    try {
      let cloudDocId = existingCloudDocId;
      if (!IMAGES_ONLY) {
        if (existingCloudDocId) {
          await cloudFetch(`/api/${PLURAL}/${existingCloudDocId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: payload }),
          });
          updated++;
          console.log('Updated:', doc.slug);
        } else {
          const createRes = await cloudFetch(`/api/${PLURAL}`, {
            method: 'POST',
            body: JSON.stringify({ data: payload }),
          });
          cloudDocId = createRes?.data?.documentId ?? createRes?.data?.document_id ?? createRes?.documentId;
          if (cloudDocId) cloudKeys.set(key, cloudDocId);
          created++;
          console.log('Created:', doc.slug);
          if (cloudDocId && cloudTenantDocId) {
            try {
              await cloudFetch(`/api/${PLURAL}/${cloudDocId}`, {
                method: 'PUT',
                body: JSON.stringify({ data: { tenant: cloudTenantDocId } }),
              });
            } catch (_) {}
          }
        }
      } else if (!cloudDocId) {
        console.warn('Skip image (no cloud entry):', doc.slug);
        skipped++;
        continue;
      }

      const imagePath = resolveLocalUploadPath(doc.image);
      if (cloudDocId && imagePath) {
        try {
          const uploaded = await uploadImageToCloud(imagePath, doc.image || {});
          if (uploaded?.id) {
            await cloudFetch(`/api/${PLURAL}/${cloudDocId}`, {
              method: 'PUT',
              body: JSON.stringify({ data: { image: uploaded.id } }),
            });
            console.log('  Image linked:', doc.slug, '←', path.basename(imagePath));
            imagesLinked++;
          }
        } catch (e) {
          console.warn('  Image failed for', doc.slug, e.message);
        }
      } else if (cloudDocId && doc.image && !imagePath) {
        console.warn('  Image file missing locally for', doc.slug, doc.image?.url || '');
      }
    } catch (e) {
      console.warn('Failed', doc.slug, e.message);
      skipped++;
    }

    await sleep(150);
  }

  console.log('');
  console.log('Done.', 'Created:', created, 'Updated:', updated, 'Images linked:', imagesLinked, 'Skipped:', skipped, '→', CLOUD_URL);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
