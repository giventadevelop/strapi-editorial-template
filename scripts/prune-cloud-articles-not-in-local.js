'use strict';

/**
 * Delete Cloud articles for a tenant whose slug is not in the local set.
 *
 *   node scripts/prune-cloud-articles-not-in-local.js --tenant-id=mosc_malankara_orthodox_2
 *   node scripts/prune-cloud-articles-not-in-local.js --tenant-id=mosc_malankara_orthodox_2 --dry-run
 */

try {
  require('dotenv').config();
} catch (_) {}

const { createStrapi, compileStrapi } = require('@strapi/strapi');

const CLOUD_URL = (process.env.STRAPI_CLOUD_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.STRAPI_CLOUD_API_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');
const TENANT_ID =
  (process.argv.find((a) => a.startsWith('--tenant-id=')) || '').split('=')[1] ||
  'mosc_malankara_orthodox_2';

async function cloudFetch(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${CLOUD_URL}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function fetchAllCloudArticles(tenantId) {
  const rows = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      'filters[tenant][tenantId][$eq]': tenantId,
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      'fields[0]': 'slug',
      'fields[1]': 'publishedAt',
    });
    const json = await cloudFetch(`/api/articles?${qs}`);
    const batch = Array.isArray(json.data) ? json.data : [];
    rows.push(...batch);
    const pageCount = json.meta?.pagination?.pageCount ?? 1;
    if (page >= pageCount || batch.length === 0) break;
    page++;
  }
  return rows;
}

async function main() {
  if (!CLOUD_URL || !API_TOKEN) {
    console.error('Set STRAPI_CLOUD_URL and STRAPI_CLOUD_API_TOKEN');
    process.exit(1);
  }

  console.log('Prune Cloud articles not in local');
  console.log('  Tenant:', TENANT_ID);
  console.log('  Dry run:', DRY_RUN);

  const app = await createStrapi(await compileStrapi()).load();
  app.log.level = 'error';

  let localSlugs = new Set();
  try {
    const local = await app.documents('api::article.article').findMany({
      filters: { tenant: { tenantId: { $eq: TENANT_ID } } },
      fields: ['slug'],
      limit: 5000,
    });
    const list = Array.isArray(local) ? local : local?.results || [];
    localSlugs = new Set(list.map((r) => r.slug).filter(Boolean));
  } finally {
    await app.destroy();
  }

  console.log('  Local slugs:', localSlugs.size);

  const cloudRows = await fetchAllCloudArticles(TENANT_ID);
  // Deduplicate by documentId (draft/published duplicates in list responses)
  const byDoc = new Map();
  for (const row of cloudRows) {
    const docId = row.documentId ?? row.document_id;
    if (docId) byDoc.set(docId, row);
  }
  console.log('  Cloud unique docs:', byDoc.size);

  let deleted = 0;
  let kept = 0;
  for (const [docId, row] of byDoc) {
    const slug = row.slug ?? row.attributes?.slug;
    if (!slug) continue;
    if (localSlugs.has(slug)) {
      kept++;
      continue;
    }
    if (DRY_RUN) {
      console.log('  Would delete', slug, docId);
      deleted++;
      continue;
    }
    try {
      await cloudFetch(`/api/articles/${docId}`, { method: 'DELETE' });
      deleted++;
      console.log('  Deleted', slug);
    } catch (e) {
      console.warn('  Delete failed', slug, e.message);
    }
  }

  console.log('Done. kept=', kept, 'deleted=', deleted);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
