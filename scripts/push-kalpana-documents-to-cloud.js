'use strict';

/**
 * Push Kalpana Document entries (with PDF files) from local Strapi to Strapi Cloud.
 * Upserts by sourceUrl + tenant (fallback: slug + tenant). Links edition by slug on Cloud.
 *
 * Prerequisites (.env):
 *   STRAPI_CLOUD_URL=https://YOUR-PROJECT.strapiapp.com
 *   STRAPI_CLOUD_API_TOKEN=...  (Full Access API token on Cloud)
 *
 * Run (local Strapi dev server stopped):
 *   DRY_RUN=1 node scripts/push-kalpana-documents-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/push-kalpana-documents-to-cloud.js --tenant-id=tenant_demo_002
 *   node scripts/push-kalpana-documents-to-cloud.js --tenant-id=tenant_demo_002 --pdfs-only
 *
 * Options:
 *   --tenant-id=XXX   Only push entries for this tenant (recommended)
 *   --pdfs-only       Skip entry create/update; retry PDF upload/link only
 *   --limit=N         Push at most N documents (testing)
 *   DRY_RUN=1         Preview counts; no HTTP writes
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true,
  });
} catch (_) {}
const FormData = require('form-data');

const { DRY_RUN, getTenantId } = require('./lib/liturgy-cli');

const PDFS_ONLY = process.argv.includes('--pdfs-only');

const projectRoot = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.resolve(projectRoot, process.env.REST_PUSH_UPLOADS_DIR || path.join('public', 'uploads'));
const PDF_CACHE_DIR = path.join(__dirname, 'data', 'kalpana-pdfs');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const UID = 'api::kalpana-document.kalpana-document';
const PLURAL = 'kalpana-documents';
const EDITION_PLURAL = 'kalpana-editions';
const MEDIA_FIELD = 'pdf';

const LIMIT = (() => {
  const m = process.argv.find((a) => a.startsWith('--limit='));
  return m ? Math.max(1, parseInt(m.split('=')[1], 10)) : null;
})();

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

async function probeCloudApi() {
  const res = await fetch(`${CLOUD_URL}/api/${PLURAL}?pagination[pageSize]=1`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  return res.status;
}

async function getCloudEditionMap(tenantIdFilter) {
  const bySlug = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    let url = `/api/${EDITION_PLURAL}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[tenant]=*`;
    if (tenantIdFilter) {
      url += `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
    }
    const data = await cloudFetch(url);
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    if (list.length === 0) break;
    for (const row of list) {
      const slug = row.slug ?? row.attributes?.slug;
      const documentId = row.documentId ?? row.document_id ?? row.id;
      if (slug && documentId) bySlug.set(slug, documentId);
    }
    if (list.length < pageSize) break;
    page++;
  }
  return bySlug;
}

async function getCloudDocumentKeys(tenantIdFilter) {
  const bySourceUrl = new Map();
  const bySlugTenant = new Map();
  let page = 1;
  const pageSize = 100;
  while (true) {
    let url = `/api/${PLURAL}?pagination[page]=${page}&pagination[pageSize]=${pageSize}&populate[tenant]=*`;
    if (tenantIdFilter) {
      url += `&filters[tenant][tenantId][$eq]=${encodeURIComponent(tenantIdFilter)}`;
    }
    let data;
    try {
      data = await cloudFetch(url);
    } catch (e) {
      if (page === 1 && String(e.message).includes('HTTP 404')) {
        return { bySourceUrl, bySlugTenant };
      }
      throw e;
    }
    const list = Array.isArray(data?.data) ? data.data : (data?.results ?? []);
    if (list.length === 0) break;
    for (const row of list) {
      const slug = row.slug ?? row.attributes?.slug;
      const sourceUrl = row.sourceUrl ?? row.attributes?.sourceUrl;
      const documentId = row.documentId ?? row.document_id ?? row.id;
      const tenantId =
        row.tenant?.tenantId ??
        row.tenant?.tenant_id ??
        row.tenant?.attributes?.tenantId ??
        row.tenant?.attributes?.tenant_id;
      if (!documentId) continue;
      if (sourceUrl) bySourceUrl.set(`${sourceUrl}_${tenantId || tenantIdFilter}`, documentId);
      if (slug && tenantId) bySlugTenant.set(`${slug}_${tenantId}`, documentId);
    }
    if (list.length < pageSize) break;
    page++;
  }
  return { bySourceUrl, bySlugTenant };
}

function resolveLocalUploadPath(file) {
  if (!file) return null;
  const url = file.url ?? file.attributes?.url;
  if (!url || typeof url !== 'string') return null;
  const relative = url.replace(/^\//, '').replace(/^uploads\//, '');
  const candidates = [
    path.join(UPLOADS_DIR, relative),
    path.join(UPLOADS_DIR, path.basename(url)),
  ];
  if (file.hash && file.ext) {
    candidates.unshift(path.join(UPLOADS_DIR, `${file.hash}${file.ext}`));
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

function resolvePdfCachePath(sourceUrl, editionYear) {
  if (!sourceUrl || !editionYear) return null;
  const hash = crypto.createHash('md5').update(sourceUrl).digest('hex').slice(0, 10);
  const base = path.basename(sourceUrl).split('?')[0] || 'document.pdf';
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const candidate = path.join(PDF_CACHE_DIR, String(editionYear), `${hash}-${safe}`);
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveLocalPdfPath(doc) {
  const fromMedia = resolveLocalUploadPath(doc[MEDIA_FIELD]);
  if (fromMedia) return fromMedia;
  const year = doc.edition?.year ?? doc.edition?.attributes?.year;
  if (doc.sourceUrl && year) {
    const cached = resolvePdfCachePath(doc.sourceUrl, year);
    if (cached) return cached;
  }
  if (doc.sourceUrl) {
    const yearDirs = fs.existsSync(PDF_CACHE_DIR) ? fs.readdirSync(PDF_CACHE_DIR) : [];
    for (const y of yearDirs) {
      const cached = resolvePdfCachePath(doc.sourceUrl, y);
      if (cached) return cached;
    }
  }
  return null;
}

async function uploadFileToCloud(localPath, fileMeta = {}) {
  if (!localPath || !fs.existsSync(localPath)) return null;
  const ext = path.extname(localPath).toLowerCase();
  const mime =
    fileMeta.mime ||
    ({
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    }[ext] ||
      'application/octet-stream');
  const baseName = fileMeta.name || path.basename(localPath, ext) || path.basename(localPath);
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
  if (!res.ok) {
    if (res.status === 500) {
      return uploadFileViaMigration(localPath, fileMeta, mime, ext);
    }
    throw new Error(`Upload ${res.status}: ${text.slice(0, 200)}`);
  }
  const uploadJson = text ? JSON.parse(text) : null;
  const raw = Array.isArray(uploadJson) ? uploadJson[0] : uploadJson;
  const created = raw?.data ?? raw;
  return {
    documentId: created?.documentId ?? raw?.documentId ?? null,
    id: created?.id ?? raw?.id ?? null,
  };
}

async function uploadFileViaMigration(localPath, fileMeta, mime, ext) {
  const buf = fs.readFileSync(localPath);
  const hash =
    fileMeta.hash ||
    crypto.createHash('md5').update(buf).digest('hex').slice(0, 20);
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
  const name = (fileMeta.name || path.basename(localPath, normalizedExt)).slice(0, 100);
  const res = await fetch(`${CLOUD_URL}/api/migration/fix-published`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uploadMedia: [
        {
          name,
          hash,
          ext: normalizedExt,
          mime: mime || 'application/pdf',
          size: buf.length,
          base64: buf.toString('base64'),
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Migration upload ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  const created = json.created?.[0];
  if (!created?.id) {
    throw new Error('Migration upload returned no file id');
  }
  return { id: created.id, hash };
}

function resolveTenantIdForDoc(doc, localTenantById, tenantIdFilter) {
  if (tenantIdFilter) return tenantIdFilter;
  const localTenant = doc.tenant;
  return (
    (typeof localTenant === 'object' && (localTenant?.tenantId ?? localTenant?.tenant_id)) ??
    (typeof localTenant === 'object' && localTenant?.id != null && localTenantById.get(localTenant.id)?.tenantId) ??
    (typeof localTenant === 'number' && localTenantById.get(localTenant)?.tenantId) ??
    null
  );
}

async function fetchLocalDocuments(app, tenantIdFilter) {
  const tenant = await app.db.query('api::tenant.tenant').findOne({
    where: { tenantId: tenantIdFilter },
    select: ['id', 'documentId'],
  });
  if (!tenant) return [];

  const docId = tenant.documentId ?? tenant.document_id;
  const filters =
    docId != null
      ? { $or: [{ tenant: tenant.id }, { tenant: { documentId: docId } }] }
      : { tenant: tenant.id };

  const all = [];
  let start = 0;
  const pageSize = 100;
  while (true) {
    const result = await app.documents(UID).findMany({
      filters,
      limit: pageSize,
      start,
      populate: { [MEDIA_FIELD]: true, edition: true, tenant: true },
      sort: 'order:desc',
    });
    const list = result?.results ?? result?.data ?? (Array.isArray(result) ? result : []);
    if (list.length === 0) break;
    all.push(...list);
    if (list.length < pageSize) break;
    start += pageSize;
    if (LIMIT && all.length >= LIMIT) break;
  }
  return LIMIT ? all.slice(0, LIMIT) : all;
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

  const list = await fetchLocalDocuments(app, tenantIdFilter);

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
    console.log('No kalpana documents found locally' + (tenantIdFilter ? ` for tenant ${tenantIdFilter}` : '') + '.');
    process.exit(0);
  }

  console.log('Push Kalpana Documents to Cloud');
  console.log('  Cloud:', CLOUD_URL);
  console.log('  Tenant filter:', tenantIdFilter || '(all tenants)');
  console.log('  Local documents:', list.length);
  if (PDFS_ONLY) console.log('  Mode: --pdfs-only (skip entry create/update)');
  if (LIMIT) console.log('  Limit:', LIMIT);
  if (DRY_RUN) console.log('  DRY_RUN=1');

  if (DRY_RUN) {
    for (const doc of list.slice(0, 20)) {
      const tenantId = resolveTenantIdForDoc(doc, localTenantById, tenantIdFilter);
      const pdfPath = resolveLocalPdfPath(doc);
      const editionSlug = doc.edition?.slug;
      console.log(
        'Would push:',
        doc.slug?.slice(0, 50),
        '| edition:',
        editionSlug,
        '| tenant:',
        tenantId,
        '| pdf:',
        pdfPath ? path.basename(pdfPath) : 'none'
      );
    }
    if (list.length > 20) console.log(`  ... and ${list.length - 20} more`);
    process.exit(0);
  }

  const cloudApiStatus = await probeCloudApi();
  if (cloudApiStatus === 404) {
    console.error('');
    console.error(`Cloud API /api/${PLURAL} returned 404 — deploy kalpana-document schema on Cloud first.`);
    console.error('  1. Commit and push src/api/kalpana-document/');
    console.error('  2. npx strapi login && npx strapi deploy --force');
    console.error('  3. npm run push:kalpana-documents-to-cloud -- --tenant-id=' + tenantIdFilter);
    process.exit(1);
  }
  if (cloudApiStatus !== 200) {
    console.error('Unexpected Cloud API status for', PLURAL + ':', cloudApiStatus);
    process.exit(1);
  }

  let cloudTenants = await getCloudTenants();
  const cloudEditions = await getCloudEditionMap(tenantIdFilter);
  const { bySourceUrl: cloudBySource, bySlugTenant: cloudBySlugTenant } = await getCloudDocumentKeys(tenantIdFilter);

  if (cloudEditions.size === 0) {
    console.error('No kalpana editions on Cloud for tenant', tenantIdFilter);
    console.error('Run first: npm run push:kalpana-editions-to-cloud -- --tenant-id=' + tenantIdFilter);
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let pdfsLinked = 0;
  let pdfMissing = 0;

  for (const doc of list) {
    const tenantId = resolveTenantIdForDoc(doc, localTenantById, tenantIdFilter);
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

    const editionSlug = doc.edition?.slug;
    const cloudEditionDocId = editionSlug ? cloudEditions.get(editionSlug) : null;
    if (!cloudEditionDocId) {
      console.warn('Skip', doc.slug, ': edition', editionSlug, 'not on Cloud');
      skipped++;
      continue;
    }

    const cloudTenantDocId = cloudTenant.documentId ?? cloudTenant.id;
    const sourceKey = doc.sourceUrl ? `${doc.sourceUrl}_${tenantId}` : null;
    const slugKey = `${doc.slug}_${tenantId}`;
    const existingCloudDocId =
      (sourceKey && cloudBySource.get(sourceKey)) ?? cloudBySlugTenant.get(slugKey) ?? null;

    const payload = {
      title: doc.title,
      slug: doc.slug,
      sourceUrl: doc.sourceUrl ?? null,
      kalpanaNumber: doc.kalpanaNumber ?? null,
      order: doc.order ?? 0,
      edition: cloudEditionDocId,
      tenant: cloudTenantDocId,
    };

    try {
      let cloudDocId = existingCloudDocId;
      if (!PDFS_ONLY) {
        if (existingCloudDocId) {
          await cloudFetch(`/api/${PLURAL}/${existingCloudDocId}`, {
            method: 'PUT',
            body: JSON.stringify({ data: payload }),
          });
          updated++;
        } else {
          const createRes = await cloudFetch(`/api/${PLURAL}`, {
            method: 'POST',
            body: JSON.stringify({ data: payload }),
          });
          cloudDocId = createRes?.data?.documentId ?? createRes?.data?.document_id ?? createRes?.documentId;
          if (sourceKey && cloudDocId) cloudBySource.set(sourceKey, cloudDocId);
          if (cloudDocId) cloudBySlugTenant.set(slugKey, cloudDocId);
          created++;
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
        console.warn('Skip PDF (no cloud entry):', doc.slug);
        skipped++;
        continue;
      }

      const pdfPath = resolveLocalPdfPath(doc);
      if (cloudDocId && pdfPath) {
        try {
          const uploaded = await uploadFileToCloud(pdfPath, doc[MEDIA_FIELD] || {});
          if (uploaded?.id) {
            await cloudFetch(`/api/${PLURAL}/${cloudDocId}`, {
              method: 'PUT',
              body: JSON.stringify({ data: { [MEDIA_FIELD]: uploaded.id } }),
            });
            pdfsLinked++;
            if ((created + updated) % 25 === 0 || pdfsLinked <= 5) {
              console.log('  pdf linked:', doc.slug?.slice(0, 60), '←', path.basename(pdfPath));
            }
          }
        } catch (e) {
          console.warn('  pdf failed for', doc.slug?.slice(0, 40), e.message);
        }
      } else if (cloudDocId && doc.sourceUrl && !pdfPath) {
        pdfMissing++;
      }
    } catch (e) {
      console.warn('Failed', doc.slug?.slice(0, 40), e.message);
      skipped++;
    }

    await sleep(120);
  }

  console.log('');
  console.log(
    'Done.',
    'Created:', created,
    'Updated:', updated,
    'PDFs linked:', pdfsLinked,
    'PDF missing locally:', pdfMissing,
    'Skipped:', skipped,
    '→', CLOUD_URL
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
